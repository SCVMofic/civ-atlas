/**
 * 民族:发源地、七种类型、"从州 A 走到相邻的州 B 要几年",以及挂到推演引擎上的事件。
 *
 * 流程(index.ts 调用):
 *   planCultures   定数量 → 挑发源地(每个民族有自己的偏好,彼此在州图上隔开)→ 定类型、扩张性、诞生年份
 *                  → 按世界标定"走一步要几年"(默认到第 3000 年,约 90% 的可居州有人住)
 *   installCultures 挂到 CivSim 上:民族诞生、民族到达;州归属变了就预约邻州的到达
 *   (sim.run)
 *   finishCultures  按最终的疆域给民族配色、分语感、起族名和州名
 *
 * 走几年 = 标定的年数 × 路程 × 地形系数(B) × 过界系数(A→B) × 类型修正 × 随机抖动 ÷ 扩张性
 *   - 路程:两治所间的路程(regions.adjLen)÷ 一个标准值
 *   - 地形系数:群落通行代价(habitat.ts 的 BIOME_COST)换算;和发源州同一群落打折;
 *     地越贫瘠拓荒越慢(游牧民族在草原荒漠不受这条限制);海拔越高越慢
 *   - 过界系数:平地 / 跨河 / 翻山 / 海峡 / 航线;航线只有海洋民族能走
 *   - 类型修正照搬 Azgaar 的方向:游牧进森林很慢、高原民族下平原很慢、海洋民族沿海快、河谷民族顺河快……
 *   - 不可居的州(治所宜居分 < 1)可以路过,但不归属任何民族
 *
 * 随机数:subSeed(seed, 'civ-culture…') + keyed(按实体取),和处理顺序无关。
 * 州、民族一律用位置锚(州 = 治所地块,民族 = 发源州的治所地块;见 rand.ts),不用编号:
 * 改地形后多几个州、州号全都错开,远处的发源地、类型、扩张快慢照旧。纯计算,不碰 DOM。
 */
import { Biome } from '../biomes';
import type { World } from '../world';
import { MinHeap } from '../util';
import { AdjKind, Layer, type Checkpoint, type Civ, type CivParams, type Culture, type CultureKind, type Habitat, type NamePins, type Regions } from './types';
import { BIOME_COST, MAJOR_RIVER } from './habitat';
import { fpow, keyed, subSeed } from './rand';
import { refCellArea, refSpacing } from './geo';
import { quantize, Ev, type CivSim } from './sim';
import { assignStyles, nameCultures } from './naming';
import type { NameMix } from '../names';
import { KIND_INFO } from './display';

// ---- 调参(以截图效果为准) ----
/** 治所宜居分 ≥ 这个值的州才算可居(和"城址"显示的门槛一致) */
export const HABITABLE_SUIT = 1;
/** 标定:到这一年,可居州里有 TARGET_OCCUPIED 被占(和 endYear 无关;endYear 只决定推到哪一年) */
export const REF_YEAR = 3000;
export const TARGET_OCCUPIED = 0.9;
/** 诞生年份跨度:第一个民族在第 0 年,其余在这么多年里陆续出现 */
export const BIRTH_SPAN = 400;
/** 晚出现的民族,诞生年份不晚于"别族最早能走到它发源地的年份"的这个倍数(免得刚出生就被挤得只剩一两个州) */
const BIRTH_HEADSTART = 0.5;
/** 自动数量:每多少个可居州一个民族,夹在 [MIN, MAX] */
const REGIONS_PER_CULTURE = 70;
const MIN_CULTURES = 4;
const MAX_CULTURES = 16;
/** 发源地间距(州图跳数)= 这个系数 × √(可居州数 / 民族数);放不下时每轮 × 0.85 */
const HEARTH_SPACING = 0.85;
/** 发源地只在按偏好排序的前这么多里挑 */
const HEARTH_POOL = 0.4;
/** 间距放宽到不足原定的这个比例时,不再加民族(至少保留 MIN_CULTURES 个) */
const MIN_SPACING = 0.6;
/** 路程的标准值 = 这么多个地块间距(默认精细度下两治所间路程的中位数约 4.5 个) */
const REF_STEPS = 4.5;
/** 贫瘠系数 = √((SUIT_REF + 1) / (平均宜居分 + 1)),夹在 [HAB_MIN, HAB_MAX] */
const SUIT_REF = 12;
const HAB_MIN = 0.6;
const HAB_MAX = 6;
const HAB_EXP = 1;
/** 群落系数 = (通行代价 / 70) ^ BIOME_EXP;本土群落再 × NATIVE */
const BIOME_EXP = 0.9;
const NATIVE = 0.6;
/** 过界系数(按 AdjKind 下标:平地、跨河、翻山、海峡、航线) */
const CROSS = [1, 1.25, 2.2, 2.5, 3];
/** 岛:所在陆块不超过这么多个州 */
const ISLAND_REGIONS = 6;
/** 大湖:至少这么多个地块 */
const BIG_LAKE = 5;

/** 群落系数表(按 Biome 下标) */
const BIOME_F = BIOME_COST.map((c) => fpow(c / 70, BIOME_EXP));

/** 群落集合 → 按 Biome 下标查的表(推演里查得很频繁) */
const biomeSet = (list: number[]) => {
  const t = new Uint8Array(16);
  for (const b of list) t[b] = 1;
  return t;
};
const STEPPE_DESERT = biomeSet([Biome.Steppe, Biome.ColdDesert, Biome.TemperateDesert, Biome.HotDesert]);
const FOREST = biomeSet([Biome.TemperateForest, Biome.TemperateRainforest, Biome.Rainforest, Biome.TropicalDryForest, Biome.Taiga]);
/** 山林民族的家:密林、苔原、湿地(Azgaar 的 Hunting) */
const WILDS = biomeSet([Biome.Taiga, Biome.Rainforest, Biome.TemperateRainforest, Biome.Tundra, Biome.Wetland]);

/** 七种民族类型的中文名、扩张性基数(定义在 display.ts,界面也用) */
export { KIND_INFO };

// ---------------------------------------------------------------------------
// 州级地形特征(由 World + Regions 现算,不存进 Civ)

export interface CultureTerrain {
  R: number;
  regions: Regions;
  /** 治所宜居分 ≥ HABITABLE_SUIT */
  habitable: Uint8Array;
  /** 有临海(开阔海或冰海)的陆地块 */
  coastal: Uint8Array;
  /** 治所是天然良港(只挨着一块海) */
  harborSeat: Uint8Array;
  /** 所在陆块很小(≤ ISLAND_REGIONS 个州) */
  island: Uint8Array;
  /** 有地块紧挨大湖 */
  lake: Uint8Array;
  /** 有大河流过 */
  river: Uint8Array;
  /** 治所离海岸 > 3 块 */
  inland: Uint8Array;
  /** 治所紧挨大湖 */
  lakeSeat: Uint8Array;
  /** 治所在大河上或紧挨大河 */
  riverSeat: Uint8Array;
  /** 平均宜居分(人口上限 ÷ 按默认地块面积折算的块数) */
  meanSuit: Float32Array;
  /** 治所的宜居分 */
  seatSuit: Float32Array;
  /** 治所的年均温 */
  temp: Float32Array;
  /** 贫瘠系数:地越贫瘠,拓荒越慢 */
  poverty: Float32Array;
  /** 路程的标准值(世界单位) */
  refLen: number;
}

export function cultureTerrain(world: World, habitat: Habitat, regions: Regions): CultureTerrain {
  const { mesh, water, flux, riverThreshold, temperature } = world;
  const { n, adjStart, adj } = mesh;
  const R = regions.count;
  const habitable = new Uint8Array(R);
  const coastal = new Uint8Array(R);
  const harborSeat = new Uint8Array(R);
  const island = new Uint8Array(R);
  const lake = new Uint8Array(R);
  const river = new Uint8Array(R);
  const inland = new Uint8Array(R);
  const lakeSeat = new Uint8Array(R);
  const riverSeat = new Uint8Array(R);
  const meanSuit = new Float32Array(R);
  const seatSuit = new Float32Array(R);
  const temp = new Float32Array(R);
  const poverty = new Float32Array(R);

  // 湖的大小(连通的湖面地块数)
  const lakeSize = new Int32Array(n);
  {
    const q: number[] = [];
    const seen = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (water[s] !== 2 || seen[s]) continue;
      q.length = 0;
      q.push(s);
      seen[s] = 1;
      for (let h = 0; h < q.length; h++) {
        const i = q[h];
        for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
          const j = adj[k];
          if (water[j] === 2 && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
      for (const i of q) lakeSize[i] = q.length;
    }
  }
  const lmRegions = new Map<number, number>();
  for (let r = 0; r < R; r++) lmRegions.set(regions.landmass[r], (lmRegions.get(regions.landmass[r]) ?? 0) + 1);
  const major = MAJOR_RIVER * riverThreshold;
  const refArea = refCellArea(mesh);
  for (let r = 0; r < R; r++) {
    const seat = regions.seat[r];
    seatSuit[r] = habitat.suitability[seat];
    habitable[r] = seatSuit[r] >= HABITABLE_SUIT ? 1 : 0;
    harborSeat[r] = habitat.harbor[seat] === 1 ? 1 : 0;
    inland[r] = habitat.coastDist[seat] > 3 ? 1 : 0;
    island[r] = (lmRegions.get(regions.landmass[r]) ?? 0) <= ISLAND_REGIONS ? 1 : 0;
    temp[r] = temperature[seat];
    if (flux[seat] >= major) riverSeat[r] = 1;
    for (let k = adjStart[seat]; k < adjStart[seat + 1]; k++) {
      const j = adj[k];
      if (lakeSize[j] >= BIG_LAKE) lakeSeat[r] = 1;
      if (water[j] === 0 && flux[j] >= major) riverSeat[r] = 1;
    }
    meanSuit[r] = regions.area[r] > 0 ? regions.capacity[r] / (regions.area[r] / refArea) : 0;
    poverty[r] = Math.min(HAB_MAX, Math.max(HAB_MIN, fpow((SUIT_REF + 1) / (meanSuit[r] + 1), HAB_EXP)));
    for (let t = regions.cellStart[r]; t < regions.cellStart[r + 1]; t++) {
      const i = regions.cells[t];
      if (flux[i] >= major) river[r] = 1;
      if (habitat.harbor[i] > 0) coastal[r] = 1;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        if (lakeSize[adj[k]] >= BIG_LAKE) lake[r] = 1;
      }
    }
  }
  return {
    R,
    regions,
    habitable,
    coastal,
    harborSeat,
    island,
    lake,
    river,
    inland,
    lakeSeat,
    riverSeat,
    meanSuit,
    seatSuit,
    temp,
    poverty,
    refLen: REF_STEPS * refSpacing(mesh),
  };
}

// ---------------------------------------------------------------------------
// 民族模型:推演要用的全部东西(可以由 Civ 重建,见 resumeCultures)

export interface CultureModel {
  terrain: CultureTerrain;
  cultures: Culture[];
  /** 走一个"标准路程"(平地、普通地形、扩张性 1)要多少年:按世界标定 */
  spreadYears: number;
  /** 邻接边数(regions.adj.length) */
  M: number;
  /** 每个民族走每条邻接边的代价(无量纲;× spreadYears = 年):cost[民族 × M + 边];Infinity = 走不了 */
  cost: Float32Array;
  /** 民族 c 路过不可居的州 r 时记一笔:passed[c × R + r] */
  passed: Uint8Array;
}

/** 民族 cu 经邻接边 k 走到州 b 的代价(无量纲)。home = 民族的本土群落;jitter = 这个民族在州 b 的随机抖动 */
function edgeCost(T: CultureTerrain, cu: Culture, home: number, b: number, k: number, jitter: number): number {
  const reg = T.regions;
  const adjKind = reg.adjKind[k];
  const kind = cu.kind;
  if (adjKind === AdjKind.SeaRoute && kind !== 'sea') return Infinity;
  const bi = reg.biome[b];
  let biomeF = BIOME_F[bi];
  if (bi === home) biomeF *= NATIVE;
  let habF = T.poverty[b];
  const e = reg.elevation[b];
  let elevF = 1 + Math.max(0, e - 600) / 1500;
  let cross = CROSS[adjKind];
  let mod = 1;
  switch (kind) {
    case 'nomad':
      if (STEPPE_DESERT[bi] || bi === Biome.Savanna) {
        mod = bi === Biome.Savanna ? 1 : 0.8;
        habF = 1; // 草原荒漠对游牧民族不算贫瘠
      } else if (FOREST[bi]) mod = 4;
      if (adjKind === AdjKind.Strait) cross *= 4;
      break;
    case 'highland':
      elevF = e < 300 ? 3 : e < 1000 ? 1.5 : 0.7;
      if (adjKind === AdjKind.Mountain) cross = 1.1;
      break;
    case 'lake':
      if (T.lake[b]) mod = 0.5;
      break;
    case 'sea':
      if (T.coastal[b]) mod = 0.6;
      else if (T.inland[b]) mod = 2.2;
      if (adjKind === AdjKind.Strait) cross = 1.2;
      else if (adjKind === AdjKind.SeaRoute) cross = 1.6;
      break;
    case 'river':
      mod = T.river[b] ? 0.5 : 1.6;
      if (adjKind === AdjKind.River) cross = 0.9;
      break;
    case 'forest':
      mod = FOREST[bi] || WILDS[bi] ? 0.6 : 2;
      break;
    default:
      break;
  }
  const dist = reg.adjLen[k] / T.refLen;
  return (dist * biomeF * habF * elevF * cross * mod * jitter) / cu.expansionism;
}

/** 算出所有民族走所有邻接边的代价表 */
function costTable(T: CultureTerrain, cultures: Culture[], seed: number): Float32Array {
  const reg = T.regions;
  const M = reg.adj.length;
  const jb = subSeed(seed, 'civ-culture-travel');
  const cost = new Float32Array(cultures.length * M);
  const jitter = new Float64Array(T.R);
  for (const cu of cultures) {
    const home = reg.biome[cu.hearth];
    const base = cu.id * M;
    // 随机抖动按"哪个民族(发源州治所)、进哪个州(治所)"取:0.8–1.2
    const tag = reg.seat[cu.hearth];
    for (let b = 0; b < T.R; b++) jitter[b] = 0.8 + 0.4 * keyed(jb, tag, reg.seat[b]);
    for (let a = 0; a < T.R; a++) {
      for (let k = reg.adjStart[a]; k < reg.adjStart[a + 1]; k++) {
        const b = reg.adj[k];
        cost[base + k] = edgeCost(T, cu, home, b, k, jitter[b]);
      }
    }
  }
  return cost;
}

/** 民族 c 从州 a 经邻接边 k(k 在 a 的邻接范围里)走到邻州要几年;Infinity = 走不了。测试和引擎共用 */
export function travelYears(m: CultureModel, c: number, k: number): number {
  return m.cost[c * m.M + k] * m.spreadYears;
}

// ---------------------------------------------------------------------------
// 定民族

type Archetype = 'fertile' | 'river' | 'coast' | 'steppe' | 'forest' | 'highland' | 'lake';
/** 第 i 个民族的偏好(Azgaar 每个预设文化都带一个偏好函数;我们轮着用七种,保证类型多样) */
const SLOTS: Archetype[] = [
  'fertile', 'river', 'coast', 'steppe', 'forest', 'highland', 'fertile', 'coast',
  'river', 'lake', 'steppe', 'fertile', 'forest', 'coast', 'highland', 'river',
];

function archetypeMatch(T: CultureTerrain, a: Archetype, r: number): number {
  const reg = T.regions;
  const b = reg.biome[r];
  switch (a) {
    case 'fertile':
      return 1;
    case 'river':
      return T.riverSeat[r] ? 1 : T.river[r] ? 0.4 : 0.1;
    case 'coast':
      return T.coastal[r] ? (T.harborSeat[r] ? 1 : 0.6) : 0.05;
    case 'steppe':
      return STEPPE_DESERT[b] ? 1 : b === Biome.Savanna ? 0.3 : 0.04;
    case 'forest':
      return WILDS[b] && T.inland[r] ? 1 : WILDS[b] ? 0.5 : 0.08;
    case 'highland':
      return reg.elevation[r] > 1300 ? 1 : reg.elevation[r] > 900 ? 0.4 : 0.03;
    case 'lake':
      return T.lakeSeat[r] ? 1 : T.lake[r] ? 0.3 : 0.05;
  }
}

/** 州图上的"跳数"距离:陆上 1、海峡 2、航线 5。从 src 出发,把更近的写进 dist */
function hopDistances(reg: Regions, src: number, dist: Float64Array) {
  const heap = new MinHeap(64);
  const best = new Float64Array(reg.count).fill(Infinity);
  best[src] = 0;
  heap.push(src, 0);
  while (heap.size) {
    const r = heap.pop();
    const d = heap.lastPri;
    if (d > best[r]) continue;
    // 已有发源地离这里更近(或一样近):从这里往外也不会更近,不用再走
    if (d >= dist[r] && d > 0) continue;
    dist[r] = d;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const kind = reg.adjKind[k];
      const nd = d + (kind === AdjKind.SeaRoute ? 5 : kind === AdjKind.Strait ? 2 : 1);
      const j = reg.adj[k];
      if (nd < best[j]) {
        best[j] = nd;
        heap.push(j, nd);
      }
    }
  }
}

function kindOf(T: CultureTerrain, r: number, arch: Archetype, base: number): CultureKind {
  const reg = T.regions;
  const b = reg.biome[r];
  const e = reg.elevation[r];
  if (STEPPE_DESERT[b] && e < 1500) return 'nomad';
  if (e > 1300) return 'highland';
  if (T.lakeSeat[r]) return 'lake';
  if (T.coastal[r]) {
    let p = T.harborSeat[r] ? 0.35 : T.island[r] ? 0.4 : 0.08;
    if (arch === 'coast') p = Math.min(1, p * 1.5 + 0.2);
    if (keyed(base, reg.seat[r], 5) < p) return 'sea';
  }
  if (T.riverSeat[r]) return 'river';
  if (WILDS[b] && T.inland[r]) return 'forest';
  return 'farm';
}

export interface CulturePlanParams {
  cultures: CivParams['cultures'];
  pace: number;
  birthSpan: number;
  /** 扩张节拍(走一个标准路程要几年,不含 pace):给了就用它,不按这个世界标定(改过地形的世界用原来星球的节拍,见 index.ts 的 planetTempo) */
  tempo?: number;
}

/** 定民族:数量、发源地、类型、扩张性、诞生年份,并标定"走一步要几年"(给了 tempo 就用它)。可居州一个都没有时返回 null */
export function planCultures(world: World, habitat: Habitat, regions: Regions, p: CulturePlanParams): CultureModel | null {
  const seed = world.params.seed;
  const base = subSeed(seed, 'civ-culture');
  const T = cultureTerrain(world, habitat, regions);
  const R = T.R;
  const cand: number[] = [];
  for (let r = 0; r < R; r++) if (T.habitable[r]) cand.push(r);
  const H = cand.length;
  if (!H) return null;

  // ---- 数量 ----
  let count =
    p.cultures === 'auto'
      ? Math.round(H / REGIONS_PER_CULTURE + (keyed(base, 1) - 0.5) * 2)
      : Math.round(p.cultures);
  if (p.cultures === 'auto') count = Math.min(MAX_CULTURES, Math.max(MIN_CULTURES, count));
  count = Math.max(1, Math.min(count, Math.floor(H / 6) || 1, SLOTS.length * 4));

  // ---- 发源地:按偏好排序,在前 40% 里挑第一个离已有发源地够远的;
  //      偏好的地方都太挤,就按"最宜居"再挑;再不行在全部可居州里挑;还不行才放宽间距。
  //      间距要放得太窄(挤在一起的民族刚出生就没地方长),就少几个民族 ----
  const hop = new Float64Array(R).fill(Infinity);
  const picks: { hearth: number; arch: Archetype }[] = [];
  const spacing = Math.max(2, HEARTH_SPACING * Math.sqrt(H / count));
  let minHops = spacing;
  const pool = Math.max(1, Math.ceil(H * HEARTH_POOL));
  // 陆块上的可居州数:小岛上的发源地长不大(海洋民族除外),打折
  const lmHab = new Map<number, number>();
  for (const r of cand) lmHab.set(regions.landmass[r], (lmHab.get(regions.landmass[r]) ?? 0) + 1);
  const room = (arch: Archetype, r: number) => Math.min(1, (lmHab.get(regions.landmass[r]) ?? 0) / (arch === 'coast' ? 3 : 12)) ** 2;
  // 每种偏好一张排好序的候选表(同一种偏好的几个民族共用,靠间距错开)
  const orders = new Map<Archetype, number[]>();
  const ranked = (arch: Archetype) => {
    let list = orders.get(arch);
    if (!list) {
      const ai = SLOTS.indexOf(arch);
      const score = new Float64Array(R);
      for (const r of cand) {
        score[r] =
          Math.sqrt(T.seatSuit[r] * Math.max(0.1, T.meanSuit[r])) *
          archetypeMatch(T, arch, r) *
          room(arch, r) *
          (0.75 + 0.5 * keyed(base, ai, regions.seat[r], 11));
      }
      list = cand.slice().sort((x, y) => score[y] - score[x] || regions.seat[x] - regions.seat[y]);
      orders.set(arch, list);
    }
    return list;
  };
  const firstFree = (list: number[], top: number) => {
    for (let i = 0; i < top; i++) if (hop[list[i]] >= minHops) return list[i];
    return -1;
  };
  for (let slot = 0; slot < count; slot++) {
    const arch = SLOTS[slot % SLOTS.length];
    let pick = -1;
    for (let tries = 0; pick < 0 && tries < 40; tries++) {
      pick = firstFree(ranked(arch), pool);
      if (pick < 0) pick = firstFree(ranked('fertile'), pool);
      if (pick < 0) pick = firstFree(ranked('fertile'), H);
      if (pick < 0) minHops *= 0.85;
    }
    if (pick < 0 || (slot >= MIN_CULTURES && minHops < MIN_SPACING * spacing)) break;
    picks.push({ hearth: pick, arch });
    hopDistances(regions, pick, hop);
  }

  // ---- 类型、扩张性;诞生年份决定编号(0 号最早)。都按发源州的治所地块取 ----
  const births = picks.map((x) => keyed(base, regions.seat[x.hearth], 3));
  const order = picks.map((_, i) => i).sort((x, y) => births[x] - births[y] || x - y);
  const cultures: Culture[] = order.map((slot, id) => {
    const { hearth, arch } = picks[slot];
    const kind = kindOf(T, hearth, arch, base);
    return {
      id,
      name: '',
      style: '',
      kind,
      hearth,
      born: id === 0 ? 0 : Math.round(births[slot] * p.birthSpan),
      expansionism: KIND_INFO[kind].expansionism * (1 + 0.5 * keyed(base, regions.seat[hearth], 7)),
      color: [128, 128, 128],
    };
  });

  const M = regions.adj.length;
  const model: CultureModel = {
    terrain: T,
    cultures,
    spreadYears: 1,
    M,
    cost: costTable(T, cultures, seed),
    passed: new Uint8Array(cultures.length * R),
  };
  model.spreadYears = (p.tempo ?? calibrate(model)) / Math.max(1e-3, p.pace);
  fixBirths(model);
  return model;
}

/**
 * 一次多源洇染(不经过事件引擎):各民族按诞生年份出发,先到先得,不可居的州只路过。
 * 返回各可居州的到达年份(没人到 = Infinity)。标定"走一步要几年"用。
 */
function floodArrivals(m: CultureModel, spreadYears: number): Float64Array {
  const T = m.terrain;
  const reg = T.regions;
  const R = T.R;
  const arrival = new Float64Array(R).fill(Infinity);
  const passed = new Uint8Array(m.cultures.length * R);
  const heap = new MinHeap(1024);
  const eR: number[] = [];
  const eC: number[] = [];
  const push = (t: number, r: number, c: number) => {
    eR.push(r);
    eC.push(c);
    heap.push(eR.length - 1, t);
  };
  for (const cu of m.cultures) push(cu.born, cu.hearth, cu.id);
  while (heap.size) {
    const e = heap.pop();
    const t = heap.lastPri;
    const r = eR[e];
    const c = eC[e];
    if (T.habitable[r]) {
      if (arrival[r] < Infinity) continue;
      arrival[r] = t;
    } else {
      if (passed[c * R + r]) continue;
      passed[c * R + r] = 1;
    }
    const base = c * m.M;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const j = reg.adj[k];
      if (T.habitable[j] ? arrival[j] < Infinity : passed[c * R + j]) continue;
      const dt = m.cost[base + k] * spreadYears;
      if (dt < Infinity) push(t + dt, j, c);
    }
  }
  return arrival;
}

/** 标定"走一个标准路程要几年":让到第 REF_YEAR 年时可居州约 TARGET_OCCUPIED 被占(诞生年份不缩放,迭代几次) */
function calibrate(m: CultureModel): number {
  const T = m.terrain;
  let H = 0;
  for (let r = 0; r < T.R; r++) H += T.habitable[r];
  const need = Math.max(1, Math.ceil(TARGET_OCCUPIED * H));
  let s = 100;
  for (let it = 0; it < 5; it++) {
    const arr = floodArrivals(m, s);
    const times: number[] = [];
    for (let r = 0; r < T.R; r++) if (T.habitable[r] && arr[r] < Infinity) times.push(arr[r]);
    if (!times.length) break;
    times.sort((a, b) => a - b);
    const t = times[Math.min(need, times.length) - 1];
    if (!(t > 0)) break;
    const next = s * (REF_YEAR / t);
    if (Math.abs(next - s) < 2e-3 * s) break;
    s = next;
  }
  return s;
}

/**
 * 保证每个民族诞生时发源州还空着,而且有一段从容发展的时间:别的民族(就算一路畅通无阻)
 * 最早什么时候能走到这里,诞生年份就不晚于它的 BIRTH_HEADSTART 倍(也至少早 1 年)。
 * 只会把诞生年份往前挪,第一个民族仍在第 0 年。
 */
function fixBirths(m: CultureModel) {
  const reg = m.terrain.regions;
  const R = reg.count;
  const C = m.cultures.length;
  if (C < 2) return;
  const solo = m.cultures.map((cu) => {
    const d = new Float64Array(R).fill(Infinity);
    const heap = new MinHeap(256);
    d[cu.hearth] = 0;
    heap.push(cu.hearth, 0);
    while (heap.size) {
      const r = heap.pop();
      const t = heap.lastPri;
      if (t > d[r]) continue;
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const nt = t + m.cost[cu.id * m.M + k] * m.spreadYears;
        const j = reg.adj[k];
        if (nt < d[j]) {
          d[j] = nt;
          heap.push(j, nt);
        }
      }
    }
    return d;
  });
  for (let changed = true, guard = 0; changed && guard < C; guard++) {
    changed = false;
    for (const cj of m.cultures) {
      let earliest = Infinity;
      for (const ci of m.cultures) if (ci !== cj) earliest = Math.min(earliest, ci.born + solo[ci.id][cj.hearth]);
      const limit = Math.max(0, Math.min(Math.floor(earliest) - 1, Math.floor(BIRTH_HEADSTART * earliest)));
      if (cj.born > limit) {
        cj.born = limit;
        changed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

const models = new WeakMap<CivSim, CultureModel>();

/**
 * 推演引擎上挂着的民族模型。同化与迁徙(assimilation.ts)要改民族表(消亡年份、迁徙),和这里用同一份:
 * generateCiv 里就是 planCultures 定的那一份;fromCiv 接着推时是 civ.cultures 的副本(不改传进来的 civ)
 */
export function cultureModelOf(sim: CivSim): CultureModel | undefined {
  return models.get(sim);
}

/** 登记民族的事件处理;births = true 时预约所有民族的诞生 */
export function installCultures(sim: CivSim, m: CultureModel, births = true): void {
  models.set(sim, m);
  const T = m.terrain;
  const reg = T.regions;
  const R = T.R;
  const own = sim.owners[Layer.Culture];
  const { habitable } = T;
  const spread = (r: number, c: number, t: number) => {
    const base = c * m.M;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const j = reg.adj[k];
      if (habitable[j] ? own[j] >= 0 : m.passed[c * R + j]) continue; // 已有人住 / 已路过
      sim.schedule(t + m.cost[base + k] * m.spreadYears, Ev.CultureArrive, j, c);
    }
  };
  // 州归属变成某个民族 → 预约邻州的到达(不管是诞生、到达,还是阶段 3 的迁徙)
  sim.onChange(Layer.Culture, (r, v) => {
    if (v >= 0) spread(r, v, sim.now);
  });
  sim.on(Ev.CultureArrive, (r, c, t) => {
    // 已经消亡的民族(阶段 3 同化与迁徙):消亡前预约的到达作废,不会死灰复燃
    if (m.cultures[c].ended !== undefined) return;
    if (!habitable[r]) {
      // 不可居的州:只路过,不归属
      if (m.passed[c * R + r]) return;
      m.passed[c * R + r] = 1;
      spread(r, c, t);
      return;
    }
    if (own[r] >= 0) return; // 先到先得
    sim.setOwner(Layer.Culture, r, c, Ev.CultureArrive);
  });
  sim.on(Ev.CultureBorn, (r, c) => {
    // fixBirths 保证了发源州此时还空着;万一被占(比如阶段 4 改过历史),这个民族就没能兴起
    if (own[r] >= 0) return;
    sim.setOwner(Layer.Culture, r, c, Ev.CultureBorn);
  });
  if (births) for (const cu of m.cultures) sim.schedule(cu.born, Ev.CultureBorn, cu.hearth, cu.id);
}

/**
 * 由 Civ 重建民族层的推演状态(CivSim.fromCiv 调用):登记事件处理,重建"路过"记录和所有待发生的到达。
 *
 * 做法:日志里每一次"某州归了某民族"(定居,以及阶段 3 的同化、迁徙改换民族)都预约过邻州的到达,
 * 从每一次出发重算一遍洇染 —— 早于 civ.endYear 的只可能是路过不可居的州(早于 endYear 到达空的可居州的,当时就定居了),
 * 照原样补上路过记录;晚于 endYear 的就是还没发生的事件,预约进引擎。还没诞生的民族重新预约诞生。
 * 州一旦有人住就不会再空出来,所以"现在还空着的州"当年也空着,当时预约的到达都还有效。
 */
export function resumeCultures(sim: CivSim, world: World, civ: Civ): void {
  const T = cultureTerrain(world, civ.habitat, civ.regions);
  const reg = T.regions;
  const R = T.R;
  // 民族表复制一份(同化与迁徙会改消亡年份、迁徙记录;不改传进来的 civ)。只复制有的字段,字段先后和原来一样
  const cultures = civ.cultures.map((c) => {
    const d = { ...c };
    if (c.migrations) d.migrations = c.migrations.map((x) => ({ ...x }));
    return d;
  });
  const m: CultureModel = {
    terrain: T,
    cultures,
    spreadYears: civ.spreadYears ?? 1,
    M: reg.adj.length,
    cost: costTable(T, cultures, civ.seed),
    passed: new Uint8Array(cultures.length * R),
  };
  // 老存档没存标定值:按同样的规则重新标定(默认扩张快慢)
  if (civ.spreadYears === undefined) m.spreadYears = calibrate(m);
  installCultures(sim, m, false);
  const now = sim.now;
  for (const cu of civ.cultures) if (cu.born > now) sim.schedule(cu.born, Ev.CultureBorn, cu.hearth, cu.id);

  const own = sim.owners[Layer.Culture];
  const log = civ.log;

  // 和引擎同样的次序:时刻(取整到 1/256 年)+ 预约先后
  const heap = new MinHeap(1024);
  const eT: number[] = [];
  const eR: number[] = [];
  const eC: number[] = [];
  let seq = 0;
  const push = (t: number, r: number, c: number) => {
    const tq = quantize(t);
    eT.push(tq);
    eR.push(r);
    eC.push(c);
    heap.push(eT.length - 1, Math.round(tq * 256) * 2 ** 28 + seq++);
  };
  const from = (r: number, c: number, t: number) => {
    const base = c * m.M;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const j = reg.adj[k];
      if (T.habitable[j] ? own[j] >= 0 : m.passed[c * R + j]) continue;
      const dt = m.cost[base + k] * m.spreadYears;
      if (dt < Infinity) push(t + dt, j, c);
    }
  };
  for (let i = 0; i < log.size; i++) if (log.layer[i] === Layer.Culture && log.value[i] >= 0) from(log.region[i], log.value[i], log.year[i]);
  while (heap.size) {
    const e = heap.pop();
    const t = eT[e];
    const r = eR[e];
    const c = eC[e];
    if (t > now || T.habitable[r]) {
      sim.schedule(t, Ev.CultureArrive, r, c);
      continue;
    }
    if (m.passed[c * R + r]) continue;
    m.passed[c * R + r] = 1;
    from(r, c, t);
  }
}

// ---------------------------------------------------------------------------
// 推演之后:配色、语感、起名

/**
 * 民族色板:色相拉开、饱和度适中(写实风淡淡罩一层,手绘风做水彩),16 种。
 * 不用绿色:写实风的森林、手绘风的林地本身就是绿的,绿色的罩染几乎看不出来。
 */
export const CULTURE_PALETTE: [number, number, number][] = [
  [196, 78, 64], // 砖红
  [62, 118, 178], // 钢蓝
  [142, 84, 164], // 紫
  [52, 150, 150], // 青
  [226, 124, 70], // 橘
  [206, 104, 150], // 玫红
  [98, 96, 186], // 靛
  [150, 62, 92], // 酒红
  [88, 164, 206], // 天蓝
  [214, 158, 52], // 赭黄(手绘风的纸本身偏黄,往后放)
  [150, 104, 64], // 赭石
  [100, 112, 140], // 石板灰蓝
  [170, 60, 150], // 品红
  [184, 128, 196], // 丁香
  [228, 150, 168], // 浅粉(和砖红拉开)
  [176, 164, 58], // 芥末
];

/** 各民族在疆域上接壤的其他民族(陆上相邻或隔海峡) */
export function cultureNeighbors(reg: Regions, owner: Int16Array, C: number): Set<number>[] {
  const out = Array.from({ length: C }, () => new Set<number>());
  for (let r = 0; r < reg.count; r++) {
    const a = owner[r];
    if (a < 0) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      if (reg.adjKind[k] === AdjKind.SeaRoute) continue;
      const b = owner[reg.adj[k]];
      if (b >= 0 && b !== a) {
        out[a].add(b);
        out[b].add(a);
      }
    }
  }
  return out;
}

function colorDist(a: readonly number[], b: readonly number[]): number {
  // 粗略的感知色差("redmean")
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/**
 * 配色:按发源州的治所地块从小到大依次挑(位置锚,和编号无关:改地形后别处多一个、少一个民族,远处民族的颜色尽量不变),
 * 和接壤的民族色差越大越好,和全世界已用的颜色也尽量拉开;用过的颜色尽量不再用(民族不超过 16 个时不会重复)。
 */
function assignColors(cultures: Culture[], nb: Set<number>[], base: number, seat: ArrayLike<number>) {
  const used = new Uint8Array(CULTURE_PALETTE.length);
  const picked: number[] = [];
  const done = new Set<number>();
  const order = cultures.slice().sort((a, b) => seat[a.hearth] - seat[b.hearth] || a.id - b.id);
  for (const cu of order) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < CULTURE_PALETTE.length; i++) {
      const col = CULTURE_PALETTE[i];
      let near = 400;
      for (const o of nb[cu.id]) if (done.has(o)) near = Math.min(near, colorDist(col, cultures[o].color));
      let all = 400;
      for (const j of picked) all = Math.min(all, colorDist(col, CULTURE_PALETTE[j]));
      const s = Math.min(near, 260) + Math.min(all, 260) - (used[i] ? 150 : 0) - 1.5 * i + 15 * keyed(base, seat[cu.hearth], i, 9);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    used[best] = 1;
    picked.push(best);
    done.add(cu.id);
    cu.color = [...CULTURE_PALETTE[best]] as [number, number, number];
  }
}

/**
 * 推演结束后:配色、分语感、起族名和州名(州名按最终疆域起,写进 regions.name)。
 * 配色、语感要和接壤的民族错开:阶段 3 有了同化与迁徙,接壤关系会变、有的民族会消亡,
 * 所以"接壤"取结束时和各检查点(每百年一份)的并集 —— 回放到哪一年,相邻的民族颜色都错得开。
 * names = 整个世界的地名风格(CivParams.names,清理过的;自动 = 不给);areas = 按份数凑占比时看的民族归属(不给 = owner;
 * 地形大事:起名照没有大事的那份历史,份数却要按真正推演结束时各民族住的地方凑)
 */
export function finishCultures(world: World, m: CultureModel, owner: Int16Array, history: readonly Checkpoint[] = [], pins?: NamePins, names?: NameMix, areas?: Int16Array): void {
  const seed = world.params.seed;
  const reg = m.terrain.regions;
  const pinned = pins?.cultures;
  if (pinned) {
    // 地形大事:民族的配色、语感照没有大事时的那份历史(见 NamePins)
    m.cultures.forEach((cu, i) => {
      cu.color = [...pinned[i].color] as [number, number, number];
      cu.style = pinned[i].style;
      if (pinned[i].autoStyle) cu.autoStyle = pinned[i].autoStyle;
    });
  } else {
    const nb = cultureNeighbors(reg, owner, m.cultures.length);
    for (const cp of history) cultureNeighbors(reg, cp.culture, m.cultures.length).forEach((set, i) => set.forEach((o) => nb[i].add(o)));
    assignColors(m.cultures, nb, subSeed(seed, 'civ-culture-color'), reg.seat);
    assignStyles(m.cultures, nb, m.terrain, subSeed(seed, 'civ-culture-style'), names, areas ?? owner);
  }
  reg.name = nameCultures(seed, m.cultures, owner, reg.seat);
  if (pinned) m.cultures.forEach((cu, i) => (cu.name = pinned[i].name));
  if (pins) pins.regionNames.forEach((x, r) => x !== undefined && r < reg.count && (reg.name![r] = x));
}
