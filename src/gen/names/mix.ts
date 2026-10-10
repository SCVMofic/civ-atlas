/**
 * 整个世界的地名风格(配比):每种语感占几份。只放 id、展示名、中式 / 音译和配比的清理、抽取,
 * 不引起名器的词库 —— 主线程(新建世界的界面、存档读写)用它,不用把词库打进主程序。
 * 起名器那边(index.ts)从这里转出去;NAME_STYLE_META 和 index.ts 的 NAME_STYLES 一一对应、顺序一致(单测核对)。
 */

export interface NameStyleMeta {
  id: string;
  /** 中文展示名,如 "北境(北欧风)" */
  label: string;
  family: 'western' | 'eastern';
}

/** 12 种语感(和 NAME_STYLES 同一个顺序:先 8 种音译,后 4 种中式) */
export const NAME_STYLE_META: readonly NameStyleMeta[] = [
  { id: 'imperial', label: '帝国(拉丁风)', family: 'western' },
  { id: 'kingdom', label: '王国(英法风)', family: 'western' },
  { id: 'nordic', label: '北境(北欧风)', family: 'western' },
  { id: 'slavic', label: '雪原(斯拉夫风)', family: 'western' },
  { id: 'hellenic', label: '群岛(希腊风)', family: 'western' },
  { id: 'desert', label: '沙海(阿拉伯风)', family: 'western' },
  { id: 'steppe', label: '草原(突厥蒙古风)', family: 'western' },
  { id: 'elven', label: '林语(精灵风)', family: 'western' },
  { id: 'central', label: '中原(古风)', family: 'eastern' },
  { id: 'xianxia', label: '江南(仙侠风)', family: 'eastern' },
  { id: 'frontier', label: '边塞(西域风)', family: 'eastern' },
  { id: 'mythic', label: '山海(神话风)', family: 'eastern' },
];

/**
 * 整个世界的地名风格怎么配:每种语感占几份(语感 id → 份数,1~MIX_SHARE_MAX 的整数;没写的 = 不用)。
 * 不给 = 自动:每个民族按发源地从全部语感里挑(相邻的民族错开、全世界少重复)。
 * 给了:各民族只在有份的几种里挑,并且让每种语感占的地方(推演结束时各民族住的州)尽量接近份数的比例
 * (gen/civ/naming.ts 的 assignStyles)。一个民族的名字只用一种语感,民族又只有十来个,所以比例是大约的。
 */
export type NameMix = Readonly<Record<string, number>>;
/** 一种语感最多几份 */
export const MIX_SHARE_MAX = 20;

/** 清理地名风格(读档、读网址时用):认不出的语感、不是正数的份数去掉,份数取整、最多 MIX_SHARE_MAX;一份都没有 = 自动(undefined) */
export function cleanMix(x: unknown): NameMix | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined;
  const src = x as Record<string, unknown>;
  const out: Record<string, number> = {};
  // 按 NAME_STYLE_META 的顺序写,同样的配比写出来的字一样
  for (const st of NAME_STYLE_META) {
    const v = src[st.id];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const n = Math.min(MIX_SHARE_MAX, Math.round(v));
    if (n >= 1) out[st.id] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 两份地名风格清理以后是不是一样(都是自动也算一样) */
export function sameMix(a: unknown, b: unknown): boolean {
  return JSON.stringify(cleanMix(a) ?? null) === JSON.stringify(cleanMix(b) ?? null);
}

/** 按份数挑一种语感(r = [0,1) 的随机数);自动 = 全部语感等可能(和加这一项以前一样:NAME_STYLES[⌊r × 12⌋]) */
export function pickStyle(mix: NameMix | undefined, r: number): string {
  if (!mix) return NAME_STYLE_META[Math.floor(r * NAME_STYLE_META.length)].id;
  let list = NAME_STYLE_META.map((s) => ({ id: s.id, share: mix[s.id] ?? 0 })).filter((x) => x.share > 0);
  if (!list.length) list = NAME_STYLE_META.map((s) => ({ id: s.id, share: 1 }));
  let left = r * list.reduce((a, x) => a + x.share, 0);
  for (const x of list) {
    if (left < x.share) return x.id;
    left -= x.share;
  }
  return list[list.length - 1].id;
}
