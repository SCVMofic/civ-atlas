/**
 * 地名风格(新建世界的「地名风格」页、创建前的确认框、世界设定里那一行)用的东西:
 * 12 种语感在界面上的顺序、颜色、例子;这颗星球上各种语感占了多少地方;「自己配」一开始的份数和快捷按钮;一句话的摘要。
 * 份数怎么变成各民族的语感见 gen/civ/naming.ts 的 assignStyles。
 */
import type { Civ } from '../gen/civ/types';
import { MIX_SHARE_MAX, NAME_STYLE_META, cleanMix, type NameMix } from '../gen/names/mix';

export interface MixStyle {
  id: string;
  /** "中原(古风)",括号用全角 */
  label: string;
  family: 'eastern' | 'western';
  /** 条上的一段、行首的圆点:中式暖色(黄、橙、粉),音译冷色(蓝、青、紫、绿) */
  color: string;
  /** 两三个例子(取自这种语感自带说明里的例子) */
  examples: string;
}

const LOOK: Record<string, [color: string, examples: string]> = {
  central: ['#E8A83E', '大靖、宁州、雁北道'],
  xianxia: ['#F2D16B', '落霞关、听雪城'],
  frontier: ['#E07B39', '镇北关、楼勒'],
  mythic: ['#D96C8A', '雷墟、桂台之野'],
  imperial: ['#4F8EF7', '阿尔多里亚'],
  kingdom: ['#8AB4FF', '卡斯特维尔'],
  nordic: ['#4DC3E0', '斯卡尔海姆'],
  slavic: ['#A9D8F0', '别洛格勒'],
  hellenic: ['#6E7BF2', '卡利波利斯'],
  desert: ['#A78BFA', '卡斯拉巴德'],
  steppe: ['#7DD3B0', '查干浩特'],
  elven: ['#3FB98A', '希尔瓦兰'],
};

/** 界面上的顺序:中式在前(条上中式在左、音译在右),各自按 NAME_STYLE_META 的顺序 */
export const MIX_STYLES: MixStyle[] = [...NAME_STYLE_META.filter((s) => s.family === 'eastern'), ...NAME_STYLE_META.filter((s) => s.family === 'western')].map((s) => ({
  id: s.id,
  label: s.label.replace('(', '（').replace(')', '）'),
  family: s.family,
  color: LOOK[s.id]?.[0] ?? '#8E8E93',
  examples: LOOK[s.id]?.[1] ?? '',
}));

export interface StyleAreas {
  /** 每种语感占的地方(0~1;没有的不写) */
  share: Record<string, number>;
  /** 推演结束时还住着地方的民族有几个 */
  peoples: number;
}

/**
 * 这颗星球上各种语感占了多少地方:按推演结束时各民族住的州数算(和生成时凑比例用的是同一个量)。
 * auto = 看自动时各民族会用哪种(自己配时生成器把它记在 Culture.autoStyle 上;自动时就是 style)。
 */
export function styleAreas(civ: Civ, auto = false): StyleAreas {
  const area = new Array<number>(civ.cultures.length).fill(0);
  for (const c of civ.culture) if (c >= 0 && c < area.length) area[c]++;
  const total = area.reduce((a, b) => a + b, 0);
  const share: Record<string, number> = {};
  if (total > 0) {
    civ.cultures.forEach((cu, i) => {
      if (!area[i]) return;
      const id = auto ? (cu.autoStyle ?? cu.style) : cu.style;
      share[id] = (share[id] ?? 0) + area[i] / total;
    });
  }
  return { share, peoples: area.filter((a) => a > 0).length };
}

/** 中式占几成(0~100 的整数;音译 = 100 减它,两个加起来正好 100) */
export function easternPct(share: Record<string, number>): number {
  const sum = MIX_STYLES.reduce((a, s) => a + (share[s.id] ?? 0), 0);
  if (sum <= 0) return 0;
  return Math.round((MIX_STYLES.reduce((a, s) => (s.family === 'eastern' ? a + (share[s.id] ?? 0) : a), 0) / sum) * 100);
}

/** 一行的百分比:有一点点也至少写 1% */
export const pctText = (v: number) => `${v > 0 ? Math.max(1, Math.round(v * 100)) : 0}%`;

const even = (pick: (s: MixStyle) => number): NameMix => Object.fromEntries(MIX_STYLES.map((s) => [s.id, pick(s)]).filter(([, n]) => (n as number) > 0));

/**
 * 「自己配」一开始的份数 = 照自动:按自动时各种语感占的地方,大约 5% 一份(有的至少 1 份,最多 MIX_SHARE_MAX)。
 * 不动份数时不算改动(还是自动,一字不差);改了才按份数起名,和自动大体一样。没有民族时每种 1 份。
 */
export function autoMix(civ: Civ | null): NameMix {
  const out: Record<string, number> = {};
  if (civ) {
    const { share } = styleAreas(civ, true);
    for (const s of MIX_STYLES) {
      const v = share[s.id] ?? 0;
      if (v > 0) out[s.id] = Math.min(MIX_SHARE_MAX, Math.max(1, Math.round((v * 100) / 5)));
    }
  }
  return Object.keys(out).length ? out : even(() => 1);
}

/** 快捷按钮(照自动另算) */
export const MIX_PRESETS: { id: string; name: string; mix: NameMix }[] = [
  { id: 'eastern', name: '全中式', mix: even((s) => (s.family === 'eastern' ? 1 : 0)) },
  { id: 'western', name: '全音译', mix: even((s) => (s.family === 'western' ? 1 : 0)) },
  // 中式 4 种、音译 8 种:中式每种 2 份,两边各 8 份
  { id: 'half', name: '中西各半', mix: even((s) => (s.family === 'eastern' ? 2 : 1)) },
];

/** 一句话:"自动"、"中式 70%、音译 30%"、"全中式"、"全音译"(按配的份数,不是实际凑出来的) */
export function mixSummary(mix: NameMix | undefined): string {
  const m = cleanMix(mix);
  if (!m) return '自动';
  const e = easternPct(m);
  if (e >= 100) return '全中式';
  if (e <= 0) return '全音译';
  return `中式 ${e}%、音译 ${100 - e}%`;
}
