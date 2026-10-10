/**
 * 文明这边起名字的唯一入口:包一层地名生成器(src/gen/names/)。地名生成器改接口时只动这个文件。
 *
 * - 每个民族分到一种"语感"(地名风格):看发源地的气候和民族类型,再加一点按实体取的随机;
 *   相邻的民族尽量不同,全世界也尽量不重复。
 * - 族名:用这种语感的国名去掉通名(王朝 / 国…),东方古风再去掉方位、"大"字前缀("东越" → "越")。
 *   界面上显示为"XX族"(display.ts 的 cultureLabel)。
 * - 州名:按占据它的民族的语感起名;没人住的州不起名(界面上显示"第 N 州")。
 *
 * - 国名词根、城名:namePolities / nameSettlements,各用一套种子。
 *   起国名时顺便记下这个国家是不是东方语感(Polity.eastern):东方国家的国号走中式写法(growth.ts)。
 *
 * **名字按位置取**(阶段 4 改地形):每个实体的名字只由"种子 + 语感 + 位置锚(地块)+ 种类"决定(Namer.keyed),
 * 和生成先后无关 —— 改地形后世界里多一个、少一个实体,别处的名字不跟着错位。位置锚:
 *   民族 = 发源州的治所地块;州 = 治所地块;国家 = 立国时国都的地块;城 = 所在地块;朝代 = 国家的锚 + 第几朝。
 *   同一个锚上有几个的(同一座城先后立了几国、故址重建的城),再按先后编"第几个"。
 * 撞名(和已经起好的名字重复)时换这个键的下一个候选,谁先占按锚点地块编号从小到大 —— 也和生成先后无关。
 * 种子来自 subSeed(seed, 'civ-names…'),其余随机数用 keyed。
 */
import { createNamer, createPersonNamer, mixStyles, NAME_STYLES, type GeneratedName, type NameMix, type Namer, type PersonNamer } from '../names';
import { Biome } from '../biomes';
import type { Culture, CultureKind, Polity, Settlement } from './types';
import { polityRootAt } from './growth';
import { keyed, subSeed } from './rand';

const B = Biome;
const DRY = [B.HotDesert, B.TemperateDesert, B.ColdDesert, B.Steppe, B.Savanna];
const COLD = [B.Taiga, B.Tundra, B.ColdDesert];
const LUSH = [B.Rainforest, B.TropicalDryForest, B.TemperateRainforest];
const TEMPERATE = [B.TemperateForest, B.TemperateRainforest, B.Steppe];

/** 各语感适合的民族:发源地年均温区间(°C)、民族类型、发源州的群落 */
const AFFINITY: Record<string, { t: [number, number]; kinds: CultureKind[]; biomes: number[] }> = {
  imperial: { t: [12, 22], kinds: ['farm', 'river', 'sea'], biomes: [B.TemperateForest, B.TropicalDryForest] },
  kingdom: { t: [5, 16], kinds: ['farm', 'river', 'forest'], biomes: TEMPERATE },
  nordic: { t: [-8, 7], kinds: ['sea', 'forest', 'highland'], biomes: COLD },
  slavic: { t: [-6, 9], kinds: ['farm', 'forest', 'river'], biomes: [B.Taiga, B.TemperateForest] },
  hellenic: { t: [14, 25], kinds: ['sea', 'lake'], biomes: [B.TemperateForest, B.TropicalDryForest, B.Savanna] },
  desert: { t: [18, 34], kinds: ['nomad', 'river'], biomes: DRY },
  steppe: { t: [-6, 16], kinds: ['nomad', 'highland'], biomes: [B.Steppe, B.ColdDesert, B.TemperateDesert] },
  elven: { t: [6, 28], kinds: ['forest', 'lake'], biomes: [...LUSH, B.TemperateForest] },
  central: { t: [8, 20], kinds: ['farm', 'river'], biomes: TEMPERATE },
  xianxia: { t: [14, 27], kinds: ['river', 'lake', 'highland'], biomes: LUSH },
  frontier: { t: [2, 18], kinds: ['nomad', 'highland'], biomes: DRY },
  mythic: { t: [10, 30], kinds: ['forest', 'highland', 'lake'], biomes: LUSH },
};
/** 打分权重:类型对口、气温合适、群落对口、随机、全世界已用过(每次)、和邻族撞了 */
const W_KIND = 1.5;
const W_TEMP = 1;
const W_BIOME = 0.8;
const W_RAND = 1;
const W_USED = 1.4;
const W_NEIGHBOR = 3;

/** 这个民族和这种语感对不对口:类型、气温、群落(不含随机) */
function affinity(id: string, kind: CultureKind, t: number, biome: number): number {
  const a = AFFINITY[id];
  if (!a) return 0;
  let s = 0;
  if (a.kinds.includes(kind)) s += W_KIND;
  const [lo, hi] = a.t;
  s += W_TEMP * (t < lo ? Math.max(-1, 1 - (lo - t) / 6) : t > hi ? Math.max(-1, 1 - (t - hi) / 6) : 1);
  if (a.biomes.includes(biome)) s += W_BIOME;
  return s;
}

/**
 * 给每个民族挑一种语感(写进 culture.style)。neighbors[c] = 和 c 接壤的民族;
 * terrain.temp[州] = 治所年均温,terrain.regions.biome[州] = 主导群落。
 * 位置锚(发源州的治所地块)决定两件事:随机的那一份按它取;谁先挑按它从小到大(相邻的民族错开、全世界少重复都看先挑的)——
 * 改地形后别处多一个、少一个民族,远处民族的语感尽量不跟着变。
 * mix = 整个世界的地名风格(names/index.ts 的 NameMix):不给 = 自动(上面的挑法);给了按份数配(assignByMix),要 owner(州 → 推演结束时的民族)
 */
export function assignStyles(
  cultures: Culture[],
  neighbors: Set<number>[],
  terrain: { temp: Float32Array; regions: { biome: Uint8Array; seat: ArrayLike<number> } },
  base: number,
  mix?: NameMix,
  owner?: ArrayLike<number>,
): void {
  if (mix && owner) return assignByMix(cultures, neighbors, terrain, base, mix, owner);
  autoStyles(cultures, neighbors, terrain, base).forEach((st, c) => (cultures[c].style = st));
}

/** 自动的挑法(见 assignStyles):返回每个民族挑到的语感,不写进 culture */
function autoStyles(
  cultures: Culture[],
  neighbors: Set<number>[],
  terrain: { temp: Float32Array; regions: { biome: Uint8Array; seat: ArrayLike<number> } },
  base: number,
): string[] {
  const out = new Array<string>(cultures.length).fill(NAME_STYLES[0].id);
  const used = new Map<string, number>();
  const seat = terrain.regions.seat;
  // 按发源州的治所地块从小到大挑(和生成先后、编号无关;改地形后别处多一个、少一个民族,这里的先后照旧)
  const order = cultures.slice().sort((a, b) => seat[a.hearth] - seat[b.hearth] || a.id - b.id);
  /** 已经挑好的民族(相邻的民族错开语感时,只看已经挑好的) */
  const done = new Set<number>();
  for (const cu of order) {
    const t = terrain.temp[cu.hearth];
    const biome = terrain.regions.biome[cu.hearth];
    let best = NAME_STYLES[0].id;
    let bestScore = -Infinity;
    NAME_STYLES.forEach((st, i) => {
      let s = affinity(st.id, cu.kind, t, biome);
      s += W_RAND * keyed(base, seat[cu.hearth], i);
      for (const o of neighbors[cu.id]) if (done.has(o) && out[o] === st.id) s -= W_NEIGHBOR;
      s -= W_USED * (used.get(st.id) ?? 0);
      if (s > bestScore) {
        bestScore = s;
        best = st.id;
      }
    });
    out[cu.id] = best;
    done.add(cu.id);
    used.set(best, (used.get(best) ?? 0) + 1);
  }
  return out;
}

/**
 * 按份数配:占比每差 1 个百分点扣多少分(各语感的差加起来;中式、音译两大类的差另算一份 —— 看地图时最先看出来的是中式占几成);
 * 配了份数的语感一个活着的民族都没分到,扣多少分
 */
const W_SHARE = 0.6;
const W_FAMILY = 1;
const W_MISSING = 4;
/** 活着的民族够分(不比配了份数的语感少)时,每种都得有活着的民族用上:差一种扣这么多(比别的加起来都大,等于硬条件) */
const W_COVER = 1000;
/** 和自动时挑的一样,加多少分:份数凑得差不多时,尽量只换必须换的民族(只把沙海调成 0 份,别的民族照旧) */
const W_KEEP = 4;
/** 挪一挪 / 换一换最多试几轮(民族十来个,通常三五轮就停) */
const MIX_ROUNDS = 60;

/**
 * 按份数配语感:只在有份的几种里挑;每种语感占的地方(推演结束时各民族住的州数)尽量接近份数的比例,
 * 同时照顾对口(和自动一样的类型、气温、群落 + 随机)、相邻的民族错开;活着的民族够分时,配了份数的语感每种都有民族用上
 * (只配一两份的也是:哪怕一个民族占的地方比份数多,也比配了却一个都没有好)。
 * 先按住的地方从大到小一个个挑,再反复试"把一个民族换成别的语感 / 两个民族对换",总分变好就换,直到换不动。
 * 份数是全世界一起凑的,改地形后远处民族的语感可能跟着变(自动时不会)。
 * 已经消亡的民族不占地方,只看对口和相邻(它们的名字出现在历史里)。
 */
function assignByMix(
  cultures: Culture[],
  neighbors: Set<number>[],
  terrain: { temp: Float32Array; regions: { biome: Uint8Array; seat: ArrayLike<number> } },
  base: number,
  mix: NameMix,
  owner: ArrayLike<number>,
): void {
  const n = cultures.length;
  if (!n) return;
  const styles = mixStyles(mix);
  const k = styles.length;
  const area = new Array<number>(n).fill(0);
  for (let r = 0; r < owner.length; r++) if (owner[r] >= 0 && owner[r] < n) area[owner[r]]++;
  const total = area.reduce((a, x) => a + x, 0);
  const shares = styles.reduce((a, x) => a + x.share, 0);
  /** 每种语感该占的州数;中式该占几个州 */
  const target = styles.map((x) => (x.share / shares) * total);
  const eastern = styles.map((x) => x.style.family === 'eastern');
  const eastTarget = target.reduce((a, x, j) => (eastern[j] ? a + x : a), 0);
  const seat = terrain.regions.seat;
  /** fit[c][j] = 民族 c 用第 j 种的对口分(含随机,随机按语感在全部语感里的序号取,和自动时一样;和自动时挑的一样再加分) */
  const auto = autoStyles(cultures, neighbors, terrain, base);
  const fit = cultures.map((cu, c) => {
    const t = terrain.temp[cu.hearth];
    const biome = terrain.regions.biome[cu.hearth];
    return styles.map((x) => affinity(x.style.id, cu.kind, t, biome) + W_RAND * keyed(base, seat[cu.hearth], x.i) + (x.style.id === auto[c] ? W_KEEP : 0));
  });
  const living = area.filter((a) => a > 0).length;
  /** 配了份数、应当有民族用上的语感有几种(活着的民族不够分时,只要求用满) */
  const want = Math.min(k, living);
  const wMissing = living >= k ? W_COVER : W_MISSING;
  const pct = total > 0 ? 100 / total : 0;
  const pick = new Array<number>(n).fill(-1);

  /** 总分(越小越好) */
  const cost = (): number => {
    const filled = new Array<number>(k).fill(0);
    const seen = new Array<boolean>(k).fill(false);
    let s = 0;
    for (let c = 0; c < n; c++) {
      const j = pick[c];
      if (j < 0) continue;
      filled[j] += area[c];
      if (area[c] > 0) seen[j] = true;
      s -= fit[c][j];
      for (const o of neighbors[c]) if (o > c && pick[o] === j) s += W_NEIGHBOR;
    }
    let east = 0;
    for (let j = 0; j < k; j++) {
      s += W_SHARE * Math.abs(filled[j] - target[j]) * pct;
      if (eastern[j]) east += filled[j];
    }
    s += W_FAMILY * 2 * Math.abs(east - eastTarget) * pct;
    s += wMissing * Math.max(0, want - seen.filter(Boolean).length);
    return s;
  };

  // 先挑:住的地方大的先挑(同样大按发源州的治所地块),每个挑当下总分最好的
  const order = cultures.map((_, c) => c).sort((a, b) => area[b] - area[a] || seat[cultures[a].hearth] - seat[cultures[b].hearth] || a - b);
  for (const c of order) {
    let best = 0;
    let bestCost = Infinity;
    for (let j = 0; j < k; j++) {
      pick[c] = j;
      const v = cost();
      if (v < bestCost - 1e-9) {
        bestCost = v;
        best = j;
      }
    }
    pick[c] = best;
  }
  // 再挪:试每个民族换成别的语感、每两个民族对换,取总分降得最多的那一步,直到降不动
  let now = cost();
  for (let round = 0; round < MIX_ROUNDS && k > 1; round++) {
    let gain = 1e-9;
    let move: [number, number, number] | null = null; // [民族, 语感] 或 [民族 a, -1, 民族 b](对换)
    for (const c of order) {
      const was = pick[c];
      for (let j = 0; j < k; j++) {
        if (j === was) continue;
        pick[c] = j;
        const d = now - cost();
        if (d > gain) {
          gain = d;
          move = [c, j, -1];
        }
      }
      pick[c] = was;
    }
    for (let x = 0; x < order.length; x++) {
      for (let y = x + 1; y < order.length; y++) {
        const a = order[x];
        const b = order[y];
        if (pick[a] === pick[b]) continue;
        [pick[a], pick[b]] = [pick[b], pick[a]];
        const d = now - cost();
        if (d > gain) {
          gain = d;
          move = [a, -1, b];
        }
        [pick[a], pick[b]] = [pick[b], pick[a]];
      }
    }
    if (!move) break;
    if (move[1] >= 0) pick[move[0]] = move[1];
    else [pick[move[0]], pick[move[2]]] = [pick[move[2]], pick[move[0]]];
    now = cost();
  }
  cultures.forEach((cu, c) => {
    cu.style = styles[pick[c]].style.id;
    cu.autoStyle = auto[c];
  });
}

/** 当国名没问题、加上"族"字就成了日常词的("丈夫国" → "丈夫族"),不拿来当族名 */
const AWKWARD = new Set(['君子', '丈夫', '淑士']);

/** 国名 → 族名词根:去掉通名;东方古风("东越""大梁")再去掉方位 / "大 / 后 / 前"前缀 */
function ethnonym(zh: string, generic: string | undefined, style: string): string {
  let s = generic && zh.endsWith(generic) && zh.length > generic.length ? zh.slice(0, zh.length - generic.length) : zh;
  if (style === 'central' && s.length === 2 && '东西南北大后前'.includes(s[0])) s = s.slice(1);
  return s;
}

// ---------------------------------------------------------------------------
// 按位置取名的公共小工具

/** 位置锚:地块编号 + 同一个地块上的第几个(按列表先后,也就是按出现先后) */
export interface Anchor {
  cell: number;
  n: number;
}

/** 给列表里每个实体算位置锚(anchor(x) = 地块;同一地块上的按列表先后编 0、1、2…) */
export function anchorsOf<T>(list: readonly T[], anchor: (x: T) => number): Anchor[] {
  const per = new Map<number, number>();
  return list.map((x) => {
    const cell = anchor(x);
    const n = per.get(cell) ?? 0;
    per.set(cell, n + 1);
    return { cell, n };
  });
}

/** 谁先挑名字:按锚点地块编号从小到大(同一地块按第几个),和生成先后无关。ids 不给 = 全部 */
export function byAnchor(at: readonly Anchor[], ids?: readonly number[]): number[] {
  const list = ids ? ids.slice() : at.map((_, i) => i);
  return list.sort((a, b) => at[a].cell - at[b].cell || at[a].n - at[b].n || a - b);
}

/** 候选流里第一个没被占的(候选流取到后面会给带序号的兜底名,总能挑到) */
function firstFree(next: () => GeneratedName, taken: ReadonlySet<string>): GeneratedName {
  let g = next();
  for (let t = 0; t < 10000 && taken.has(g.zh); t++) g = next();
  return g;
}

/** 每种语感一个 Namer(按需建,字库复用) */
function namerCache(seed: number): (style: string) => Namer {
  const namers = new Map<string, Namer>();
  return (style: string) => {
    let n = namers.get(style);
    if (!n) namers.set(style, (n = createNamer(seed, style)));
    return n;
  };
}

/** 挑得再多也没中意的就停(族名、国名:先看前几个里有没有短的,都被占了才往后找) */
const MAX_PICKS = 400;

/**
 * 起名:民族(写进 culture.name,不带"族"字)和州(返回 州 → 名字,没人住的为空串)。
 * owner[州] = 占据它的民族(推演结束时);seat[州] = 治所地块(位置锚)。
 * 民族的锚 = 发源州的治所地块,州的锚 = 治所地块;都按锚点地块编号小的先挑(见文件头)
 */
export function nameCultures(seed: number, cultures: Culture[], owner: Int16Array, seat: ArrayLike<number>): string[] {
  const namer = namerCache(subSeed(seed, 'civ-names'));
  const at = anchorsOf(cultures, (cu) => seat[cu.hearth] ?? -1);
  const taken = new Set<string>();
  for (const i of byAnchor(at)) {
    const cu = cultures[i];
    const next = namer(cu.style).keyed('state', at[i].cell, at[i].n);
    // 取前几个候选里第一个不超过 4 个字、没和别族撞名的(族名要好念);都不合适就取最短的;前几个全被占了就往后找
    let pick = '';
    for (let t = 0; t < MAX_PICKS && (t < 6 || !pick); t++) {
      const g = next();
      const e = ethnonym(g.zh, g.generic, cu.style);
      if (taken.has(e) || AWKWARD.has(e)) continue;
      if (!pick || e.length < pick.length) pick = e;
      if (e.length <= 4) {
        pick = e;
        break;
      }
    }
    cu.name = pick || `无名${cu.id + 1}`;
    taken.add(cu.name);
  }
  const names = new Array<string>(owner.length).fill('');
  const used = new Set<string>();
  const peopled: number[] = [];
  for (let r = 0; r < owner.length; r++) if (owner[r] >= 0 && owner[r] < cultures.length) peopled.push(r);
  peopled.sort((a, b) => (seat[a] ?? -1) - (seat[b] ?? -1) || a - b);
  for (const r of peopled) {
    names[r] = firstFree(namer(cultures[owner[r]].style).keyed('region', seat[r] ?? -1), used).zh;
    used.add(names[r]);
  }
  return names;
}

/** 复国的国名前缀(阶段 3 分合):东方语感 "后昌""南昌";西幻语感 "新索拉特""北索拉特"。依次挑第一个没被占的 */
const RESTORE_PREFIX_EAST = ['后', '北', '南', '东', '西', '新'];
const RESTORE_PREFIX_WEST = ['新', '北', '南', '东', '西', '后'];

/** 复国的国家在故国的哪个方向另立(新国都离故都远时):'东' | '西' | '南' | '北';就在故地 = null */
export type RestoreDirection = (p: Polity, fallen: Polity) => string | null;

/**
 * 国名词根(写进 polity.name;全称 = 词根 + 当年的国号,见 growth.ts):
 * 每个民族最早立的那个国家直接用族名("越族" → "越国");之后同族的国家按这个民族的语感另起国名、去掉通名。
 * 复国的国家(阶段 3,Polity.restores)沿用故国国名加前缀:就在故地复国 = "后昌"(西幻 "新索拉特"),
 * 远离故都另立 = 按方向 "南昌""北索拉特"(dir 给出方向;不给就一律按故地算);前缀都被占了才另起国名。
 * 故国改朝换代过的(东方),沿用的是它亡国时那一朝的国号("大昌 → 大景"亡了,复国叫"后景")。
 * 不和别的国家、别的民族撞名。
 *
 * 按位置取名(见文件头):锚 = 立国时国都的地块(+ 这块地上第几个立国)。先后:作者起好的国名(干预"立国")先占上;
 * 各民族最早立的国(不是复国的)用族名;其余不是复国的按锚点地块编号小的先挑;复国的按编号(故国总是先起好名字);
 * 最后起历朝(按锚点地块编号小的先挑,见 dynastyNamer)。
 * places:城(位置锚、西幻的王朝名借王室根据地的城名)、州名(可不给)。
 */
export function namePolities(seed: number, polities: Polity[], cultures: Culture[], places: DynastyPlaces, dir?: RestoreDirection, pinned?: ReadonlySet<string>): void {
  const namer = namerCache(subSeed(seed, 'civ-names-polity'));
  const S = places.settlements;
  const at = anchorsOf(polities, (p) => S[p.capital]?.cell ?? -1);
  // 中式国号里"昌"会升格成"大昌":"昌"和"大昌"算同一个名字,不许两个国家分别占着
  const taken = new Set<string>(cultures.map((c) => c.name));
  const takenBare = new Set<string>(cultures.map((c) => bare(c.name)));
  const claim = (x: string) => {
    taken.add(x);
    takenBare.add(bare(x));
  };
  const styleOf = (p: Polity) => cultures[p.culture]?.style || 'kingdom';
  const pending: number[] = [];
  const seen = new Set<number>();
  for (const p of polities) {
    // 东方语感的国家,国号走中式写法(growth.ts 的 easternTitles)
    p.eastern = NAME_STYLES.find((s) => s.id === cultures[p.culture]?.style)?.family === 'eastern';
    // 阶段 4 干预"立国"时作者起好了国名的,不另起
    if (p.name) claim(p.name);
  }
  for (const p of polities) {
    if (p.name || p.restores !== undefined) continue;
    const cu = cultures[p.culture];
    // 地形大事钉住的国名(pinned)里已经有族名了:那个国家就是这一族最早立的国,后来的另起国名
    if (cu && cu.name && !seen.has(cu.id) && !pinned?.has(cu.name)) {
      seen.add(cu.id);
      p.name = cu.name;
      claim(p.name);
    } else pending.push(p.id);
  }
  /** 按这个国家的键另起一个国名词根:前几个候选里第一个不超过 4 个字、没被占的;都不合适取最短的 */
  const fresh = (p: Polity): string => {
    const next = namer(styleOf(p)).keyed('state', at[p.id].cell, at[p.id].n);
    let pick = '';
    for (let t = 0; t < MAX_PICKS && (t < 8 || !pick); t++) {
      const g = next();
      const root = stripGeneric(g.zh, g.generic);
      if (taken.has(root) || AWKWARD.has(root) || (p.eastern && takenBare.has(bare(root)))) continue;
      if (!pick || root.length < pick.length) pick = root;
      if (root.length <= 4) {
        pick = root;
        break;
      }
    }
    return pick || `无名${p.id + 1}`;
  };
  for (const id of byAnchor(at, pending)) {
    polities[id].name = fresh(polities[id]);
    claim(polities[id].name);
  }
  // 历朝(不是复国的国家):按锚点地块编号小的先挑
  const dyn = dynastyNamer(seed, places, at);
  for (const id of byAnchor(at)) {
    const p = polities[id];
    if (p.restores === undefined && p.dynasties) dyn(p, styleOf(p), taken, takenBare);
  }
  // 复国:故国国名加前缀(故国编号更小,国名、历朝都已经起好;改朝换代过的用它亡国时那一朝的国号);前缀都被占了才另起。
  // 按编号依次起(复国的国家也可能再亡、再被复国),起完紧接着起它的历朝
  for (const p of polities) {
    if (p.restores === undefined) continue;
    if (!p.name) {
      const fallen = polities[p.restores];
      let pick = '';
      if (fallen && fallen.name) {
        const last = polityRootAt(fallen, fallen.ended ?? Infinity);
        // 东方:"大安"复国叫"后安"不叫"后大安"
        const root = p.eastern ? bare(last) : last;
        const way = dir?.(p, fallen) ?? null;
        const order = (p.eastern ? RESTORE_PREFIX_EAST : RESTORE_PREFIX_WEST).slice();
        if (way && order.includes(way)) order.splice(0, 0, ...order.splice(order.indexOf(way), 1));
        pick = order.map((x) => x + root).find((n) => !taken.has(n) && !AWKWARD.has(n) && !(p.eastern && takenBare.has(bare(n)))) ?? '';
      }
      p.name = pick || fresh(p);
      claim(p.name);
    }
    if (p.dynasties) dyn(p, styleOf(p), taken, takenBare);
  }
}

/** "大安" → "安"(中式国号里"安"和"大安"算同一个名字);别的原样 */
function bare(root: string): string {
  return [...root].length === 2 && root[0] === '大' ? root.slice(1) : root;
}

/** 去掉通名:"渭国" → "渭"、"九罗王朝" → "九罗" */
function stripGeneric(zh: string, generic: string | undefined): string {
  return generic && zh.endsWith(generic) && zh.length > generic.length ? zh.slice(0, zh.length - generic.length) : zh;
}

/**
 * 新朝的国号字(东方,单字为主):按民族的语感挑。中原古风取吉字和古国字("景""雍""汾"),
 * 仙侠风取它国名里的玄虚字("衍""霄""渊");都是地名生成器字库里本来就有的字(地图字体子集里有)。
 * 边塞(西域音译)和山海(神话)风没有单字国号的传统:另起一个两字的("楼勒""有熊",见 DYNASTY_TWO)
 */
const DYNASTY_CHARS: Record<string, string> = {
  central: '宁靖昭乾康安定兴隆昌景瑞雍顺嘉宣崇恒启承沂漳沁滦潍淄汝汾渭洛淮济漓湘',
  xianxia: '乾玄景衍辰霄渊岳澜羽灵武',
};
/** 山海风:一半是"有" + 鸟兽草木("有熊""有桑",上古部族称"有某氏"),一半按语感另起("玄羽""千目") */
const MYTHIC_DYNASTY = '鹿虎熊狐龙凤鹤雁鹊鸿鹰桑梧桂';
const MYTHIC_YOU = 0.5;
/**
 * 西幻城名、州名末尾的通名(借来做王朝名时去掉:"卡拉尔堡" → "卡拉尔王朝"、"赛音八里" → "赛音王朝"、
 * "科雷尔郡" → "科雷尔王朝"、"乌兰戈壁" → "乌兰王朝")
 */
const CITY_GENERICS = ['斡鲁朵', '库尔干', '布拉克', '沙赫尔', '波利斯', '浩特', '八里', '肯特', '苏木', '巴扎', '格勒', '港', '堡'];
const REGION_GENERICS = ['戈壁', '塔拉', '乌拉', '塔格', '峡湾', '郡'];

/** 西幻城名 / 州名 → 王朝名:去掉末尾的通名(剩下不到两个字就不去) */
export function houseName(place: string, region = false): string {
  for (const g of region ? REGION_GENERICS : CITY_GENERICS) {
    if (place.endsWith(g) && [...place].length - [...g].length >= 2) return place.slice(0, place.length - g.length);
  }
  return place;
}

/** 起王朝名要用的地名:城(王室根据地 seat 是城的编号)、州名(可不给) */
export interface DynastyPlaces {
  settlements: readonly Settlement[];
  regionNames?: readonly string[];
}

/**
 * 给一个国家的历朝起名(Polity.dynasties 的 name;起完它自己的国名以后调用):
 * - 东方:第一朝 = 国名词根;之后每一朝另起国号 —— 单字为主(DYNASTY_CHARS),边塞 / 山海风两个字;
 *   不和本国以前的国号、不和任何别的国家 / 民族 / 别国的历朝撞名(taken / takenBare 全世界共用,起完就占上)
 * - 西幻:王朝名借王室根据地(seat)的城名、去掉通名;同一国里不重名(同一座城又出了一朝,借它所在的州名;
 *   还撞就按语感另起一个城名式的名字)
 * 随机数、另起的名字按"国家的位置锚 + 第几朝"取(keyed / Namer.keyed),和别的国家起名先后无关
 */
function dynastyNamer(seed: number, { settlements, regionNames }: DynastyPlaces, at: readonly Anchor[]) {
  const base = subSeed(seed, 'civ-names-dynasty');
  const namer = namerCache(base);
  const free = (x: string, taken: Set<string>, takenBare: Set<string>) =>
    !!x && !taken.has(x) && !takenBare.has(bare(x)) && !AWKWARD.has(x);
  return (p: Polity, style: string, taken: Set<string>, takenBare: Set<string>) => {
    const ds = p.dynasties!;
    const { cell, n } = at[p.id];
    /** 这个国家第 i 朝的 keyed 随机数(同一地块立的第几国占高位,和 i 错开) */
    const rand = (i: number, use: number) => keyed(base, cell, n * 4096 + i, use);
    if (!p.eastern) {
      const used = new Set<string>([p.name]);
      ds.forEach((d, i) => {
        const s = settlements[d.seat];
        let name = houseName(s?.name ?? '');
        if ((!name || used.has(name)) && s && regionNames?.[s.region]) name = houseName(regionNames[s.region], true);
        if (!name || used.has(name)) {
          const next = namer(style).keyed('city', cell, n, i);
          for (let t = 0; t < 6 && (!name || used.has(name)); t++) name = houseName(next().zh);
        }
        d.name = name || `第${i + 1}`;
        used.add(d.name);
      });
      return;
    }
    ds[0].name = p.name;
    const pool = DYNASTY_CHARS[style];
    for (let i = 1; i < ds.length; i++) {
      let name = '';
      if (pool) {
        // 从随机的一处起,依次找第一个没被占的字
        const cs = [...pool];
        const k0 = Math.floor(rand(i, 1) * cs.length);
        for (let j = 0; j < cs.length && !name; j++) {
          const c = cs[(k0 + j) % cs.length];
          if (free(c, taken, takenBare)) name = c;
        }
      } else if (style === 'mythic' && rand(i, 3) < MYTHIC_YOU) {
        const cs = [...MYTHIC_DYNASTY];
        const k0 = Math.floor(rand(i, 2) * cs.length);
        for (let j = 0; j < cs.length && !name; j++) {
          const c = `有${cs[(k0 + j) % cs.length]}`;
          if (free(c, taken, takenBare)) name = c;
        }
      }
      // 字用完了 / 别的语感:按语感起一个国名,去掉通名(两个字的优先)
      if (!name) {
        const next = namer(style).keyed('state', cell, n, i);
        for (let t = 0; t < 12 && !name; t++) {
          const g = next();
          const root = stripGeneric(g.zh, g.generic);
          if (free(root, taken, takenBare) && [...root].length <= 3) name = root;
        }
      }
      ds[i].name = name || `${p.name}${i + 1}`;
      taken.add(ds[i].name);
      takenBare.add(bare(ds[i].name));
    }
  };
}

/**
 * 城名(写进 settlement.name):按城所在民族的语感起名,全世界不重名。
 * 按位置取名(见文件头):锚 = 城所在的地块(+ 这块地上第几座);按锚点地块编号小的先挑。
 * 阶段 3 城市兴衰:在被毁的城故址上重建的城(Settlement.rebuilds)放在最后起 —— 同族重建沿用旧名
 * (和旧城同名,是故城重建),换了民族另起新名;原有的城名不因为有没有重建而变
 */
export function nameSettlements(seed: number, settlements: Settlement[], cultures: Culture[], pinned?: ReadonlyMap<number, string>): void {
  const namer = namerCache(subSeed(seed, 'civ-names-city'));
  const at = anchorsOf(settlements, (s) => s.cell);
  // 地形大事:钉住的城名(见 types.ts 的 NamePins)先占上
  const taken = new Set<string>(pinned?.values() ?? []);
  const fresh = (s: Settlement) => {
    s.name = firstFree(namer(cultures[s.culture]?.style || 'kingdom').keyed('city', at[s.id].cell, at[s.id].n), taken).zh;
    taken.add(s.name);
  };
  if (pinned) for (const [id, x] of pinned) if (settlements[id]) settlements[id].name = x;
  const originals = settlements.filter((s) => s.rebuilds === undefined && !pinned?.has(s.id)).map((s) => s.id);
  for (const id of byAnchor(at, originals)) fresh(settlements[id]);
  for (const s of settlements) {
    if (s.rebuilds === undefined || pinned?.has(s.id)) continue;
    const old = settlements[s.rebuilds];
    if (old && old.culture === s.culture && old.name) s.name = old.name;
    else fresh(s);
  }
}

/**
 * 人名(people.ts 起君主、统帅的名字用):每种语感一个人名生成器(按需建)。
 * 东方中式 = 姓 + 名,边塞、山海、西幻 = 名;按键取,同一个键永远是同一个名字(见 src/gen/names/persons.ts)
 */
export function personNamers(seed: number): (style: string) => PersonNamer {
  const base = subSeed(seed, 'civ-names-person');
  const namers = new Map<string, PersonNamer>();
  return (style: string) => {
    let n = namers.get(style);
    if (!n) namers.set(style, (n = createPersonNamer(base, style)));
    return n;
  };
}

/** 语感的中文名(如"北境(北欧风)") */
export function styleLabel(style: string): string {
  return NAME_STYLES.find((s) => s.id === style)?.label ?? style;
}
