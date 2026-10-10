/**
 * 战争结果的结构化派生视图(阶段 1a,gen/civ/warOutcome.ts):
 * 只用 war / conquer / peace / fall 史事,把每一场仗的参战方、亡国、割让地区(带前后归属)、打下的州整理出来。
 * 与地图那侧的 warSpans 交叉核对(防止两份推导漂移),与编年史的战争条目一致。不改推演、不改存档。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import type { Annal } from '../src/gen/civ/types';
import { ownersAt } from '../src/gen/civ/timeline';
import { buildChronicle } from '../src/gen/civ/chronicle';
import { canCross } from '../src/gen/civ/polities';
import { polityKey } from '../src/gen/edits';
import { warOutcomes } from '../src/gen/civ/warOutcome';
import { warSpans } from '../src/render/civ/warfare';

let world: World;
let civ: Civ;

beforeAll(() => {
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
  civ = generateCiv(world);
});

describe('战争结果的结构化视图', () => {
  it('与地图那侧的 warSpans 对得上(参战方、起止、易手的州)', () => {
    const outs = warOutcomes(civ);
    const spans = warSpans(civ);
    expect(outs.length).toBeGreaterThan(3);
    expect(outs.length).toBe(spans.length);
    for (const w of outs) {
      const s = spans.find((x) => x.id === w.id);
      expect(s, `war ${w.id}`).toBeTruthy();
      expect(w.atk).toBe(s!.atk);
      expect(w.def).toBe(s!.def);
      expect(w.start).toBe(s!.start);
      expect(w.end).toBe(s!.end);
      // 割让 + 打下来的州 = 这场仗易手过的州(warSpans.taken 就是全部 conquer)
      expect(new Set([...w.conquered, ...w.ceded].map((t) => t.region))).toEqual(new Set(s!.taken.map((t) => t.region)));
    }
  });

  it('和平割地:前后归属与史事一致,条数 = peace 记的割让州数', () => {
    const A = civ.annals;
    let wars = 0;
    let ceded = 0;
    for (const w of warOutcomes(civ)) {
      if (!w.ceded.length) continue;
      wars++;
      const p = [...A].reverse().find((e) => e.kind === 'peace' && e.war === w.id);
      expect(p, `war ${w.id} 有割让却没有 peace`).toBeTruthy();
      expect(w.ceded.length).toBe(p!.region);
      for (const t of w.ceded) {
        // 每笔割让都能在史事里找到那条 conquer:得方 a = to,原主 b = from
        expect(A.some((e) => e.kind === 'conquer' && e.war === w.id && e.region === t.region && e.a === t.to && e.b === t.from)).toBe(true);
        ceded++;
      }
    }
    expect(wars).toBeGreaterThan(0);
    expect(ceded).toBeGreaterThan(0);
  });

  it('无割地的和平:ceded 为空,peace 的 region 记 −1(不生成割地记录)', () => {
    const A = civ.annals;
    let quiet = 0;
    for (const w of warOutcomes(civ)) {
      if (w.end === Infinity || w.ceded.length) continue;
      const p = A.find((e) => e.kind === 'peace' && e.war === w.id);
      if (!p) continue; // 亡国结束的仗没有 peace
      expect(p.region).toBe(-1);
      quiet++;
    }
    expect(quiet).toBeGreaterThan(0);
  });

  it('亡国:这场仗里亡了哪个国家记进 fallen,与 fall 史事一致', () => {
    const A = civ.annals;
    let checked = 0;
    for (const w of warOutcomes(civ)) {
      for (const f of w.fallen) {
        expect(A.some((e) => e.kind === 'fall' && e.war === w.id && e.year === f.year && e.a === f.polity && e.b === f.by)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('编年史与结构化结果一致:一场仗正好一条战争条目,参战方与事发州对得上', () => {
    const entries = buildChronicle(civ).filter((e) => e.kind === 'war');
    const A = civ.annals;
    for (const w of warOutcomes(civ)) {
      // 编年史按 war 列分组,条目的 id = 这一组第一条史事的下标(= 宣战那条)
      const first = A.findIndex((e) => e.kind === 'war' && e.war === w.id);
      const entry = entries.find((e) => e.id === first);
      expect(entry, `war ${w.id}`).toBeTruthy();
      expect(entry!.polities).toContain(w.atk);
      expect(entry!.polities).toContain(w.def);
      // 易手的州都在条目的事发地里;有易手时条目的事发地就是这些州
      // (一州没打下来/没割让的仗,条目的事发地是没打下来的那几仗的战场,结构化视图不管这个)
      const regions = new Set([...w.conquered, ...w.ceded].map((t) => t.region));
      for (const r of regions) expect(entry!.regions).toContain(r);
      if (regions.size) expect(new Set(entry!.regions)).toEqual(regions);
    }
  });

  it('援盟:war 史事的 settlement 列在结构化视图里记成 joinedFor', () => {
    let outs: ReturnType<typeof warOutcomes> | null = null;
    let joins: Annal[] = [];
    let allyZ = -1;
    let allyY = -1;
    let alliedFrom = Infinity;
    for (const seed of [7, 2024]) {
      const baseCiv = seed === 7 ? civ : generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }));
      const reg = baseCiv.regions;
      for (const e of baseCiv.annals) {
        if (e.kind !== 'war' || e.year < 1000) continue;
        const y0 = Math.floor(e.year);
        if (e.year === y0 || baseCiv.polities[e.b].founded >= y0 - 1) continue;
        const own = ownersAt(baseCiv, y0 - 0.01).polity;
        const border = (a: number, b: number) => {
          const P = baseCiv.polities[a];
          for (let r = 0; r < reg.count; r++) {
            if (own[r] !== a) continue;
            for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (own[reg.adj[k]] === b && canCross(P, reg.adjKind[k])) return true;
          }
          return false;
        };
        // 守方 e.b 和一个同时挨着攻方 e.a 的邻国 z 在年初结盟
        const z = baseCiv.polities.find(
          (q) => q.id !== e.a && q.id !== e.b && q.founded < y0 - 1 && (q.ended ?? Infinity) > e.year && own.includes(q.id) && border(q.id, e.b) && border(q.id, e.a),
        )?.id;
        if (z === undefined) continue;
        const gen = generateCiv(generateWorld({ ...DEFAULT_PARAMS, seed }), { interventions: [{ kind: 'ally', a: polityKey(baseCiv, z), b: polityKey(baseCiv, e.b), from: y0 }] });
        const j = gen.annals.filter((x) => x.kind === 'war' && x.settlement >= 0);
        if (j.length) {
          outs = warOutcomes(gen);
          joins = j;
          allyZ = z;
          allyY = e.b;
          alliedFrom = y0;
          break;
        }
      }
      if (outs) break;
    }
    expect(outs, '没找到援盟的场景').toBeTruthy();
    expect(joins.length).toBeGreaterThan(0);
    for (const e of joins) {
      const w = outs!.find((x) => x.id === e.war)!;
      expect(w.joinedFor).toBe(e.settlement);
      expect(w.atk).toBe(e.a);
      expect(w.def).toBe(e.b);
    }
    // 不是援盟的仗 joinedFor 是 null
    expect(outs!.some((w) => w.joinedFor === null)).toBe(true);
    // 结盟影响决策:结盟以后,盟国之间不再出现互为攻守的仗(结构化视图里也看得见)
    for (const w of outs!) {
      if (w.start < alliedFrom || w.joinedFor !== null) continue;
      expect(new Set([w.atk, w.def])).not.toEqual(new Set([allyZ, allyY]));
    }
  }, 180_000);

  it('没有史事时不崩:返回空数组', () => {
    expect(warOutcomes({ ...civ, annals: [] })).toEqual([]);
  });
});
