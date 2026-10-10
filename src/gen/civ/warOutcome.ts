/**
 * 战争结果的结构化派生视图(阶段 1a):把 `civ.annals` 里的 war / conquer / peace / fall 整理成
 * 「每一场仗:谁打谁、为谁援盟、谁亡了、割了哪些州、打下哪些州」,每一次领土易手都带前后归属。
 *
 * 纯函数、只读 annals:不改推演、不改存档、不新增持久状态,也不碰 RNG / 事件调度 / 续跑契约。
 * 地图那侧的战事视图(`render/civ/warfare.ts` 的 `warSpans`)回答的是「打过哪几仗、某一年画什么」;
 * 这里只回答「结果」,两者都不改史事,可以互相核对(测试里就有一条交叉核对,防止两份推导漂移)。
 *
 * 只用史事里确实记下的字段,数据不足以判定的(比如胜负)一律不猜:
 *   war     攻方 a / 守方 b / 援盟 settlement(应哪国之约参战;不是援盟 = −1)
 *   conquer 得方 a / 原主 b(−1 = 部落地带)/ region / war
 *   peace   攻方 a / 守方 b / region = **割让的州数**(紧挨在它前面的那几条同 war 的 conquer 就是割让的)
 *   fall    灭亡 a / 灭它者 b(−1 = 自己瓦解 / 并入,−2 = 亡于天灾)/ region / war
 * 见 `types.ts` 的史事字段表。
 */
import type { Civ, Year } from './types';

/** 一次领土易手:哪个州、哪一年、从谁到谁(−1 = 部落地带 / 无主) */
export interface Transfer {
  year: Year;
  region: number;
  from: number;
  to: number;
}

/** 一场仗里灭亡的国家 */
export interface WarFall {
  year: Year;
  /** 灭亡的国家 */
  polity: number;
  /** 灭它的国家(−1 = 自己瓦解 / 并入,−2 = 亡于天灾) */
  by: number;
}

/** 一场战争的结果(全部由史事推导) */
export interface WarOutcome {
  id: number;
  /** 攻方、守方(国家编号) */
  atk: number;
  def: number;
  start: Year;
  /** 打完那一刻(议和 / 一方亡国 / 一方在别处不在了);还在打 = Infinity */
  end: Year;
  /** 援盟:这一场仗是为哪个国家应约参战(war 史事的 settlement 列);不是援盟 = null */
  joinedFor: number | null;
  /** 这场仗里灭亡的国家(按年份) */
  fallen: WarFall[];
  /** 议和时划界割让的州(前后归属;不是打下来的) */
  ceded: Transfer[];
  /** 打下来(换了主人)的州(前后归属;议和割让的另记在 ceded,不重复) */
  conquered: Transfer[];
}

const cache = new WeakMap<Civ, WarOutcome[]>();

/** 这个世界里每一场战争的结果(按宣战先后) */
export function warOutcomes(civ: Civ): WarOutcome[] {
  const hit = cache.get(civ);
  if (hit) return hit;
  const A = civ.annals;
  // 议和时划界割让的 conquer:peace.region = 紧挨在它前面、连着记的那几条同 war 的 conquer(types.ts 的字段表)。
  // 只往回看**连着**的一段:碰到别的史事(别的种类、别的战争)就停,免得把更早打下来的州错认成割地;
  // 条数最多 e.region 条。和 render 侧 warSpans 的判定同一套规则(测试里交叉核对)。
  const cession = new Set<number>();
  for (let i = 0; i < A.length; i++) {
    const e = A[i];
    if (e.kind !== 'peace' || e.region <= 0) continue;
    let n = 0;
    for (let j = i - 1; j >= 0 && n < e.region; j--) {
      const c = A[j];
      if (c.kind !== 'conquer' || c.war !== e.war) break;
      cession.add(j);
      n++;
    }
  }
  const byId = new Map<number, WarOutcome>();
  const out: WarOutcome[] = [];
  for (let i = 0; i < A.length; i++) {
    const e = A[i];
    if (e.war < 0) continue;
    if (e.kind === 'war') {
      if (byId.has(e.war)) continue;
      const w: WarOutcome = {
        id: e.war,
        atk: e.a,
        def: e.b,
        start: e.year,
        end: Infinity,
        joinedFor: e.settlement >= 0 ? e.settlement : null,
        fallen: [],
        ceded: [],
        conquered: [],
      };
      byId.set(e.war, w);
      out.push(w);
      continue;
    }
    const w = byId.get(e.war);
    if (!w) continue;
    if (e.kind === 'peace') w.end = Math.min(w.end, e.year);
    else if (e.kind === 'fall') {
      if (e.a === w.atk || e.a === w.def) w.end = Math.min(w.end, e.year);
      w.fallen.push({ year: e.year, polity: e.a, by: e.b });
    } else if (e.kind === 'conquer' && e.region >= 0) {
      const t: Transfer = { year: e.year, region: e.region, from: e.b, to: e.a };
      if (cession.has(i)) w.ceded.push(t);
      else w.conquered.push(t);
    }
  }
  // 交战的一方在别的事里不在了(并入、分裂……),仗也就打完了
  for (const w of out) {
    for (const id of [w.atk, w.def]) {
      const ended = civ.polities[id]?.ended;
      if (ended !== undefined && ended < w.end) w.end = Math.max(w.start, ended);
    }
  }
  cache.set(civ, out);
  return out;
}
