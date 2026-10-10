/**
 * TASK-011A 反例:恢复推演**会**改变同刻事件的执行顺序,但**不影响**任何可观察结果。
 *
 * 两条路径:
 *   ① 一口气跑:`generateCiv(world, { endYear })`
 *   ② 切段恢复:`generateCiv(world, { endYear: cut })` → `CivSim.fromCiv(world, half)` → `run(endYear)`
 *
 * 怎么"看见"顺序:给 `CivSim.prototype.on` 打桩,把每个 handler 包一层,记下
 * **(时刻 t, 事件类型, a, b)** —— 引擎实际调用 handler 的先后。
 *
 * 最小复现(seed 42 / 切 2600 / 推到 2610):
 * - 一口气跑 23 条、切段恢复 21 条,第 4 条(index 3)起分叉:
 *     一口气跑: … 看邻国(1,16)@2601.605 → 立国(4,214)@2602.414 → 看内政(1,16)@2603.098
 *     切段恢复: … 立国(4,214)@2602.414 → 战役(0,31)@2603.621 → 立国(99,314)@2603.75
 * - 但 ChangeLog 逐字段、史事、检查点(**年份 + 每个检查点的民族层与国家层**)、最终归属**完全一致**。
 *
 * 这条测试把**现状**钉住:顺序差异是真的(不许说"没有差异"),而结果一致也是真的
 * (不许在没解释的情况下把它放宽成"结果可以不同")。详见 docs/simulation-event-audit.md 的 011 部分。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import { CivSim, Ev, EVENT_INFO, quantize } from '../src/gen/civ/sim';

const SEED = 42;
const CUT = 2600;
const END = 2610;

type TraceEntry = [number, number, number, number]; // t, kind, a, b

const kindName = (k: number) => EVENT_INFO.find((e) => e.id === k)?.name ?? `#${k}`;
const show = (t: TraceEntry[]) => t.map(([tm, k, a, b]) => `${kindName(k)}(${a},${b})@${tm}`);

/** 给 CivSim.prototype.on 打桩,记录 handler 的执行顺序;返回 { trace, restore } */
function traceOn(): { trace: TraceEntry[]; restore: () => void } {
  const trace: TraceEntry[] = [];
  const proto = CivSim.prototype as unknown as { on: (k: number, h: (a: number, b: number, t: number) => void, o?: unknown) => void };
  const orig = proto.on;
  proto.on = function (kind, handler, opts) {
    return orig.call(this, kind, (a: number, b: number, t: number) => {
      trace.push([t, kind, a, b]);
      return handler(a, b, t);
    }, opts);
  };
  return { trace, restore: () => void (proto.on = orig) };
}

const world = generateWorld({ ...DEFAULT_PARAMS, seed: SEED });

/** 一口气推到 END */
function straight() {
  const { trace, restore } = traceOn();
  try {
    const civ = generateCiv(world, { endYear: END });
    return { trace, log: civ.log, annals: civ.annals, checkpoints: civ.checkpoints, polity: civ.polity, culture: civ.culture };
  } finally {
    restore();
  }
}

/** 推到 CUT,再从成品接着推到 END */
function resumed() {
  const half = generateCiv(world, { endYear: CUT });
  const { trace, restore } = traceOn();
  try {
    const sim = CivSim.fromCiv(world, half);
    sim.run(END);
    const res = sim.result();
    return { trace, log: res.log, annals: res.annals, checkpoints: res.checkpoints, polity: res.polity, culture: res.culture };
  } finally {
    restore();
  }
}

describe('恢复推演 · 同刻事件顺序(TASK-011A 反例)', () => {
  it('事件执行顺序**确实**会不一样(轨迹条数与内容都不同)', () => {
    // 只比"切开之后"那一段(切开那一刻的边界语义是另一个话题)
    const a = straight().trace.filter((e) => e[0] > CUT);
    const b = resumed().trace.filter((e) => e[0] > CUT);
    expect(a.length, '一口气跑的条数').toBe(23);
    expect(b.length, '切段恢复的条数').toBe(21);
    // 前三条相同,第 4 条起分叉 —— 精确到事件序列
    expect(show(a.slice(0, 3))).toEqual(show(b.slice(0, 3)));
    expect(a[3]).toEqual([quantize(2601.60546875), Ev.WarCheck, 1, 16]);
    expect(b[3]).toEqual([quantize(2602.4140625), Ev.PolityFound, 4, 214]);
    expect(show(a)).not.toEqual(show(b));
  }, 120_000);

  it('但**可观察结果**完全一致:ChangeLog 逐字段、史事、检查点、最终归属', () => {
    const a = straight();
    const b = resumed();
    // ChangeLog:逐字段比(顺序、年份、州、层、值、原因)
    expect(b.log.size).toBe(a.log.size);
    expect(Array.from(b.log.year)).toEqual(Array.from(a.log.year));
    expect(Array.from(b.log.region)).toEqual(Array.from(a.log.region));
    expect(Array.from(b.log.layer)).toEqual(Array.from(a.log.layer));
    expect(Array.from(b.log.value)).toEqual(Array.from(a.log.value));
    expect(Array.from(b.log.cause)).toEqual(Array.from(a.log.cause));
    // 史事
    expect(b.annals).toEqual(a.annals);
    // 检查点:契约 §1.2 承诺的是"年份 + 每个检查点的民族层与国家层都逐字节一致",三样都要比
    expect(b.checkpoints.length, '检查点个数').toBe(a.checkpoints.length);
    expect(b.checkpoints.map((c) => c.year), '检查点年份序列').toEqual(a.checkpoints.map((c) => c.year));
    for (let i = 0; i < a.checkpoints.length; i++) {
      expect(Buffer.from(b.checkpoints[i].polity.buffer).equals(Buffer.from(a.checkpoints[i].polity.buffer)), `第 ${i} 个检查点的国家层`).toBe(true);
      expect(Buffer.from(b.checkpoints[i].culture.buffer).equals(Buffer.from(a.checkpoints[i].culture.buffer)), `第 ${i} 个检查点的民族层`).toBe(true);
    }
    // 最终归属
    expect(Buffer.from(b.polity.buffer).equals(Buffer.from(a.polity.buffer)), '国家归属').toBe(true);
    expect(Buffer.from(b.culture.buffer).equals(Buffer.from(a.culture.buffer)), '民族归属').toBe(true);
  }, 120_000);
});
