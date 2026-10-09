/**
 * 世界指纹对账:一批种子 × 参数(含改地形、干预)下,地形、文明、铺像素、回放帧、编年史的**全部数据**逐字段算指纹。
 * 纯重构(结果应当逐字节不变)时用:先在 main 上存一份,再在分支上对账。
 *
 *   npx tsx scripts/fingerprint.ts --save /tmp/main.json     # 在 main 上跑,存期望值
 *   npx tsx scripts/fingerprint.ts --check /tmp/main.json    # 在分支上跑,逐字段对账(有差异退出码 1)
 *   npx tsx scripts/fingerprint.ts --only 3                  # 只跑第 3 组(调试用;可和 --check 连用)
 *
 * 指纹的算法和 tests/determinism.test.ts 一样:类型化数组逐字节,数按 64 位原样,对象按键名排序。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_PARAMS, generateWorld, type WorldParams } from '../src/gen/world';
import type { Civ } from '../src/gen/civ';
import { simulation } from '../src/simulation/simulation';
import { rasterize } from '../src/gen/raster';
import { buildHistoryFrames } from '../src/gen/history';
import { buildChronicle } from '../src/gen/civ/chronicle';
import { polityKey, regionKey, settlementKey, type Intervention, type TerrainOp } from '../src/gen/edits';

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);

function print(v: unknown): string {
  const h = createHash('sha1');
  const feed = (x: unknown): void => {
    if (x === null || x === undefined) return void h.update(`~${x}`);
    if (ArrayBuffer.isView(x)) {
      h.update(`<${x.constructor.name}:${x.byteLength}>`);
      return void h.update(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
    }
    if (Array.isArray(x)) {
      h.update(`[${x.length}`);
      x.forEach(feed);
      return void h.update(']');
    }
    if (x instanceof Map) {
      h.update(`{map${x.size}`);
      for (const [k, v] of x) {
        feed(k);
        feed(v);
      }
      return void h.update('}');
    }
    if (x instanceof Set) {
      h.update(`{set${x.size}`);
      for (const v of x) feed(v);
      return void h.update('}');
    }
    if (typeof x === 'object') {
      for (const k of Object.keys(x as object).sort()) {
        h.update(`.${k}`);
        feed((x as Record<string, unknown>)[k]);
      }
      return;
    }
    if (typeof x === 'number') {
      f64[0] = x;
      h.update('n');
      return void h.update(f64b);
    }
    h.update(`${typeof x}:${String(x)}`);
  };
  feed(v);
  return h.digest('hex').slice(0, 16);
}

/** 改地形:和 scripts/stress.ts 同样的几组极端修改,外加几处普通的 */
const rows = (kind: 'sink' | 'raise'): TerrainOp[] => [0, 200, 400, 600, 800, 1000].map((y) => ({ kind, pts: [0, y, 1024, y + 30, 2048, y], r: 160, s: 2 }));
const MIX: TerrainOp[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((k): TerrainOp => ({ kind: 'volcano', pts: [k * 290, (k * 397) % 1024], r: 160, s: 2 })),
  { kind: 'volcano', pts: [2048, 1024], r: 3, s: 0.2 },
  { kind: 'range', pts: [0, 512, 700, 300, 1400, 700, 2048, 512], r: 160, s: 2 },
  { kind: 'range', pts: [1024, 0, 1024, 1024], r: 3, s: 2 },
  { kind: 'range', pts: [500, 500], r: 40, s: 1 },
  { kind: 'lake', pts: [0, 0], r: 160, s: 2 },
  { kind: 'lake', pts: [1024, 512], r: 160, s: 2 },
  { kind: 'lake', pts: [300, 300], r: 3, s: 0.2 },
  { kind: 'sink', pts: [200, 200, 1800, 800], r: 100, s: 2 },
  { kind: 'raise', pts: [1800, 200, 200, 800], r: 100, s: 2 },
  { kind: 'range', pts: [1990, 300, 2100, 330, 2200, 360], r: 60, s: 2 },
  { kind: 'raise', pts: [-40, 700, 60, 720], r: 50, s: 1 },
];
const MILD: TerrainOp[] = [
  { kind: 'volcano', pts: [640, 380], r: 40, s: 1 },
  { kind: 'range', pts: [900, 300, 1000, 420, 1150, 460], r: 25, s: 1.2 },
  { kind: 'lake', pts: [1300, 600], r: 30, s: 1 },
  { kind: 'raise', pts: [300, 700, 420, 760], r: 50, s: 1 },
  { kind: 'sink', pts: [1600, 300, 1700, 350], r: 40, s: 1 },
];

interface Case {
  name: string;
  params: Partial<WorldParams> & { seed: number };
  terrain?: TerrainOp[];
  /** 按不干预时的文明挑几条干预(键按结果取,确定性) */
  interventions?: boolean;
  /** 另算回放帧(慢一些,挑几组) */
  frames?: boolean;
}

const CASES: Case[] = [
  { name: 'seed 7', params: { seed: 7 }, frames: true },
  { name: 'seed 2024', params: { seed: 2024 }, frames: true },
  { name: 'seed 1', params: { seed: 1 } },
  { name: 'seed 42', params: { seed: 42 } },
  { name: 'seed 7 · 12k', params: { seed: 7, cells: 12000 } },
  { name: 'seed 2024 · 12k', params: { seed: 2024, cells: 12000 } },
  { name: 'seed 3 · 80k', params: { seed: 3, cells: 80000 } },
  { name: 'seed 99 · 陆地 12%', params: { seed: 99, landFraction: 0.12 } },
  { name: 'seed 5 · 陆地 60%', params: { seed: 5, landFraction: 0.6 } },
  { name: 'seed 11 · 5 板块', params: { seed: 11, plates: 5 } },
  { name: 'seed 13 · 60 板块', params: { seed: 13, plates: 60, cells: 20000 } },
  { name: 'seed 17 · 冷 −12', params: { seed: 17, temperature: -12 }, frames: true },
  { name: 'seed 19 · 热 +12', params: { seed: 19, temperature: 12, cells: 20000 } },
  { name: 'seed 23 · 少雨', params: { seed: 23, rainfall: 0.4 } },
  { name: 'seed 29 · 山 ×2', params: { seed: 29, mountains: 2 } },
  { name: 'seed 31 · 山 ×0.2 · 50k · 陆地 45%', params: { seed: 31, mountains: 0.2, cells: 50000, landFraction: 0.45 } },
  { name: 'seed 43 · 改地形大杂烩', params: { seed: 43 }, terrain: MIX, frames: true },
  { name: 'seed 47 · 整片沉成海', params: { seed: 47, cells: 20000 }, terrain: rows('sink') },
  { name: 'seed 53 · 整片抬成陆地', params: { seed: 53, cells: 20000 }, terrain: rows('raise') },
  { name: 'seed 7 · 普通改地形 + 干预', params: { seed: 7, cells: 20000 }, terrain: MILD, interventions: true },
  { name: 'seed 2024 · 干预', params: { seed: 2024, cells: 20000 }, interventions: true },
];

function pickInterventions(civ: Civ): Intervention[] {
  const out: Intervention[] = [];
  const P = civ.polities.length;
  if (P >= 2) {
    out.push({ kind: 'declare', a: polityKey(civ, 0), b: polityKey(civ, 1), from: 900 });
    out.push({ kind: 'protect', a: polityKey(civ, 1), from: 1000 });
  }
  const cap = P >= 1 ? civ.polities[0].capital : -1;
  const own = cap >= 0 ? civ.settlements.findIndex((s, i) => i !== cap && s.culture === civ.settlements[cap].culture) : -1;
  if (own >= 0) out.push({ kind: 'move', a: polityKey(civ, 0), city: settlementKey(civ, own), from: 1400 });
  if (civ.regions.count > 10) out.push({ kind: 'found', region: regionKey(civ, Math.floor(civ.regions.count / 3)), from: 1200 });
  if (P >= 3) out.push({ kind: 'halt', a: polityKey(civ, 2), from: 600, until: 1800 });
  return out;
}

function fingerprint(c: Case): Record<string, string> {
  const params = { ...DEFAULT_PARAMS, ...c.params };
  const w = generateWorld(params, undefined, c.terrain);
  let civ = simulation.run({ world: w });
  const out: Record<string, string> = {};
  if (c.interventions) {
    const list = pickInterventions(civ);
    out['interventions'] = print(list);
    civ = simulation.run({ world: w, params: { interventions: list } });
  }
  for (const k of Object.keys(w).sort()) out[`world.${k}`] = print((w as unknown as Record<string, unknown>)[k]);
  for (const k of Object.keys(civ).sort()) out[`civ.${k}`] = print((civ as unknown as Record<string, unknown>)[k]);
  out['chronicle'] = print(buildChronicle(civ));
  const r = rasterize(w);
  for (const k of Object.keys(r).sort()) out[`raster.${k}`] = print((r as unknown as Record<string, unknown>)[k]);
  if (c.frames) out['frames'] = print(buildHistoryFrames(w));
  return out;
}

const args = process.argv.slice(2);
const argOf = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const save = argOf('--save');
const check = argOf('--check');
const only = argOf('--only');
const expected: Record<string, Record<string, string>> | null = check ? JSON.parse(readFileSync(check, 'utf8')) : null;

const result: Record<string, Record<string, string>> = {};
let bad = 0;
const t0 = performance.now();
CASES.forEach((c, idx) => {
  if (only !== undefined && Number(only) !== idx) return;
  const t = performance.now();
  const fp = fingerprint(c);
  result[c.name] = fp;
  const ms = Math.round(performance.now() - t);
  if (expected) {
    const want = expected[c.name];
    const keys = new Set([...Object.keys(fp), ...Object.keys(want ?? {})]);
    const diff = want ? [...keys].filter((k) => fp[k] !== want[k]) : ['(期望值里没有这一组)'];
    if (diff.length) bad++;
    console.log(`${diff.length ? '✗' : '✓'} [${idx}] ${c.name}(${ms}ms,${Object.keys(fp).length} 个字段)${diff.length ? ' 不一致:' + diff.join(' ') : ''}`);
  } else {
    console.log(`[${idx}] ${c.name}(${ms}ms,${Object.keys(fp).length} 个字段)`);
  }
});
if (save) writeFileSync(save, JSON.stringify(result, null, 1));
console.log(`共 ${Object.keys(result).length} 组,${Math.round((performance.now() - t0) / 1000)} 秒${expected ? (bad ? `,${bad} 组不一致` : ',全部一致') : ''}`);
if (bad) process.exit(1);
