/**
 * 极端参数压力测试:npx tsx scripts/stress.ts(出现 NaN 则退出码 1)
 * 每行打印:生成 / 铺像素 / 文明(其中宜居度 + 划州、推演(民族 + 城镇 + 国家 + 战争)、回放一帧、道路)耗时,
 * 州数、民族数、占据率、国家数、城镇数、路段数,战争统计(场数、攻占、灭亡、迁都、飞地、易手频繁的州),
 * 分合统计(分裂、合并、复国、主动迁都),王朝更替(东方改朝换代 / 西幻王室更迭),信仰(大教、教派、宗教大事),
 * 以及 36k 默认精细度下的生成总时长。
 * 改地形(阶段 4):几组极端的地形修改(最大最强的火山 / 山脉铺满全图、两极的湖、跨 180° 经线的笔画、整片沉成海 / 抬成陆地)。
 * 草图:一片陆地也没画的"都是海"(整颗星球是海)、满图涂成山地、跨 180° 经线和两极的大杂烩(再叠上地形修改)。
 * 地形大事:半路整颗星球沉入海中、整片抬成陆地、五件最大最强的火山(有同一年的、第 1 年和第 2999 年的),
 * 各段的州和那时的地形对得上,大事以后的城、国家、信仰、编年史照样合法。
 */
import { generateWorld, DEFAULT_PARAMS } from '../src/gen/world';
import { rasterize } from '../src/gen/raster';
import { planetTempo } from '../src/gen/civ';
import { simulation } from '../src/simulation/simulation';
import { Biome } from '../src/gen/biomes';
import { ownersAt } from '../src/gen/civ/timeline';
import { HABITABLE_SUIT } from '../src/gen/civ/cultures';
import { labelImage, pixelRegions, washPixels } from '../src/render/civ/territory';
import { borderLines } from '../src/render/civ/borders';
import { CIV_SHOW_OFF } from '../src/render/civ/overlay';
import { warFront, warMarkPoints, warSpans } from '../src/render/civ/warfare';
import { capitalAt, populationAt } from '../src/gen/civ/growth';
import { warStats } from '../src/gen/civ/wars';
import { politicsStats } from '../src/gen/civ/politics';
import { dynastyStats } from '../src/gen/civ/dynasty';
import { assimStats } from '../src/gen/civ/assimilation';
import { cityStats } from '../src/gen/civ/cities';
import { Layer } from '../src/gen/civ/types';
import { faithAt, faithFromScratch } from '../src/gen/civ/religion';
import { civLabelItems, civMapLayer, labelViewExtras } from '../src/render/civ/labels';
import { placeMap } from '../src/render/labels/draw';
import type { TerrainOp, Upheaval } from '../src/gen/edits';
import { upheavalSteps } from '../src/gen/civ/upheaval';
import { buildChronicle } from '../src/gen/civ/chronicle';
import { sketchGrid, type SketchEdit, type SketchKind } from '../src/gen/sketch';

/** 极端的地形修改:大杂烩(最大最强的火山、横贯全图的山脉、角上 / 海里的湖、画笔)、整片沉成海、整片抬成陆地 */
const rows = (kind: 'sink' | 'raise'): TerrainOp[] => [0, 200, 400, 600, 800, 1000].map((y) => ({ kind, pts: [0, y, 1024, y + 30, 2048, y], r: 160, s: 2 }));
const MIX: TerrainOp[] = [
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((k): TerrainOp => ({ kind: 'volcano', pts: [k * 290, (k * 397) % 1024], r: 160, s: 2 })),
  { kind: 'volcano', pts: [2048, 1024], r: 3, s: 0.2 },
  { kind: 'range', pts: [0, 512, 700, 300, 1400, 700, 2048, 512], r: 160, s: 2 },
  { kind: 'range', pts: [1024, 0, 1024, 1024], r: 3, s: 2 },
  { kind: 'range', pts: [500, 500], r: 40, s: 1 },
  { kind: 'lake', pts: [0, 0], r: 160, s: 2 },
  { kind: 'lake', pts: [1024, 512], r: 160, s: 2 },
  { kind: 'lake', pts: [300, 300], r: 3, s: 0.2 },
  { kind: 'sink', pts: [200, 200, 1800, 800], r: 100, s: 2 },
  { kind: 'raise', pts: [1800, 200, 200, 800], r: 100, s: 2 },
  // 跨 180° 经线的笔画(x 超出地图、从负数开始)
  { kind: 'range', pts: [1990, 300, 2100, 330, 2200, 360], r: 60, s: 2 },
  { kind: 'raise', pts: [-40, 700, 60, 720], r: 50, s: 1 },
];

/** 极端的草图:满图一行行涂同一种笔(半径最大) */
const fill = (kind: SketchKind, rest: SketchEdit['rest'] = 'auto'): SketchEdit => ({
  rest,
  strokes: Array.from({ length: 5 }, (_, k) => ({ kind, r: 128, pts: [-100, k * 230, 1024, k * 230 + 40, 2148, k * 230] })),
});
const SKETCH_MIX: SketchEdit = {
  rest: 'sea',
  strokes: [
    { kind: 'land', r: 128, pts: [1900, 400, 2150, 450, 2300, 500] },
    { kind: 'mountain', r: 4, pts: [1950, 420, 2100, 470] },
    { kind: 'land', r: 100, pts: [0, 0, 2048, 0] },
    { kind: 'mountain', r: 60, pts: [500, 1024] },
    { kind: 'land', r: 4, pts: [1000, 512] },
    { kind: 'sea', r: 30, pts: [2000, 440, 2100, 460] },
    { kind: 'erase', r: 50, pts: [1024, 0] },
    { kind: 'isles', r: 160, pts: [600, 600, 900, 650] },
    { kind: 'shelf', r: 90, pts: [700, 300] },
    { kind: 'hills', r: 2, pts: [1900, 420] },
    { kind: 'plateau', r: 160, pts: [1950, 460, 2200, 480] },
    { kind: 'mountain', r: 30, pts: [2000, 470, 2050, 480], h: 2 },
    { kind: 'sea', r: 10, pts: [1950, 420, 2100, 420, 2100, 520, 1950, 520], fill: 1 },
    { kind: 'land', r: 2, pts: [0, 1024, 2048, 1024, 1024, 0], fill: 1 },
  ],
};

const cases = [
  {}, { landFraction: 0.12 }, { landFraction: 0.6 }, { plates: 5 }, { plates: 30 }, { plates: 60 },
  { cells: 200000 }, { cells: 12000 }, { temperature: -12 }, { temperature: 12 }, { rainfall: 0.4 }, { mountains: 2 }, { mountains: 0.2 },
  { terrain: MIX }, { terrain: rows('sink') }, { terrain: rows('raise') },
  { sketch: { rest: 'sea', strokes: [] } }, { sketch: fill('mountain') }, { sketch: fill('land', 'sea') }, { sketch: fill('isles', 'sea') }, { sketch: fill('plateau') },
  { sketch: { ...SKETCH_MIX, coast: 0 }, terrain: MIX }, { sketch: SKETCH_MIX, terrain: [...MIX, { kind: 'river', pts: [1950, 420, 2150, 470, 2300, 500], r: 9, s: 1 }] },
] as ({ terrain?: TerrainOp[]; sketch?: SketchEdit } & Partial<typeof DEFAULT_PARAMS>)[];
/** 打印用:改地形的只写"改地形 · 几处",草图只写"草图 · 几笔" */
const caseName = (c: (typeof cases)[number]) =>
  c.sketch
    ? `{"草图":"${c.sketch.rest === 'sea' ? '都是海' : '交给程序'} ${c.sketch.strokes.length} 笔"${c.terrain ? `,"改地形":"${c.terrain.length} 处"` : ''}}`
    : c.terrain
      ? `{"改地形":"${c.terrain[0].kind === 'sink' && c.terrain.length === 6 ? '整片沉成海' : c.terrain[0].kind === 'raise' ? '整片抬成陆地' : '大杂烩'} ${c.terrain.length} 处"}`
      : JSON.stringify(c);
let worstHabReg = 0;
let worstRoutes = 0;
let worstTotal = 0;
let worstSim = 0;
let worstFrame = 0;
let worstLabels = 0;
for (const c of cases) {
  for (const seed of [3, 99]) {
    const { terrain, sketch, ...pc } = c;
    const grid = sketchGrid(sketch);
    // 改过地形的世界要原来星球(参数 + 草图)的扩张节拍:和 worker 一样事先记下(新建时先生成的就是没改的星球),不算进耗时
    const tempo = terrain ? (planetTempo({ ...DEFAULT_PARAMS, ...pc, seed }, undefined, grid) ?? null) : undefined;
    const t0 = performance.now();
    const w = generateWorld({ ...DEFAULT_PARAMS, ...pc, seed }, undefined, terrain, grid);
    const t1 = performance.now();
    const r = rasterize(w, 1);
    const t2 = performance.now();
    // 文明:按 progress 回调的时间点拆出"宜居度 + 划州"两步
    const marks: [string, number][] = [];
    const civ = simulation.run({ world: w, params: { tempo }, progress: (stage) => marks.push([stage, performance.now()]) });
    const t3 = performance.now();
    const civMs = t3 - t2;
    const habReg = (marks.find((m) => m[0] === '文明')?.[1] ?? t3) - t2;
    // 推演 = 定民族 + 按年推演(民族 + 城镇 + 国家,同一个引擎;从"文明"到"起名"两个进度点之间)
    const simMs = (marks.find((m) => m[0] === '起名')?.[1] ?? t3) - (marks.find((m) => m[0] === '文明')?.[1] ?? t2);
    // 回放一帧:任意年份的归属 + 半分辨率铺色块(不含浏览器贴图)
    const pix = pixelRegions(w.mesh, r, civ.regions.of);
    const colors = new Uint8Array(Math.max(1, civ.cultures.length) * 3);
    civ.cultures.forEach((cu, i) => colors.set(cu.color, i * 3));
    const buf = new Uint8ClampedArray(Math.ceil(r.w / 2) * Math.ceil(r.h / 2) * 4);
    let frameMs = 0;
    washPixels({ w: r.w, h: r.h, f: 2, pixRegion: pix, owner: civ.culture, colors, style: 'fantasy', wrap: true }, buf); // 热身
    for (const y of [civ.endYear * 0.4, civ.endYear * 0.7, civ.endYear]) {
      const f0 = performance.now();
      const own = ownersAt(civ, y);
      washPixels({ w: r.w, h: r.h, f: 2, pixRegion: pix, owner: own.culture, colors, style: 'fantasy', wrap: true }, buf);
      frameMs = Math.max(frameMs, performance.now() - f0);
    }
    // 国家视图回放一帧:国界(平滑 + 抖动)+ 按国界改判的归属图 + 半分辨率国土
    const pcolors = new Uint8Array(Math.max(1, civ.polities.length) * 3);
    civ.polities.forEach((p, i) => pcolors.set(p.color, i * 3));
    const lab = new Int16Array(Math.ceil(r.w / 2) * Math.ceil(r.h / 2));
    const fp = (y: number) => ({ world: w, raster: r, civ, style: 'fantasy' as const, year: y, show: { ...CIV_SHOW_OFF, polities: true }, fast: true });
    borderLines(fp(civ.endYear * 0.3), Layer.Polity); // 热身:州界的链每个世界只描一次(首次绘制时算)
    for (const y of [civ.endYear * 0.5, civ.endYear * 0.8, civ.endYear]) {
      const f0 = performance.now();
      const own = ownersAt(civ, y);
      const lines = borderLines(fp(y), Layer.Polity);
      labelImage(r.w, r.h, 2, r.scale, pix, own.polity, lines, lab, w.width);
      washPixels({ w: r.w, h: r.h, f: 2, pixRegion: pix, owner: own.polity, colors: pcolors, style: 'fantasy', label: lab, polity: true, wrap: true }, buf);
      frameMs = Math.max(frameMs, performance.now() - f0);
    }
    // 道路:从 '道路' 这一步开始,到下一个不是道路 / 航线的步骤(或结束)为止
    const ri = marks.findIndex((m) => m[0] === '道路');
    let routesMs = 0;
    if (ri >= 0) {
      let end = ri;
      while (end + 1 < marks.length && (marks[end + 1][0] === '道路' || marks[end + 1][0] === '航线')) end++;
      routesMs = (marks[end + 1]?.[1] ?? t3) - marks[ri][1];
    }
    let land = 0, nan = 0;
    for (let i = 0; i < w.mesh.n; i++) { if (w.water[i] === 0) land++; if (!Number.isFinite(w.elevation[i]) || !Number.isFinite(w.precipitation[i])) nan++; }
    let rn = 0;
    for (let k = 0; k < r.elev.length; k++) if (!Number.isFinite(r.elev[k]) || !Number.isFinite(r.temp[k]) || !Number.isFinite(r.precip[k]) || !Number.isFinite(r.ice[k])) rn++;
    // 文明:宜居度、州的各项数值不能有 NaN,每块陆地都要有州
    let cn = 0;
    const { habitat: hb, regions: R } = civ;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!Number.isFinite(hb.suitability[i]) || !Number.isFinite(hb.capacity[i])) cn++;
      if ((w.water[i] === 0) !== (R.of[i] >= 0)) cn++;
    }
    for (let q = 0; q < R.count; q++) if (!Number.isFinite(R.area[q]) || !Number.isFinite(R.capacity[q]) || !Number.isFinite(R.elevation[q])) cn++;
    for (let k = 0; k < R.adjLen.length; k++) if (!Number.isFinite(R.adjLen[k])) cn++;
    // 民族:日志年份有限且有序、归属编号在范围内、颜色和扩张性不是 NaN
    let hab = 0, occ = 0;
    for (let q = 0; q < R.count; q++) {
      const cu = civ.culture[q];
      if (cu < -1 || cu >= civ.cultures.length) cn++;
      if (hb.suitability[R.seat[q]] >= HABITABLE_SUIT) { hab++; if (cu >= 0) occ++; }
    }
    for (let i = 0; i < civ.log.size; i++) if (!Number.isFinite(civ.log.year[i]) || (i && civ.log.year[i] < civ.log.year[i - 1])) cn++;
    for (const cu of civ.cultures) if (!Number.isFinite(cu.expansionism) || !Number.isFinite(cu.born) || cu.color.some((v) => !Number.isFinite(v))) cn++;
    // 道路:地块编号合法;陆路不下水、不穿冰原
    for (const rt of civ.routes) {
      for (let t = 0; t < rt.cells.length; t++) {
        const c = rt.cells[t];
        if (!(c >= 0 && c < w.mesh.n)) cn++;
        else if (rt.kind !== 'sea' && (w.water[c] !== 0 || w.biome[c] === Biome.Ice)) cn++;
      }
    }
    // 城镇、国家:人口、年份不是 NaN;国家归属编号在范围内;在世的国家,国都(迁都后按新国都)在本国;灭亡的国家一州不剩
    for (const st of civ.settlements) if (!Number.isFinite(st.founded) || !Number.isFinite(st.capacity) || !Number.isFinite(populationAt(st, civ.endYear)) || !st.name) cn++;
    for (const po of civ.polities) {
      if (!Number.isFinite(po.founded) || !po.name || po.color.some((v) => !Number.isFinite(v))) cn++;
      if (po.ended === undefined) {
        if (civ.polity[civ.settlements[capitalAt(po, civ.endYear)].region] !== po.id) cn++;
      } else if (!Number.isFinite(po.ended) || civ.polity.includes(po.id)) cn++;
    }
    // 战争(阶段 3):史事的年份有限且有序、编号在范围内(同化与迁徙的史事 a、b 是民族,war 列是国家)
    for (let i = 0; i < civ.annals.length; i++) {
      const e = civ.annals[i];
      if (!Number.isFinite(e.year) || (i && e.year < civ.annals[i - 1].year)) cn++;
      if (e.kind === 'migrate' || e.kind === 'assimilate' || e.kind === 'vanish') {
        if (e.a < 0 || e.a >= civ.cultures.length || e.b >= civ.cultures.length || e.war >= civ.polities.length || !(e.region >= 0 && e.region < R.count)) cn++;
      } else if (e.a >= civ.polities.length || e.b >= civ.polities.length) cn++;
    }
    // 同化与迁徙(阶段 3):消亡的民族一州不剩、消亡年份有限;迁徙记录的方位合法
    const asm = assimStats(civ);
    for (const cu of civ.cultures) {
      if (cu.ended !== undefined && (!Number.isFinite(cu.ended) || civ.culture.includes(cu.id))) cn++;
      for (const mg of cu.migrations ?? []) if (!Number.isFinite(mg.year) || !'东南西北'.includes(mg.dir)) cn++;
    }
    if (!Number.isFinite(asm.changedShare) || !Number.isFinite(asm.rulingShare) || asm.flippy > 0) cn++;
    const ws = warStats(civ);
    if (![ws.tribalShare, ws.exclaveShare].every(Number.isFinite)) cn++;
    // 分合(阶段 3):分出来的国家,从哪国分出、复的是哪国,编号都在范围内、比自己早;被并掉的国家有灭亡年份
    const ps = politicsStats(civ);
    for (const po of civ.polities) {
      if (po.parent !== undefined && !(po.parent >= 0 && po.parent < po.id)) cn++;
      if (po.restores !== undefined && !(po.restores >= 0 && po.restores < po.id && civ.polities[po.restores].ended !== undefined)) cn++;
      if (!po.titles?.length || !po.capitals?.length || po.capitals[0].settlement !== po.capital) cn++;
    }
    for (const e of civ.annals) if (e.kind === 'merge' && civ.polities[e.b]?.ended !== e.year) cn++;
    // 王朝更替(阶段 3):历朝的年份有限、按先后、第一条是立国那年;王室根据地是城;推演结束后都起了名
    const ds = dynastyStats(civ);
    for (const po of civ.polities) {
      const d = po.dynasties;
      if (!d) continue;
      if (d[0].year !== po.founded) cn++;
      d.forEach((x, i) => {
        if (!Number.isFinite(x.year) || (i && !(x.year > d[i - 1].year)) || !civ.settlements[x.seat] || !x.name) cn++;
      });
    }
    if (![ds.meanEastern, ds.meanWestern].every(Number.isFinite)) cn++;
    // 城市兴衰:洗劫的折损在 0–1 之间、被毁 / 立都年份有限;重建的城在被毁的城故址上;人口任何年份有限、非负,被毁后为 0
    const cs = cityStats(civ);
    for (const st of civ.settlements) {
      for (const k of st.sacks ?? []) if (!Number.isFinite(k.year) || !(k.loss > 0 && k.loss < 1)) cn++;
      if (st.ended !== undefined && !(st.ended >= st.founded && st.ended <= civ.endYear)) cn++;
      for (const sp of st.capitalSpans ?? []) if (!Number.isFinite(sp.from) || (sp.until !== undefined && !(sp.until >= sp.from)) || !civ.polities[sp.polity]) cn++;
      if (st.rebuilds !== undefined) {
        const old = civ.settlements[st.rebuilds];
        if (!old || old.region !== st.region || !(old.ended! < st.founded)) cn++;
      }
      for (const y of [st.founded, (st.founded + civ.endYear) / 2, st.ended ?? civ.endYear, civ.endYear]) {
        const pop = populationAt(st, y);
        if (!Number.isFinite(pop) || pop < 0 || (st.ended !== undefined && y >= st.ended && pop !== 0)) cn++;
      }
    }
    for (const e of civ.annals) {
      if ((e.kind === 'sack' || e.kind === 'ruin' || e.kind === 'rebuild' || e.kind === 'decline') && civ.settlements[e.settlement]?.region !== e.region) cn++;
    }
    for (let q = 0; q < R.count; q++) if (civ.polity[q] < -1 || civ.polity[q] >= civ.polities.length || (civ.polity[q] >= 0 && civ.culture[q] < 0)) cn++;
    // 地理名:路径不能有 NaN,名字不能为空
    for (const pl of civ.places) {
      if (!pl.name) cn++;
      for (let k = 0; k < pl.path.length; k++) if (!Number.isFinite(pl.path[k])) cn++;
    }
    // 信仰:编号在范围内、年份有限且有序;检查点 + 补日志和从头翻日志一样;有文明就有信仰
    const rel = civ.religion;
    if (civ.viable && civ.cultures.length && !rel) cn++;
    if (rel) {
      const F = rel.faiths.length;
      rel.faiths.forEach((f, i) => {
        if (f.id !== i || !f.name || f.color.some((v) => !Number.isFinite(v))) cn++;
        if (f.kind !== 'folk' && !Number.isFinite(f.founded)) cn++;
        if (f.kind === 'great' && !civ.settlements[f.holy ?? -1]) cn++;
        if (f.kind === 'sect' && !(f.parent !== undefined && rel.faiths[f.parent]?.kind === 'great')) cn++;
      });
      for (let i = 0; i < rel.log.size; i++) {
        if (!Number.isFinite(rel.log.year[i]) || (i && rel.log.year[i] < rel.log.year[i - 1])) cn++;
        if (rel.log.value[i] < -1 || rel.log.value[i] >= F || !(rel.log.region[i] >= 0 && rel.log.region[i] < R.count)) cn++;
      }
      for (let i = 0; i < rel.events.length; i++) {
        const e = rel.events[i];
        if (!Number.isFinite(e.year) || (i && e.year < rel.events[i - 1].year) || !(e.faith >= 0 && e.faith < F) || e.polity >= civ.polities.length) cn++;
      }
      for (const st of rel.states) if (!civ.polities[st.polity] || !rel.faiths[st.faith] || (st.until !== undefined && !(st.until >= st.from))) cn++;
      const a = faithAt(civ, civ.endYear * 0.55);
      const b = faithFromScratch(civ, civ.endYear * 0.55);
      for (let q = 0; q < R.count; q++) if (a[q] !== b[q]) cn++;
    }
    // 国名、城名、城镇符号:国名的路径、字号不能有 NaN;排版 + 避让一帧的耗时(缩放 1 倍,Node 里,不含画)
    let labelMs = 0;
    for (const y of [civ.endYear * 0.6, civ.endYear]) {
      const l0 = performance.now();
      const lp = { world: w, raster: r, civ, style: 'fantasy' as const, year: y, show: { ...CIV_SHOW_OFF, labels: true, polities: true, routes: true } };
      const layer = civMapLayer(lp);
      const view = { ...labelViewExtras(lp), scale: 1326 / w.width, ox: 0, oy: 0, dpr: 1, k: 1, mapCss: 1326 };
      const placed = placeMap(civLabelItems(lp).concat(layer.items), layer.marks, view);
      labelMs = Math.max(labelMs, performance.now() - l0);
      for (const it of layer.items) {
        if (it.sizeWorld !== undefined && !(it.sizeWorld > 0)) cn++;
        for (let k = 0; k < it.path.length; k++) if (!Number.isFinite(it.path[k])) cn++;
      }
      for (const pl of placed.labels) for (const g of pl.glyphs) if (!Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.a)) cn++;
    }
    worstLabels = Math.max(worstLabels, labelMs);
    // 战事:每场仗打完不早于开打;战线、双剑的坐标、浓淡不能有 NaN
    for (const s of warSpans(civ)) if (!(s.end >= s.start)) cn++;
    for (const y of [civ.endYear * 0.5, civ.endYear * 0.8, civ.endYear]) {
      const wp = { world: w, raster: r, civ, style: 'fantasy' as const, year: y, show: { ...CIV_SHOW_OFF, polities: true, wars: true } };
      for (const l of warFront(wp)) for (let k = 0; k < l.pts.length; k++) if (!Number.isFinite(l.pts[k])) cn++;
      for (const m of warMarkPoints(wp, true)) if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !(m.alpha > 0 && m.alpha <= 1)) cn++;
    }
    if (nan || rn || cn) process.exitCode = 1;
    const isDefaultCells = !('cells' in c) && !terrain;
    if (isDefaultCells) {
      worstHabReg = Math.max(worstHabReg, habReg);
      worstRoutes = Math.max(worstRoutes, routesMs);
      worstTotal = Math.max(worstTotal, t3 - t0);
    }
    worstSim = Math.max(worstSim, simMs);
    worstFrame = Math.max(worstFrame, frameMs);
    console.log(
      caseName(c), 'seed', seed,
      `gen ${Math.round(t1 - t0)}ms raster ${Math.round(t2 - t1)}ms 文明 ${Math.round(civMs)}ms(宜居度+划州 ${Math.round(habReg)}ms · 推演 ${simMs.toFixed(1)}ms · 回放一帧 ${frameMs.toFixed(1)}ms · 道路 ${Math.round(routesMs)}ms · 国名城名排版 ${labelMs.toFixed(1)}ms)`,
      'land', (land / w.mesh.n).toFixed(2), 'rivers', w.rivers.length, 'max', Math.round(w.maxElevation),
      `州 ${R.count}${civ.viable ? '' : '(无文明)'} 民族 ${civ.cultures.length} 占据 ${hab ? Math.round((occ / hab) * 100) : 0}% 国家 ${civ.polities.length}(在世 ${ws.alive})城镇 ${civ.settlements.length} 路段 ${civ.routes.length} 地名 ${civ.places.length}`,
      `战争 ${ws.wars} 攻占 ${ws.conquests} 灭亡 ${ws.falls} 迁都 ${ws.capitalMoves} 飞地 ${(ws.exclaveShare * 100).toFixed(1)}% 易手频繁 ${ws.flippy}`,
      `分裂 ${ps.splits} 合并 ${ps.merges} 复国 ${ps.restorations} 主动迁都 ${ps.capitalMoves}`,
      `改朝换代 ${ds.eastern} 王室更迭 ${ds.western}`,
      `同化 ${asm.assimilated} 迁徙 ${asm.migrations} 波 ${asm.migrated} 州 改换过民族 ${(asm.changedShare * 100).toFixed(1)}% 消亡 ${asm.vanished}`,
      `洗劫 ${cs.sacks} 毁城 ${cs.ruins} 重建 ${cs.rebuilds} 遗址 ${cs.ruinsAtEnd} 旧都渐衰 ${cs.declines}`,
      `大教 ${rel?.faiths.filter((f) => f.kind === 'great').length ?? 0} 教派 ${rel?.faiths.filter((f) => f.kind === 'sect').length ?? 0} 宗教大事 ${rel?.events.length ?? 0}`,
      nan || rn || cn ? `NaN! ${nan}/${rn}/${cn}` : '',
    );
  }
}
console.log(`\n默认精细度下:宜居度+划州最慢 ${Math.round(worstHabReg)}ms(预算 60ms);道路最慢 ${Math.round(worstRoutes)}ms(预算 150ms);生成+铺像素+文明最慢 ${Math.round(worstTotal)}ms(预算 2000ms)`);
// 推演预算从 40ms 放宽到 60ms(加入战争时):战争每次看邻国、每一仗都要现算各国国力(全部城镇的人口)、
// 边境胜算、扫一遍前线,推演最慢从约 25ms 涨到约 35ms;修好"离国都的路程"以后国家更大、接壤更多、仗更多,
// 最慢约 45ms(陆地 60% 的世界,约 1500 州、70 多场仗)
// 之后的王朝更替、同化与迁徙等推演机制合计允许放宽到 100ms;同化与迁徙这一项自身约多 5ms(看孤地、看民族),
// 世界的历史跟着变(仗、分裂的多少),默认精细度下推演最慢约 55ms → 60–75ms(机器忙时单次测量很不稳)
// 城市兴衰(洗劫、毁城、重建、旧都衰落)自身只多几毫秒(攻城时掷两次骰子、看重建 / 看旧都每个世界几十次),人口多算两段
console.log(`所有参数下:推演(民族 + 城镇 + 国家 + 战争 + 分合 + 王朝 + 同化迁徙 + 城市兴衰)最慢 ${worstSim.toFixed(1)}ms(预算 100ms);回放一帧(归属 + 国界 + 半分辨率色块,Node 里)最慢 ${worstFrame.toFixed(1)}ms(预算 30ms)`);
console.log(`国名、城名、城镇符号排版 + 避让(缩放 1 倍,含国土栅格首次计算)最慢 ${worstLabels.toFixed(1)}ms`);

// ---- 地形大事:极端的几种(整颗星球沉入海中、整片抬成陆地、五件最大最强的火山) ----
const UPHEAVAL_CASES: [string, Upheaval[]][] = [
  ['整颗星球沉入海中', [{ year: 1500, ops: rows('sink') }]],
  ['整片抬成陆地', [{ year: 300, ops: rows('raise') }]],
  [
    '五件火山(有同一年的)',
    [1, 1500, 1500, 2999, 1200].map((year, k): Upheaval => ({ year, ops: [{ kind: 'volcano', pts: [k * 410 + 100, (k * 397 + 200) % 1024], r: 160, s: 2 }] })),
  ],
];
for (const [name, list] of UPHEAVAL_CASES) {
  for (const seed of [3, 99]) {
    const params = { ...DEFAULT_PARAMS, seed };
    const t0 = performance.now();
    const w = generateWorld(params);
    const steps = upheavalSteps(params, [], null, list);
    const t1 = performance.now();
    const civ = simulation.run({ world: w, params: { upheavals: steps } });
    const t2 = performance.now();
    let cn = 0;
    const worlds = [w, ...steps.map((s) => s.world)];
    for (const x of worlds) for (let i = 0; i < x.mesh.n; i++) if (!Number.isFinite(x.elevation[i]) || !Number.isFinite(x.precipitation[i])) cn++;
    // 各段的州和那时的地形对得上(陆地都在州里、水不在);州的各项数值不是 NaN
    const eraRegions = [...(civ.eras ?? []).map((e) => e.regions), civ.regions];
    if (civ.viable && eraRegions.length !== worlds.length) cn++;
    eraRegions.forEach((R, k) => {
      const x = worlds[Math.min(k, worlds.length - 1)];
      for (let i = 0; i < x.mesh.n; i++) if ((x.water[i] === 0) !== (R.of[i] >= 0)) cn++;
      for (let q = 0; q < R.count; q++) if (!Number.isFinite(R.area[q]) || !Number.isFinite(R.capacity[q]) || !Number.isFinite(R.elevation[q])) cn++;
      if (k && R.count < eraRegions[k - 1].count) cn++;
    });
    const last = worlds[worlds.length - 1];
    // 史事有序;结束时还在的城在陆地上;在世的国家国都在本国,亡了的一州不剩
    for (let i = 1; i < civ.annals.length; i++) if (civ.annals[i].year < civ.annals[i - 1].year) cn++;
    for (const st of civ.settlements) {
      if (st.ended === undefined && last.water[st.cell] !== 0) cn++;
      if (!Number.isFinite(populationAt(st, civ.endYear)) || !st.name) cn++;
    }
    for (const po of civ.polities) {
      if (po.ended === undefined) {
        if (civ.polity[civ.settlements[capitalAt(po, civ.endYear)].region] !== po.id) cn++;
      } else if (civ.polity.includes(po.id)) cn++;
    }
    for (let q = 0; q < civ.regions.count; q++) if (civ.regions.cellStart[q + 1] === civ.regions.cellStart[q] && (civ.polity[q] >= 0 || civ.culture[q] >= 0)) cn++;
    const rel = civ.religion;
    if (rel) {
      const a = faithAt(civ, civ.endYear * 0.55);
      const b = faithFromScratch(civ, civ.endYear * 0.55);
      for (let q = 0; q < civ.regions.count; q++) if (a[q] !== b[q]) cn++;
    }
    const ch = buildChronicle(civ).filter((e) => e.kind === 'upheaval');
    if (civ.viable && civ.cultures.length && ch.length !== (civ.upheavals?.length ?? 0)) cn++;
    for (const e of ch) if (!e.text) cn++;
    if (cn) process.exitCode = 1;
    console.log(
      `{"地形大事":"${name}"}`, 'seed', seed,
      `生成各段地形 ${Math.round(t1 - t0)}ms 文明 ${Math.round(t2 - t1)}ms`,
      `段 ${worlds.length} 州 ${civ.regions.count} 国家 ${civ.polities.length}(在世 ${civ.polities.filter((p) => p.ended === undefined).length})城镇 ${civ.settlements.length}`,
      `大事 ${ch.map((e) => `${Math.floor(e.year)} ${e.text}`).join(' | ')}`,
      cn ? `NaN! ${cn}` : '',
    );
  }
}
