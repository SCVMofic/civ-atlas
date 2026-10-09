/**
 * 地名生成器:按不同语感生成中文的国名、城名、山名、海名、河名、地区名。
 *
 * 西幻风(western)先拼拉丁字母原形再音译(Aldoria → 阿尔多里亚);
 * 东方风(eastern)用意象字库 + 通名组合(落霞关、苍澜海),并照顾平仄。
 *
 * 纯计算、不碰 DOM;所有随机数来自 subSeed(seed, 'names:风格') + mulberry32。两种取法:
 * - 逐个取 name(kind):同 seed + styleId + 调用顺序 → 同样的名字,同一个 Namer 内不重名;
 * - 按键取 keyed(kind, ...key):同 seed + styleId + kind + key → 同一串候选,和调用先后无关
 *   (文明、地理实体起名用它,key = 位置锚;改地形后远处的名字不跟着错位)。
 */
import { mulberry32, subSeed, type Rng } from '../util';
import { WESTERN_STYLES, westernCandidate } from './western';
import { EASTERN_STYLES, easternCandidate } from './eastern';
import { latinBlocked, zhBlocked } from './filters';
import { NAME_KINDS, ZH_LEN, type Candidate, type NameKind } from './spec';
import type { NameMix } from './mix';

export type { NameKind } from './spec';
export { NAME_KINDS } from './spec';
export { createPersonNamer, type PersonNamer } from './persons';

export interface NameStyle {
  id: string;
  /** 中文展示名,如 "北境(北欧风)" */
  label: string;
  family: 'western' | 'eastern';
  /** 一句话说明 + 例子,给风格选择界面用 */
  desc: string;
}

export interface GeneratedName {
  /** 完整中文名,如 "阿尔多里亚"、"卡斯特维尔港"、"苍澜海" */
  zh: string;
  /** 西幻风的拉丁字母原形,如 "Aldoria"、"Aldor Mountains";东方风没有 */
  latin?: string;
  /** zh 末尾的通名(山脉 / 海 / 河 / 关 / 州…),没有就不给;地图标注可以拿它换行或换字号 */
  generic?: string;
}

export interface Namer {
  readonly style: NameStyle;
  /** 逐个取名:同一个 Namer 内不重名(结果取决于调用先后) */
  name(kind: NameKind): GeneratedName;
  /**
   * 按键取名:返回这个键的"候选流" —— 每调用一次给下一个候选。同一个 seed + 语感 + kind + key 永远是同一串名字,
   * 和别的键、调用先后都无关(世界里多一个、少一个实体,别的实体的名字不跟着错位)。
   * key 是几个整数:位置锚(地块编号)、同一处的第几个、用途编号……
   *
   * 候选已经过字数、屏蔽字检查,但**不查重**(也不占 name() 的不重名名额):调用方自己挑没被占的,
   * 撞名时按一个和处理顺序无关的规则取下一个(比如按锚点地块编号小的先占)。
   * 取了几十个还挑不中(极少见)时,接着给加方位前缀 / 序号的兜底名,一直取总能挑到。
   * 字库是 Namer 里现成的,每个键只多一个随机数发生器,很便宜
   */
  keyed(kind: NameKind, ...key: number[]): () => GeneratedName;
}

export const NAME_STYLES: NameStyle[] = [
  ...WESTERN_STYLES.map((s) => ({ id: s.id, label: s.label, family: 'western' as const, desc: s.desc })),
  ...EASTERN_STYLES.map((s) => ({ id: s.id, label: s.label, family: 'eastern' as const, desc: s.desc })),
];

// 地名风格(配比):类型、清理、按份数抽在 mix.ts(不引词库,主线程也用)
export { MIX_SHARE_MAX, NAME_STYLE_META, cleanMix, pickStyle, sameMix, type NameMix, type NameStyleMeta } from './mix';

/** 用得上的语感和份数(按 NAME_STYLES 的顺序;i = 在 NAME_STYLES 里的序号);自动 = 全部各一份 */
export function mixStyles(mix: NameMix | undefined): { style: NameStyle; i: number; share: number }[] {
  const all = NAME_STYLES.map((style, i) => ({ style, i, share: mix ? (mix[style.id] ?? 0) : 1 }));
  const used = all.filter((x) => x.share > 0);
  return used.length ? used : all.map((x) => ({ ...x, share: 1 }));
}

/** 最近几个同类名字里用过的词根不再用,避免一张图上"瓦伦西亚、瓦伦堡、瓦伦河"扎堆 */
const RECENT_WINDOW = 12;
const MAX_TRIES = 80;
/** 按键取名:一个键最多给这么多个正常候选,之后给兜底名 */
const KEYED_MAX = 48;
/** 候选实在不够(同一类名字要几千个)时,加方位前缀兜底;西幻风的拉丁原形也跟着加 */
const FALLBACK_PREFIX: Array<[string, string]> = [
  ['新', 'New'], ['北', 'North'], ['南', 'South'], ['东', 'East'], ['西', 'West'], ['上', 'Upper'],
  ['下', 'Lower'], ['大', 'Great'], ['小', 'Little'], ['外', 'Outer'], ['内', 'Inner'],
];

/** 同 seed + styleId + 调用顺序 → 同样的名字 */
export function createNamer(seed: number, styleId: string): Namer {
  const style = NAME_STYLES.find((s) => s.id === styleId);
  if (!style) throw new Error(`未知的地名风格 "${styleId}",可选:${NAME_STYLES.map((s) => s.id).join(', ')}`);
  const rng = mulberry32(subSeed(seed, 'names:' + styleId));
  const west = WESTERN_STYLES.find((s) => s.id === styleId);
  const east = EASTERN_STYLES.find((s) => s.id === styleId);
  const genWith = (kind: NameKind, r: Rng): Candidate | null => (west ? westernCandidate(west, kind, r) : easternCandidate(east!, kind, r));
  const gen = (kind: NameKind): Candidate | null => genWith(kind, rng);
  const keyBase = subSeed(seed, 'names-keyed:' + styleId);

  const used = new Set<string>();
  const recent = new Map<NameKind, string[]>();

  /** 字数在范围内、不含屏蔽字(不查重) */
  const shapeOk = (c: Candidate, kind: NameKind) => {
    const len = [...c.zh].length;
    const [lo, hi] = ZH_LEN[kind];
    if (len < lo || len > hi) return false;
    if (zhBlocked(c.zh)) return false;
    if (c.latin && latinBlocked(c.latin)) return false;
    return true;
  };
  const acceptable = (c: Candidate, kind: NameKind) => !used.has(c.zh) && shapeOk(c, kind);

  return {
    style,
    keyed(kind, ...key) {
      let h = fmix((keyBase ^ Math.imul(NAME_KINDS.indexOf(kind) + 1, 0x27d4eb2f)) >>> 0);
      for (const k of key) h = fmix((h ^ Math.imul(k | 0, 0x9e3779b1)) >>> 0);
      const r = mulberry32(h);
      /** 最先给出的几个候选(兜底时拿它们加前缀 / 序号) */
      const firsts: Candidate[] = [];
      let given = 0;
      let fb = 0;
      return () => {
        while (given < KEYED_MAX) {
          let c: Candidate | null = null;
          for (let t = 0; t < MAX_TRIES && !c; t++) {
            const x = genWith(kind, r);
            if (x && shapeOk(x, kind)) c = x;
          }
          if (!c) break;
          given++;
          if (firsts.length < 3) firsts.push(c);
          return out(c);
        }
        given = KEYED_MAX;
        return out(keyedFallback(kind, firsts, fb++));
      };
    },
    name(kind) {
      const rec = recent.get(kind) ?? [];
      let best: Candidate | null = null;
      for (let t = 0; t < MAX_TRIES; t++) {
        const c = gen(kind);
        if (!c || !acceptable(c, kind)) continue;
        // 前 2/3 的尝试要求词根不撞最近用过的;实在找不到就放宽
        if (t < (MAX_TRIES * 2) / 3 && c.tokens.some((tk) => rec.includes(tk))) {
          best ??= c;
          continue;
        }
        best = c;
        break;
      }
      if (!best) best = fallback(kind);
      used.add(best.zh);
      rec.push(...best.tokens);
      while (rec.length > RECENT_WINDOW) rec.shift();
      recent.set(kind, rec);
      return out(best);
    },
  };

  /**
   * 按键取名的兜底(候选流取了 KEYED_MAX 个以后):第 i 个 = 最先几个候选轮流加方位前缀(不超字数),
   * 前缀用完再加序号("无名河二")。和 name() 的兜底同一套写法,只是不看已用过的名字(调用方自己查重)
   */
  function keyedFallback(kind: NameKind, firsts: Candidate[], i: number): Candidate {
    const hi = ZH_LEN[kind][1];
    const bases = firsts.length ? firsts : [{ zh: kind === 'river' ? '无名河' : '无名地', tokens: [] }];
    const prefixed: Candidate[] = [];
    for (const c of bases) {
      if ([...c.zh].length >= hi) continue;
      for (const [p, en] of FALLBACK_PREFIX) {
        const zh = p + c.zh;
        if (!zhBlocked(zh)) prefixed.push({ ...c, zh, latin: c.latin && `${en} ${c.latin}`, tokens: [] });
      }
    }
    if (i < prefixed.length) return prefixed[i];
    const k = i - prefixed.length;
    const base = bases[k % bases.length];
    const n = 2 + Math.floor(k / bases.length);
    return { ...base, zh: base.zh + cnNumber(n), latin: base.latin && `${base.latin} ${n}`, tokens: [] };
  }

  /** 兜底:拿能用的名字加前缀(不超字数),前缀用完再加序号,保证一定能返回且不重名 */
  function fallback(kind: NameKind): Candidate {
    const hi = ZH_LEN[kind][1];
    let base: Candidate | null = null;
    for (let t = 0; t < MAX_TRIES * 2; t++) {
      const c = gen(kind);
      if (!c || zhBlocked(c.zh) || (c.latin && latinBlocked(c.latin))) continue;
      base ??= c;
      if ([...c.zh].length >= hi) continue;
      for (const [p, en] of FALLBACK_PREFIX) {
        const zh = p + c.zh;
        if (!used.has(zh) && !zhBlocked(zh)) return { ...c, zh, latin: c.latin && `${en} ${c.latin}`, tokens: [] };
      }
    }
    base ??= { zh: kind === 'river' ? '无名河' : '无名地', tokens: [] };
    for (let n = 2; ; n++) {
      const zh = base.zh + cnNumber(n);
      if (!used.has(zh)) return { ...base, zh, latin: base.latin && `${base.latin} ${n}`, tokens: [] };
    }
  }
}

function out(c: Candidate): GeneratedName {
  const o: GeneratedName = { zh: c.zh };
  if (c.latin) o.latin = c.latin;
  if (c.generic) o.generic = c.generic;
  return o;
}

/** 32 位整数混合(murmur3 fmix32):按键取名时把几个整数揉成一个种子 */
function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** 2 → 二,15 → 十五,203 → 二百零三(兜底序号用,正常世界规模碰不到) */
function cnNumber(n: number): string {
  const d = '零一二三四五六七八九';
  if (n < 10) return d[n];
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
  const rest = n % 100;
  return cnNumber(Math.floor(n / 100)) + '百' + (rest === 0 ? '' : rest < 10 ? '零' + d[rest] : rest < 20 ? '一' + cnNumber(rest) : cnNumber(rest));
}
