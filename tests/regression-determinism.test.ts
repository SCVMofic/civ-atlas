/**
 * 确定性回归(RFC TASK-005):同样的输入 = 逐字节同一个世界。
 *
 * 每个用例把**整条流水线**跑两遍,逐字段比指纹(tests/lib/fingerprint.ts,和
 * scripts/fingerprint.ts 同一套算法):地形 → 气候 → 河流 → 生物群系 → 文明 → 编年史 → 铺像素 → 回放帧,
 * 外加改过地形、画过草图、带干预、带地形大事的世界。失败信息里是"哪几个字段变了"。
 *
 * 和 tests/determinism.test.ts 的分工:那份把两个种子的指纹**钉死**(钉住的是"任何电脑上都是这个值",
 * 覆盖跨平台);这份跑**两遍互相比**(覆盖"同一台机器上跑两次一样",能抓住 Map 遍历顺序、
 * 模块级缓存、隐藏的 Math.random / 时间戳之类的非确定性 —— 钉死的期望值反而看不见这些)。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World, type WorldParams } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { buildChronicle } from '../src/gen/civ/chronicle';
import { mergeUpheavals } from '../src/gen/civ/upheaval';
import type { UpheavalStep } from '../src/gen/civ/upheaval';
import { rasterize } from '../src/gen/raster';
import { buildHistoryFrames } from '../src/gen/history';
import { sketchGrid, type Sketch, type SketchEdit } from '../src/gen/sketch';
import { polityKey, type Intervention, type TerrainOp, type Upheaval } from '../src/gen/edits';
import { changedFields, fieldsOf, hashOf } from './lib/fingerprint';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, cells: 12000 };

// ---------------------------------------------------------------------------
// 两条常用的流水线

/** 各段世界:第 k 段 = 原来的地形套上前 k + 1 件大事的修改(和 worker.ts 的 stepsOf 同一套累积方式) */
function eraSteps(params: WorldParams, terrain: readonly TerrainOp[] | undefined, sketch: Sketch | null, list: readonly Upheaval[]): UpheavalStep[] {
  let all: TerrainOp[] = [...(terrain ?? [])];
  return mergeUpheavals(list).map((m) => {
    all = [...all, ...m.ops];
    return { year: m.year, ops: m.ops, items: m.items, world: generateWorld(params, undefined, all, sketch) };
  });
}

/** 整条流水线的全部字段:world.* / civ.* / chronicle / raster.* / frames */
function pipeline(params: WorldParams, terrain?: readonly TerrainOp[], sketchEdit?: SketchEdit, list?: readonly Upheaval[]): Record<string, string> {
  const sketch = sketchGrid(sketchEdit);
  const w = generateWorld(params, undefined, terrain, sketch);
  const out: Record<string, string> = { ...fieldsOf('world.', w) };
  const steps = eraSteps(params, terrain, sketch, list ?? []);
  const civ = generateCiv(w, steps.length ? { upheavals: steps } : {});
  Object.assign(out, fieldsOf('civ.', civ), { chronicle: hashOf(buildChronicle(civ)) });
  Object.assign(out, fieldsOf('raster.', rasterize(w)), { frames: hashOf(buildHistoryFrames(w)) });
  return out;
}

/** 按不干预时的历史挑几条干预(键按结果取,确定性) */
function someInterventions(civ: Civ): Intervention[] {
  const out: Intervention[] = [];
  if (civ.polities.length >= 2) {
    out.push({ kind: 'declare', a: polityKey(civ, 0), b: polityKey(civ, 1), from: 900 });
    out.push({ kind: 'protect', a: polityKey(civ, 1), from: 1000 });
  }
  if (civ.polities.length >= 3) out.push({ kind: 'halt', a: polityKey(civ, 2), from: 600, until: 1800 });
  return out;
}

/** 两遍比一遍:逐字段比指纹,不一致时报出是哪几个字段 */
function expectSame(label: string, once: () => Record<string, string>): void {
  const a = once();
  const b = once();
  const diff = changedFields(a, b);
  expect(diff, `${label}:这些字段两次不一样`).toEqual([]);
  expect(Object.keys(a).length).toBeGreaterThan(0);
}

/** 只比世界字段(地形 / 气候 / 河流 / 生物群系……) */
const worldFields = (w: World) => fieldsOf('world.', w);
/** 只比文明字段 + 编年史 */
const civFields = (civ: Civ) => ({ ...fieldsOf('civ.', civ), chronicle: hashOf(buildChronicle(civ)) });

// ---------------------------------------------------------------------------

describe('确定性回归 · 地形 / 气候 / 河流 / 生物群系', () => {
  const cases: { name: string; params: WorldParams }[] = [
    { name: 'seed 7(默认参数)', params: { ...SMALL, seed: 7 } },
    { name: 'seed 2024', params: { ...SMALL, seed: 2024 } },
    { name: 'seed 99 · 陆地 12%', params: { ...SMALL, seed: 99, landFraction: 0.12 } },
    { name: 'seed 13 · 60 板块', params: { ...SMALL, seed: 13, plates: 60 } },
    { name: 'seed 17 · 冷 −12', params: { ...SMALL, seed: 17, temperature: -12 } },
  ];
  it.each(cases)('$name:两次生成逐字段一致(网格、海拔、气候、河流、生物群系、板块、火山、纬向线)', ({ params }) => {
    const once = () => worldFields(generateWorld(params));
    expectSame('世界', once);
  }, 60_000);

  it('四个种子交叉:生成的先后不影响任何一个(没有残留的模块级状态)', () => {
    const keys = [7, 42, 99, 2024].map((seed) => ({ seed, params: { ...SMALL, seed } }));
    const first = keys.map(({ params }) => worldFields(generateWorld(params)));
    // 中间插一堆别的世界,再按相反顺序重算一遍
    generateWorld({ ...SMALL, seed: 555, cells: 6000 });
    generateWorld({ ...SMALL, seed: 556, landFraction: 0.6 });
    const again = [...keys].reverse().map(({ params }) => worldFields(generateWorld(params)));
    again.reverse();
    first.forEach((fp, i) => expect(changedFields(fp, again[i]), `第 ${i} 个世界的字段变了`).toEqual([]));
  }, 60_000);
});

describe('确定性回归 · 文明 / 编年史', () => {
  const cases: { name: string; params: WorldParams }[] = [
    { name: 'seed 7', params: { ...SMALL, seed: 7 } },
    { name: 'seed 2024', params: { ...SMALL, seed: 2024 } },
    { name: 'seed 53 · 陆地 45% · 山 ×0.5', params: { ...SMALL, seed: 53, landFraction: 0.45, mountains: 0.5 } },
  ];
  it.each(cases)('$name:两次推演逐字段一致(民族、州、国家、城镇、人物、信仰、道路、王朝、编年史)', ({ params }) => {
    const once = () => civFields(generateCiv(generateWorld(params)));
    expectSame('文明', once);
  }, 120_000);

  it('推演两遍之间插一次别的世界的推演,结果不变', () => {
    const params = { ...SMALL, seed: 7 };
    const w = generateWorld(params);
    const a = civFields(generateCiv(w));
    generateCiv(generateWorld({ ...SMALL, seed: 556, landFraction: 0.6 }));
    const b = civFields(generateCiv(w));
    expect(changedFields(a, b)).toEqual([]);
  }, 120_000);
});

describe('确定性回归 · 改过地形 / 画过草图', () => {
  const MILD: TerrainOp[] = [
    { kind: 'volcano', pts: [640, 380], r: 40, s: 1 },
    { kind: 'range', pts: [900, 300, 1000, 420, 1150, 460], r: 25, s: 1.2 },
    { kind: 'lake', pts: [1300, 600], r: 30, s: 1 },
    { kind: 'raise', pts: [300, 700, 420, 760], r: 50, s: 1 },
    { kind: 'sink', pts: [1600, 300, 1700, 350], r: 40, s: 1 },
  ];
  const SKETCH: SketchEdit = {
    rest: 'auto',
    strokes: [
      { kind: 'land', r: 60, pts: [700, 300, 760, 310, 820, 330] },
      { kind: 'mountain', r: 40, h: 2, pts: [700, 300, 760, 310] },
      { kind: 'isles', r: 30, pts: [1200, 600] },
    ],
  };

  it('地形修改:两次生成的地形、气候、河流逐字段一致', () => {
    const once = () => worldFields(generateWorld(SMALL, undefined, MILD));
    expectSame('改地形', once);
  }, 60_000);

  it('草图:两次生成逐字段一致(照草图长出来的星球)', () => {
    const once = () => worldFields(generateWorld(SMALL, undefined, undefined, sketchGrid(SKETCH)));
    expectSame('草图', once);
  }, 60_000);

  it('地形修改 + 草图 + 文明 + 编年史 + 铺像素:整条流水线两次一致', () => {
    const params = { ...SMALL, seed: 7, cells: 8000 };
    const once = () => pipeline(params, MILD, SKETCH);
    expectSame('改地形 + 草图', once);
  }, 180_000);
});

describe('确定性回归 · 干预 / 地形大事', () => {
  it('同样的干预:两次推演逐字段一致(宣战、保护、停战)', () => {
    const params = { ...SMALL, seed: 7 };
    const w = generateWorld(params);
    const list = someInterventions(generateCiv(w));
    expect(list.length).toBeGreaterThan(0);
    const once = () => civFields(generateCiv(w, { interventions: list }));
    expectSame('干预', once);
  }, 180_000);

  it('同样的地形大事:各段世界、两次推演逐字段一致', () => {
    const params = { ...SMALL, seed: 7 };
    const list: Upheaval[] = [
      { year: 1200, ops: [{ kind: 'volcano', pts: [600, 500], r: 60, s: 1.4 }] },
      { year: 2200, ops: [{ kind: 'raise', pts: [1400, 400, 1600, 520], r: 70, s: 1.2 }] },
    ];
    const once = () => {
      const steps = eraSteps(params, undefined, null, list);
      expect(steps.length).toBe(2);
      return {
        steps: hashOf(steps.map((s) => ({ year: s.year, ops: s.ops, items: s.items }))),
        worlds: hashOf(steps.map((s) => fieldsOf('world.', s.world))),
        ...civFields(generateCiv(generateWorld(params), { upheavals: steps })),
      };
    };
    expectSame('地形大事', once);
  }, 240_000);
});

describe('确定性回归 · 指纹本身', () => {
  it('有分辨力:换个种子、换个地形、换一帧,指纹就变(免得恒等指纹把回归测成绿的)', () => {
    const a = worldFields(generateWorld({ ...SMALL, seed: 7, cells: 4000 }));
    const b = worldFields(generateWorld({ ...SMALL, seed: 8, cells: 4000 }));
    expect(changedFields(a, b).length).toBeGreaterThan(0);

    const w = generateWorld({ ...SMALL, seed: 7, cells: 4000 });
    const withOps = worldFields(generateWorld({ ...SMALL, seed: 7, cells: 4000 }, undefined, [{ kind: 'raise', pts: [900, 500, 1000, 520], r: 50, s: 1 }]));
    expect(changedFields(worldFields(w), withOps).length).toBeGreaterThan(0);

    expect(hashOf([1, 2, 3])).not.toBe(hashOf([1, 2, 4]));
    expect(hashOf(new Float32Array([1, 2]))).not.toBe(hashOf(new Float32Array([1, 3])));
    // 0.1 + 0.2 和 0.3 不是一个指纹(浮点按 64 位原样,不做归一化)
    expect(hashOf(0.1 + 0.2)).not.toBe(hashOf(0.3));
  }, 60_000);
});

describe('确定性回归 · 铺像素 / 回放帧', () => {
  it('两次铺像素逐字段一致;两次回放帧逐字节一致', () => {
    const params = { ...SMALL, seed: 7, cells: 8000 };
    const w = generateWorld(params);
    expect(changedFields(fieldsOf('raster.', rasterize(w)), fieldsOf('raster.', rasterize(w)))).toEqual([]);
    const f1 = buildHistoryFrames(w);
    const f2 = buildHistoryFrames(w);
    expect(f1.w).toBe(f2.w);
    expect(f1.h).toBe(f2.h);
    expect(f1.mya).toEqual(f2.mya);
    expect(f1.frames.length).toBe(f2.frames.length);
    for (let i = 0; i < f1.frames.length; i++) {
      expect(Buffer.from(f1.frames[i].buffer).equals(Buffer.from(f2.frames[i].buffer)), `第 ${i} 帧不一样`).toBe(true);
    }
  }, 120_000);
});
