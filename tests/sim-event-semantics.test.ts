/**
 * 事件语义回归(TASK-010B):把 `CivSim` 那些**现在没有直接护栏**的语义钉住。
 *
 * 只补审计(`docs/simulation-event-audit.md` §8)里标着「没有覆盖 / 只有间接覆盖」的几条:
 *   ① `on` 是覆盖式(后注册顶掉先前)+ handler 收到 `(a, b, t)` 的契约
 *   ② `record` 的默认 `-1`、`via` 只在给了才带、按调用先后追加
 *   ③ `run(untilYear)` **含当年**:恰好落在 `untilYear` 的事件会触发,之后的不会
 *   ④ `onChange` 可以挂多个监听者,按注册顺序同步触发
 *   ⑤ `schedule` 把"预约到过去"抬到当前这一刻(且排在已排队的后面);`+Infinity`/`NaN`/超 65536 年不预约
 *   ⑥ `floor` 把更早的事件抬到 floor(地形大事"接着推"靠这条)
 *   ⑦ `setOwner` 写进 ChangeLog 的字段内容(不只是条数)
 *
 * 这些都是**当前实现**的语义;测试先跑通、把现状钉住,不改任何生产代码。
 * 已有直接覆盖的(同刻按预约先后、过期作废、setOwner 的通知与 no-op、检查点节奏、切段恢复逐字节一致)
 * 不在这里重复 —— 见 tests/civ-sim.test.ts 与各 civ-*.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { CivSim, Ev, quantize } from '../src/gen/civ/sim';
import { Layer } from '../src/gen/civ/types';

describe('CivSim 事件语义 · on 的注册契约', () => {
  it('on 是覆盖式:同一类事件后注册的 handler 顶掉先前的(不会两个都跑)', () => {
    const sim = new CivSim(3);
    const seen: string[] = [];
    sim.on(Ev.WarCheck, () => seen.push('first'));
    sim.on(Ev.WarCheck, () => seen.push('second'));
    sim.schedule(10, Ev.WarCheck, 0, 0);
    sim.run(10);
    expect(seen).toEqual(['second']);
  });

  it('handler 收到 (a, b, t):t 是量化后的时刻(不是预约时原样的数)', () => {
    const sim = new CivSim(3);
    const got: [number, number, number][] = [];
    sim.on(Ev.WarCheck, (a, b, t) => got.push([a, b, t]));
    sim.schedule(12.5001, Ev.WarCheck, 1, 7);
    sim.run(20);
    expect(got).toEqual([[1, 7, quantize(12.5001)]]);
  });

  it('onChange 可以挂多个监听者,按注册顺序同步触发(收到 region / value / prev / cause)', () => {
    const sim = new CivSim(2);
    const heard: string[] = [];
    sim.onChange(Layer.Culture, (r, v, p, c) => heard.push(`A:${r},${v},${p},${c}`));
    sim.onChange(Layer.Culture, (r, v, p, c) => heard.push(`B:${r},${v},${p},${c}`));
    sim.setOwner(Layer.Culture, 1, 5, Ev.CultureBorn);
    expect(heard).toEqual([`A:1,5,-1,${Ev.CultureBorn}`, `B:1,5,-1,${Ev.CultureBorn}`]);
  });
});

describe('CivSim 事件语义 · record 记史事', () => {
  it('年份 = 现在;没给的字段一律 −1;按调用先后追加', () => {
    const sim = new CivSim(2);
    sim.run(150);
    sim.record('found', { a: 3, region: 1 });
    sim.record('rank', { a: 3 });
    expect(sim.result().annals).toEqual([
      { year: 150, kind: 'found', a: 3, b: -1, region: 1, settlement: -1, war: -1 },
      { year: 150, kind: 'rank', a: 3, b: -1, region: -1, settlement: -1, war: -1 },
    ]);
  });

  it('via 只在显式给了才带上(不给就没有这个字段)', () => {
    const sim = new CivSim(2);
    sim.record('battle', { a: 0, via: 3 });
    sim.record('battle', { a: 0 });
    const [withVia, without] = sim.result().annals;
    expect(withVia.via).toBe(3);
    expect('via' in without).toBe(false);
  });
});

describe('CivSim 事件语义 · run 的年份边界', () => {
  it('含这一年:恰好落在 untilYear 的事件会触发', () => {
    const sim = new CivSim(2);
    const seen: number[] = [];
    sim.on(Ev.WarCheck, (_a, _b, t) => seen.push(t));
    sim.schedule(100, Ev.WarCheck, 0, 0);
    sim.run(100);
    expect(seen).toEqual([100]);
    expect(sim.pending).toBe(0);
  });

  it('这一年之后的不触发,还留在堆里', () => {
    const sim = new CivSim(2);
    const seen: number[] = [];
    sim.on(Ev.WarCheck, (_a, _b, t) => seen.push(t));
    sim.schedule(100.5, Ev.WarCheck, 0, 0);
    sim.run(100);
    expect(seen).toEqual([]);
    expect(sim.pending).toBe(1);
    sim.run(101);
    expect(seen).toEqual([quantize(100.5)]);
  });

  it('now 只前进:推到更早的年份不会把时间倒回去', () => {
    const sim = new CivSim(2);
    sim.run(500);
    expect(sim.result().endYear).toBe(500);
    sim.run(200);
    expect(sim.result().endYear).toBe(500);
  });
});

describe('CivSim 事件语义 · schedule 的钳制与丢弃', () => {
  it('预约到过去 → 抬到"现在"这一刻,并排在已排队的同一刻事件之后', () => {
    const sim = new CivSim(2);
    const seen: string[] = [];
    sim.on(Ev.WarCheck, (_a, b, t) => seen.push(`b${b}@${t}`));
    sim.run(50);
    sim.schedule(50, Ev.WarCheck, 0, 1); // 就在现在这一刻
    sim.schedule(10, Ev.WarCheck, 0, 2); // 预约到过去 → 抬到 50,但 seq 更大
    expect(sim.pending).toBe(2);
    sim.run(50);
    expect(seen).toEqual(['b1@50', 'b2@50']);
  });

  it('+Infinity / NaN / 超过 65536 年:不预约(堆里不留东西)', () => {
    const sim = new CivSim(2);
    sim.schedule(Number.POSITIVE_INFINITY, Ev.WarCheck, 0, 0);
    sim.schedule(Number.NaN, Ev.WarCheck, 0, 0);
    sim.schedule(70000, Ev.WarCheck, 0, 0); // MAX_TICK = 2^24 个 tick = 65536 年
    expect(sim.pending).toBe(0);
  });

  it('floor:早于 floor 的事件被抬到 floor(地形大事"接着推"靠这条)', () => {
    const sim = new CivSim(2);
    const seen: number[] = [];
    sim.on(Ev.WarCheck, (_a, _b, t) => seen.push(t));
    sim.now = 500;
    sim.floor = 1000; // 大事那一刻:更早的事一律从这一刻起
    sim.schedule(300, Ev.WarCheck, 0, 0);
    sim.run(1200);
    expect(seen).toEqual([1000]);
  });
});

describe('CivSim 事件语义 · setOwner 写进日志的字段', () => {
  it('年份 = 现在;region / layer / value / cause 原样;值不变的那次什么都不写', () => {
    const sim = new CivSim(2);
    sim.run(75);
    sim.setOwner(Layer.Polity, 1, 4, Ev.PolityFound);
    sim.setOwner(Layer.Polity, 1, 4, Ev.Conquer); // 新值 = 旧值 → 不写、不 +版本、不通知
    sim.setOwner(Layer.Culture, 0, 2, Ev.CultureBorn);
    const log = sim.result().log;
    expect(log.size).toBe(2);
    expect(Array.from(log.year)).toEqual([75, 75]);
    expect(Array.from(log.region)).toEqual([1, 0]);
    expect(Array.from(log.layer)).toEqual([Layer.Polity, Layer.Culture]);
    expect(Array.from(log.value)).toEqual([4, 2]);
    expect(Array.from(log.cause)).toEqual([Ev.PolityFound, Ev.CultureBorn]);
    // 版本号:两次成功写入各 +1(第二次是另一层、另一个州),被 no-op 的那次不 +1
    expect(Array.from(sim.version)).toEqual([1, 1]);
  });
});
