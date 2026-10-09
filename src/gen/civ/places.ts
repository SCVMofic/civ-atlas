/**
 * 地理名称:找出值得标在地图上的地理实体,并起名。
 *
 *   海域   大片连通的开阔水面。每个地块算"离陆地 / 冰多远",挑一批互相隔开的最远点
 *          (各片海的"最难到达点"),按大小(绝对尺度,见 SEA)和围合程度分成 洋 / 海 / 湾
 *   山脉   高海拔地块的连通片;按海拔加权求主轴,再沿主轴分段取山脊的平均位置 → 一条顺着山脊的折线
 *   大河   world.rivers 串成干流(汇合处跟着流量大的那支走),按河口流量挑最大的若干条
 *   湖泊   连通的湖面;锚点是离湖岸最远的一点
 *   岛屿   不算大陆的陆块;锚点是离海最远的一点
 *   荒漠   连通的荒漠群落;锚点是离荒漠边缘最远的一点
 *
 * 纯计算,不碰 DOM。输出的标注路径是世界坐标(和 mesh.x / mesh.y 一样)。
 * 主轴、标注路径、射线、聚类这些 2D 几何在"局部平面"(geometry.ts 的 Chart)里算;距离、最近地块都问几何层(gen/geometry.ts)。
 *
 * 主轴、山脊线、聚类、射线在切于实体中间的局部平面(方位等距)里算,形状不走样;
 * 横排 / 竖排的标注沿过锚点的纬线 / 经线摆(主图局部平面,Geometry.mapChart),字在主图上是正的;
 * 跨 180° 经线的实体是连着的一片,标注路径也是连着的一笔(x 可以略超出 [0, 地图宽),画的时候再处理)。
 * 大洋的方位按在主图上的位置(见 Geometry.mapSide)。
 *
 * **地名语感**:还没有民族数据时,整个世界按种子挑一种语感;传入 cultures + culture(各州的民族)后,
 * 按地名所在州的民族语感起名(海洋一律用中性的叫法,culture = -1)。
 *
 * Place.rank:1 = 总览就显示;2 = 放大到约 1.8 倍显示;3 = 放大到约 3 倍显示(见 render/civ/labels.ts)。
 */
import type { World } from '../world';
import { Biome } from '../biomes';
import { MinHeap, hypot2, mulberry32, subSeed } from '../util';
import { geometryOf, type Chart, type Geometry } from '../geometry';
import { createNamer, NAME_STYLES, pickStyle, type GeneratedName, type NameMix, type Namer } from '../names';
import type { Culture, Place, Regions } from './types';
import { adjLengths, cellAreas, refCellArea, refSpacing } from './geo';
import { keyed, round24 } from './rand';

/** 按当地民族切换语感时要的数据(有民族数据时传进来;不传 = 整个世界一种语感) */
export interface PlaceNaming {
  cultures?: Culture[];
  /** 各州的民族(-1 = 无人) */
  culture?: Int16Array;
  /** 整个世界的地名风格(CivParams.names):没人住的地方也照它 */
  names?: NameMix;
}

type Kind = Place['kind'];

// ---------------------------------------------------------------------------
// 参数(面积以"默认精细度下的地块"计,长度以地块间距计,换精细度时结果大致不变)

/**
 * 海域的大小一律按绝对尺度(世界单位的"离岸半径",地图宽 2048 ≈ 4 万公里,1 单位约 20 公里)分档,
 * 不按"最开阔那片海"的比例 —— 改地形时最开阔的那片海变小了,远处的海不会跟着改叫法、改名字。
 */
const SEA = {
  /** 离陆地这么多个地块间距以内的海不算"一片海"的中心 */
  minRadius: 3.2,
  /** 两个海域中心至少隔开(较大那片的半径 × 这个数) */
  separation: 1.4,
  /** 两片海之间的窄口宽度 < 较小那片半径 × 这个数,才算两片 */
  saddle: 0.62,
  /** 补名:半径 ≥ fillR、离已有海名 ≥ 半径 × fillSeparation 的开阔水面 */
  fillR: 45,
  fillSeparation: 1.8,
  max: 14,
  /** 半径 ≥ oceanR(约 2000 公里)的叫"洋";最多 maxOceans 个,按半径排名(一样大按锚点地块编号) */
  oceanR: 100,
  maxOceans: 4,
  /** 一片够 oceanR 的都没有时,最大那片只要 ≥ oceanMin 个地块间距也叫"洋"(陆地很多的世界) */
  oceanMin: 11,
  /** 围合得紧(enclosure ≥ 0.6)、半径 < bayR 的叫"湾" */
  bayR: 27,
  /** 显示档:海 ≥ rank1R 总览就显示,≥ rank2R 放大一档;湾 ≥ bayRank2R 放大一档;补上的名字 < fillRank1R 的最多第二档 */
  rank1R: 45,
  rank2R: 27,
  bayRank2R: 30,
  fillRank1R: 75,
};
const MOUNTAIN = {
  /** 高于 max(minElev, 最高峰 × elevFrac) 的陆地算山地 */
  minElev: 950,
  elevFrac: 0.17,
  minArea: 18,
  max: 18,
  tier1: 7,
  tier1Area: 50,
  tier2Area: 28,
  /** 面积超过这么多、且横向散开(次轴 / 主轴 ≥ splitRatio)的山系拆成几段 */
  splitArea: 170,
  splitRatio: 0.33,
};
const RIVER = { minLen: 13, max: 14, tier1: 3, tier2: 5 };
/** 湖、岛:最大的一两个即使不够 tier1Area,只要够 topArea 也在总览里显示 */
const LAKE = { minArea: 3, max: 10, tier1Area: 14, tier2Area: 6, top: 1, topArea: 5 };
const ISLAND = { minArea: 9, max: 14, tier1Area: 110, tier2Area: 32, top: 2, topArea: 20, maxFracOfLargest: 0.22, maxArea: 2600 };
const DESERT = { minArea: 35, max: 6, tier1Area: 200, tier2Area: 80 };

/** 写实风的河宽(和 render/realistic.ts 画河的参数一致),标注时要让开河道 */
const RIVER_W = { minW: 0.5, maxW: 7.5, fluxRef: 1000 };

export function findPlaces(world: World, regions: Regions, naming: PlaceNaming = {}): Place[] {
  const { mesh } = world;
  const n = mesh.n;
  if (n === 0) return [];
  const ctx = makeContext(world);
  const namers = makeNamers(world.params.seed, regions, naming);

  const out: Place[] = [];
  // 先找齐(顺序固定:海 → 山 → 河 → 湖 → 岛 → 荒漠),再统一起名(nameAll:名字按位置取,和找的先后无关)
  out.push(...findSeas(world, ctx, namers));
  out.push(...findMountains(world, ctx, namers));
  out.push(...findRivers(world, ctx, namers));
  out.push(...findLakes(world, ctx, namers));
  out.push(...findIslands(world, ctx, namers));
  out.push(...findDeserts(world, ctx, namers));
  nameAll(namers);
  // 跨 180° 经线的标注路径整条挪到中点落在地图里
  for (const p of out) ctx.geo.centerPath(p.path);
  return out;
}

// ---------------------------------------------------------------------------
// 公共:邻接边长、面积、最近地块查询、距离场、连通片、主轴

interface Ctx {
  n: number;
  edge: Float32Array;
  area: Float32Array;
  /** 默认精细度下一个地块的面积 / 间距 */
  cellA: number;
  sp: number;
  /** 世界坐标点所在的地块(连续查,见 Geometry.locator) */
  nearest: (x: number, y: number) => number;
  geo: Geometry;
}

function makeContext(world: World): Ctx {
  const { mesh } = world;
  const geo = geometryOf(mesh);
  const sp = refSpacing(mesh);
  return { n: mesh.n, edge: adjLengths(mesh), area: cellAreas(mesh), cellA: refCellArea(mesh), sp, nearest: geo.locator(), geo };
}

/**
 * 距离场:inside 里的每个地块到"外面"的沿网格距离(世界单位)。外面的地块为 0。
 * 从紧挨着 inside 的外部地块出发做多源 Dijkstra,只往 inside 里走。
 */
function distanceField(world: World, ctx: Ctx, inside: Uint8Array): Float32Array {
  const { adjStart, adj } = world.mesh;
  // 用双精度:堆里存的是双精度,单精度数组会把距离舍入得更小,导致地块被当成"已过时"跳过
  const dist = new Float64Array(ctx.n).fill(Infinity);
  const heap = new MinHeap(1024);
  for (let i = 0; i < ctx.n; i++) {
    if (inside[i]) continue;
    dist[i] = 0;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      if (inside[adj[k]]) {
        heap.push(i, 0);
        break;
      }
    }
  }
  while (heap.size > 0) {
    const i = heap.pop();
    const d = heap.lastPri;
    if (d > dist[i]) continue;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const j = adj[k];
      if (!inside[j]) continue;
      const nd = d + ctx.edge[k];
      if (nd < dist[j]) {
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  // 走不到的地块(网格里偶尔有没有邻居的孤点)记为 0,不当成"最远点"
  const out = new Float32Array(ctx.n);
  for (let i = 0; i < ctx.n; i++) out[i] = dist[i] === Infinity ? 0 : dist[i];
  return out;
}

/** 连通片:返回每片的地块列表(按片里最小的地块编号排序,顺序确定) */
function components(world: World, mask: Uint8Array): number[][] {
  const { n, adjStart, adj } = world.mesh;
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    const q = [s];
    seen[s] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (mask[j] && !seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    out.push(q);
  }
  return out;
}

function sumArea(ctx: Ctx, cells: number[]): number {
  let a = 0;
  for (const c of cells) a += ctx.area[c];
  return a;
}

/** 片里 field 最大的地块(并列取编号小的) */
function argmax(cells: number[], field: Float32Array): number {
  let best = cells[0];
  for (const c of cells) if (field[c] > field[best] || (field[c] === field[best] && c < best)) best = c;
  return best;
}

/** 主轴(坐标、方向都在局部平面 ch 上) */
interface Axis {
  ch: Chart;
  cx: number;
  cy: number;
  /** 主方向(单位向量) */
  ux: number;
  uy: number;
  /** 主 / 次方向的标准差 */
  s1: number;
  s2: number;
}

/** 加权主成分:中心、主方向、两个方向的标准差(局部平面切在这片地块的加权质心附近) */
function principalAxis(world: World, cells: number[], weight: (c: number) => number): Axis {
  const ch = geometryOf(world.mesh).chartOf(cells, weight);
  let W = 0;
  let cx = 0;
  let cy = 0;
  for (const c of cells) {
    const w = weight(c);
    W += w;
    cx += w * ch.u(c);
    cy += w * ch.v(c);
  }
  if (W <= 0) return { ch, cx: ch.u(cells[0]), cy: ch.v(cells[0]), ux: 1, uy: 0, s1: 0, s2: 0 };
  cx /= W;
  cy /= W;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const c of cells) {
    const w = weight(c);
    const dx = ch.u(c) - cx;
    const dy = ch.v(c) - cy;
    sxx += w * dx * dx;
    syy += w * dy * dy;
    sxy += w * dx * dy;
  }
  sxx /= W;
  syy /= W;
  sxy /= W;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  let ux = sxy;
  let uy = l1 - sxx;
  if (Math.abs(ux) + Math.abs(uy) < 1e-9) {
    ux = sxx >= syy ? 1 : 0;
    uy = sxx >= syy ? 0 : 1;
  }
  const len = hypot2(ux, uy);
  ux /= len;
  uy /= len;
  // 统一朝右(朝下),方向确定
  if (ux < 0 || (ux === 0 && uy < 0)) {
    ux = -ux;
    uy = -uy;
  }
  return { ch, cx, cy, ux, uy, s1: Math.sqrt(l1), s2: Math.sqrt(l2) };
}

/**
 * 沿主轴分段,每段取加权平均的横向偏移 → 一条顺着实体走向的折线(3–12 个点)。
 * 两端各去掉 5% 的极端点,免得被伸出去的小角带偏。
 */
function spinePath(cells: number[], ax: Axis, weight: (c: number) => number, sp: number): Float32Array {
  const { ch } = ax;
  const vx = -ax.uy;
  const vy = ax.ux;
  const ts = cells.map((c) => (ch.u(c) - ax.cx) * ax.ux + (ch.v(c) - ax.cy) * ax.uy).sort((a, b) => a - b);
  const t0 = ts[Math.floor(ts.length * 0.05)];
  const t1 = ts[Math.min(ts.length - 1, Math.floor(ts.length * 0.95))];
  const len = t1 - t0;
  const nb = Math.max(3, Math.min(12, Math.round(len / (3.5 * sp))));
  const sw = new Float64Array(nb);
  const so = new Float64Array(nb);
  for (const c of cells) {
    const t = (ch.u(c) - ax.cx) * ax.ux + (ch.v(c) - ax.cy) * ax.uy;
    if (t < t0 || t > t1) continue;
    const b = Math.min(nb - 1, Math.max(0, Math.floor(((t - t0) / Math.max(1e-6, len)) * nb)));
    const w = weight(c);
    sw[b] += w;
    so[b] += w * ((ch.u(c) - ax.cx) * vx + (ch.v(c) - ax.cy) * vy);
  }
  let off = Array.from({ length: nb }, (_, b) => (sw[b] > 0 ? so[b] / sw[b] : NaN));
  // 空段:用两边插值
  for (let b = 0; b < nb; b++) {
    if (!Number.isNaN(off[b])) continue;
    let l = b - 1;
    while (l >= 0 && Number.isNaN(off[l])) l--;
    let r = b + 1;
    while (r < nb && Number.isNaN(off[r])) r++;
    off[b] = l >= 0 && r < nb ? (off[l] + off[r]) / 2 : l >= 0 ? off[l] : r < nb ? off[r] : 0;
  }
  // 平滑两遍(首尾也参与,标注路径要柔和)
  for (let pass = 0; pass < 2; pass++) {
    const o = off.slice();
    for (let b = 0; b < nb; b++) {
      const a = off[Math.max(0, b - 1)];
      const c = off[Math.min(nb - 1, b + 1)];
      o[b] = 0.25 * a + 0.5 * off[b] + 0.25 * c;
    }
    off = o;
  }
  const path = new Float32Array(nb * 2);
  for (let b = 0; b < nb; b++) {
    const t = t0 + ((b + 0.5) / nb) * len;
    const u = ax.cx + ax.ux * t + vx * off[b];
    const v = ax.cy + ax.uy * t + vy * off[b];
    path[b * 2] = ch.toX(u, v);
    path[b * 2 + 1] = ch.toY(u, v);
  }
  return path;
}

/** 局部平面上的折线 [u0, v0, u1, v1, …] → 世界坐标的标注路径 */
function pathOf(ch: Chart, pts: number[]): Float32Array {
  const out = new Float32Array(pts.length);
  for (let k = 0; k + 1 < pts.length; k += 2) {
    out[k] = ch.toX(pts[k], pts[k + 1]);
    out[k + 1] = ch.toY(pts[k], pts[k + 1]);
  }
  return out;
}

/**
 * 从局部平面上的 (u, v) 沿水平(或竖直)方向往两边走,直到 field 低于 margin(或走出地图),返回这条"弦"的两端。
 * 用来给海域、荒漠找一段能放下横排(竖排)文字的空地。
 */
function chord(ctx: Ctx, ch: Chart, field: Float32Array, u: number, v: number, vertical: boolean, margin: number, maxHalf: number): [number, number] {
  const step = ctx.sp * 0.5;
  const walk = (dir: number) => {
    let s = 0;
    while (s < maxHalf) {
      const ns = s + step;
      const pu = vertical ? u : u + dir * ns;
      const pv = vertical ? v + dir * ns : v;
      const px = ch.toX(pu, pv);
      const py = ch.toY(pu, pv);
      if (field[ctx.nearest(px, py)] < margin) break;
      s = ns;
    }
    return s;
  };
  return [walk(-1), walk(1)];
}

// ---------------------------------------------------------------------------
// 起名

interface Namers {
  /** 这个地块按哪种语感起名 → namer + 民族编号 */
  at: (cell: number) => { namer: Namer; culture: number; family: 'western' | 'eastern' };
  /** 海名的 keyed 随机数的根 */
  seaBase: number;
  used: Set<string>;
  /** 找到了、还没起名的地理实体(nameAll 统一起名) */
  pending: { p: Place; req: NameReq }[];
}

/** 一个地理实体怎么起名:海 = 中性的叫法;山、河 = 直接用这一类名字;湖、岛、荒漠 = 借别的类的专名换通名 */
type NameReq =
  | { t: 'sea'; kind: 'ocean' | 'sea' | 'bay'; climate: 'cold' | 'warm' | 'mild'; dir: string | null }
  | { t: 'direct'; from: 'mountain' | 'river' }
  | { t: 'derived'; from: 'sea' | 'mountain' | 'region'; suffix: string; keep: string[]; shortest?: boolean };

/** 先占名字的先后:按种类(海 → 山 → 河 → 湖 → 岛 → 荒漠),同种类按锚点地块编号从小到大 —— 和找的先后、个头排名无关 */
const KIND_ORDER: Record<Kind, number> = { sea: 0, mountains: 1, river: 2, lake: 3, island: 4, desert: 5 };

/** 记下一个待起名的地理实体(名字先空着,nameAll 统一起) */
function later(ns: Namers, p: Place, req: NameReq): Place {
  ns.pending.push({ p, req });
  return p;
}

/**
 * 统一起名:名字按位置取 —— 每个实体的候选只由"种子 + 语感 + 锚点地块 + 种类"决定(Namer.keyed);
 * 撞名时换这个实体的下一个候选,谁先占按 KIND_ORDER + 锚点地块编号。改地形后远处的实体找到的锚点不变,名字就不变
 */
function nameAll(ns: Namers): void {
  const list = ns.pending.map((x, i) => ({ ...x, i }));
  list.sort((a, b) => KIND_ORDER[a.p.kind] - KIND_ORDER[b.p.kind] || (a.p.cell ?? -1) - (b.p.cell ?? -1) || a.i - b.i);
  for (const { p, req } of list) {
    const cell = p.cell ?? -1;
    const salt = KIND_ORDER[p.kind];
    const nm =
      req.t === 'sea'
        ? { zh: seaName(ns, cell, req.kind, req.climate, req.dir), culture: -1 }
        : req.t === 'direct'
          ? directName(ns, cell, req.from, salt)
          : derivedName(ns, cell, req.from, req.suffix, req.keep, salt, !!req.shortest);
    p.name = nm.zh;
    p.culture = nm.culture;
    if (nm.latin) p.latin = nm.latin;
  }
  ns.pending.length = 0;
}

/** 世界种子挑一种语感(没人住的地方、没有民族数据时用它);names = 整个世界的地名风格,按份数挑 */
export function worldNameStyle(seed: number, names?: NameMix): string {
  const rng = mulberry32(subSeed(seed, 'civ-places-style'));
  return pickStyle(names, rng());
}

function makeNamers(seed: number, regions: Regions, naming: PlaceNaming): Namers {
  const base = subSeed(seed, 'civ-places-names');
  const cache = new Map<string, Namer>();
  const get = (style: string) => {
    let nm = cache.get(style);
    if (!nm) cache.set(style, (nm = createNamer(base, style)));
    return nm;
  };
  const fallback = worldNameStyle(seed, naming.names);
  const valid = new Set(NAME_STYLES.map((s) => s.id));
  const family = new Map(NAME_STYLES.map((s) => [s.id, s.family]));
  const { cultures, culture } = naming;
  return {
    at(cell) {
      let style = fallback;
      let cu = -1;
      if (cultures && culture) {
        const r = cell >= 0 && cell < regions.of.length ? regions.of[cell] : -1;
        const c = r >= 0 && r < culture.length ? culture[r] : -1;
        if (c >= 0 && c < cultures.length && valid.has(cultures[c].style)) {
          style = cultures[c].style;
          cu = c;
        }
      }
      return { namer: get(style), culture: cu, family: family.get(style)! };
    },
    seaBase: subSeed(seed, 'civ-places-sea'),
    used: new Set(),
    pending: [],
  };
}

/** 去掉通名(和"之"),得到专名部分:"卡皮内山脉" → "卡皮内","招摇之山" → "招摇" */
function coreOf(g: GeneratedName): string {
  let s = g.zh;
  if (g.generic && s.endsWith(g.generic) && s.length > g.generic.length) s = s.slice(0, -g.generic.length);
  if (s.endsWith('之') && s.length > 1) s = s.slice(0, -1);
  return s;
}

/** 一个地理实体最多看这么多个候选(候选流取到后面给带序号的兜底名,正常世界碰不到) */
const MAX_PICKS = 400;

/** 湖、岛的名字取前几个合格候选里最短的(小地方的名字短些,标注放得下;一样长取先出现的) */
const DERIVED_SHORTEST_OF = 3;

/**
 * 借用某一类名字的专名,换上自己的通名(湖 / 岛 / 沙漠没有专门的名字类别)。
 * keep:原名已经是这种通名的就原样用(如"伊昌泽"本来就是湖名)。候选按锚点地块取(salt 区分借同一类名字的几种实体)
 */
function derivedName(ns: Namers, cell: number, from: 'sea' | 'mountain' | 'region', suffix: string, keep: string[], salt: number, shortest: boolean): { zh: string; latin?: string; culture: number } {
  const { namer, culture } = ns.at(cell);
  const next = namer.keyed(from, cell, salt);
  let last = '';
  let best: { zh: string; latin?: string; len: number } | null = null;
  let seen = 0;
  for (let t = 0; t < MAX_PICKS && seen < (shortest ? DERIVED_SHORTEST_OF : 1); t++) {
    const g = next();
    const core = coreOf(g);
    const zh = g.generic && keep.includes(g.generic) ? g.zh : core + suffix;
    const len = [...zh].length;
    if (!ns.used.has(zh)) last = zh;
    // 专名里带"之"、太长、重名的不要
    if (core.includes('之') || len > 6 || len < 2 || ns.used.has(zh)) continue;
    seen++;
    if (!best || len < best.len) best = { zh, latin: g.latin, len };
  }
  if (best) {
    ns.used.add(best.zh);
    return { zh: best.zh, latin: best.latin, culture };
  }
  ns.used.add(last);
  return { zh: last, culture };
}

function directName(ns: Namers, cell: number, kind: 'mountain' | 'river', salt: number): { zh: string; latin?: string; culture: number } {
  const { namer, culture } = ns.at(cell);
  const next = namer.keyed(kind, cell, salt);
  let g = next();
  for (let t = 0; t < MAX_PICKS && ns.used.has(g.zh); t++) g = next();
  ns.used.add(g.zh);
  return { zh: g.zh, latin: g.latin, culture };
}

// 海洋用中性的叫法:不带任何民族语感,按冷暖、位置、气象取意象
const OCEAN_WORDS = '长风 落日 晨曦 无垠 苍茫 沧浪 静澜 怒涛 远帆 星辉 鲸歌 云帆 天青 镜光 暮光 浩渺'.split(' ');
const OCEAN_COLD = '永冬 冰封 极光 霜冠 寒星'.split(' ');
const OCEAN_WARM = '暖流 珊瑚 翡翠 碧波 金阳'.split(' ');
const SEA_WORDS = '静 暮 翠 银 雾 潮 镜 玉 晴 云 碧 蔚 琉璃 寒鸦 白鲸 风暴 迷雾 群星 明月 潮声 长夜'.split(' ');
const SEA_COLD = '冰 霜 雪 白 极光 寒冰 冰牙'.split(' ');
const SEA_WARM = '暖 珊瑚 翡翠 金沙 碧玉'.split(' ');
const BAY_WORDS = '月牙 弯刀 静水 渔人 白帆 鹭 燕 鲸 雾 银 金 蓝 碧 镜 风 落霞 长滩 海豹 珍珠 贝壳 灯塔 归帆 渡鸦'.split(' ');
const BAY_COLD = '寒 冰 霜 白熊 海豹'.split(' ');
const DIRS: Record<string, string> = { n: '北', s: '南', e: '东', w: '西' };

/** 海名:按锚点地块取随机数(keyed),撞名换下一个 */
function seaName(ns: Namers, cell: number, kind: 'ocean' | 'sea' | 'bay', climate: 'cold' | 'warm' | 'mild', dir: string | null): string {
  const rng = mulberry32(Math.floor(keyed(ns.seaBase, cell) * 4294967296));
  const pick = (a: string[]) => a[Math.floor(rng() * a.length)];
  for (let t = 0; t < 40; t++) {
    let zh: string;
    if (kind === 'ocean') {
      // 大洋:方位 + 大洋(西大洋),或意象 + 洋(长风洋)
      if (dir && rng() < 0.45) zh = DIRS[dir] + '大洋';
      else zh = pick(climate === 'cold' && rng() < 0.7 ? OCEAN_COLD : climate === 'warm' && rng() < 0.5 ? OCEAN_WARM : OCEAN_WORDS) + '洋';
    } else if (kind === 'sea') {
      if (dir && rng() < 0.2) zh = DIRS[dir] + '海';
      else zh = pick(climate === 'cold' && rng() < 0.6 ? SEA_COLD : climate === 'warm' && rng() < 0.4 ? SEA_WARM : SEA_WORDS) + '海';
    } else {
      zh = pick(climate === 'cold' && rng() < 0.5 ? BAY_COLD : BAY_WORDS) + '湾';
    }
    if (!ns.used.has(zh)) {
      ns.used.add(zh);
      return zh;
    }
  }
  // 兜底:加序号
  const g = kind === 'ocean' ? '洋' : kind === 'sea' ? '海' : '湾';
  for (let i = 2; ; i++) {
    const zh = `第${'二三四五六七八九十'[Math.min(8, i - 2)]}${g}${i > 10 ? i : ''}`;
    if (!ns.used.has(zh)) {
      ns.used.add(zh);
      return zh;
    }
  }
}

/** 还没起名(nameAll 再起) */
const UNNAMED = { zh: '', culture: -1 };

function place(kind: Kind, name: { zh: string; latin?: string; culture: number }, path: Float32Array, rank: number, size: number, cell: number): Place {
  const p: Place = { kind, name: name.zh, culture: name.culture, path, rank, size, cell };
  if (name.latin) p.latin = name.latin;
  return p;
}

/** 按纬度粗分冷暖(y 越靠上下两边越冷) */
function climateAt(world: World, cell: number): 'cold' | 'warm' | 'mild' {
  const t = world.temperature[cell];
  return t < 2 ? 'cold' : t > 22 ? 'warm' : 'mild';
}

// ---------------------------------------------------------------------------
// 海域

function findSeas(world: World, ctx: Ctx, names: Namers): Place[] {
  const { mesh, water, seaIce } = world;
  const { n } = mesh;
  const { geo } = ctx;
  // 开阔水面:海,没结冰
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) open[i] = water[i] === 1 && seaIce[i] < 0.5 ? 1 : 0;
  const dist = distanceField(world, ctx, open);

  const order: number[] = [];
  for (let i = 0; i < n; i++) if (open[i] && dist[i] >= SEA.minRadius * ctx.sp) order.push(i);
  order.sort((a, b) => dist[b] - dist[a] || a - b);

  // "独立的一片海" = 它和更开阔的海之间隔着一道窄口(像山峰的"独立高度"):
  // 从候选点出发,只走离岸 ≥ 半径 × SADDLE 的水面,走不到更开阔的地方,才算独立的一片
  const stamp = new Int32Array(n).fill(-1);
  const heap = new MinHeap(256);
  const { adjStart, adj } = mesh;
  const separate = (c: number) => {
    const floor = SEA.saddle * dist[c];
    heap.size = 0;
    heap.push(c, -dist[c]);
    stamp[c] = c;
    let visits = 0;
    while (heap.size > 0) {
      const i = heap.pop();
      if (dist[i] > dist[c] || (dist[i] === dist[c] && i < c)) return false;
      if (++visits > 40000) return false;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const j = adj[k];
        if (stamp[j] === c || !open[j] || dist[j] < floor) continue;
        stamp[j] = c;
        heap.push(j, -dist[j]);
      }
    }
    return true;
  };
  // 标注路径:过中心的一段水平弦(竖长的海用竖直弦),两端离岸至少留出一行字的余地(球面:沿纬线 / 经线)
  const seaPath = (c: number) => {
    const d = dist[c];
    const margin = Math.max(2.2 * ctx.sp, 0.3 * d);
    const maxHalf = d * 3;
    const ch = geo.mapChart(mesh.x[c], mesh.y[c]);
    const u = ch.u(c);
    const v = ch.v(c);
    const [hl, hr] = chord(ctx, ch, dist, u, v, false, margin, maxHalf);
    const [vu, vd] = chord(ctx, ch, dist, u, v, true, margin, maxHalf);
    return vu + vd > 1.7 * (hl + hr)
      ? pathOf(ch, [u, v - vu, u, v + (vd - vu) / 2, u, v + vd])
      : pathOf(ch, [u - hl, v, u + (hr - hl) / 2, v, u + hr, v]);
  };
  const picked: number[] = [];
  const paths: Float32Array[] = [];
  /** 补上的名字(不是独立的一片海)重要度低一档 */
  const filled = new Set<number>();
  for (const c of order) {
    if (picked.length >= SEA.max) break;
    let near = false;
    for (const p of picked) {
      const need = SEA.separation * dist[p];
      if (geo.dist2(c, p) < need * need) {
        near = true;
        break;
      }
    }
    if (near || !separate(c)) continue;
    picked.push(c);
    paths.push(seaPath(c));
  }
  // 大洋很大时,离已有海名很远的开阔水面再补一个名字(像太平洋里的珊瑚海)。
  // "很远"既看中心之间,也看到已有海名那一行字的距离:一条长水道已经被一行竖排的字占满,就不再补
  for (const c of order) {
    if (picked.length >= SEA.max || dist[c] < SEA.fillR) break;
    let far = true;
    const ch = geo.chart(c);
    for (let i = 0; i < picked.length && far; i++) {
      const p = picked[i];
      const r = Math.max(dist[p], dist[c]);
      if (geo.dist2(c, p) < (SEA.fillSeparation * r) ** 2) far = false;
      else if (segDistance(ch, paths[i], ch.u(c), ch.v(c)) < r) far = false;
    }
    if (!far) continue;
    picked.push(c);
    paths.push(seaPath(c));
    filled.add(c);
  }
  if (!picked.length) return [];
  // 哪几片叫"洋":够大的按半径排名取前几(一样大按锚点地块编号),和找的先后无关
  const byRank = [...picked].sort((a, b) => dist[b] - dist[a] || a - b);
  const oceanSet = new Set(byRank.filter((c) => dist[c] >= SEA.oceanR && dist[c] >= SEA.oceanMin * ctx.sp).slice(0, SEA.maxOceans));
  if (!oceanSet.size && dist[byRank[0]] >= SEA.oceanMin * ctx.sp) oceanSet.add(byRank[0]);

  // 围合程度:16 条射线,在 3.5 倍半径内碰到陆地(不算冰)的比例
  const enclosure = (c: number) => {
    const R = dist[c] * 3.5;
    const ch = geo.chart(c);
    const u = ch.u(c);
    const v = ch.v(c);
    let hit = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const dx = round24(Math.cos(ang));
      const dy = round24(Math.sin(ang));
      for (let s = dist[c] * 0.8; s <= R; s += ctx.sp) {
        const pu = u + dx * s;
        const pv = v + dy * s;
        const px = ch.toX(pu, pv);
        const py = ch.toY(pu, pv);
        const j = ctx.nearest(px, py);
        if (water[j] !== 1) {
          hit++;
          break;
        }
      }
    }
    return hit / 16;
  };

  // 大洋的方位:按中心在图上的位置
  const dirOf = (c: number): string | null => geo.mapSide(c);

  const out: Place[] = [];
  for (const c of picked) {
    const d = dist[c];
    let kind: 'ocean' | 'sea' | 'bay';
    if (oceanSet.has(c)) kind = 'ocean';
    else if (d < SEA.bayR && enclosure(c) >= 0.6) kind = 'bay';
    else kind = 'sea';
    let rank = kind === 'ocean' ? 1 : kind === 'sea' ? (d >= SEA.rank1R ? 1 : d >= SEA.rank2R ? 2 : 3) : d >= SEA.bayRank2R ? 2 : 3;
    if (filled.has(c) && d < SEA.fillRank1R) rank = Math.max(rank, 2);
    const path = paths[picked.indexOf(c)];
    out.push(later(names, place('sea', { zh: '', culture: -1 }, path, rank, d, c), { t: 'sea', kind, climate: climateAt(world, c), dir: kind === 'bay' ? null : dirOf(c) }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 山脉

function findMountains(world: World, ctx: Ctx, ns: Namers): Place[] {
  const { mesh, water, elevation } = world;
  const n = mesh.n;
  const maxE = Math.max(1, world.maxElevation);
  // 门槛和手绘风画山峰符号的门槛相当:画了山的地方就有机会标山名
  const T = Math.max(MOUNTAIN.minElev, maxE * MOUNTAIN.elevFrac);
  const high = new Uint8Array(n);
  for (let i = 0; i < n; i++) high[i] = water[i] === 0 && elevation[i] >= T ? 1 : 0;
  // 越高的地块权重越大:主轴和路径贴着山脊走
  const w = (c: number) => (elevation[c] - T + 300) ** 2 * ctx.area[c];
  const pieces: { cells: number[]; area: number; mass: number }[] = [];
  for (const cells of components(world, high)) {
    const area = sumArea(ctx, cells) / ctx.cellA;
    if (area < MOUNTAIN.minArea) continue;
    // 又大又不成一条线(分叉、拐弯的山系):按位置聚成几段,各起各的名字
    const ax = principalAxis(world, cells, (c) => ctx.area[c]);
    const k = area >= MOUNTAIN.splitArea && ax.s2 / Math.max(1e-6, ax.s1) >= MOUNTAIN.splitRatio ? Math.min(4, Math.max(2, Math.round(area / MOUNTAIN.splitArea))) : 1;
    for (const part of k > 1 ? kmeans(ax.ch, cells, k, elevation) : [cells]) {
      const a = sumArea(ctx, part) / ctx.cellA;
      if (a < MOUNTAIN.minArea) continue;
      let mass = 0;
      for (const c of part) mass += (elevation[c] - T + 400) * (ctx.area[c] / ctx.cellA);
      pieces.push({ cells: part, area: a, mass });
    }
  }
  pieces.sort((a, b) => b.mass - a.mass || a.cells[0] - b.cells[0]);

  const out: Place[] = [];
  pieces.slice(0, MOUNTAIN.max).forEach((m, i) => {
    const ax = principalAxis(world, m.cells, w);
    const elong = ax.s1 / Math.max(1e-6, ax.s2);
    let path: Float32Array;
    let size: number;
    if (elong >= 1.7) {
      path = spinePath(m.cells, ax, w, ctx.sp);
      size = polyLength(ctx.geo, path);
    } else {
      // 块状山地:在最高处附近横排(球面:沿那里的纬线)
      const top = argmax(m.cells, elevation);
      const half = Math.max(2 * ctx.sp, ax.s1 * 1.4);
      const px = ax.ch.toX((ax.ch.u(top) + ax.cx) / 2, (ax.ch.v(top) + ax.cy) / 2);
      const py = ax.ch.toY((ax.ch.u(top) + ax.cx) / 2, (ax.ch.v(top) + ax.cy) / 2);
      const mc = ctx.geo.mapChart(px, py);
      const cx = mc.toU(px, py);
      const cy = mc.toV(px, py);
      path = pathOf(mc, [cx - half, cy, cx, cy, cx + half, cy]);
      size = half * 2;
    }
    const rank = i < MOUNTAIN.tier1 && m.area >= MOUNTAIN.tier1Area ? 1 : m.area >= MOUNTAIN.tier2Area ? 2 : 3;
    const mid = (path.length >> 2) << 1;
    const anchor = ctx.nearest(path[mid], path[mid + 1]);
    out.push(later(ns, place('mountains', UNNAMED, path, rank, size, anchor), { t: 'direct', from: 'mountain' }));
  });
  return out;
}

/**
 * 把一片地块按位置聚成 k 堆(k 均值,确定性):第一个中心取最高点,之后每次取离已有中心最远的点,
 * 再迭代 10 轮。分叉、拐弯的山系会按"臂"分开。
 */
function kmeans(ch: Chart, cells: number[], k: number, elevation: Float32Array): number[][] {
  const cx: number[] = [];
  const cy: number[] = [];
  const top = argmax(cells, elevation);
  cx.push(ch.u(top));
  cy.push(ch.v(top));
  while (cx.length < k) {
    let best = cells[0];
    let bd = -1;
    for (const c of cells) {
      let d = Infinity;
      for (let j = 0; j < cx.length; j++) d = Math.min(d, (ch.u(c) - cx[j]) ** 2 + (ch.v(c) - cy[j]) ** 2);
      if (d > bd) {
        bd = d;
        best = c;
      }
    }
    cx.push(ch.u(best));
    cy.push(ch.v(best));
  }
  const label = new Int32Array(cells.length);
  for (let it = 0; it < 10; it++) {
    const sx = new Float64Array(k);
    const sy = new Float64Array(k);
    const cnt = new Float64Array(k);
    cells.forEach((c, i) => {
      let bj = 0;
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = (ch.u(c) - cx[j]) ** 2 + (ch.v(c) - cy[j]) ** 2;
        if (d < bd) {
          bd = d;
          bj = j;
        }
      }
      label[i] = bj;
      sx[bj] += ch.u(c);
      sy[bj] += ch.v(c);
      cnt[bj]++;
    });
    for (let j = 0; j < k; j++) {
      if (!cnt[j]) continue;
      cx[j] = sx[j] / cnt[j];
      cy[j] = sy[j] / cnt[j];
    }
  }
  const out: number[][] = Array.from({ length: k }, () => []);
  cells.forEach((c, i) => out[label[i]].push(c));
  return out.filter((p) => p.length > 0);
}

/** 局部平面上的点 (px, py) 到世界坐标折线 p(x,y,x,y…)的距离(折线先换到局部平面) */
function segDistance(ch: Chart, p: Float32Array, px: number, py: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = ch.toU(p[i], p[i + 1]);
    const ay = ch.toV(p[i], p[i + 1]);
    const bx = ch.toU(p[i + 2], p[i + 3]) - ax;
    const by = ch.toV(p[i + 2], p[i + 3]) - ay;
    const L = bx * bx + by * by;
    const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / L)) : 0;
    best = Math.min(best, hypot2(px - ax - bx * t, py - ay - by * t));
  }
  return p.length >= 2 && best === Infinity ? hypot2(px - ch.toU(p[0], p[1]), py - ch.toV(p[0], p[1])) : best;
}

/** 世界坐标折线的长度 */
function polyLength(geo: Geometry, p: Float32Array): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += geo.pointDist(p[i], p[i + 1], p[i - 2], p[i - 1]);
  return L;
}

// ---------------------------------------------------------------------------
// 大河:把 world.rivers 串成干流

function findRivers(world: World, ctx: Ctx, ns: Namers): Place[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const id = new Map<string, number>();
  const vx: number[] = [];
  const vy: number[] = [];
  const vf: number[] = [];
  const next: number[] = [];
  for (const r of world.rivers) {
    const p = r.pts;
    const m = p.length / 3;
    let prev = -1;
    for (let i = 0; i < m; i++) {
      const k = key(p[i * 3], p[i * 3 + 1]);
      let v = id.get(k);
      if (v === undefined) {
        v = vx.length;
        id.set(k, v);
        vx.push(p[i * 3]);
        vy.push(p[i * 3 + 1]);
        vf.push(p[i * 3 + 2]);
        next.push(-1);
      }
      if (prev >= 0 && prev !== v) next[prev] = v;
      prev = v;
    }
  }
  const N = vx.length;
  const main = new Int32Array(N).fill(-1);
  for (let u = 0; u < N; u++) {
    const v = next[u];
    if (v >= 0 && (main[v] < 0 || vf[u] > vf[main[v]])) main[v] = u;
  }
  // 从每个源头往下走,只要自己是下游节点的干流就继续
  const chains: { nodes: number[]; peak: number; len: number }[] = [];
  const guard = new Uint8Array(N);
  for (let h = 0; h < N; h++) {
    if (main[h] >= 0) continue;
    const c = [h];
    let cur = h;
    guard.fill(0);
    guard[h] = 1;
    while (next[cur] >= 0) {
      const v = next[cur];
      if (guard[v]) break;
      guard[v] = 1;
      c.push(v);
      if (main[v] !== cur) break;
      cur = v;
    }
    if (c.length < 3) continue;
    const joins = next[c[c.length - 1]] >= 0 && main[c[c.length - 1]] !== c[c.length - 2];
    const peak = vf[joins ? c[c.length - 2] : c[c.length - 1]];
    let len = 0;
    for (let i = 1; i < c.length; i++) len += ctx.geo.pointDist(vx[c[i]], vy[c[i]], vx[c[i - 1]], vy[c[i - 1]]);
    chains.push({ nodes: c, peak, len });
  }
  chains.sort((a, b) => b.peak - a.peak || a.nodes[0] - b.nodes[0]);
  const picked = chains.filter((c) => c.len >= RIVER.minLen * ctx.sp).slice(0, RIVER.max);

  return picked.map((ch, i) => {
    const m = ch.nodes.length;
    // 在局部平面上平滑两遍
    const at = ch.nodes[m >> 1];
    const plane = ctx.geo.chart(ctx.nearest(vx[at], vy[at]));
    let xs = ch.nodes.map((v) => plane.toU(vx[v], vy[v]));
    let ys = ch.nodes.map((v) => plane.toV(vx[v], vy[v]));
    // 和画河一样平滑两遍(首尾不动)
    for (let pass = 0; pass < 2; pass++) {
      const sx = xs.slice();
      const sy = ys.slice();
      for (let k = 1; k < m - 1; k++) {
        sx[k] = 0.25 * xs[k - 1] + 0.5 * xs[k] + 0.25 * xs[k + 1];
        sy[k] = 0.25 * ys[k - 1] + 0.5 * ys[k] + 0.25 * ys[k + 1];
      }
      xs = sx;
      ys = sy;
    }
    const path = new Float32Array(m * 2);
    for (let k = 0; k < m; k++) {
      path[k * 2] = plane.toX(xs[k], ys[k]);
      path[k * 2 + 1] = plane.toY(xs[k], ys[k]);
    }
    const rank = i < RIVER.tier1 ? 1 : i < RIVER.tier1 + RIVER.tier2 ? 2 : 3;
    // size = 河口附近的半河宽(世界单位):标注要让开这么宽
    const t = Math.min(1, Math.sqrt(Math.max(0, ch.peak - world.riverThreshold) / RIVER_W.fluxRef));
    const halfW = (RIVER_W.minW + (RIVER_W.maxW - RIVER_W.minW) * t) / 2;
    const mid = ctx.nearest(plane.toX(xs[m >> 1], ys[m >> 1]), plane.toY(xs[m >> 1], ys[m >> 1]));
    return later(ns, place('river', UNNAMED, path, rank, halfW, mid), { t: 'direct', from: 'river' });
  });
}

// ---------------------------------------------------------------------------
// 湖泊 / 岛屿 / 荒漠:连通片 + 离边缘最远的一点

function findLakes(world: World, ctx: Ctx, ns: Namers): Place[] {
  const n = ctx.n;
  const lake = new Uint8Array(n);
  for (let i = 0; i < n; i++) lake[i] = world.water[i] === 2 && world.biome[i] !== Biome.Ice ? 1 : 0;
  const dist = distanceField(world, ctx, lake);
  const comps = components(world, lake)
    .map((cells) => ({ cells, area: sumArea(ctx, cells) / ctx.cellA }))
    .filter((c) => c.area >= LAKE.minArea)
    .sort((a, b) => b.area - a.area || a.cells[0] - b.cells[0])
    .slice(0, LAKE.max);
  return comps.map((c, i) => {
    const a = argmax(c.cells, dist);
    const rank = (i < 2 && c.area >= LAKE.tier1Area) || (i < LAKE.top && c.area >= LAKE.topArea) ? 1 : c.area >= LAKE.tier2Area ? 2 : 3;
    const r = Math.sqrt((c.area * ctx.cellA) / Math.PI);
    return later(ns, place('lake', UNNAMED, new Float32Array([world.mesh.x[a], world.mesh.y[a]]), rank, r, a), { t: 'derived', from: 'sea', suffix: '湖', keep: ['泽', '泊'], shortest: true });
  });
}

function findIslands(world: World, ctx: Ctx, ns: Namers): Place[] {
  const n = ctx.n;
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = world.water[i] !== 1 ? 1 : 0;
  const all = components(world, land).map((cells) => ({ cells, area: sumArea(ctx, cells) / ctx.cellA }));
  if (!all.length) return [];
  const largest = Math.max(...all.map((c) => c.area));
  const maxArea = Math.min(ISLAND.maxArea, largest * ISLAND.maxFracOfLargest);
  const comps = all
    .filter((c) => c.area >= ISLAND.minArea && c.area <= maxArea)
    .sort((a, b) => b.area - a.area || a.cells[0] - b.cells[0])
    .slice(0, ISLAND.max);
  if (!comps.length) return [];
  const dist = distanceField(world, ctx, land);
  return comps.map((c, i) => {
    const a = argmax(c.cells, dist);
    const rank = c.area >= ISLAND.tier1Area || (i < ISLAND.top && c.area >= ISLAND.topArea) ? 1 : c.area >= ISLAND.tier2Area ? 2 : 3;
    const r = Math.sqrt((c.area * ctx.cellA) / Math.PI);
    const ax = principalAxis(world, c.cells, (k) => ctx.area[k]);
    // 狭长的岛沿长轴标(竖长的竖排),其余在最宽处横排
    const path = axisPath(ctx, dist, a, ax, r, world.mesh);
    return later(ns, place('island', UNNAMED, path, rank, r, a), { t: 'derived', from: 'mountain', suffix: '岛', keep: [], shortest: true });
  });
}

function findDeserts(world: World, ctx: Ctx, ns: Namers): Place[] {
  const n = ctx.n;
  const desert = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = world.biome[i];
    desert[i] = world.water[i] === 0 && (b === Biome.HotDesert || b === Biome.TemperateDesert || b === Biome.ColdDesert) ? 1 : 0;
  }
  const comps = components(world, desert)
    .map((cells) => ({ cells, area: sumArea(ctx, cells) / ctx.cellA }))
    .filter((c) => c.area >= DESERT.minArea)
    .sort((a, b) => b.area - a.area || a.cells[0] - b.cells[0])
    .slice(0, DESERT.max);
  if (!comps.length) return [];
  const dist = distanceField(world, ctx, desert);
  return comps.map((c) => {
    const a = argmax(c.cells, dist);
    // 主要是哪种荒漠
    let hot = 0;
    let cold = 0;
    for (const k of c.cells) {
      if (world.biome[k] === Biome.HotDesert) hot++;
      else if (world.biome[k] === Biome.ColdDesert) cold++;
    }
    const other = c.cells.length - hot - cold;
    const suffix = hot >= other && hot >= cold ? '沙漠' : cold > other ? '荒原' : '荒漠';
    const rank = c.area >= DESERT.tier1Area ? 1 : c.area >= DESERT.tier2Area ? 2 : 3;
    const r = Math.sqrt((c.area * ctx.cellA) / Math.PI);
    const ax = principalAxis(world, c.cells, (k) => ctx.area[k]);
    const path = axisPath(ctx, dist, a, ax, r, world.mesh);
    return later(ns, place('desert', UNNAMED, path, rank, r, a), { t: 'derived', from: 'region', suffix, keep: ['漠', '荒', '原'] });
  });
}

/**
 * 面状实体的标注路径:过锚点的一段直线。
 * 狭长(长短轴比 ≥ 1.8)且接近水平 → 沿长轴;接近竖直 → 竖直;否则水平。长度取实体内能放下的那一段。
 * 横排 / 竖排沿过锚点的纬线 / 经线(主图局部平面);斜的沿主轴(实体的局部平面)
 */
function axisPath(ctx: Ctx, dist: Float32Array, a: number, ax: Axis, r: number, mesh: World['mesh']): Float32Array {
  const { ch } = ax;
  const x = ch.u(a);
  const y = ch.v(a);
  const mc = ctx.geo.mapChart(mesh.x[a], mesh.y[a]);
  const mx = mc.u(a);
  const my = mc.v(a);
  const elong = ax.s1 / Math.max(1e-6, ax.s2);
  const ang = round24(Math.atan2(ax.uy, ax.ux)); // (-90°, 90°];舍入到 24 位,跨 CPU 一致(见 rand.ts)
  const margin = Math.max(ctx.sp * 0.8, dist[a] * 0.3);
  const maxHalf = Math.max(r * 1.6, ax.s1 * 2);
  if (elong >= 1.8 && Math.abs(ang) > (55 * Math.PI) / 180) {
    const [u, d] = chord(ctx, mc, dist, mx, my, true, margin, maxHalf);
    return pathOf(mc, [mx, my - u, mx, my + (d - u) / 2, mx, my + d]);
  }
  if (elong >= 1.8 && Math.abs(ang) > (12 * Math.PI) / 180 && Math.abs(ang) < (40 * Math.PI) / 180) {
    // 斜着的:沿长轴往两边走,直到出了实体
    const walk = (dir: number) => {
      let s = 0;
      while (s < maxHalf) {
        const ns = s + ctx.sp * 0.5;
        const pu = x + dir * ax.ux * ns;
        const pv = y + dir * ax.uy * ns;
        if (dist[ctx.nearest(ch.toX(pu, pv), ch.toY(pu, pv))] < margin) break;
        s = ns;
      }
      return s;
    };
    const l = walk(-1);
    const rr = walk(1);
    return pathOf(ch, [x - ax.ux * l, y - ax.uy * l, x + (ax.ux * (rr - l)) / 2, y + (ax.uy * (rr - l)) / 2, x + ax.ux * rr, y + ax.uy * rr]);
  }
  const [l, rr] = chord(ctx, mc, dist, mx, my, false, margin, maxHalf);
  return pathOf(mc, [mx - l, my, mx + (rr - l) / 2, my, mx + rr, my]);
}

/**
 * 地形大事之后重新找出来的地名(next),沿用大事之前同一处地方的名字(prev):同一类、锚点离得够近的算同一处
 * (海、湖、岛、荒漠按大小,山、河按标注路径挨得多近),从最近的一对起配;配上的照用原名(连同语感、拉丁原形),
 * 新冒出来的(新岛、新海湾)保留新起的名字,和原有的重名就在后面找一个没用过的。配上的稳定键沿用原来那一处的(Place.keyCell)。就地改 next。
 */
export function keepPlaceNames(world: World, prev: readonly Place[], next: Place[]): void {
  const geo = geometryOf(world.mesh);
  const { x, y } = world.mesh;
  const anchor = (p: Place): [number, number] => {
    if (p.cell !== undefined && p.cell >= 0) return [x[p.cell], y[p.cell]];
    const n = p.path.length >> 1;
    const m = n >> 1;
    return [p.path[2 * m], p.path[2 * m + 1]];
  };
  const W = world.mesh.width;
  const dist = (a: [number, number], b: [number, number]) => {
    let dx = Math.abs(a[0] - b[0]);
    if (dx > W / 2) dx = W - dx;
    return Math.hypot(dx, a[1] - b[1]);
  };
  void geo;
  const pairs: { d: number; i: number; j: number }[] = [];
  next.forEach((q, j) => {
    prev.forEach((p, i) => {
      if (p.kind !== q.kind) return;
      const d = dist(anchor(p), anchor(q));
      const lim = q.kind === 'mountains' || q.kind === 'river' ? 40 : Math.max(20, 1.2 * Math.max(p.size ?? 0, q.size ?? 0));
      if (d <= lim) pairs.push({ d, i, j });
    });
  });
  pairs.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);
  const usedP = new Set<number>();
  const usedN = new Set<number>();
  for (const { i, j } of pairs) {
    if (usedP.has(i) || usedN.has(j)) continue;
    usedP.add(i);
    usedN.add(j);
    const p = prev[i];
    const q = next[j];
    q.name = p.name;
    q.culture = p.culture;
    if (p.latin !== undefined) q.latin = p.latin;
    else delete q.latin;
    const kc = p.keyCell ?? p.cell;
    if (kc !== undefined) q.keyCell = kc;
  }
  const taken = new Set(next.filter((_, j) => usedN.has(j)).map((q) => q.name));
  next.forEach((q, j) => {
    if (usedN.has(j)) return;
    let name = q.name;
    for (let k = 2; taken.has(name); k++) name = `${q.name}${k}`;
    q.name = name;
    taken.add(name);
  });
}
