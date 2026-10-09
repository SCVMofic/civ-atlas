/**
 * 编辑地形的界面:新建世界卡片里的工具面板(TerrainPanel)、地图上的覆盖层(涂过的地方、放的火山湖河、光标圈)。
 * 地形是世界的根:只在新建世界这一步能改,点"创建世界"后锁住(想换地形用"以它为底稿新建")。
 *
 * - 涂一片(陆地、丘陵、山地、高原、浅海、海、群岛、擦掉):按住拖动涂一笔(画法"圈起来填满" = 画一圈,松手连上起点、圈里整片涂上),
 *   大小是滑条(笔的半径,世界坐标),山地另有高低。每一笔加进草图(editsStore.addSketchStroke,格式见 gen/sketch.ts),
 *   程序照草图重新长出整颗星球。
 * - 放一处:火山 / 湖 = 点一下放一处(拖动照样平移);河 = 从源头画到海边的一条线。三档大小见 gen/terrainEdits.ts 的 TERRAIN_PRESETS。
 *   加一处 = editsStore.addTerrainOp。旧存档里、或"让助手改"做出来的山脉 / 抬起陆地 / 沉成海照常生效、照常画出来,算在"画了几笔"里。
 * - 导入图片(「整张草图」第一行,或者把图片拖到地图上):左边整块换成导入面板,地图上画预览(ImportImage.tsx);
 *   用了以后认出来的格子铺成草图的底子(editsStore.setSketchImage),算一步;第一行改成写照的哪张图、可以去掉。
 * - 撤销 / 重做按先后,草图的笔、导入图片和放的一处混在一起算(Ctrl / ⌘ + Z,Ctrl / ⌘ + Shift + Z 或 Ctrl + Y);全部清除点两下才清,回到程序原来的星球。
 *   App 看到地形修改或草图变了就在后台重新生成世界、重推文明(见 App.tsx)。
 * - 地图事件由 App 转给这里:terrainDown / terrainMove / terrainUp(画线、涂、圈)、terrainClick(放点)、terrainCancel(第二根手指按下);
 *   返回 true = 这一下归编辑地形管。按住空格拖动是平移。
 * - 覆盖层(TerrainOverlay)用 SVG,坐标就是世界坐标(viewBox = 地图原图大小),随地图一起缩放平移。
 */
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { TerrainKind, TerrainOp } from '../gen/edits';
import { SKETCH_COAST, SKETCH_MAX_PTS, SKETCH_R, sketchCoast, type SketchEdit, type SketchImage, type SketchKind, type SketchStroke } from '../gen/sketch';
import { TERRAIN_MAX_PTS, TERRAIN_PRESETS as PRESETS, isPointKind, sameTerrain } from '../gen/terrainEdits';
import { Icon, type IconName } from './icons';
import { Seg, Slider } from './tpControls';
import {
  addSketchStroke,
  addTerrainOp,
  clearSketch,
  clearTerrain,
  editsEra,
  getEdits,
  redoSketchImage,
  removeSketchImage,
  setSketchCoast,
  setSketchImage,
  setSketchRest,
  sketchImageSteps,
  undoSketchImage,
  undoSketchStroke,
  undoTerrainOp,
  useEdits,
} from './editsStore';
import {
  ImportLayer,
  ImportPanel,
  LayerMark,
  cancelImport,
  coverMaskUrl,
  importCancel,
  importCaption,
  importClick,
  importDown,
  importMove,
  importOn,
  importResult,
  importUndoClick,
  importUp,
  pickImage,
  useImport,
} from './ImportImage';

// ---------------------------------------------------------------------------
// 工具状态

/** 放一处的三样 */
export type PlaceKind = 'volcano' | 'lake' | 'river';
export type EditTool = SketchKind | PlaceKind;

export interface TerrainToolState {
  on: boolean;
  tool: EditTool;
  /** 涂一片的笔:半径(世界坐标,SKETCH_R 范围) */
  r: number;
  /** 涂一片的画法:涂抹 / 圈起来填满 */
  method: 'paint' | 'lasso';
  /** 山地的高低:0 低 / 1 中 / 2 高 */
  h: 0 | 1 | 2;
  /** 放一处的大小:0 小 / 1 中 / 2 大 */
  size: 0 | 1 | 2;
  /** 地图上显示草图(涂过的地方、放的火山湖河) */
  show: boolean;
  /** 海岸线的选择(草图还一笔没有时也记着,画第一笔时带上;有草图时以草图里的为准) */
  coast: number;
}

let tool: TerrainToolState = { on: false, tool: 'land', r: 40, method: 'paint', h: 1, size: 1, show: true, coast: SKETCH_COAST };
const toolSubs = new Set<() => void>();
const emitTool = () => toolSubs.forEach((f) => f());

export const isPlaceTool = (t: EditTool): t is PlaceKind => t === 'volcano' || t === 'lake' || t === 'river';

export function getTerrainTool(): TerrainToolState {
  return tool;
}
export function setTerrainTool(p: Partial<TerrainToolState>) {
  const next = { ...tool, ...p };
  if ((Object.keys(next) as (keyof TerrainToolState)[]).every((k) => next[k] === tool[k])) return;
  tool = next;
  if (!tool.on) {
    setDraft({ draft: null, cursor: null });
    cancelImport();
  }
  emitTool();
}
export function useTerrainTool(): TerrainToolState {
  return useSyncExternalStore(
    (f) => (toolSubs.add(f), () => toolSubs.delete(f)),
    () => tool,
    () => tool,
  );
}

const PAINT: { id: SketchKind; name: string; hint: string }[] = [
  { id: 'land', name: '陆地', hint: '按住拖动来涂。松手后星球照着草图重新长，海岸线和山河由程序补上。' },
  { id: 'hills', name: '丘陵', hint: '涂过的地方起一片丘陵；涂到海里会先长出陆地。' },
  { id: 'mountain', name: '山地', hint: '涂一道就是一条山脉，山脊顺着涂的方向；涂到海里会先长出陆地。' },
  { id: 'plateau', name: '高原', hint: '涂过的地方抬成一片高原；涂到海里会先长出陆地。' },
  { id: 'shelf', name: '浅海', hint: '涂过的地方是一片浅海，像大陆架那样浅。' },
  { id: 'sea', name: '海', hint: '涂过的地方沉成深海。' },
  { id: 'isles', name: '群岛', hint: '涂过的地方冒出一片大大小小的岛。' },
  { id: 'erase', name: '擦掉', hint: '擦过的地方交还给程序。' },
];
const PLACE: { id: PlaceKind; name: string; icon: IconName; sizes: [string, string, string]; hint: string }[] = [
  { id: 'volcano', name: '火山', icon: 'volcano', sizes: ['小', '中', '大'], hint: '点一下放一座火山；点在海里是火山岛。' },
  { id: 'lake', name: '湖', icon: 'lake', sizes: ['小', '中', '大'], hint: '点一下挖一个湖（点在陆地上）。' },
  { id: 'river', name: '河', icon: 'river', sizes: ['细', '中', '粗'], hint: '从源头画到海边，河顺着画的线流。' },
];
const LASSO_HINT = '按住画一圈，松手自动连上起点，圈里整片涂满。';
const PHONE_HINT = '一根手指涂，两根手指拖动、放大。';
const COASTS: { v: number; name: string }[] = [
  { v: 0, name: '贴着画' },
  { v: SKETCH_COAST, name: '适中' },
  { v: 1, name: '曲折' },
];
const HEIGHTS = ['低', '中', '高'];

// ---------------------------------------------------------------------------
// 正在画的线、光标(世界坐标),给覆盖层画

interface Draft {
  draft: number[] | null;
  cursor: [number, number] | null;
}
let draftNow: Draft = { draft: null, cursor: null };
/** 这一笔是什么时候按下的(第二根手指紧跟着按下 = 想捏合,不是在画) */
let draftT0 = 0;
const draftSubs = new Set<() => void>();
function setDraft(s: Draft) {
  draftNow = s;
  draftSubs.forEach((f) => f());
}
function useDraft(): Draft {
  return useSyncExternalStore(
    (f) => (draftSubs.add(f), () => draftSubs.delete(f)),
    () => draftNow,
    () => draftNow,
  );
}

/** 按住空格 = 平移(画线、涂的工具里拖动本来是画) */
let space = false;

/**
 * 世界东西相连的一整圈宽度(世界单位);还没有世界时 0。App 设。
 * 地图给的点 x 在 [0, 宽) 里;画线时每个新点按上一个点展开,跨 180° 经线的线是连着的一笔,原样存下
 * (x 可以超出 [0, 宽);存档、生成都按经纬度解释,见 gen/terrainEdits.ts 的 cleanTerrainOp)
 */
let wrapW = 0;
export function setTerrainWrap(w: number) {
  wrapW = w;
}
const near = (x: number, ref: number) => (wrapW ? x - wrapW * Math.round((x - ref) / wrapW) : x);
/** 画在覆盖层上的点:按上一个点展开(旧存档里跨接缝的线是一个个取模存的,这样也不横穿整张图) */
function displayPts(pts: readonly number[], wrap: number): number[] {
  if (!wrap) return pts as number[];
  const out = [...pts];
  for (let i = 2; i < out.length; i += 2) out[i] = out[i - 2] + (out[i] - out[i - 2]) - wrap * Math.round((out[i] - out[i - 2]) / wrap);
  return out;
}

/** 这支笔现在多大(世界坐标的半径) */
function radiusOf(t: TerrainToolState): number {
  return isPlaceTool(t.tool) ? PRESETS[t.tool][t.size][0] : t.r;
}
const lassoOn = (t: TerrainToolState) => !isPlaceTool(t.tool) && t.method === 'lasso';

/** 地图上按下:涂、圈、画河的工具开始画(返回 true = 这一下归编辑地形管,不平移) */
export function terrainDown(w: [number, number] | null, button: number): boolean {
  if (tool.on && importOn()) return !space && importDown(w, button);
  if (!tool.on || !w || button !== 0 || space || tool.tool === 'volcano' || tool.tool === 'lake') return false;
  draftT0 = performance.now();
  setDraft({ draft: [Math.round(w[0]), Math.round(w[1])], cursor: w });
  return true;
}

/** 地图上移动:更新光标;正在画就把线接长(返回 true = 正在画) */
export function terrainMove(w: [number, number] | null): boolean {
  if (!tool.on) return false;
  if (importOn()) return importMove(w);
  const d = draftNow.draft;
  if (!d) {
    if (w !== draftNow.cursor) setDraft({ draft: null, cursor: w });
    return false;
  }
  if (!w) return true;
  const r = radiusOf(tool);
  const lx = d[d.length - 2];
  const ly = d[d.length - 1];
  // 点和点至少隔开小半个半径(手抖的小折弯不算,线也不会太长);圈的时候点密一点,圈出来的边顺
  const step = lassoOn(tool) ? 4 : Math.max(tool.tool === 'river' ? 4 : 2, r * 0.4);
  const cap = tool.tool === 'river' ? TERRAIN_MAX_PTS : SKETCH_MAX_PTS;
  // 按上一个点展开(跨 180° 经线接着画,不跳到地图另一头)
  const wx = near(w[0], lx);
  const far = (wx - lx) ** 2 + (w[1] - ly) ** 2 >= step * step;
  const next = far && d.length < cap * 2 ? [...d, Math.round(wx), Math.round(w[1])] : d;
  setDraft({ draft: next, cursor: [wx, w[1]] });
  return true;
}

/** 松开:画完的一笔加进草图,或者加成一条河 */
export function terrainUp() {
  if (importOn()) return importUp();
  const d = draftNow.draft;
  if (!d) return;
  const c0 = draftNow.cursor;
  setDraft({ draft: null, cursor: c0 });
  const c: [number, number] | null = c0 && [near(c0[0], d[d.length - 2]), c0[1]];
  // 松开的地方离最后一个点还差一小段(不到一步):补上,线画到哪儿就到哪儿
  const cap = tool.tool === 'river' ? TERRAIN_MAX_PTS : SKETCH_MAX_PTS;
  const pts = c && d.length < cap * 2 && (c[0] - d[d.length - 2]) ** 2 + (c[1] - d[d.length - 1]) ** 2 >= 4 ? [...d, Math.round(c[0]), Math.round(c[1])] : d;
  if (tool.tool === 'river') {
    // 河至少要有两个点(点一下不算)
    if (pts.length < 4) return;
    const [r, s] = PRESETS.river[tool.size];
    addOp({ kind: 'river', pts, r, s });
    return;
  }
  if (isPlaceTool(tool.tool)) return;
  const st: SketchStroke = { kind: tool.tool, r: tool.r, pts };
  if (tool.tool === 'mountain' && tool.h !== 1) st.h = tool.h;
  if (lassoOn(tool) && pts.length >= 6) st.fill = 1;
  addStroke(st);
}

/** 单击地图:火山、湖在这里放一处(返回 true = 这一下归编辑地形管,不看详情) */
export function terrainClick(w: [number, number] | null): boolean {
  if (!tool.on) return false;
  if (importOn()) {
    importClick(w);
    return true;
  }
  if (!w || (tool.tool !== 'volcano' && tool.tool !== 'lake')) return true;
  const [r, s] = PRESETS[tool.tool][tool.size];
  addOp({ kind: tool.tool, pts: [Math.round(w[0]), Math.round(w[1])], r, s });
  return true;
}

/**
 * 手机上第二根手指按下:刚按下不久的这一笔不算(是想两根手指拖动、放大),返回 true = 收掉了、可以开始捏合;
 * 已经画了一阵的照旧画完(手掌碰到屏幕不打断)
 */
export function terrainCancel(): boolean {
  if (importOn()) {
    importCancel();
    return true;
  }
  if (!draftNow.draft) return true;
  if (performance.now() - draftT0 > 400) return false;
  setDraft({ draft: null, cursor: null });
  return true;
}

// ---------------------------------------------------------------------------
// 撤销 / 重做:草图的笔、导入图片和放的一处按先后混在一起

type Step = 's' | 'o' | 'i';
type Item = { t: 's'; v: SketchStroke } | { t: 'o'; v: TerrainOp } | { t: 'i'; v: SketchImage };
/** 这次编辑里加的先后('s' 草图的一笔,'o' 放的一处,'i' 导入一张图);和 editsStore 里两份列表的末尾、导入的那几次对得上 */
let order: Step[] = [];
/** 撤掉的(最后撤的在最后),和撤完时的样子(之后又改过别的 = 不能重做) */
let redo: Item[] = [];
let redoAt: { terrain: readonly TerrainOp[]; sketch: SketchEdit | undefined } | null = null;

/** 上面几样记录是哪一次整个换掉修改之后记的(换了世界、读档 = 旧记录作废) */
let orderEra = -1;

function trimOrder() {
  if (orderEra !== editsEra()) {
    orderEra = editsEra();
    order = [];
    redo = [];
    redoAt = null;
  }
  const e = getEdits();
  let ns = e.sketch?.strokes.length ?? 0;
  let no = e.terrain.length;
  let ni = sketchImageSteps();
  // 从后往前对:多出来的(被别处清掉、撤掉的)去掉
  const keep: Step[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    if (order[i] === 's' ? ns-- > 0 : order[i] === 'o' ? no-- > 0 : ni-- > 0) keep.push(order[i]);
  }
  order = keep.reverse();
}
function addStroke(st: SketchStroke) {
  trimOrder();
  if (!addSketchStroke(st, tool.coast)) return;
  order.push('s');
  redo = [];
}
function addOp(op: TerrainOp) {
  trimOrder();
  if (!addTerrainOp(op)) return;
  order.push('o');
  redo = [];
}
/** 「用这张图」:导入的图铺成草图的底子(算一步),收起导入面板 */
function applyImport() {
  const r = importResult();
  if (!r) return;
  trimOrder();
  if (!setSketchImage(r.name, r.layer, tool.coast)) return;
  order.push('i');
  redo = [];
  cancelImport();
}
/** 去掉导入的图片(笔画留着) */
export function removeImage() {
  removeSketchImage();
  trimOrder();
}
const canRedo = (terrain: readonly TerrainOp[], sketch: SketchEdit | undefined) => redo.length > 0 && !!redoAt && redoAt.terrain === terrain && redoAt.sketch === sketch;

/** 撤销最后一笔(这次加的按先后;更早的、助手加的:先撤草图,再撤放的) */
export function undoTerrain() {
  trimOrder();
  const e = getEdits();
  const ns = e.sketch?.strokes.length ?? 0;
  const img = e.sketch?.image;
  // 没记下先后的(读档来的、助手加的):导入的图在最后几笔之后就先撤它
  const t = order.pop() ?? (img && (img.at ?? 0) >= ns ? 'i' : ns ? 's' : e.terrain.length ? 'o' : null);
  if (!t) return;
  if (!canRedo(e.terrain, e.sketch)) redo = [];
  if (t === 'i') {
    if (!img) return;
    redo.push({ t, v: img });
    undoSketchImage();
  } else if (t === 's') {
    redo.push({ t, v: e.sketch!.strokes[ns - 1] });
    // 撤掉最后一笔、草图没了:记下它的海岸线,重做时照样
    if (ns === 1) setTerrainTool({ coast: sketchCoast(e.sketch) });
    undoSketchStroke();
  } else {
    redo.push({ t, v: e.terrain[e.terrain.length - 1] });
    undoTerrainOp();
  }
  const a = getEdits();
  redoAt = { terrain: a.terrain, sketch: a.sketch };
}
/** 重做刚撤掉的那一笔(撤完以后又改了别的 = 不能重做) */
export function redoTerrain() {
  trimOrder();
  const e = getEdits();
  if (!canRedo(e.terrain, e.sketch)) return;
  const it = redo.pop()!;
  trimOrder();
  let ok = true;
  if (it.t === 'i') redoSketchImage(it.v, tool.coast);
  else ok = it.t === 's' ? addSketchStroke(it.v, tool.coast) : addTerrainOp(it.v);
  if (ok) order.push(it.t);
  const a = getEdits();
  redoAt = { terrain: a.terrain, sketch: a.sketch };
}
/** 海岸线:贴着画(0)、适中(SKETCH_COAST)、曲折(1);还没画也记着 */
export function setTerrainCoast(v: number) {
  setTerrainTool({ coast: v });
  setSketchCoast(v);
}
/** 全部清除:草图、放的火山湖河、旧的地形修改一起清掉,回到程序原来的星球 */
export function clearAllTerrain() {
  clearSketch();
  clearTerrain();
  order = [];
  redo = [];
  redoAt = null;
}

/** 编辑地形画了几笔:草图的笔 + 放的一处(连同旧的地形修改) */
export function terrainCount(e: { terrain: readonly TerrainOp[]; sketch?: SketchEdit }): number {
  return e.terrain.length + (e.sketch?.strokes.length ?? 0);
}
/** 入口那一行、创建前确认框里地形那一行右边写什么(none = 一笔没画时) */
export function terrainSide(e: { terrain: readonly TerrainOp[]; sketch?: SketchEdit }, none: string): string {
  const n = terrainCount(e);
  if (e.sketch?.image) return n ? `照一张图，又画了 ${n} 笔` : '照一张图';
  // 一笔没画、没涂的地方都是海(草图只剩这一条设定)
  return n ? `画了 ${n} 笔` : e.sketch ? '都是海' : none;
}

// ---------------------------------------------------------------------------
// 工具面板

/** App 给的状态:重新生成中、上一次重新生成的结果 */
export interface TerrainStatus {
  /** 正在按新地形重新生成 */
  busy: boolean;
  /** 上一次重新生成:花了多久(毫秒)、多少处改名在新历史里对不上、多少条干预没生效(和世界概览"我的干预"页一个口径) */
  last?: { ms: number; lostNames: number; lostInterventions: number } | null;
}

/** 大小滑条:两头一个小点、一个大点,右边写半径 */
function SizeSlider({ r }: { r: number }) {
  return <Slider label="大小" act="terrain-size" min={SKETCH_R[0]} max={SKETCH_R[1]} value={r} onChange={(v) => setTerrainTool({ r: v })} show={r} />;
}

/**
 * 编辑地形的面板(新建世界卡片里"编辑地形"点开后的样子):
 * 涂一片的八支笔、放一处的三样;这支笔的画法 / 大小 / 高低和一句怎么用;整张草图的海岸线、没涂的地方、画了几笔(撤销 / 重做 / 全部清除)、
 * 在地图上显示草图。组头右边"完成"(收起)。世界还在生成时"画了几笔"那里写"生成中…"。
 * 手机上工具排成一行横着滑,海岸线和没涂的地方收进「整张草图」那一行(点开展开)。
 * 开着的时候键盘:Esc 收起,Ctrl / ⌘ + Z 撤销,Ctrl / ⌘ + Shift + Z(或 Ctrl + Y)重做,按住空格拖动是平移。
 */
export function TerrainPanel({ disabled, phone = false }: { disabled: boolean; phone?: boolean }) {
  const t = useTerrainTool();
  const edits = useEdits();
  const [confirm, setConfirm] = useState(false);
  const [wholeOpen, setWholeOpen] = useState(false);
  const importing = !!useImport();
  const n = terrainCount(edits);
  const sk = edits.sketch;
  const img = sk?.image;
  const coast = sk ? sketchCoast(sk) : t.coast;
  const rest = sk?.rest ?? 'auto';
  const redoOk = canRedo(edits.terrain, sk);

  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  // 键盘(熟手的加速,功能都有按钮):Esc 收起,Ctrl / ⌘ + Z 撤销,加 Shift(或 Ctrl + Y)重做,按住空格拖动 = 平移
  useEffect(() => {
    if (!t.on) return;
    const typing = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) && (el as HTMLInputElement).type !== 'range';
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      // 导入图片的时候:Esc 取消导入,Ctrl / ⌘ + Z 撤销点的那一下
      if (importOn() && (e.key === 'Escape' || (mod && k === 'z' && !e.shiftKey))) {
        e.preventDefault();
        if (e.key === 'Escape') cancelImport();
        else importUndoClick();
      } else if (e.key === 'Escape') setTerrainTool({ on: false });
      else if (importOn() && mod && (k === 'y' || k === 'z')) e.preventDefault();
      else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault();
        redoTerrain();
      } else if (mod && k === 'z') {
        e.preventDefault();
        undoTerrain();
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (!space) {
          space = true;
          document.body.classList.add('terrain-pan');
        }
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      if (!typing(e)) e.preventDefault(); // 焦点停在按钮上时,空格不去按那个按钮
      space = false;
      document.body.classList.remove('terrain-pan');
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      space = false;
      document.body.classList.remove('terrain-pan');
    };
  }, [t.on]);

  if (importing) return <ImportPanel phone={phone} onUse={applyImport} />;

  const place = isPlaceTool(t.tool) ? PLACE.find((x) => x.id === t.tool)! : null;
  const paint = PAINT.find((x) => x.id === t.tool);
  const hint = place ? place.hint : t.method === 'lasso' ? LASSO_HINT : phone ? PHONE_HINT : paint!.hint;

  const tile = (id: EditTool, name: string, mark: ReactNode) => (
    <button key={id} className={`tp-tile${t.tool === id ? ' on' : ''}`} role="radio" aria-checked={t.tool === id} data-tool={id} onClick={() => setTerrainTool({ tool: id })}>
      {mark}
      {name}
    </button>
  );
  const paintTiles = PAINT.map((x) => tile(x.id, x.name, <i className={`tp-sw k-${x.id}`} />));
  const placeTiles = PLACE.map((x) => tile(x.id, x.name, <Icon name={x.icon} size={18} />));
  const tools = phone ? (
    <div className="sb-group">
      <div className="tp-strip" role="radiogroup" aria-label="工具">
        {paintTiles}
        <span className="tp-bar" />
        {placeTiles}
      </div>
    </div>
  ) : (
    <div className="sb-group">
      <div className="tp-tools" role="radiogroup" aria-label="工具">
        <div className="tp-sub">涂一片</div>
        <div className="tp-tiles c4">{paintTiles}</div>
        <div className="tp-sub">放一处</div>
        <div className="tp-tiles c3">{placeTiles}</div>
      </div>
    </div>
  );

  const opts = (
    <div className="sb-group">
      <div className="tp-opts">
        {place ? (
          <Seg label="大小" act="terrain-place-size" items={place.sizes.map((name, i) => ({ v: i as 0 | 1 | 2, name }))} value={t.size} onPick={(v) => setTerrainTool({ size: v })} />
        ) : (
          <>
            <Seg
              label="画法"
              act="terrain-method"
              items={[
                { v: 'paint' as const, name: '涂抹' },
                { v: 'lasso' as const, name: '圈起来填满' },
              ]}
              value={t.method}
              onPick={(v) => setTerrainTool({ method: v })}
            />
            <SizeSlider r={t.r} />
            {t.tool === 'mountain' && <Seg label="高低" act="terrain-height" items={HEIGHTS.map((name, i) => ({ v: i as 0 | 1 | 2, name }))} value={t.h} onPick={(v) => setTerrainTool({ h: v })} />}
          </>
        )}
      </div>
      <div className="tp-hint">{hint}</div>
    </div>
  );

  const wholeOpts = (
    <div className="tp-opts">
      <Seg
        label="海岸线"
        act="terrain-coast"
        items={COASTS}
        value={coast}
        onPick={setTerrainCoast}
      />
      <Seg
        label="没涂的地方"
        act="terrain-rest"
        items={[
          { v: 'auto' as const, name: '交给程序' },
          { v: 'sea' as const, name: '都是海' },
        ]}
        value={rest}
        onPick={(v) => setSketchRest(v)}
      />
    </div>
  );
  const count = (
    <div className="tp-count">
      <b className="tp-n">{disabled ? '生成中…' : n ? `画了 ${n} 笔` : '还没画'}</b>
      <button className="sb-link" data-act="terrain-undo" disabled={!n && !img} onClick={undoTerrain} title="撤销最后一笔(Ctrl / ⌘ + Z)">
        撤销
      </button>
      <button className="sb-link" data-act="terrain-redo" disabled={!redoOk} onClick={redoTerrain} title="重做(Ctrl / ⌘ + Shift + Z)">
        重做
      </button>
      <button
        className={`sb-link${confirm ? ' danger' : ''}`}
        data-act="terrain-clear"
        disabled={!n && !sk}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          setConfirm(false);
          clearAllTerrain();
        }}
      >
        {confirm ? '确认清除' : '全部清除'}
      </button>
    </div>
  );
  const showRow = (
    <button className="sb-row tp-show" role="switch" aria-checked={t.show} data-act="terrain-show" onClick={() => setTerrainTool({ show: !t.show })}>
      <span className="sb-row-main">在地图上显示草图</span>
      <span className={`ai-switch${t.show ? ' on' : ''}`} aria-hidden="true" />
    </button>
  );
  // 「整张草图」第一行:导入图片;导入过的写照的哪张图、可以去掉
  const imageRow = img ? (
    <div className="sb-row tp-image">
      <Icon name="image" size={18} className="sb-ico" />
      <span className="sb-row-main" title={img.name}>
        {img.name ? `照图：${img.name}` : '照图'}
      </span>
      <button className="sb-link" data-act="terrain-image-remove" onClick={removeImage}>
        去掉
      </button>
    </div>
  ) : (
    <button className="sb-row tp-import" data-act="terrain-import" onClick={pickImage}>
      <Icon name="image" size={18} className="sb-ico" />
      <span className="sb-row-main">
        <b>导入图片</b>
      </span>
      <span className="sb-row-side">手画的地图、高度图</span>
      <Icon name="chevron" size={14} className="sb-chev" />
    </button>
  );
  const coastName = COASTS.find((x) => x.v === coast)?.name ?? '适中';

  return (
    <div className="tp" role="toolbar" aria-label="编辑地形">
      <section className="sb-sec">
        <div className="sb-sec-head">
          <span>编辑地形</span>
          <button className="sb-link tp-done" data-act="terrain-done" onClick={() => setTerrainTool({ on: false })}>
            完成
          </button>
        </div>
        {tools}
      </section>
      {opts}
      {phone ? (
        <div className="sb-group">
          <button className={`sb-row tp-whole${wholeOpen ? ' open' : ''}`} data-act="terrain-whole" aria-expanded={wholeOpen} onClick={() => setWholeOpen((o) => !o)}>
            <Icon name="sketch" size={18} className="sb-ico" />
            <span className="sb-row-main">
              <b>整张草图</b>
            </span>
            {!wholeOpen && <span className="sb-row-side">{`${coastName}，${rest === 'sea' ? '都是海' : '交给程序'}`}</span>}
            <Icon name={wholeOpen ? 'down' : 'chevron'} size={14} className="sb-chev" />
          </button>
          {wholeOpen && (
            <>
              {imageRow}
              {wholeOpts}
              {showRow}
            </>
          )}
          {count}
        </div>
      ) : (
        <section className="sb-sec">
          <div className="sb-sec-head">
            <span>整张草图</span>
          </div>
          <div className="sb-group">
            {imageRow}
            {wholeOpts}
            {count}
            {showRow}
          </div>
          {!img && <div className="tp-fine">也可以把图片直接拖到地图上。</div>}
        </section>
      )}
    </div>
  );
}

/**
 * 圈起来填满正在画的时候,地图底下的一句提示(松手会怎样)。电脑上贴在地图下边(地图放大出了屏幕就贴着窗口底),手机上在卡片上面
 */
export function TerrainCaption({ phone }: { phone: boolean }) {
  const t = useTerrainTool();
  const d = useDraft();
  const im = useImport();
  const impText = t.on ? importCaption(im) : null;
  const on = !!impText || (t.on && !im && !!d.draft && lassoOn(t));
  let style: React.CSSProperties | undefined;
  if (on && !phone) {
    // 地图左右无限接着画,横着看的就是舞台(两边面板中间那一块);竖着取地图下边和舞台下边靠上的那个
    const r = document.querySelector('.terrain-overlay')?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    if (r && stage) style = { left: (stage.left + stage.right) / 2, top: Math.min(Math.min(r.bottom, stage.bottom) + 22, window.innerHeight - 66), bottom: 'auto' };
  }
  const kind = t.tool as SketchKind;
  const name = PAINT.find((x) => x.id === kind)?.name ?? '';
  return (
    <div className={`st-cap st-tip tp-cap${on ? '' : ' off'}`} style={style} aria-hidden={!on}>
      {impText ?? (kind === 'erase' ? '松手自动连上起点，圈里整片交还给程序' : `松手自动连上起点，圈里整片变成${name}`)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 地图覆盖层

const pathOf = (pts: readonly number[]) => {
  let d = `M${pts[0]} ${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
  // 只有一个点:画一个零长度的线段,圆头笔画成一个点
  if (pts.length === 2) d += `L${pts[0] + 0.01} ${pts[1]}`;
  return d;
};

/** 一处修改在地图上的记号:圈(火山、湖)、带子 + 中线(山脉)、带子(画笔)、亮蓝的线(河);线都描一道暗边,浅色、深色的底上都看得清 */
function OpMark({ op, pending }: { op: TerrainOp; pending: boolean }) {
  const cls = `tt-mark k-${op.kind}${pending ? ' pending' : ''}`;
  if (isPointKind(op.kind))
    return (
      <g className={cls}>
        <circle className="tt-halo" cx={op.pts[0]} cy={op.pts[1]} r={op.r} vectorEffect="non-scaling-stroke" />
        <circle className="tt-line" cx={op.pts[0]} cy={op.pts[1]} r={op.r} vectorEffect="non-scaling-stroke" />
      </g>
    );
  const d = pathOf(op.pts);
  if (op.kind === 'river')
    return (
      <g className={cls}>
        <path className="tt-river" d={d} vectorEffect="non-scaling-stroke" />
      </g>
    );
  return (
    <g className={cls}>
      <path className="tt-band" d={d} strokeWidth={op.r * (op.kind === 'range' ? 1.6 : 2)} />
      <path className="tt-halo" d={d} vectorEffect="non-scaling-stroke" />
      <path className="tt-line" d={d} vectorEffect="non-scaling-stroke" />
    </g>
  );
}

/** 草图的一笔:涂抹 = 笔走过的一条宽带子;圈起来填满 = 一块填色的区域描一圈细边;群岛再叠一层小岛的花纹 */
function StrokeMark({ s, pending, pat }: { s: SketchStroke; pending: boolean; pat: string }) {
  const cls = `sk-mark k-${s.kind}${pending ? ' pending' : ''}`;
  if (s.fill)
    return (
      <g className={`${cls} fill`}>
        <path className="sk-area" d={`${pathOf(s.pts)}Z`} />
        {s.kind === 'isles' && <path d={`${pathOf(s.pts)}Z`} style={{ fill: `url(#${pat})`, fillRule: 'evenodd' }} />}
        <path className="sk-edge" d={`${pathOf(s.pts)}Z`} vectorEffect="non-scaling-stroke" />
      </g>
    );
  const d = pathOf(s.pts);
  return (
    <g className={cls}>
      <path className="sk-band" d={d} strokeWidth={s.r * 2} />
      {s.kind === 'isles' && <path d={d} style={{ stroke: `url(#${pat})` }} strokeWidth={s.r * 2} />}
    </g>
  );
}

const sameStroke = (a: SketchStroke, b: SketchStroke) =>
  a === b || (a.kind === b.kind && a.r === b.r && a.h === b.h && a.fill === b.fill && a.pts.length === b.pts.length && a.pts.every((v, i) => v === b.pts[i]));
const NO_STROKES: readonly SketchStroke[] = [];
const disp = (pts: readonly number[], wrap: number) => (wrap ? displayPts(pts, wrap) : (pts as number[]));

/**
 * 草图那一层:按先后叠;遇到擦掉的一笔,把之前叠好的整个用它挖掉(左右各挪一圈也挖,跨 180° 经线的照样擦得掉)。
 * erasing = 正在用擦掉涂的那一笔(跟着一起挖,淡淡描出擦到哪儿)
 */
function sketchLayer(
  strokes: readonly SketchStroke[],
  sameS: number,
  image: { img: SketchImage; pending: boolean } | null,
  erasing: SketchStroke | null,
  uid: string,
  width: number,
  height: number,
  wrap: number,
) {
  const pat = `${uid}-isles`;
  const masks: ReactNode[] = [];
  let body: ReactNode[] = [];
  type Entry = { s: SketchStroke; pending: boolean; draft: boolean } | { img: SketchImage; pending: boolean };
  const list: Entry[] = strokes.map((s, i) => ({ s, pending: i >= sameS, draft: false }));
  // 导入的图铺在第 at 笔之后(前面的笔被它盖住,后面的盖在它上面)
  if (image) list.splice(Math.min(image.img.at ?? 0, list.length), 0, image);
  if (erasing) list.push({ s: erasing, pending: true, draft: true });
  list.forEach((e, i) => {
    if ('img' in e) {
      // 导入的图盖住的格子(海也算)生成时盖掉了前面的笔:前面画好的整个用它挖掉,再画这一层
      const url = body.length ? coverMaskUrl(e.img.cells) : '';
      if (url) {
        const id = `${uid}-i${i}`;
        masks.push(
          <mask key={id} id={id} maskUnits="userSpaceOnUse" x={-width} y={-height} width={width * 4} height={height * 3}>
            <rect x={-width} y={-height} width={width * 4} height={height * 3} fill="#fff" />
            {[0, ...(wrap ? [-wrap, wrap] : [])].map((dx) => (
              <image key={dx} href={url} x={dx} y={0} width={width} height={height} preserveAspectRatio="none" />
            ))}
          </mask>,
        );
        body = [
          <g key={id} mask={`url(#${id})`}>
            {body}
          </g>,
        ];
      }
      return void body.push(<LayerMark key={i} image={e.img} width={width} height={height} pending={e.pending} />);
    }
    const { s, pending, draft } = e;
    if (s.kind !== 'erase') return void body.push(<StrokeMark key={i} s={{ ...s, pts: disp(s.pts, wrap) }} pending={pending} pat={pat} />);
    const id = `${uid}-e${i}`;
    const d = s.fill ? `${pathOf(disp(s.pts, wrap))}Z` : pathOf(disp(s.pts, wrap));
    masks.push(
      <mask key={id} id={id} maskUnits="userSpaceOnUse" x={-width} y={-height} width={width * 4} height={height * 3}>
        <rect x={-width} y={-height} width={width * 4} height={height * 3} fill="#fff" />
        {[0, ...(wrap ? [-wrap, wrap] : [])].map((dx) => (
          <path key={dx} d={d} transform={dx ? `translate(${dx} 0)` : undefined} fill={s.fill ? '#000' : 'none'} stroke={s.fill ? 'none' : '#000'} strokeWidth={s.fill ? undefined : s.r * 2} />
        ))}
      </mask>,
    );
    body = [
      <g key={id} mask={`url(#${id})`}>
        {body}
      </g>,
    ];
    if (draft) body.push(<path key={`${id}-d`} className="sk-erasing" d={d} strokeWidth={s.r * 2} />);
  });
  return { masks, body };
}

/**
 * 地图上的覆盖层:开着编辑地形时画出草图(各支笔各自的颜色,半透明;擦掉的地方把之前涂的挖掉)、放的火山湖河、
 * 正在画的那一笔(圈起来填满:虚线圈 + 连回起点的点线)、跟着鼠标的大小圈;"在地图上显示草图"关掉时只留正在画的和光标圈。
 * shown / shownSketch = 地图上现在这个世界是带着哪些地形修改、哪份草图生成的(之后加的、还在重新生成的那几笔闪着)。
 * 画好的草图和放的几处只在它们变了时重排(拖动时只动正在画的那一笔和光标)
 */
export function TerrainOverlay({
  width,
  height,
  shown,
  shownSketch,
  wrap = 0,
  scale = 1,
}: {
  width: number;
  height: number;
  shown: readonly TerrainOp[];
  shownSketch?: SketchEdit;
  wrap?: number;
  /** 屏幕上一个世界单位多少像素(导入图片时序号、小方块按屏幕大小画) */
  scale?: number;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const t = useTerrainTool();
  const edits = useEdits();
  const dr = useDraft();
  const importing = !!useImport();
  const img = edits.sketch?.image;
  const shownImg = shownSketch?.image;
  const ops = edits.terrain;
  const strokes = edits.sketch?.strokes ?? NO_STROKES;
  const shownStrokes = shownSketch?.strokes ?? NO_STROKES;
  const erasePts = t.on && dr.draft && t.tool === 'erase' && t.method === 'paint' ? dr.draft : null;
  const layer = useMemo(() => {
    if (!t.on || (!t.show && !erasePts)) return { masks: [], body: [] };
    // 从第几笔开始地图上还没有(按先后比;撤销的不算)
    let sameS = 0;
    while (sameS < strokes.length && sameS < shownStrokes.length && sameStroke(strokes[sameS], shownStrokes[sameS])) sameS++;
    const image = t.show && img ? { img, pending: !shownImg || shownImg.cells !== img.cells || (shownImg.at ?? 0) !== (img.at ?? 0) } : null;
    return sketchLayer(t.show ? strokes : NO_STROKES, sameS, image, erasePts && { kind: 'erase', r: t.r, pts: erasePts }, uid, width, height, wrap);
  }, [t.on, t.show, t.r, strokes, shownStrokes, img, shownImg, erasePts, uid, width, height, wrap]);
  const opMarks = useMemo(() => {
    if (!t.on || !t.show) return null;
    let same = 0;
    while (same < ops.length && same < shown.length && sameTerrain([ops[same]], [shown[same]])) same++;
    return ops.map((op, i) => <OpMark key={i} op={{ ...op, pts: disp(op.pts, wrap) }} pending={i >= same} />);
  }, [t.on, t.show, ops, shown, wrap]);
  if (!t.on) return null;
  if (importing)
    return (
      <svg className="terrain-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <g id={uid} className="terrain-marks">
          <ImportLayer width={width} height={height} scale={scale} rest={edits.sketch?.rest ?? 'auto'} />
        </g>
        {!!wrap && [-wrap, wrap, 2 * wrap].map((dx) => <use key={dx} href={`#${uid}`} x={dx} />)}
      </svg>
    );
  const r = radiusOf(t);
  const pat = `${uid}-isles`;

  let draftMark: ReactNode = null;
  if (dr.draft) {
    const pts = dr.draft;
    if (t.tool === 'river') draftMark = <OpMark op={{ kind: 'river', pts, r, s: 1 }} pending />;
    else if (!isPlaceTool(t.tool) && t.method === 'lasso') {
      const n = pts.length;
      draftMark = (
        <g className={`sk-lasso k-${t.tool}`}>
          <path className="sk-lasso-area" d={`${pathOf(pts)}Z`} vectorEffect="non-scaling-stroke" />
          {n >= 4 && <path className="sk-lasso-close" d={`M${pts[n - 2]} ${pts[n - 1]}L${pts[0]} ${pts[1]}`} vectorEffect="non-scaling-stroke" />}
        </g>
      );
    } else if (!isPlaceTool(t.tool) && t.tool !== 'erase') {
      const s: SketchStroke = { kind: t.tool as SketchKind, r: t.r, pts };
      draftMark = <StrokeMark s={s} pending pat={pat} />;
    }
  }

  return (
    <svg className="terrain-overlay" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <pattern id={pat} patternUnits="userSpaceOnUse" width="22" height="22" fill="rgba(150, 225, 110, 0.85)">
          <circle cx="5" cy="6" r="3.4" />
          <circle cx="15" cy="4" r="2.2" />
          <circle cx="13" cy="15" r="3.8" />
          <circle cx="3" cy="17" r="1.8" />
        </pattern>
        {layer.masks}
      </defs>
      <g id={uid} className="terrain-marks">
        {layer.body}
        {opMarks}
        {draftMark}
        {dr.cursor && !dr.draft && (
          <g className="tt-cursor">
            <circle className="tt-halo" cx={dr.cursor[0]} cy={dr.cursor[1]} r={r} vectorEffect="non-scaling-stroke" />
            <circle className="tt-line" cx={dr.cursor[0]} cy={dr.cursor[1]} r={r} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </g>
      {/* 左右各挪一圈再画几份(主图右边还接着一份;跨 180° 经线的线两边都看得到) */}
      {!!wrap && [-wrap, wrap, 2 * wrap].map((dx) => <use key={dx} href={`#${uid}`} x={dx} />)}
    </svg>
  );
}
