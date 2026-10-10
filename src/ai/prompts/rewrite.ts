/**
 * AI 改写(阶段 5「对话式编辑」)的材料、提示词和结果核对:作者用一句话说想怎么改世界
 * ("让大昌多撑三百年""让索拉特和大昌结盟""在北边的海里放一座火山岛"),AI 把它翻成现有的修改 ——
 * 干预(gen/edits.ts 的 Intervention)、改名、改地形(TerrainOp)—— 列给作者确认,确认了才执行。
 * 纯函数,不碰 DOM、不调 AI(助手用它核对、合进修改,见 src/ui/assistantStore.ts)。
 *
 * - 材料(rewriteMaterial):这份历史里的陆块、国家、城、民族、山河,和已经做过的修改。实体一律用短编号
 *   (P3 国家、C12 城、R45 州、E2 民族、M7 山河湖海、L0 陆块;数字 = 这份历史里的编号),位置写成(经度, 纬度)。
 *   州有八九百个,只列作者话里点了名的;城只列各国的国都、几座大城和作者点了名的
 * - 提示词(rewriteRequest,json: true):能用哪些修改、各自的规矩、回复的 JSON 格式;之前几轮说过什么一并带上
 *   (每次都按现在的世界重写材料,执行过的修改已经在"已经做过的修改"里)
 * - 核对(parseRewrite):编号换成稳定键,按那一年的情形核对(国家在不在、两国接不接壤、城在不在本国国土里……),
 *   不合格的照样列出来、写明原因,不执行;经纬度换成世界坐标(x = 经度、y = 纬度,见 gen/edits.ts「地形修改」),
 *   大小按改地形工具条的三档(TERRAIN_PRESETS)
 * - 合进修改(mergeRewrite)/ 撤销(unmergeRewrite):一批修改一次合进 WorldEdits,撤销只拿掉这一批加的
 * - 测试用假 AI(网址 ai=mock)回的是 {"mock":true,…},界面换成 mockRewrite 的一份固定提议,好检查界面和流程
 */
import type { World } from '../../gen/world';
import { AdjKind, type Civ, type Place, type Polity } from '../../gen/civ/types';
import { BIOMES } from '../../gen/biomes';
import { KIND_INFO, cultureLabel, regionLabel, regionNamed } from '../../gen/civ/display';
import { capitalAt, dynastyIndexAt, polityAlive, polityName, polityRootAt, polityRoots, polityTitleChain, populationAt, populationLabel } from '../../gen/civ/growth';
import { ownersAt, type Owners } from '../../gen/civ/timeline';
import { cnNumber } from '../../gen/civ/chronicle';
import { KM_PER_UNIT } from '../../gen/civ/geo';
import {
  cleanIntervention,
  cleanName,
  cultureKey,
  dynastyKey,
  keyCells,
  placeKeyOf,
  polityKey,
  regionKey,
  regionOfKey,
  resolveKey,
  settlementKey,
  type Intervention,
  type KeyKind,
  type TerrainKind,
  type TerrainOp,
  type WorldEdits,
} from '../../gen/edits';
import { TERRAIN_H, TERRAIN_MAX_OPS, TERRAIN_PRESETS, TERRAIN_W, cleanTerrainOp, isPointKind } from '../../gen/terrainEdits';
import { looseJson, placeKindLabel } from './names';
import type { AiRequest } from '../types';

/** 调用记录里的功能名 */
export const REWRITE_FEATURE = '改写';
/** 立国给的是位置(at)时,离它多远以内的有人住的州才算"那一带"(公里) */
const NEAR_KM = 1500;
/** 一次最多几条修改(多出来的不要) */
export const REWRITE_MAX_ITEMS = 12;
/** 作者一句话最长多少字 */
export const WISH_MAX = 300;

// ---------------------------------------------------------------------------
// 坐标与距离

/** 世界坐标 → [经度 −180…180, 纬度 −90…90] */
export function toLonLat(x: number, y: number): [number, number] {
  let lon = (x / TERRAIN_W) * 360 - 180;
  lon -= 360 * Math.floor((lon + 180) / 360);
  return [lon, 90 - (y / TERRAIN_H) * 180];
}

/** [经度, 纬度] → 世界坐标(经度不取模:跨 180° 经线的一笔由 cleanTerrainOp 规整) */
export function toWorld(lon: number, lat: number): [number, number] {
  return [((lon + 180) / 360) * TERRAIN_W, ((90 - lat) / 180) * TERRAIN_H];
}

/** 世界坐标里一点到一处地形修改(点或折线)的距离;东西方向首尾相接 */
function distToOp(x: number, y: number, op: TerrainOp): number {
  const q = op.pts;
  let best = Infinity;
  for (const k of [-1, 0, 1]) {
    const px = x + k * TERRAIN_W;
    if (q.length < 4) best = Math.min(best, Math.hypot(px - q[0], y - q[1]));
    for (let i = 0; i + 3 < q.length; i += 2) {
      const ax = q[i];
      const ay = q[i + 1];
      const dx = q[i + 2] - ax;
      const dy = q[i + 3] - ay;
      const L = dx * dx + dy * dy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (y - ay) * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(px - ax - t * dx, y - ay - t * dy));
    }
  }
  return best;
}

/** 地球半径(公里):赤道一圈 = 地图宽 */
const R_KM = (TERRAIN_W * KM_PER_UNIT) / (2 * Math.PI);
const RAD = Math.PI / 180;

/** 两点的球面距离(公里) */
function distKm(a: readonly [number, number], b: readonly [number, number]): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
/** 从 a 看 b 在哪个方向(八个方位) */
function dirWord(a: readonly [number, number], b: readonly [number, number]): string {
  const [l1, p1] = [a[0] * RAD, a[1] * RAD];
  const [l2, p2] = [b[0] * RAD, b[1] * RAD];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  const deg = (Math.atan2(y, x) / RAD + 360) % 360;
  return DIRS[Math.round(deg / 45) % 8];
}

const f1 = (v: number) => String(Math.round(v * 10) / 10);
const ll = (p: readonly [number, number]) => `(${f1(p[0])}, ${f1(p[1])})`;
const cellLL = (world: World, cell: number): [number, number] => toLonLat(world.mesh.x[cell], world.mesh.y[cell]);
/** 公里数取个整:100 以下到十,以上到五十 */
const kmText = (km: number) => `${km < 100 ? Math.max(10, Math.round(km / 10) * 10) : Math.round(km / 50) * 50} 公里`;

/** 离 [经度, 纬度] 最近的地块(没有 = −1) */
function nearestCell(world: World, p: readonly [number, number]): number {
  const m = world.mesh;
  const [x, y] = toWorld(p[0], p[1]);
  // 先在主图上粗找(经度差按纬度缩),再按球面距离精排前几个
  const k = Math.cos(Math.min(89, Math.abs(p[1])) * RAD);
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < m.n; i++) {
    let dx = Math.abs(m.x[i] - x) % TERRAIN_W;
    if (dx > TERRAIN_W / 2) dx = TERRAIN_W - dx;
    const dy = m.y[i] - y;
    const d = dx * dx * k * k + dy * dy;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 历史的小工具

/** 国家在 y 年的全称(还没立国 / 已亡:立国时 / 亡国前的国号) */
export function nameAt(p: Polity, y: number): string {
  const t = y < p.founded ? p.founded : p.ended !== undefined && y >= p.ended ? p.ended - 1 / 512 : y;
  return polityName(p, t) || p.name || '某国';
}

/** 国家最后(或现在)的那一刻 */
export const lastYear = (civ: Civ, p: Polity) => Math.min(p.ended !== undefined ? p.ended - 1 / 512 : civ.endYear, civ.endYear);

/** 没写年份的命令从哪一年起:时间轴的年份,最晚是最后一年的前一年 */
const defaultFrom = (civ: Civ, year: number) => Math.max(0, Math.min(civ.endYear - 1, Math.floor(Number.isFinite(year) ? year : civ.endYear)));

/** 城 s 在 y 年还在(建了、没毁) */
const stands = (civ: Civ, sid: number, y: number) => {
  const s = civ.settlements[sid];
  return !!s && s.founded <= y && (s.ended === undefined || s.ended > y);
};

/** y 年和国家 id 接壤的国家(和国家面板的"宣战"同一口径:海洋国家隔海峡、航线也算) */
export function bordersAt(civ: Civ, own: Int16Array, id: number): Set<number> {
  const reg = civ.regions;
  const near = new Set<number>();
  const sea = civ.polities[id]?.kind === 'sea';
  for (let r = 0; r < reg.count; r++) {
    if (own[r] !== id) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const q = own[reg.adj[k]];
      const kind = reg.adjKind[k];
      if (q >= 0 && q !== id && (sea || (kind !== AdjKind.Strait && kind !== AdjKind.SeaRoute))) near.add(q);
    }
  }
  return near;
}

/** 国家怎么亡的:"第 2450 年被 P5 所灭""第 2450 年并入 P5""第 2450 年瓦解";还在 = 空串 */
export function endText(civ: Civ, p: Polity): string {
  if (p.ended === undefined) return '';
  const y = Math.floor(p.ended);
  const merge = civ.annals.find((e) => e.kind === 'merge' && e.b === p.id);
  if (merge) return `第 ${y} 年并入 P${merge.a}`;
  const fall = civ.annals.find((e) => e.kind === 'fall' && e.a === p.id);
  if (fall && fall.b >= 0) return `第 ${y} 年被 P${fall.b} 所灭`;
  return `第 ${y} 年瓦解`;
}

/** 陆块的叫法(L0 = 最大的,按面积从大到小编号) */
function landName(id: number, regions: number, polar: boolean): string {
  const base = regions <= 2 ? '小岛' : id === 0 ? '最大的大陆' : regions <= 15 ? '大岛' : `第${cnNumber(id + 1)}大陆`;
  return polar && regions > 2 ? `${base}(极地)` : base;
}

// ---------------------------------------------------------------------------
// 材料

export interface RewriteMaterial {
  /** 材料全文(user 消息的前半) */
  text: string;
  /** 时间轴在哪一年(作者没说年份时,命令从这一年起) */
  year: number;
}

/**
 * 给 AI 的材料。year = 时间轴现在的年份;wishes = 作者这几轮说的话(点了名的州、城、山河一并列出)
 */
export function rewriteMaterial(world: World, civ: Civ, year: number, edits: WorldEdits, wishes: readonly string[], lock?: RewriteLock): RewriteMaterial {
  const Y = Math.floor(Math.min(civ.endYear, Math.max(0, Number.isFinite(year) ? year : civ.endYear)));
  const said = wishes.join('\n');
  const named = (s: string | undefined) => !!s && [...s].length >= 2 && said.includes(s);
  const reg = civ.regions;
  const own = ownersAt(civ, Math.min(Y, civ.endYear));
  const out: string[] = [];

  out.push('# 这个世界');
  out.push(
    `历史从第 0 年推演到第 ${civ.endYear} 年;时间轴现在在第 ${Y} 年` +
      (civ.viable ? `,作者没说年份的命令从第 ${defaultFrom(civ, Y)} 年起。` : '。') +
      '位置写成(经度, 纬度):经度 −180~180,东经为正;纬度 −90~90,北纬为正。赤道一圈约 4 万公里,纬度 1° 约 111 公里。',
  );
  if (lock === 'terrain') out.push('这个世界已经建好,地形定下来了:不能再改地形(火山、山脉、湖、抬起陆地、沉成海都不行),只能下历史命令、改名。作者要改地形时,在 cannot 里说"世界建好以后地形不能再改,想换地形请在世界设定里以它为底稿新建"。');
  else if (lock === 'history') out.push('这个世界还在新建:现在只能改地形,不能下历史命令、不能改名(历史在作者点"创建世界"以后才定下来)。作者要改历史或名字时,在 cannot 里说"创建世界以后再改历史和名字"。');
  if (!civ.viable) out.push('这颗星球太冷或陆地太少,没有长出文明:没有国家、城和民族,只能改地形。');

  // ---- 陆块 ----
  interface Land {
    n: number;
    area: number;
    v: [number, number, number];
    lat: [number, number];
    lons: number[];
    biome: Map<number, number>;
    polities: Set<number>;
  }
  const lands = new Map<number, Land>();
  let landArea = 0;
  const seatLL: [number, number][] = [];
  for (let r = 0; r < reg.count; r++) {
    const p = cellLL(world, reg.seat[r]);
    seatLL[r] = p;
    const id = reg.landmass[r];
    let L = lands.get(id);
    if (!L) lands.set(id, (L = { n: 0, area: 0, v: [0, 0, 0], lat: [90, -90], lons: [], biome: new Map(), polities: new Set() }));
    L.n++;
    L.area += reg.area[r];
    landArea += reg.area[r];
    const [lo, la] = [p[0] * RAD, p[1] * RAD];
    L.v[0] += Math.cos(la) * Math.cos(lo);
    L.v[1] += Math.cos(la) * Math.sin(lo);
    L.v[2] += Math.sin(la);
    L.lat[0] = Math.min(L.lat[0], p[1]);
    L.lat[1] = Math.max(L.lat[1], p[1]);
    L.lons.push(p[0]);
    L.biome.set(reg.biome[r], (L.biome.get(reg.biome[r]) ?? 0) + reg.area[r]);
    if (own.polity[r] >= 0) L.polities.add(own.polity[r]);
  }
  const landList = [...lands.entries()].sort((a, b) => b[1].area - a[1].area || a[0] - b[0]);
  if (landList.length) {
    out.push('', '## 陆块(按面积;小岛不列)');
    for (const [id, L] of landList.slice(0, 12)) {
      if (L.n < 2 && id > 2) continue;
      const cLon = Math.atan2(L.v[1], L.v[0]) / RAD;
      const cLat = Math.atan2(L.v[2], Math.hypot(L.v[0], L.v[1])) / RAD;
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of L.lons) {
        const d = ((((x - cLon + 180) % 360) + 360) % 360) - 180;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
      const lonText = hi - lo > 300 ? '经度 全部' : `经度 ${f1(wrap(cLon + lo))} ~ ${f1(wrap(cLon + hi))}${cLon + lo < -180 || cLon + hi >= 180 ? '(跨 180° 经线)' : ''}`;
      const top = [...L.biome.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([b]) => BIOMES[b]?.name)
        .filter(Boolean);
      const pol = [...L.polities].sort((a, b) => a - b);
      out.push(
        `L${id} ${landName(id, L.n, Math.abs(cLat) >= 60)} · 占陆地 ${Math.max(1, Math.round((L.area / (landArea || 1)) * 100))}% · ` +
          `中心 ${ll([cLon, cLat])},纬度 ${f1(L.lat[0])} ~ ${f1(L.lat[1])},${lonText} · 多为${top.join('、')}` +
          (civ.viable ? ` · 第 ${Y} 年上面的国家:${pol.length ? pol.slice(0, 16).map((p) => `P${p}`).join('、') + (pol.length > 16 ? ' 等' : '') : '无'}` : ''),
      );
    }
  }

  // ---- 国家 ----
  const size = new Map<number, number>();
  for (let r = 0; r < reg.count; r++) if (own.polity[r] >= 0) size.set(own.polity[r], (size.get(own.polity[r]) ?? 0) + 1);
  const P = civ.polities;
  const alive = P.filter((p) => polityAlive(p, Y) && (size.get(p.id) ?? 0) > 0).sort((a, b) => (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0) || a.id - b.id);
  const later = P.filter((p) => p.founded > Y).sort((a, b) => a.founded - b.founded || a.id - b.id);
  const gone = P.filter((p) => !alive.includes(p) && !later.includes(p)).sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0) || a.id - b.id);
  const cityIds = new Set<number>();
  const S = civ.settlements;
  if (P.length) {
    out.push('', `## 国家(第 ${Y} 年在世的在前)`);
    const order = [...alive, ...later, ...gone];
    // 太多的只列前 80 个;排在后面、但作者点了名的也列上
    const listed = order.slice(0, 80);
    for (const p of order.slice(80)) if ([nameAt(p, Y), ...polityRoots(p), ...polityTitleChain(p).split(' → ')].some(named)) listed.push(p);
    for (const p of listed) {
      const chain = polityTitleChain(p);
      const cu = civ.cultures[p.culture];
      out.push(
        `P${p.id} ${nameAt(p, Y)} · 第 ${Math.floor(p.founded)}—${p.ended !== undefined ? `${Math.floor(p.ended)} 年` : `${civ.endYear} 年(到最后仍在)`}` +
          (chain.includes('→') ? ` · 国号先后:${chain}` : '') +
          (cu ? ` · 民族 E${cu.id}(${cu.name}族)` : ''),
      );
      if (alive.includes(p)) {
        const cap = capitalAt(p, Y);
        cityIds.add(cap);
        // 本国的几座大城(迁都用得上)
        S.filter((s) => s.id !== cap && own.polity[s.region] === p.id && stands(civ, s.id, Y))
          .sort((a, b) => populationAt(b, Y) - populationAt(a, Y) || a.id - b.id)
          .slice(0, 3)
          .forEach((s) => cityIds.add(s.id));
        const near = [...bordersAt(civ, own.polity, p.id)].sort((a, b) => a - b);
        const lm = reg.landmass[S[cap]?.region ?? 0];
        out.push(
          `  第 ${Y} 年:在世,${size.get(p.id)} 州,国都 C${cap} ${S[cap]?.name ?? ''} ${ll(cellLL(world, S[cap].cell))},在 L${lm};` +
            (near.length ? `邻国 ${near.map((q) => `P${q}`).join('、')}` : '没有接壤的国家'),
        );
      } else if (p.founded > Y) {
        cityIds.add(p.capital);
        out.push(`  第 ${Y} 年:还没立国;立国时国都 C${p.capital} ${S[p.capital]?.name ?? ''} ${ll(cellLL(world, S[p.capital].cell))}`);
      } else {
        const cap = capitalAt(p, lastYear(civ, p));
        cityIds.add(cap);
        out.push(`  第 ${Y} 年:已亡(${endText(civ, p) || '已亡'});最后的国都 C${cap} ${S[cap]?.name ?? ''} ${ll(cellLL(world, S[cap].cell))}`);
      }
    }
  }

  // ---- 城 ----
  for (const s of S) if (named(s.name)) cityIds.add(s.id);
  if (cityIds.size) {
    out.push('', '## 城(各国的国都、大城,和作者点了名的)');
    for (const id of [...cityIds].sort((a, b) => a - b)) {
      const s = S[id];
      if (!s) continue;
      let now: string;
      if (s.founded > Y) now = `还没建(第 ${Math.floor(s.founded)} 年建城)`;
      else if (s.ended !== undefined && s.ended <= Y) now = `已毁(第 ${Math.floor(s.ended)} 年)`;
      else {
        const o = own.polity[s.region];
        const isCap = o >= 0 && capitalAt(P[o], Y) === s.id;
        now = `${o >= 0 ? `属 P${o}${isCap ? ',是国都' : ''}` : '无主'},${populationLabel(populationAt(s, Y))}`;
      }
      out.push(`C${id} ${s.name} · ${ll(cellLL(world, s.cell))} · 在 R${s.region} ${regionLabel(civ, s.region)} · 第 ${Y} 年:${now}`);
    }
  }

  // ---- 点了名的州 ----
  const regs: number[] = [];
  for (let r = 0; r < reg.count && regs.length < 30; r++) if (regionNamed(civ, r) && named(regionLabel(civ, r))) regs.push(r);
  if (regs.length) {
    out.push('', '## 州(作者点了名的)');
    for (const r of regs) {
      const o = own.polity[r];
      const c = own.culture[r];
      const cities = S.filter((s) => s.region === r && stands(civ, s.id, Y)).map((s) => `C${s.id}`);
      out.push(
        `R${r} ${regionLabel(civ, r)} · 治所 ${ll(seatLL[r])} · 在 L${reg.landmass[r]} · 第 ${Y} 年:${o >= 0 ? `属 P${o}` : '无主'},` +
          `${c >= 0 ? `住着 E${c}` : '没人住'}${cities.length ? ` · 城 ${cities.slice(0, 4).join('、')}` : ''}`,
      );
    }
  }

  // ---- 民族 ----
  if (civ.cultures.length) {
    const n = new Map<number, number>();
    for (let r = 0; r < reg.count; r++) if (own.culture[r] >= 0) n.set(own.culture[r], (n.get(own.culture[r]) ?? 0) + 1);
    out.push('', '## 民族');
    for (const cu of civ.cultures) {
      const h = reg.seat[cu.hearth];
      out.push(
        `E${cu.id} ${cu.name}族 · ${KIND_INFO[cu.kind]?.name ?? ''} · 发源 ${h !== undefined ? ll(cellLL(world, h)) : ''} · 第 ${Math.floor(cu.born)} 年出现 · ` +
          `第 ${Y} 年 ${n.get(cu.id) ?? 0} 州${cu.ended !== undefined ? ` · 第 ${Math.floor(cu.ended)} 年消亡` : ''}`,
      );
    }
  }

  // ---- 山河湖海 ----
  const places = civ.places.map((p, i) => ({ p, i })).filter(({ p }) => p.path.length >= 2);
  const shown = places
    .slice()
    .sort((a, b) => b.p.rank - a.p.rank || a.i - b.i)
    .slice(0, 40);
  for (const x of places) if (!shown.includes(x) && named(x.p.name)) shown.push(x);
  if (shown.length) {
    out.push('', '## 山河湖海(重要的,和作者点了名的)');
    for (const { p, i } of shown.sort((a, b) => a.i - b.i)) out.push(`M${i} ${p.name}(${placeKindLabel(p)})· ${placeWhere(p)}`);
  }

  // ---- 已经做过的修改 ----
  const ivs = edits.interventions.map((v) => cleanIntervention(v)).filter((v): v is Intervention => !!v);
  const renamed = Object.keys(edits.names).length;
  if (ivs.length || renamed || edits.terrain.length) {
    out.push('', '## 已经做过的修改');
    for (const v of ivs.slice(0, 40)) out.push(`- 第 ${v.from} 年起:${ivText(civ, v)}`);
    if (renamed) out.push(`- 改过 ${renamed} 处名字(上面写的已经是新名字)`);
    for (const op of edits.terrain.slice(0, 20)) out.push(`- 改地形:${TERRAIN_NAME[op.kind]} ${opWhere(op)}`);
  }

  return { text: out.join('\n'), year: Y };
}

/** 地理实体在哪(给 AI 看的) */
function placeWhere(p: Place): string {
  const pt = (t: number): [number, number] => {
    const n = p.path.length >> 1;
    const i = Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
    return toLonLat(p.path[2 * i], p.path[2 * i + 1]);
  };
  const km = (p.size ?? 0) * KM_PER_UNIT;
  switch (p.kind) {
    case 'sea':
      return `在 ${ll(pt(0.5))} 一带`;
    case 'mountains':
      return `山脊 ${ll(pt(0))} → ${ll(pt(1))}${km > 0 ? `,长约 ${kmText(km)}` : ''}`;
    case 'river':
      return `流经 ${ll(pt(0))} → ${ll(pt(0.5))} → ${ll(pt(1))}`;
    default:
      return `在 ${ll(pt(0.5))}${km > 0 ? `,宽约 ${kmText(km * 2)}` : ''}`;
  }
}

const TERRAIN_NAME: Record<TerrainKind, string> = { volcano: '火山', range: '山脉', lake: '湖', raise: '抬起陆地', sink: '沉成海', river: '河' };

const opWhere = (op: TerrainOp) => {
  const n = op.pts.length >> 1;
  const a = ll(toLonLat(op.pts[0], op.pts[1]));
  return n > 1 ? `${a} → ${ll(toLonLat(op.pts[2 * n - 2], op.pts[2 * n - 1]))}` : a;
};

/** 已下的干预(给 AI 看的,用编号) */
function ivText(civ: Civ, v: Intervention): string {
  const id = (key: string, kind: KeyKind, tag: string) => {
    const r = resolveKey(civ, key);
    return r && r.kind === kind ? `${tag}${r.id}` : `(新历史里没有的${kind === 'polity' ? '国家' : '城'})`;
  };
  const reg = (key: string) => {
    const r = regionOfKey(key, keyCells(civ.regions));
    return r >= 0 && r < civ.regions.count ? `R${r}` : '(没有的州)';
  };
  const until = (u?: number) => (u !== undefined ? `,至第 ${u} 年` : '');
  switch (v.kind) {
    case 'protect':
      return `${id(v.a, 'polity', 'P')} 保护${until(v.until)}`;
    case 'unity':
      return `${id(v.a, 'polity', 'P')} 禁止分裂`;
    case 'halt':
      return `${id(v.a, 'polity', 'P')} 禁止扩张${until(v.until)}`;
    case 'ally':
      return `${id(v.a, 'polity', 'P')} 与 ${id(v.b, 'polity', 'P')} 结盟${until(v.until)}`;
    case 'declare':
      return `${id(v.a, 'polity', 'P')} 向 ${id(v.b, 'polity', 'P')} 宣战`;
    case 'move':
      return `${id(v.a, 'polity', 'P')} 迁都 ${id(v.city, 'settlement', 'C')}`;
    case 'cede':
      return `${reg(v.region)} 划给 ${id(v.a, 'polity', 'P')}${v.permanent ? '(永久)' : ''}`;
    case 'found':
      return `在 ${reg(v.region)} 立国${v.name ? `(号${v.name})` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// 提示词

/** 某种地形工具某一档的宽度(公里):火山 = 山体、湖 = 湖面、山脉 / 画笔 = 带子 */
const presetKm = (k: TerrainKind, i: number) => Math.round((2 * TERRAIN_PRESETS[k][i][0] * KM_PER_UNIT) / 50) * 50;
const sizesKm = (k: TerrainKind) => [0, 1, 2].map((i) => `${['小', '中', '大'][i]}约 ${presetKm(k, i)}`).join('、');

/** 能用的修改(op)和各自的规矩:改写和助手的提示词共用 */
export const REWRITE_OPS = [
  '### 历史命令:从 from 那一年的年初生效;那一年之前的历史一字不变,之后整段重新推演',
  '- protect 保护 country:国都攻不下,不会被灭、不会被并(国土照样会丢、会分裂、会改朝换代)。可给 until = 保护到哪一年为止,之后照常可能被灭',
  '- unity 禁止 country 分裂:不会有州叛离自立,也不会有遗民复国',
  '- halt 禁止 country 扩张:不进无主之地、不主动宣战、不并别国;被打照常防守。可给 until',
  '- ally country 与 other 结盟:两国不互相宣战,一方被打另一方多半出兵。可给 until',
  '- declare country 向 other 宣战:那一年两国必须接壤',
  '- move country 迁都到 city:那一年 city 必须在它的国土里',
  '- cede 把一州划给 country:用 region 指定州,或用 city 指定"这座城所在的州";permanent: true = 之后谁也夺不走',
  '- found 在一州立一个新国家(用 region 或 city 指定;材料里没列那一带的州时用 at = [经度, 纬度],会挑离它最近、那一年有人住的一州,不要自己编 R 编号;那一年州里要有人住);' +
    '可给 name = 国名,只写名字本身,不带"国""王国""王朝"之类的国号。作者没说年份时不要在最后几年立国(新国家来不及长大),挑一个早几百年、那一带有人住的年份',
  '命令下了就一直有效(给了 until 的到那一年为止)。后果由推演自己展开:你只能下命令,不能直接规定谁打赢、谁灭谁、哪年发生什么。',
  '',
  '### 改名:立即生效,历史不变',
  '- rename 把 target(P / C / R / E / M 编号)改叫 name。国家只写名字本身("秦""阿尔瑟"),国号由推演按国力配;民族不带"族"字',
  '',
  '### 改地形:整个世界按新地形重新生成,历史整个重来(命令和改名按位置尽量保留)。动静很大,只在作者明确要改地形、地貌或气候时用',
  '- volcano 在 at 放一座火山;放在海里 = 火山岛',
  '- lake 在 at 挖一个湖(要在陆地上;在同一批前面抬起的新陆地上也行,湖排在抬陆地的后面)',
  '- range 沿 path 抬起一道山脉;穿过海面的一段成岛链、半岛',
  '- raise 沿 path 把海抬成陆地(像用画笔涂一条带子)',
  '- sink 沿 path 把陆地沉成海',
  'at = [经度, 纬度];path = [[经度, 纬度], …],2 到 20 个点,按顺序连成一条线(山脉沿山脊走,画笔沿线涂)。',
  `size = "小" / "中" / "大"(山脉是低 / 中 / 高),宽度(公里):火山山体 ${sizesKm('volcano')};湖 ${sizesKm('lake')};山脉 ${sizesKm('range')};画笔带子 ${sizesKm('raise')}。`,
  '气候不能直接改,只能借地形:纬度 0–30° 吹东风,30–60° 吹西风,60° 以上吹东风;水汽从海上顺风吹来,遇山在迎风坡下雨,翻过山就干(雨影)。',
  '所以"让某地更干旱"可以在它的上风一侧拉一道山脉挡住水汽;"更湿润"可以在它的上风一侧沉出一片海湾。用这种办法时在 why 里说清楚。',
].join('\n');

export const REWRITE_SYSTEM = [
  '你是「文明与地图」里帮作者改世界的助手。这是一颗虚构的星球:地形由板块、侵蚀、气候生成,历史从第 0 年按规则推演到最后一年。',
  '作者用一句话说想怎么改(历史、名字或地形),你把它翻成下面这些"修改",列给作者确认,作者点了执行才生效。',
  '',
  '## 能用的修改(op)',
  '',
  REWRITE_OPS,
  '',
  '## 规则',
  '1. 国家、城、州、民族、山河只能用材料里的编号(P3、C12、R45、E2、M7);作者说的名字对不上任何一个,写进 cannot,不要编。',
  '2. from 是整数年份,要在那个国家存在的年份里(立国次年到亡国前一年;写成立国那年的会挪到次年),而且早于历史的最后一年。作者没说年份,就用材料开头写的默认年份;那一年这国还没立或已亡,挑一个合理的年份,在 why 里说。',
  '   例:"让它多撑三百年" → 从原本亡国前约 30 年起 protect,until = 原本亡国那年 + 300。',
  '3. 只做作者要的,不要额外加作者没提的事;一句话可以拆成几条修改。能用历史命令做到的,不要动地形。',
  '   同一次不要既改地形又下历史命令:地形一改历史整个重来,材料里的国家、城、年份就对不上了。作者两样都要时,这次只改地形,在 cannot 里说"地形改好后再说历史那部分"。',
  '4. 每条修改带 why:一句话(25 字以内)说为什么这样改,给作者看。',
  '5. 做不到、或只能做到一部分的,写进 cannot,一条一句话,说明原因;有替代做法就一并说。',
  '6. 作者是在提问或闲聊、不是要改时,edits 留空,在 reply 里回答。',
  '7. reply 用一两句话说打算怎么改。全部用中文。',
  '',
  '## 回复格式:只回一个 JSON 对象,不要别的文字',
  '{"reply":"…","edits":[' +
    '{"op":"protect","country":"P3","from":2400,"until":2750,"why":"…"},' +
    '{"op":"declare","country":"P3","other":"P5","from":1200,"why":"…"},' +
    '{"op":"move","country":"P3","city":"C12","from":1300,"why":"…"},' +
    '{"op":"found","city":"C40","from":1500,"name":"…","why":"…"},' +
    '{"op":"rename","target":"C12","name":"…","why":"…"},' +
    '{"op":"volcano","at":[35.5,12],"size":"中","why":"…"},' +
    '{"op":"range","path":[[10,40],[14,46],[16,52]],"size":"大","why":"…"}' +
    '],"cannot":["…"]}',
].join('\n');

/** 之前的一轮(给 AI 看前情) */
export interface RewriteTurn {
  wish: string;
  /** AI 当时的回复(一两句话) */
  reply?: string;
  /** AI 当时列的修改(一句一条) */
  items?: string[];
  /** 作者执行了没有 */
  applied?: boolean;
}

/** 这一轮的请求:材料 + 前几轮(最多 4 轮) + 作者这次说的话 */
export function rewriteRequest(mat: RewriteMaterial, history: readonly RewriteTurn[], wish: string): AiRequest {
  const w = cleanWish(wish);
  const parts = [mat.text];
  const prev = history.slice(-4);
  if (prev.length) {
    parts.push('', '# 之前的对话(世界已经按执行过的修改更新,上面的材料是现在的样子)');
    for (const t of prev) {
      parts.push(`作者:${cleanWish(t.wish)}`);
      if (t.reply || t.items?.length)
        parts.push(`你:${t.reply ?? ''}${t.items?.length ? `(列的修改:${t.items.join(';')})` : ''}${t.applied ? '—— 作者执行了' : '—— 作者没有执行'}`);
    }
  }
  parts.push('', '# 作者这次说', w);
  return {
    feature: REWRITE_FEATURE,
    title: [...w].length > 24 ? `${[...w].slice(0, 24).join('')}…` : w,
    messages: [
      { role: 'system', content: REWRITE_SYSTEM },
      { role: 'user', content: parts.join('\n') },
    ],
    json: true,
    temperature: 0.3,
    maxTokens: 2000,
  };
}

/** 作者的话:去掉控制字符,超长截断 */
export function cleanWish(s: string): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  const cs = [...t];
  return cs.length > WISH_MAX ? cs.slice(0, WISH_MAX).join('') : t;
}

// ---------------------------------------------------------------------------
// 解析与核对

/** 一条能执行的修改 */
export type RewriteChange =
  | { kind: 'intervention'; v: Intervention }
  | { kind: 'name'; key: string; name: string }
  | { kind: 'terrain'; op: TerrainOp };

export interface RewriteItem {
  /** AI 给的种类(protect / rename / volcano……;认不出的原样) */
  op: string;
  /** 能执行的修改;不合格 = null(原因在 problem) */
  change: RewriteChange | null;
  /** 一句话说这条修改:"大昌:保护(至第 2750 年)""在昌城以东约 300 公里放一座火山(中)" */
  text: string;
  /** 历史命令的生效年份 */
  year?: number;
  /** AI 说的理由 */
  why?: string;
  /** 不能执行的原因 */
  problem?: string;
  /** 给 AI 看的补充(立国:那一州在哪、多大、什么地貌、离给的位置多远),好让它核对是不是作者说的地方 */
  where?: string;
}

export type RewriteParse = { ok: true; reply: string; items: RewriteItem[]; cannot: string[] } | { ok: false; message: string };

/**
 * 锁住了哪一样:terrain = 世界建好了,地形定下来(只能下命令、改名);history = 还在新建,只能改地形(历史等创建以后)
 */
export type RewriteLock = 'terrain' | 'history';

const LOCKED: Record<RewriteLock, string> = {
  terrain: '世界建好以后地形不能再改;想换地形,在世界设定里「以它为底稿新建」',
  history: '还在新建世界:现在只能改地形,历史和名字等创建以后再改',
};

export interface RewriteContext {
  world: World;
  /** 套上了改名的这份历史(界面上看到的名字) */
  civ: Civ;
  /** 时间轴的年份(没写年份的命令从这一年起) */
  year: number;
  /** 现在的修改(查重、地形处数上限) */
  edits: WorldEdits;
  /** 锁住了哪一样(那一类修改照样列出来,写明原因,不能执行) */
  lock?: RewriteLock;
}

const str = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return '';
  const cs = [...v.replace(/\s+/g, ' ').trim()];
  return cs.length > max ? `${cs.slice(0, max).join('')}…` : cs.join('');
};

/** "P3""p3""P3 大昌""P3(大昌)" → 3;不是这一类的编号 = null */
function handleOf(v: unknown, tag: string): number | null {
  const s = typeof v === 'number' ? `${tag}${v}` : typeof v === 'string' ? v : '';
  const m = /^\s*([A-Za-z])\s*(\d{1,7})/.exec(s);
  return m && m[1].toUpperCase() === tag ? Number(m[2]) : null;
}

/** "2400""第 2400 年"、2400.6 → 2400;没给 / 认不出 = null */
function yearOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const m = /(-?\d{1,6})/.exec(v);
    if (m) return Number(m[1]);
  }
  return null;
}

/** [经度, 纬度](也认 {lon, lat}、"35.5, 12");认不出 = null */
function pointOf(v: unknown): [number, number] | null {
  let a: unknown = v;
  if (typeof v === 'string') a = v.split(/[,,\s]+/).filter(Boolean).map(Number);
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const o = a as Record<string, unknown>;
    a = [o.lon ?? o.lng ?? o.x ?? o['经度'], o.lat ?? o.y ?? o['纬度']];
  }
  if (!Array.isArray(a) || a.length < 2) return null;
  const lon = Number(a[0]);
  const lat = Number(a[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lon) > 540) return null;
  return [lon, lat];
}

/** 折线:[[经, 纬], …](也认平铺的 [经, 纬, 经, 纬, …]);最多 20 个点 */
function pathOf(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null;
  const out: [number, number][] = [];
  if (v.length && typeof v[0] === 'number') {
    for (let i = 0; i + 1 < v.length; i += 2) {
      const p = pointOf([v[i], v[i + 1]]);
      if (!p) return null;
      out.push(p);
    }
  } else {
    for (const x of v) {
      const p = pointOf(x);
      if (!p) return null;
      out.push(p);
    }
  }
  return out.length ? out.slice(0, 20) : null;
}

const SIZE_WORDS: Record<string, number> = { 小: 0, 低: 0, 细: 0, small: 0, low: 0, 中: 1, medium: 1, mid: 1, 大: 2, 高: 2, 粗: 2, large: 2, big: 2, high: 2 };
const sizeOf = (v: unknown): number => {
  if (typeof v === 'number' && v >= 0 && v <= 2) return Math.round(v);
  if (typeof v === 'string') {
    const k = v.trim().toLowerCase();
    if (k in SIZE_WORDS) return SIZE_WORDS[k];
    for (const [w, i] of Object.entries(SIZE_WORDS)) if (k.includes(w)) return i;
  }
  return 1;
};
const SIZE_LABEL: Record<TerrainKind, readonly [string, string, string]> = {
  volcano: ['小', '中', '大'],
  lake: ['小', '中', '大'],
  range: ['低', '中', '高'],
  raise: ['细', '中', '粗'],
  sink: ['细', '中', '粗'],
  river: ['小', '中', '大'],
};

/** AI 偶尔写中文的种类名 */
const OP_ALIAS: Record<string, string> = {
  保护: 'protect',
  不许灭: 'protect',
  禁止分裂: 'unity',
  禁止扩张: 'halt',
  不许扩张: 'halt',
  结盟: 'ally',
  宣战: 'declare',
  迁都: 'move',
  划州: 'cede',
  立国: 'found',
  改名: 'rename',
  火山: 'volcano',
  湖: 'lake',
  山脉: 'range',
  抬起陆地: 'raise',
  沉成海: 'sink',
  mountain: 'range',
  mountains: 'range',
};

const EDIT_KEYS = ['edits', 'changes', 'actions', '修改'];

/** 英文的修改种类、工具名 → 中文(AI 回给作者的话里偶尔夹着) */
const OP_WORDS: Record<string, string> = {
  protect: '保护',
  unity: '禁止分裂',
  halt: '禁止扩张',
  ally: '结盟',
  declare: '宣战',
  move: '迁都',
  cede: '划州',
  found: '立国',
  rename: '改名',
  volcano: '火山',
  lake: '湖',
  range: '山脉',
  raise: '抬起陆地',
  sink: '沉成海',
  try_edits: '试推演',
  propose_edits: '确认单',
};

/**
 * AI 回给作者的话里的编号、英文种类名换成名字和中文(提示词里叫它只说名字,偶尔还是会漏):
 * "保护 P9 到 2800 年" → "保护尼梅亚帝国到 2800 年";"尼梅亚帝国(P9)""P9 尼梅亚帝国" → "尼梅亚帝国";"protect" → "保护"。
 * 认不出的编号(这份历史里没有)原样留着
 */
export function plainIds(text: string, ctx: Pick<RewriteContext, 'world' | 'civ' | 'year'>): string {
  if (!text || !/[A-Za-z]/.test(text)) return text;
  const { world, civ } = ctx;
  const Y = Math.floor(Math.min(civ.endYear, Math.max(0, Number.isFinite(ctx.year) ? ctx.year : civ.endYear)));
  const reg = civ.regions;
  const nameOf = (tag: string, id: number): string => {
    if (tag === 'P') return civ.polities[id] ? nameAt(civ.polities[id], Y) : '';
    if (tag === 'C') return civ.settlements[id]?.name ?? '';
    if (tag === 'R') return id < reg.count ? regionLabel(civ, id) : '';
    if (tag === 'E') return civ.cultures[id] ? cultureLabel(civ.cultures[id]) : '';
    if (tag === 'M') return civ.places[id]?.name ?? '';
    // 陆块:和材料里一样叫"最大的大陆""小岛"……
    let n = 0;
    let lat = 0;
    for (let r = 0; r < reg.count; r++) {
      if (reg.landmass[r] !== id) continue;
      n++;
      lat += cellLL(world, reg.seat[r])[1];
    }
    return n ? landName(id, n, Math.abs(lat / n) >= 60) : '';
  };
  const ID = String.raw`[PCREML]\d{1,5}`;
  return (
    text
      // 括号里只有编号:整个去掉
      .replace(new RegExp(String.raw`\s*[(（]\s*${ID}(?:\s*[、,，/和与]\s*${ID})*\s*[)）]`, 'g'), '')
      // 剩下的编号换成名字;紧挨着已经写了这个名字的,只去掉编号
      .replace(new RegExp(String.raw`(?<![A-Za-z0-9_])([PCREML])(\d{1,5})(?![A-Za-z0-9_])`, 'g'), (m, tag: string, num: string, off: number, all: string) => {
        const name = nameOf(tag, Number(num));
        if (!name) return m;
        const before = all.slice(0, off).replace(/[\s:：]+$/, '');
        const after = all.slice(off + m.length).replace(/^[\s:：]+/, '');
        return before.endsWith(name) || after.startsWith(name) ? '' : name;
      })
      .replace(/\b(protect|unity|halt|ally|declare|move|cede|found|rename|volcano|lake|range|raise|sink|try_edits|propose_edits)\b/gi, (w) => OP_WORDS[w.toLowerCase()] ?? w)
      // 去掉编号以后留下的空格:汉字、标点和汉字之间的不要,连着几个的并成一个
      .replace(/([\u3000-\u9fff\uff00-\uffef,;:!?)])[ \t]+(?=[\u3400-\u9fff\uff00-\uffef(])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
  );
}

/** AI 回的 JSON → 能执行的修改(逐条核对;不合格的写明原因)。整段看不懂 = ok: false */
export function parseRewrite(text: string, ctx: RewriteContext): RewriteParse {
  const v = looseJson(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, message: 'AI 回的内容看不懂,再试一次' };
  const o = v as Record<string, unknown>;
  const reply = plainIds(str(o.reply ?? o.answer ?? o['回复'], 300), ctx);
  let list: unknown[] = [];
  for (const k of EDIT_KEYS) if (Array.isArray(o[k])) list = o[k] as unknown[];
  const cannotRaw = o.cannot ?? o['做不到'];
  const cannot = (Array.isArray(cannotRaw) ? cannotRaw : typeof cannotRaw === 'string' ? [cannotRaw] : [])
    .map((x) => plainIds(str(x, 160), ctx))
    .filter(Boolean)
    .slice(0, 6);
  if (!reply && !list.length && !cannot.length) return { ok: false, message: 'AI 没给出修改,换个说法再试一次' };
  const chk = new Checker(ctx);
  const items = list.slice(0, REWRITE_MAX_ITEMS).map((x) => chk.item(x));
  if (list.length > REWRITE_MAX_ITEMS) cannot.push(`AI 列了 ${list.length} 条修改,一次最多 ${REWRITE_MAX_ITEMS} 条,后面的没收`);
  return { ok: true, reply, items, cannot };
}

/** 逐条核对(同一批里查重、数地形处数) */
class Checker {
  private readonly owners = new Map<number, Owners>();
  private readonly seen = new Set<string>();
  private terrainLeft: number;
  /** 这一批里已经收下的地形修改(核对湖的位置要算上它们) */
  private readonly batchTerrain: TerrainOp[] = [];
  constructor(private readonly ctx: RewriteContext) {
    for (const x of ctx.edits.interventions) this.seen.add(JSON.stringify(cleanIntervention(x)));
    this.terrainLeft = TERRAIN_MAX_OPS - ctx.edits.terrain.length;
  }

  private own(y: number): Owners {
    let o = this.owners.get(y);
    if (!o) this.owners.set(y, (o = ownersAt(this.ctx.civ, y)));
    return o;
  }

  item(x: unknown): RewriteItem {
    if (!x || typeof x !== 'object') return { op: '?', change: null, text: '一条看不懂的修改', problem: 'AI 写的格式不对' };
    const o = x as Record<string, unknown>;
    const raw = str(o.op ?? o.kind ?? o.type ?? o['种类'], 20);
    const op = OP_ALIAS[raw] ?? OP_ALIAS[raw.toLowerCase()] ?? raw.toLowerCase();
    const why = plainIds(str(o.why ?? o.reason ?? o['理由'], 80), this.ctx) || undefined;
    const r = this.check(op, o);
    return { op, why, ...r };
  }

  private check(op: string, o: Record<string, unknown>): Omit<RewriteItem, 'op' | 'why'> {
    const r = this.checkOp(op, o);
    const terrain = op === 'volcano' || op === 'lake' || op === 'range' || op === 'raise' || op === 'sink';
    const lock = this.ctx.lock;
    // 锁住的那一类:照样列出来(写的是哪一条看得懂),不能执行
    if (lock && r.change && (lock === 'terrain') === terrain) return { ...r, change: null, problem: LOCKED[lock] };
    return r;
  }

  private checkOp(op: string, o: Record<string, unknown>): Omit<RewriteItem, 'op' | 'why'> {
    switch (op) {
      case 'protect':
      case 'unity':
      case 'halt':
      case 'ally':
      case 'declare':
      case 'move':
      case 'cede':
      case 'found':
        return this.command(op, o);
      case 'rename':
        return this.rename(o);
      case 'volcano':
      case 'lake':
      case 'range':
      case 'raise':
      case 'sink':
        return this.terrain(op, o);
      default:
        return { change: null, text: `「${op || '?'}」`, problem: '没有这种修改' };
    }
  }

  // ---- 历史命令 ----

  private command(kind: Intervention['kind'], o: Record<string, unknown>): Omit<RewriteItem, 'op' | 'why'> {
    const { civ } = this.ctx;
    const P = civ.polities;
    // 没写年份 = 时间轴的年份;时间轴在最后一年(刚打开时就是)= 前一年(命令最晚从那一年起)
    const given = yearOf(o.from ?? o.year ?? o['年份']);
    const asked = given === null || given === civ.endYear ? defaultFrom(civ, given ?? this.ctx.year) : given;
    // 立国那年下的命令挪到次年:命令在年初生效,立国那年的年初它还没立国,命令会落空(立国正好在年初那一刻也一样)
    let late = '';
    const firstYear = (v: unknown): number => {
      const id = handleOf(v, 'P');
      const p = id !== null ? P[id] : undefined;
      if (!p || asked < Math.floor(p.founded) || asked > p.founded) return asked;
      late = nameAt(p, p.founded);
      return Math.floor(p.founded) + 1;
    };
    const from =
      kind === 'found'
        ? asked
        : Math.max(firstYear(o.country ?? o.a ?? o.polity ?? o['国家']), kind === 'ally' || kind === 'declare' ? firstYear(o.other ?? o.b ?? o.target ?? o['对方']) : asked);
    const movedNote = from !== asked ? `${late}第 ${asked} 年才立国,那年年初还不在,命令改从第 ${from} 年起` : undefined;
    const untilRaw = yearOf(o.until ?? o.to ?? o['截止']);
    const fail = (text: string, problem: string) => ({ change: null, text, year: from, problem, ...(movedNote ? { where: movedNote } : {}) });
    const label = KIND_LABEL[kind];
    if (!civ.viable || !P.length) return fail(label, '这个世界没有文明');
    if (!(from >= 0 && from < civ.endYear)) return fail(label, `年份要在第 0—${civ.endYear - 1} 年之间`);
    const own = this.own(from);
    const pol = (v: unknown, who: string): { id: number; name: string } | string => {
      const id = handleOf(v, 'P');
      if (id === null) return `没说是哪个${who}`;
      const p = P[id];
      if (!p) return `材料里没有 P${id}`;
      const name = nameAt(p, from);
      if (from < p.founded) return `第 ${from} 年${name}还没立国(第 ${Math.floor(p.founded)} 年立国)`;
      if (p.ended !== undefined && from >= p.ended) return `第 ${from} 年${name}已亡(亡于第 ${Math.floor(p.ended)} 年)`;
      return { id, name };
    };
    /** 州:region 或 city 所在的州;立国也认 at(离这一点最近、那一年有人住的一州) */
    const regionOf = (): { r: number; name: string; at?: [number, number] } | string => {
      const rid = handleOf(o.region, 'R');
      const cid = handleOf(o.city ?? o.region, 'C');
      const r = rid !== null ? rid : cid !== null ? (civ.settlements[cid]?.region ?? -1) : null;
      if (r === null && kind === 'found') {
        const at = pointOf(o.at ?? o.point ?? o.position);
        if (at) return this.peopledNear(at, own);
      }
      if (r === null) return '没说是哪一州';
      if (!(r >= 0 && r < civ.regions.count)) return '材料里没有这一州';
      return { r, name: regionLabel(civ, r) };
    };
    let v: Intervention;
    let text: string;
    let where = movedNote;
    const untilOk = untilRaw !== null && untilRaw > from ? Math.min(untilRaw, 65535) : undefined;
    const untilText = untilOk !== undefined ? `(至第 ${untilOk} 年)` : '';
    // 挪到次年以后截止年份不在开始之后(原本给的是一年期的命令):不能当成没给截止、变成一直有效
    if (movedNote && untilRaw !== null && untilRaw > asked && untilRaw <= from && (kind === 'protect' || kind === 'halt' || kind === 'ally'))
      return fail(label, `命令最早从第 ${from} 年起,到第 ${untilRaw} 年为止一年也管不到`);
    if (kind === 'found') {
      const R = regionOf();
      if (typeof R === 'string') return fail('立国', R);
      const name = typeof o.name === 'string' ? cleanName('polity', o.name) : '';
      text = `在${R.name}立国${name ? `,国名「${name}」` : ''}`;
      where = this.regionWhere(R.r, own, from, R.at);
      if (own.culture[R.r] < 0) return { ...fail(text, `第 ${from} 年${R.name}没人住,立不成`), where };
      v = name ? { kind, region: regionKey(civ, R.r), from, name } : { kind, region: regionKey(civ, R.r), from };
    } else {
      const A = pol(o.country ?? o.a ?? o.polity ?? o['国家'], '国家');
      if (typeof A === 'string') return fail(label, A);
      const a = polityKey(civ, A.id);
      if (kind === 'protect' || kind === 'halt') {
        text = `${A.name}:${label}${untilText}`;
        v = untilOk !== undefined ? { kind, a, from, until: untilOk } : { kind, a, from };
      } else if (kind === 'unity') {
        text = `${A.name}:${label}`;
        v = { kind, a, from };
      } else if (kind === 'ally' || kind === 'declare') {
        const B = pol(o.other ?? o.b ?? o.target ?? o['对方'], '对方国家');
        if (typeof B === 'string') return fail(`${A.name}${label}`, B);
        if (B.id === A.id) return fail(`${A.name}${label}`, '要两个不同的国家');
        const b = polityKey(civ, B.id);
        if (kind === 'ally') {
          text = `${A.name}与${B.name}结盟${untilText}`;
          v = untilOk !== undefined ? { kind, a, b, from, until: untilOk } : { kind, a, b, from };
        } else {
          text = `${A.name}向${B.name}宣战`;
          if (!bordersAt(civ, own.polity, A.id).has(B.id)) return fail(text, `第 ${from} 年两国不接壤,打不起来`);
          v = { kind, a, b, from };
        }
      } else if (kind === 'move') {
        const cid = handleOf(o.city ?? o.target, 'C');
        const s = cid !== null ? civ.settlements[cid] : undefined;
        if (!s) return fail(`${A.name}迁都`, cid === null ? '没说迁到哪座城' : `材料里没有 C${cid}`);
        text = `${A.name}迁都${s.name}`;
        if (!stands(civ, s.id, from)) return fail(text, s.founded > from ? `第 ${from} 年${s.name}还没建` : `第 ${from} 年${s.name}已毁`);
        if (own.polity[s.region] !== A.id) return fail(text, `第 ${from} 年${s.name}不在${A.name}的国土里`);
        if (capitalAt(P[A.id], from) === s.id) return fail(text, `${s.name}那一年本来就是国都`);
        v = { kind, a, city: settlementKey(civ, s.id), from };
      } else {
        const R = regionOf();
        if (typeof R === 'string') return fail(`划州给${A.name}`, R);
        const permanent = o.permanent === true || o.permanent === 'true';
        text = `${R.name}划给${A.name}${permanent ? '(永久)' : ''}`;
        if (own.culture[R.r] < 0) return fail(text, `第 ${from} 年${R.name}没人住,划不成`);
        if (own.polity[R.r] === A.id) return fail(text, `第 ${from} 年${R.name}本来就是${A.name}的`);
        v = permanent ? { kind: 'cede', a, region: regionKey(civ, R.r), from, permanent: true } : { kind: 'cede', a, region: regionKey(civ, R.r), from };
      }
    }
    const c = cleanIntervention(v);
    if (!c) return fail(text, '格式不对');
    const k = JSON.stringify(c);
    if (this.seen.has(k)) return { ...fail(text, '已经下过这条命令'), ...(where ? { where } : {}) };
    this.seen.add(k);
    return { change: { kind: 'intervention', v: c }, text, year: from, ...(where ? { where } : {}) };
  }

  /** 离 at 最近、那一年有人住的一州(at 落在有人住的州里 = 就是它);一千五百公里内都没有 = 说明原因 */
  private peopledNear(at: [number, number], own: Owners): { r: number; name: string; at: [number, number] } | string {
    const { world, civ } = this.ctx;
    const reg = civ.regions;
    const cell = nearestCell(world, at);
    const r0 = cell >= 0 ? reg.of[cell] : -1;
    if (r0 >= 0 && own.culture[r0] >= 0) return { r: r0, name: regionLabel(civ, r0), at };
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r < reg.count; r++) {
      if (own.culture[r] < 0) continue;
      const d = distKm(at, cellLL(world, reg.seat[r]));
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    const here = `${ll(at)} 一带`;
    if (best < 0) return `${here}没人住,整个世界那一年也没有有人住的州`;
    if (bd > NEAR_KM) return `${here}没人住;最近有人住的州是 R${best} ${regionLabel(civ, best)},在它${dirWord(at, cellLL(world, reg.seat[best]))}约 ${kmText(bd)}`;
    return { r: best, name: regionLabel(civ, best), at };
  }

  /** 一州在哪(给 AI 核对):"R702 在 (−43.6, 31.8),一座小岛(2 块地),多为稀树草原,第 2999 年是部落地带;离给的位置约 300 公里" */
  private regionWhere(r: number, own: Owners, year: number, at?: [number, number]): string {
    const { world, civ } = this.ctx;
    const reg = civ.regions;
    const p = cellLL(world, reg.seat[r]);
    let n = 0;
    for (let q = 0; q < reg.count; q++) if (reg.landmass[q] === reg.landmass[r]) n++;
    const owner = own.polity[r];
    const who = own.culture[r] < 0 ? '没人住' : owner >= 0 ? `属 P${owner} ${nameAt(civ.polities[owner], year)}` : '是部落地带';
    const far = at ? distKm(at, p) : 0;
    return (
      `R${r} 在 ${ll(p)},${landName(reg.landmass[r], n, Math.abs(p[1]) >= 60)}(这块陆地 ${n} 州)上,多为${BIOMES[reg.biome[r]]?.name ?? '?'},第 ${year} 年${who}` +
      (at && far >= 50 ? `;离给的位置 ${ll(at)} 约 ${kmText(far)}` : '')
    );
  }

  // ---- 改名 ----

  private rename(o: Record<string, unknown>): Omit<RewriteItem, 'op' | 'why'> {
    const { civ } = this.ctx;
    const t = o.target ?? o.of ?? o.country ?? o.city ?? o['对象'];
    const want = typeof o.name === 'string' ? o.name : typeof o.to === 'string' ? o.to : '';
    const Y = Math.floor(this.ctx.year);
    let key = '';
    let old = '';
    let name = '';
    const fail = (text: string, problem: string) => ({ change: null, text, problem });
    const tag = typeof t === 'string' ? t.trim().charAt(0).toUpperCase() : '';
    const id = tag ? handleOf(t, tag) : null;
    if (id === null) return fail(`改名为「${str(want, 16)}」`, '没说改哪个名字');
    if (tag === 'P' && civ.polities[id]) {
      const p = civ.polities[id];
      const di = p.eastern ? dynastyIndexAt(p, Math.min(Math.max(Y, p.founded), lastYear(civ, p))) : 0;
      if (di > 0) {
        key = dynastyKey(civ, id, di);
        name = cleanName('dynasty', want, true);
        old = polityRootAt(p, p.dynasties![di].year);
      } else {
        key = polityKey(civ, id);
        name = cleanName('polity', want);
        old = p.name;
      }
    } else if (tag === 'C' && civ.settlements[id]) {
      key = settlementKey(civ, id);
      name = cleanName('settlement', want);
      old = civ.settlements[id].name;
    } else if (tag === 'R' && id < civ.regions.count) {
      key = regionKey(civ, id);
      name = cleanName('region', want);
      old = regionLabel(civ, id);
    } else if (tag === 'E' && civ.cultures[id]) {
      key = cultureKey(civ, id);
      name = cleanName('culture', want);
      old = `${civ.cultures[id].name}族`;
    } else if (tag === 'M' && civ.places[id]) {
      key = placeKeyOf(civ, id);
      name = cleanName('place', want);
      old = civ.places[id].name;
    } else return fail(`改名为「${str(want, 16)}」`, `材料里没有 ${tag}${id}`);
    const text = `${old}改名为「${name || str(want, 16)}」`;
    if (!name) return fail(text, '新名字是空的');
    if (name === old || (tag === 'E' && `${name}族` === old)) return fail(text, '和现在的名字一样');
    if (this.seen.has(`name:${key}`)) return fail(text, '同一个名字改了两次');
    this.seen.add(`name:${key}`);
    return { change: { kind: 'name', key, name }, text };
  }

  // ---- 改地形 ----

  private terrain(kind: TerrainKind, o: Record<string, unknown>): Omit<RewriteItem, 'op' | 'why'> {
    const { world } = this.ctx;
    const pts = isPointKind(kind) ? (() => {
          const p = pointOf(o.at ?? o.point ?? o.pos ?? o.position ?? (Array.isArray(o.path) ? o.path[0] : undefined));
          return p ? [p] : null;
        })()
      : pathOf(o.path ?? o.points ?? o.line ?? (o.at !== undefined ? [o.at] : undefined));
    const size = sizeOf(o.size ?? o.scale ?? o['大小']);
    const sizeText = `(${SIZE_LABEL[kind][size]})`;
    const fail = (text: string, problem: string) => ({ change: null, text, problem });
    if (!pts) return fail(`${TERRAIN_NAME[kind]}${sizeText}`, isPointKind(kind) ? '没给位置' : '没给路线');
    if (kind === 'range' && pts.length < 2) return fail(`山脉${sizeText}`, '山脉要至少两个点连成线');
    const a = this.where(pts[0]);
    const b = pts.length > 1 ? this.where(pts[pts.length - 1]) : a;
    const text =
      kind === 'volcano'
        ? `在${a}放一座火山${sizeText}`
        : kind === 'lake'
          ? `在${a}挖一个湖${sizeText}`
          : kind === 'range'
            ? `从${a}到${b}抬起一道山脉${sizeText}`
            : `把${pts.length > 1 ? `${a}到${b}` : a}一带${kind === 'raise' ? '抬成陆地' : '沉成海'}${sizeText}`;
    if (kind === 'lake') {
      // 同一批前面抬起陆地、堆山、放火山的地方,现在是海也可能到时候成了陆地:这里不拦,生成时湖心落在海里就不挖;
      // 前面沉成海的地方,现在是陆地也挖不成
      const [x, y] = toWorld(pts[0][0], pts[0][1]);
      const raised = this.batchTerrain.some((op) => op.kind !== 'sink' && op.kind !== 'lake' && distToOp(x, y, op) < op.r * 1.5);
      const sunk = this.batchTerrain.some((op) => op.kind === 'sink' && distToOp(x, y, op) < op.r);
      const c = nearestCell(world, pts[0]);
      if (!raised && sunk) return fail(text, '同一批前面把这里沉成了海,湖要挖在陆地上');
      if (!raised && c >= 0 && world.water[c] === 1) return fail(text, '这里是海,湖要挖在陆地上');
    }
    if (this.terrainLeft <= 0) return fail(text, `改地形最多 ${TERRAIN_MAX_OPS} 处,已经满了`);
    const [r, s] = TERRAIN_PRESETS[kind][size];
    const op = cleanTerrainOp({ kind, pts: pts.flatMap((p) => toWorld(p[0], p[1])), r, s });
    if (!op) return fail(text, '位置不对');
    this.terrainLeft--;
    this.batchTerrain.push(op);
    return { change: { kind: 'terrain', op }, text };
  }

  private anchors: { name: string; p: [number, number] }[] | null = null;

  /** 一个位置的说法:"昌城以东约 300 公里""昌城一带";在海上的加"(海上)" */
  private where(p: readonly [number, number]): string {
    const { world, civ } = this.ctx;
    if (!this.anchors) {
      const Y = Math.floor(this.ctx.year);
      this.anchors = civ.settlements.filter((s) => stands(civ, s.id, Y)).map((s) => ({ name: s.name, p: cellLL(world, s.cell) }));
      if (!this.anchors.length)
        this.anchors = civ.places.filter((x) => x.kind !== 'sea' && x.cell !== undefined).map((x) => ({ name: x.name, p: cellLL(world, x.cell!) }));
    }
    let best: { name: string; p: [number, number] } | null = null;
    let bd = Infinity;
    for (const a of this.anchors) {
      const d = distKm(a.p, p);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    const c = nearestCell(world, p);
    const sea = c >= 0 && world.water[c] === 1 ? '(海上)' : '';
    if (!best || bd > 2500) return `${p[1] >= 0 ? '北纬' : '南纬'} ${f1(Math.abs(p[1]))}°、${p[0] >= 0 ? '东经' : '西经'} ${f1(Math.abs(p[0]))}° 一带${sea}`;
    if (bd < 60) return `${best.name}一带${sea}`;
    return `${best.name}以${dirWord(best.p, p)}约 ${kmText(bd)}${sea}`;
  }
}

const KIND_LABEL: Record<Intervention['kind'], string> = {
  protect: '保护',
  unity: '禁止分裂',
  halt: '禁止扩张',
  ally: '结盟',
  declare: '宣战',
  move: '迁都',
  cede: '划州',
  found: '立国',
};

// ---------------------------------------------------------------------------
// 合进修改 / 撤销

/** 把选中的几条修改合进 edits(一次 setEdits:干预、地形只重推 / 重新生成一回)。已有的跳过;什么都没变 = 原对象 */
export function mergeRewrite(edits: WorldEdits, changes: readonly RewriteChange[]): WorldEdits {
  let names = edits.names;
  let interventions = edits.interventions;
  let terrain = edits.terrain;
  for (const c of changes) {
    if (c.kind === 'name') {
      if (names[c.key] === c.name) continue;
      if (names === edits.names) names = { ...names };
      names[c.key] = c.name;
    } else if (c.kind === 'intervention') {
      const v = cleanIntervention(c.v);
      if (!v) continue;
      const k = JSON.stringify(v);
      if (interventions.some((x) => JSON.stringify(x) === k)) continue;
      interventions = [...interventions, v];
    } else {
      const op = cleanTerrainOp(c.op);
      if (!op || terrain.length >= TERRAIN_MAX_OPS) continue;
      terrain = [...terrain, op];
    }
  }
  return names === edits.names && interventions === edits.interventions && terrain === edits.terrain ? edits : { ...edits, names, interventions, terrain };
}

/** 去掉 list 里和 drop 一样的那几条(各去一次) */
function without<T>(list: readonly T[], drop: readonly T[]): T[] {
  const left = drop.map((x) => JSON.stringify(x));
  return list.filter((x) => {
    const i = left.indexOf(JSON.stringify(x));
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/**
 * 撤销一批改写:now = 现在的修改,before / after = 这一批执行前后。之后没再改过 = 直接回到 before;
 * 改过别的 = 只拿掉这一批加的干预、地形,改过的名字恢复成执行前的(之后又被改过的名字不动)
 */
export function unmergeRewrite(now: WorldEdits, before: WorldEdits, after: WorldEdits): WorldEdits {
  if (now === after) return before;
  const addedIv = without(after.interventions, before.interventions);
  const addedT = without(after.terrain, before.terrain);
  let names = now.names;
  for (const k of Object.keys(after.names)) {
    if (after.names[k] === before.names[k] || now.names[k] !== after.names[k]) continue;
    if (names === now.names) names = { ...names };
    if (k in before.names) names[k] = before.names[k];
    else delete names[k];
  }
  const interventions = addedIv.length ? without(now.interventions, addedIv) : now.interventions;
  const terrain = addedT.length ? without(now.terrain, addedT) : now.terrain;
  return names === now.names && interventions.length === now.interventions.length && terrain.length === now.terrain.length
    ? now
    : { ...now, names, interventions, terrain };
}

// ---------------------------------------------------------------------------
// 测试用假 AI(网址 ai=mock)

/**
 * 假 AI 的固定提议(不理解话的意思,只看有没有地形的字眼):话里有"火山 / 山 / 湖 / 海 / 陆 / 岛"= 在第 year 年最大的国家
 * 国都以东约 600 公里放一座火山;否则 = 这个国家从这一年起保护 300 年。没有文明的世界只放火山(经度 0、纬度 0)
 */
export function mockRewrite(ctx: RewriteContext, wish = ''): string {
  const { civ, world } = ctx;
  const Y = Math.floor(Math.min(civ.endYear - 1, Math.max(0, ctx.year)));
  const own = ownersAt(civ, Y);
  const size = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r++) if (own.polity[r] >= 0) size.set(own.polity[r], (size.get(own.polity[r]) ?? 0) + 1);
  const big = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const edits: Record<string, unknown>[] = [];
  const terrain = big === undefined || /火山|山|湖|海|陆|岛/.test(wish);
  if (!terrain) {
    const until = Y + 300 < civ.endYear ? Y + 300 : undefined;
    edits.push({ op: 'protect', country: `P${big}`, from: Y, ...(until !== undefined ? { until } : {}), why: '测试用假 AI 的示例' });
  } else {
    let at: [number, number] = [0, 0];
    const cap = big !== undefined ? civ.settlements[capitalAt(civ.polities[big], Y)] : undefined;
    if (cap) {
      const [lon, lat] = cellLL(world, cap.cell);
      at = [Math.round((lon + 600 / (111 * Math.max(0.2, Math.cos(lat * RAD)))) * 10) / 10, Math.round(lat * 10) / 10];
    }
    edits.push({ op: 'volcano', at, size: '中', why: '测试用假 AI 的示例' });
  }
  return JSON.stringify({
    reply: '【测试用假 AI】这是一份固定的示例提议,用来检查界面和流程,不代表真实效果。',
    edits,
    cannot: ['测试用假 AI 不理解你说的话,只给固定的示例'],
  });
}
