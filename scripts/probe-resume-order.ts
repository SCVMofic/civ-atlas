/**
 * TASK-011A 探索脚本:**恢复推演会不会改变同刻事件的执行顺序?**
 *
 * 两条路径:
 *   ① 一口气跑:`generateCiv(world, { endYear })`
 *   ② 切段恢复:`generateCiv(world, { endYear: cut })` → `CivSim.fromCiv(world, half)` → `sim.run(endYear)`
 *
 * 怎么"看见"事件顺序:给 `CivSim.prototype.on` 打桩,把每个 handler 包一层,
 * 记录 **(时刻 t, 事件类型, a, b)** —— 这就是引擎实际的处理顺序(handler 被调用的先后)。
 * 再比:轨迹、ChangeLog(逐字段)、史事、检查点、最终归属。
 *
 * 比较范围:`t > cut` 的那一段(切开那一刻的边界语义是另一个话题,先排除掉)。
 * 检查点比的是**年份 + 民族层 + 国家层**(契约 docs/simulation-resume-contract.md §1.2 承诺的三样)。
 *
 * 用法:
 *   npx tsx scripts/probe-resume-order.ts                 # 默认:6 个种子 × 4 个切分年份
 *   npx tsx scripts/probe-resume-order.ts 7 1200 2000     # 只跑 seed 7、切 1200、推到 2000
 *
 * 本脚本不改任何生产代码;它是"探索范围"的证据,不是"不存在差异"的证明。
 */
import { createHash } from 'node:crypto';
import { DEFAULT_PARAMS, generateWorld, type World, type WorldParams } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { CivSim, EVENT_INFO } from '../src/gen/civ/sim';
import { quantize } from '../src/gen/civ/sim';

type TraceEntry = [number, number, number, number]; // t, kind, a, b

const KIND_NAME = new Map<number, string>(EVENT_INFO.map((e) => [e.id, e.name]));
const kindName = (k: number) => KIND_NAME.get(k) ?? `#${k}`;

/** 打桩:把 handler 包一层记录执行顺序;返回还原函数 */
function traceHandlers(sink: TraceEntry[]): () => void {
  const proto = CivSim.prototype as unknown as { on: (k: number, h: (a: number, b: number, t: number) => void, o?: unknown) => void };
  const orig = proto.on;
  proto.on = function (kind, handler, opts) {
    return orig.call(this, kind, (a: number, b: number, t: number) => {
      sink.push([t, kind, a, b]);
      return handler(a, b, t);
    }, opts);
  };
  return () => {
    proto.on = orig;
  };
}

interface Run {
  trace: TraceEntry[];
  civ: Civ;
  /** 推完那一刻各州的归属(恢复路径要从 sim.result() 拿,不能用切开时的 half) */
  polity: Int16Array;
  culture: Int16Array;
  log: { year: number[]; region: number[]; layer: number[]; value: number[]; cause: number[]; size: number };
  annals: string;
  checkpoints: string;
}

/** 一口气推到 endYear */
function straight(params: WorldParams, world: World, endYear: number): Run {
  const trace: TraceEntry[] = [];
  const restore = traceHandlers(trace);
  try {
    const civ = generateCiv(world, { endYear });
    return {
      trace,
      civ,
      polity: civ.polity,
      culture: civ.culture,
      log: logOf(civ.log),
      annals: JSON.stringify(civ.annals),
      checkpoints: checkpointDigest(civ.checkpoints),
    };
  } finally {
    restore();
  }
}

/** 推到 cut,再从成品接着推到 endYear */
function resumed(params: WorldParams, world: World, cut: number, endYear: number): Run {
  const half = generateCiv(world, { endYear: cut });
  const trace: TraceEntry[] = [];
  const restore = traceHandlers(trace);
  try {
    const sim = CivSim.fromCiv(world, half);
    sim.run(endYear);
    const res = sim.result();
    return {
      trace,
      civ: half,
      polity: res.polity,
      culture: res.culture,
      log: logOf(res.log),
      annals: JSON.stringify(res.annals),
      checkpoints: checkpointDigest(res.checkpoints),
    };
  } finally {
    restore();
  }
}

/**
 * 检查点的指纹:**年份 + 民族层 + 国家层**(契约 §1.2 承诺的三样),逐字节算进摘要。
 * 整份数组 JSON 太大,这里用 sha1 摘要 —— 一样能判"逐字节是否相同"。
 */
function checkpointDigest(cps: { year: number; culture: Int16Array; polity: Int16Array }[]): string {
  const h = createHash('sha1');
  for (const c of cps) {
    h.update(`${c.year}|`);
    h.update(new Uint8Array(c.culture.buffer, c.culture.byteOffset, c.culture.byteLength));
    h.update('|');
    h.update(new Uint8Array(c.polity.buffer, c.polity.byteOffset, c.polity.byteLength));
    h.update(';');
  }
  return h.digest('hex');
}

function logOf(log: { size: number; year: Float32Array; region: Int32Array; layer: Uint8Array; value: Int16Array; cause: Uint8Array }) {
  return {
    year: Array.from(log.year.slice(0, log.size)),
    region: Array.from(log.region.slice(0, log.size)),
    layer: Array.from(log.layer.slice(0, log.size)),
    value: Array.from(log.value.slice(0, log.size)),
    cause: Array.from(log.cause.slice(0, log.size)),
    size: log.size,
  };
}

/** 第一处不一样的位置 + 前后各 3 条(便于人读) */
function firstDiff(a: TraceEntry[], b: TraceEntry[]): { at: number; a: TraceEntry[]; b: TraceEntry[] } | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      return { at: i, a: a.slice(Math.max(0, i - 3), i + 3), b: b.slice(Math.max(0, i - 3), i + 3) };
    }
  }
  return null;
}

const fmt = (t: TraceEntry[]) => t.map(([tm, k, a, b]) => `${tm} ${kindName(k)}(${a},${b})`);

const args = process.argv.slice(2);
const oneSeed = args[0] ? Number(args[0]) : null;
const oneCut = args[1] ? Number(args[1]) : null;
const oneEnd = args[2] ? Number(args[2]) : 3000;

const seeds = oneSeed !== null ? [oneSeed] : [7, 2024, 3, 99, 1, 42];
const cuts = oneCut !== null ? [oneCut] : [1200, 2000, 2600, 900];
const END = oneEnd;

console.log(`探针:${seeds.length} 个种子 × ${cuts.length} 个切分年份,终点 ${END};地块 ${DEFAULT_PARAMS.cells}`);
console.log(`比较字段:事件执行轨迹(只取 t > cut)、ChangeLog 逐字段、史事、检查点、最终归属\n`);

let cases = 0;
let traceDiffs = 0;
let logDiffs = 0;
let annalDiffs = 0;
let cpDiffs = 0;
let ownerDiffs = 0;

for (const seed of seeds) {
  const params: WorldParams = { ...DEFAULT_PARAMS, seed };
  const world = generateWorld(params);
  const straightRun = straight(params, world, END);
  for (const cut of cuts) {
    if (cut >= END) continue;
    cases++;
    const res = resumed(params, world, cut, END);
    // 轨迹只比"切开之后"那一段;两边都丢掉 t <= cut 的边界条目
    const sTrace = straightRun.trace.filter((e) => e[0] > cut);
    const rTrace = res.trace.filter((e) => e[0] > cut);
    const td = firstDiff(sTrace, rTrace);
    const sameLog = JSON.stringify(straightRun.log) === JSON.stringify(res.log);
    const sameAnnals = straightRun.annals === res.annals;
    const sameCp = straightRun.checkpoints === res.checkpoints;
    const sameOwners =
      Buffer.from(straightRun.polity.buffer).equals(Buffer.from(res.polity.buffer)) &&
      Buffer.from(straightRun.culture.buffer).equals(Buffer.from(res.culture.buffer));

    if (td) traceDiffs++;
    if (!sameLog) logDiffs++;
    if (!sameAnnals) annalDiffs++;
    if (!sameCp) cpDiffs++;
    if (!sameOwners) ownerDiffs++;

    const tag = td || !sameLog || !sameAnnals || !sameCp || !sameOwners ? '✗ 有差异' : '✓ 一致';
    console.log(
      `seed ${seed} 切 ${cut}:${tag}  (轨迹 ${sTrace.length}/${rTrace.length} 条` +
        `${sameLog ? '' : ' · 日志不同'}${sameAnnals ? '' : ' · 史事不同'}${sameCp ? '' : ' · 检查点不同'}${sameOwners ? '' : ' · 归属不同'})`,
    );
    if (td) {
      console.log(`    轨迹第一处不同在第 ${td.at} 条:`);
      console.log(`      一口气跑: ${fmt(td.a).join(' | ')}`);
      console.log(`      切段恢复: ${fmt(td.b).join(' | ')}`);
    }
  }
}

console.log(
  `\n共 ${cases} 组:轨迹不同 ${traceDiffs}、日志不同 ${logDiffs}、史事不同 ${annalDiffs}、检查点不同 ${cpDiffs}、归属不同 ${ownerDiffs}`,
);
if (traceDiffs === 0 && logDiffs === 0 && annalDiffs === 0) {
  console.log('这一批样本里没有观察到顺序差异 —— 这只是"探索范围"的记录,不是"不存在差异"的证明。');
}
void quantize; // 保留:以后要按 tick 归组时用
