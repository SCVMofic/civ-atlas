import './theme.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { DEFAULT_PARAMS, type World, type WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import { renderRealistic } from '../render/realistic';
import { renderFantasy } from '../render/fantasy';
import { TerrainDetail } from './TerrainDetail';
import { MapDecor } from './MapDecor';
import { nearX, wrapOf } from '../render/common';
import {
  centerX,
  clampCurved,
  clampSphere,
  getMapCenter,
  handleMapCenterRequests,
  lonOfX,
  mirrorCanvas,
  publishMapCenter,
  requestMapCenter,
  stageToWorld,
  useMapCenter,
  viewCentredAt,
  worldToStage,
  windowSpan,
  xOfLon,
  type StageBox,
} from './mapWrap';
import { projectWorld, projectWorldNear, unprojectRel, unprojectWorld, wrapLon, type MapProj } from '../render/projection';
import {
  GLOBE_READY,
  ProjLayer,
  curvedProj,
  getProjection,
  isCurved,
  isMapProjection,
  pageColor,
  presentTerrain,
  setGraticule,
  setMapMoving,
  setProjection,
  useGraticule,
  useMapMoving,
  useProjection,
  type MapProjection,
} from './projection';
import { LAYERS, renderLayer, type LayerId } from '../render/layers';
import { Legend } from './Legend';
import type { EraWorld, TempoNote, WorkerResponse } from '../worker/protocol';
import type { AppError } from '../worker/protocol';
import { WorldComputeService } from '../worker/client';
import type { Civ } from '../gen/civ/types';
import { CivLayer } from './CivLayer';
import { CivTimeline } from './CivTimeline';
import { EventPins, type WorldToClient } from './EventPins';
import { HistoryBook } from './HistoryBook';
import { AiSettingsHost } from './AiSettings';
import { AccountHost, ShareGone, SharedHint, closeTrash, openLogin, setGoHome, useTrashView } from './AccountDialogs';
import { openBundleText } from './bundle';
import { serverBase } from '../account/server';
import { getSession, takeInviteFromUrl } from '../account/session';
import { setReloadHandler, startSync } from '../account/sync';
import { SHARE_CODE_RE, openShareCode, shortLink } from '../account/cloud';
import { ServerError } from '../account/server';
import { highlightBox, highlightMarks } from '../render/civ/highlight';
import {
  clearChroniclePick,
  clearSelection,
  getChronicle,
  getCivShow,
  getCivTime,
  getSelection,
  pausePlayback,
  playFrom,
  prepareCivReplay,
  resetCivTime,
  setChronicle,
  takeAutoplay,
  setCivShow,
  setSelection,
  startCivReplay,
  stepYear,
  togglePlayback,
  useChronicle,
  useCivHighlight,
  useChroniclePick,
  useCivShow,
  useSelection,
  type MapSelection,
} from './civView';
import {
  EMPTY_EDITS,
  GENERATOR_VERSION,
  applyNames,
  aiNameKeys,
  faithKey,
  keySeats,
  namesWithoutAi,
  placeKeyOf,
  polityKey,
  regionKey,
  resolveKey,
  sameInterventions,
  settlementKey,
  upgradeLegacyKeys,
  type Intervention,
  type TerrainOp,
  type Upheaval,
  type WorldEdits,
} from '../gen/edits';
import { sameTerrain, sameUpheavals } from '../gen/terrainEdits';
import type { RasterPatch } from '../gen/rasterPatch';
import { baseRegions, civAtEra, dropComposed, eraData, eraIndex, eraMapsOf, eraReady, eraShown, patchKey, reuseRegions, useEraIndex, withHistory, type EraMaps } from './eras';
import { sameSketch, type SketchEdit } from '../gen/sketch';
import { clearEditHistory, clearEdits, getEdits, removeIntervention, removeUpheaval, setEditGate, setEdits, undoTerrainOp, useEdits } from './editsStore';
import { redoLastEdit, undoLastEdit } from './undo';
import { useShortcuts } from './useShortcuts';
import { ShortcutsHost, openShortcuts } from './ShortcutsDialog';
import { TipLayer } from './Tips';
import { openSaveMenu } from './SaveMenu';
import { replayStart } from './timelineLayout';
import {
  checkWarning,
  cleanSignature,
  cleanTitle,
  decodeShare,
  editCount,
  GEN_KEY,
  isShareHash,
  parseSave,
  versionNote,
  worldCheck,
  worldKey,
  type ParseResult,
  type SaveFile,
  type SaveOrigin,
  type SaveView,
} from '../gen/savefile';
import {
  THUMB_H,
  THUMB_W,
  attachWorld,
  briefError,
  briefWarning,
  currentWorld,
  deleteWorld,
  detachWorld,
  importSave,
  isStored,
  isWorldId,
  legacyWorld,
  listWorlds,
  loadWorld,
  markCreated,
  markOpened,
  newWorldId,
  nextTitle,
  notify,
  persistent,
  refreshThumb,
  renameWorld,
  sameOrigin,
  setReopenHandler,
  setThumbMaker,
  setWorldStats,
  startAutoSave,
  updateCheck,
  useSavesVersion,
  viewChanged,
  type StoredWorld,
  type WorldKind,
} from './saveStore';
import { getStage, setStage, useStage, type DraftBase, type Stage } from './stageStore';
import { polityAlive } from '../gen/civ/growth';
import { CIV_SHOW_OFF, drawCivOverlay } from '../render/civ/overlay';
import { getPolityPick, interventionActorThen, interventionDoneText, setPickHover, setPolityPick, usePolityPick } from './Interventions';
import { Inspector } from './Inspector';
import { TargetLayer } from './TargetPlates';
import { FLY_MS, animProgress, curvedFly, easeOutCubic, flatFly, markFocus, personKey, pointsFocus, resolvePersonKey, selectionFocus, selectionKey, sideRoom, phoneFree, type FlyGoal } from './flyTo';
import { MarkLayer, markHitAt, markPinAt, markPinTip, type MarkApi } from './MarkLayer';
import { cancelDraft, getMarkUi, newMarkDraft, patchDraft, resetMarkUi, setMarkDragging, stopPlacing, toggleDraftRegion, useMarkUi } from './markStore';
import { markHover, markSpot, ownerName } from './markInfo';
import { CharacterLayer, characterPinAt, characterPinTip } from './CharacterLayer';
import { draftAsCharacter, escapeCharacter, getCharUi, parseYear as parseCharYear, pickPlace, resetCharacterUi, stopPicking, useCharUi } from './characterStore';
import { characterHover, placeOf, whereOfCity, whereOfRegion } from './characterInfo';
import { lifeStops, type Where } from '../gen/characters';
import { regionLabel } from '../gen/civ/display';
import { NAME_ZOOM } from '../render/marks';
import { collapseSide, expandSide, getSide, setSideHold, useSide } from './sideStore';
import { getPanel, setSheet, setWorldSheet, usePanel } from './panelStore';
import { closeOverview, getPeople, setPeople } from './overviewStore';
import { STUDIO_STYLES, Studio } from './studio/Studio';
import { setFlatGeomSource, useStudioFlat } from './studio/studioStore';
import { MyWorlds } from './MyWorlds';
import { useCoarse, useNarrow } from './device';
import { isDoubleTap, pinchStep, type Pt, type Tap } from './gestures';
import { createPinchGuard, createWheelReader, inGesturePinch, setGesturePinch, wheelSample } from './wheel';
import { mapTextBoxes, pickLabelAt } from './mapPick';
import { ownersAt } from '../gen/civ/timeline';
import { faithAt } from '../gen/civ/religion';
import { interventionOutcome } from '../gen/civ/chronicle';
import { takeRewriteNote, type RewriteNote } from './rewriteStore';
import { AssistantPanel, PreviewBanner } from './Assistant';
import { astRoom, closeAssistant, useAstOpen } from './astPanel';
import { PREVIEW_EDIT_BLOCK, exitPreview, getAssistant, newConversation, sameInBoth, setTrialRunner, stopAsk, syncAssistantWorld, useAssistantPreview } from './assistantStore';
import { closeBookReader, closeHistoryBook, stopBook } from './bookStore';
import { useAiOn } from '../ai/client';
import { Globe, getGlobeOn, setGlobeOn, useGlobeOn, type GlobeApi } from './Globe';
import { setupAi } from '../ai/setup';
import { ToastBar, clearToast, showToast } from './Toast';
import { DRAFT_SEG, FirstHint, HoverCard, MapBar, MapControls, PhoneButtons, SEG_LAYERS, hintSeen, markHintSeen } from './Corners';
import { Sidebar } from './Sidebar';
import { PhoneSheet } from './PhoneSheet';
import { useLayerThumbs } from './LayerPopover';
import { WorldOverview } from './WorldOverview';
import { hoverInfo, probeLines, type HoverInfo } from './hoverInfo';
import { layerDark, layerDef, layerFromUrl, layerOf, type MapLayer, type Style } from './mapLayers';
import {
  TerrainOverlay,
  getTerrainTool,
  setTerrainTool,
  setTerrainWrap,
  terrainClick,
  terrainDown,
  terrainMove,
  terrainUp,
  terrainCancel,
  useTerrainTool,
  type TerrainStatus,
} from './TerrainTools';
import { isImageFile, startImport, useImportOn } from './ImportImage';
import { closeUpheaval, getUpUi, setUpRunner, takeUpPreview, undoUpOp, upCancel, upClick, upDown, upMove, upUp, upheavalName, useUpUi } from './upheavalStore';
import { UpheavalHint, UpheavalOverlay } from './UpheavalPanel';
import { dismissing, tookDismissClick } from './dismissClick';
import { makeFlagView, setFlagView, useFlagPreview } from './flagStore';
import { noteGenSpeed } from './genSpeed';

type Replay = { w: number; h: number; frames: Uint8ClampedArray[]; mya: number[]; idx: number };

function readUrl() {
  const q = new URLSearchParams(location.search);
  const params: WorldParams = { ...DEFAULT_PARAMS };
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    const v = q.get(k);
    if (v !== null && !Number.isNaN(Number(v))) params[k] = Number(v);
  }
  // 画风 / 数据图层:旧链接的 style=、layer= 照旧;没有 style= 时 layer= 是新的图层名(政区、民族……,见 mapLayers.ts)
  const qs = q.get('style');
  const ql = q.get('layer');
  const mapLayer = layerFromUrl(q);
  let style: Style = qs === 'realistic' || qs === 'data' ? qs : 'fantasy';
  let layer: LayerId = LAYERS.some((l) => l.id === ql) ? (ql as LayerId) : 'biomes';
  if (mapLayer) {
    const d = layerDef(mapLayer);
    style = d.style;
    if (d.data) layer = d.data;
  }
  // 分享链接:# 后面是整份存档(gen/savefile.ts 的 encodeShare)
  const share = isShareHash(location.hash) ? location.hash : null;
  // 分享短链接(网站/s/<码> 转过来的 ?s=<码>):存档在服务器上,打开时去取
  const shortShare = q.get('s');
  // 投影、中央经线(改了就写进网址,刷新、复制网址都还在)
  // 地球仪以前写的是 view=globe,照样认
  const pq = q.get('proj') ?? (q.get('view') === 'globe' ? 'globe' : null);
  const proj: MapProjection = isMapProjection(pq) && (pq !== 'globe' || GLOBE_READY) ? pq : 'equirect';
  const lq = Number(q.get('lon'));
  const lon = q.get('lon') !== null && Number.isFinite(lq) ? wrapLon(lq) : null;
  const grat = q.get('grat') === '1';
  // 生成器版本(gen=):这个网址是哪一版画出来的世界;和现在的不同,打开时说清变了什么。旧网址没有 = 不知道,不提示;
  // 带了却认不出(不是整数之类)当成第 0 版:认不出的旧版本,照样提示,也不当成没带 gen 的老网址
  const gq = q.get(GEN_KEY);
  const gen = gq === null ? null : /^\d{1,6}$/.test(gq) ? Number(gq) : 0;
  return { params, style, layer, mapLayer, share, shortShare, proj, lon, grat, gen };
}

/**
 * 换了图层:写进网址(layer= 新的图层名;去掉旧的 style=,civ= 里的国家 / 民族 / 信仰开关交给图层管),刷新、复制网址都还在
 */
function writeLayerUrl(id: MapLayer) {
  const q = new URLSearchParams(location.search);
  q.delete('style');
  const civ = q.get('civ');
  if (civ !== null) {
    const rest = civ.split(/[,+ ]/).filter((k) => k && !/^-?(polities|cultures|faiths)$/.test(k));
    if (rest.length) q.set('civ', rest.join(','));
    else q.delete('civ');
  }
  // 默认的"政区"可以省掉(没有 civ= 时才省:有 civ= 的旧链接按它认图层)
  if (id === 'political' && !q.has('civ')) q.delete('layer');
  else q.set('layer', id);
  const next = `?${q}`;
  if (next !== location.search) history.replaceState(null, '', next);
}

/** 一个要打开的世界:生成(或直接用正在看的这一个)→ 套上修改 → 交给 saveStore 自动存 */
interface Target {
  id: string;
  kind: WorldKind;
  params: WorldParams;
  edits: WorldEdits;
  /** 已经存下的修改(套上的和它是同一个对象就不重写) */
  saved?: WorldEdits;
  title?: string;
  /** 新建中、作者还没动过(不存) */
  pristine?: boolean;
  /** 以某个世界为底稿新建 */
  base?: DraftBase | null;
  /** 换成存档里的投影和中央经线(undefined = 不动;null = 等距圆柱、0°) */
  view?: SaveView | null;
  /** 从哪打开的(生成完的提示按它说) */
  from?: 'file' | 'link' | 'stored' | 'restore' | 'url';
  /** 网址里带的生成器版本(from = 'url':打开带种子的网址) */
  gen?: number;
  /** 打开的存档(核对版本、地形) */
  save?: SaveFile;
  /** 读档时的警告 */
  warnings?: string[];
  /** 从分享短链接打开的:它的码(还没存进我的世界时留在网址里,刷新再取一次,看到分享的人最新的改动) */
  shareCode?: string;
  /** 底稿出处(存档里带着的;打开别人的分享短链接时是那个链接,改了另存时写进去) */
  origin?: SaveOrigin | null;
}

/** 随机一个种子(新建世界、"换一颗") */
function randomSeedValue(): number {
  return Math.floor(Math.random() * 999999) + 1;
}

/** 新建中的世界现在的样子(参数、修改、名字),比较动没动过用 */
function draftSig(params: WorldParams, edits: WorldEdits, title?: string): string {
  return JSON.stringify([worldKey(params), edits, title ?? '']);
}

/** 一个新建中的世界(还没动过) */
function draftTarget(params: WorldParams, base: DraftBase | null = null, edits: WorldEdits = EMPTY_EDITS, title?: string): Target {
  return { id: newWorldId(), kind: 'draft', params, edits, pristine: true, base, title };
}

/** 存着的一个世界(刷新页面回到它时投影照网址,不换) */
function storedTarget(w: StoredWorld, from: 'stored' | 'restore'): Target {
  return {
    id: w.id,
    kind: w.draft ? 'draft' : 'created',
    params: w.save.params,
    edits: w.save.edits,
    saved: w.save.edits,
    title: w.save.title,
    base: w.base ?? null,
    pristine: false,
    view: from === 'restore' ? undefined : (w.save.view ?? null),
    from,
    save: w.save,
    origin: w.save.origin ?? null,
  };
}

/** 网址里带种子的(别人发的网址、截图脚本):直接看这个世界,先不存,改了才存 */
function visitTarget(params: WorldParams, gen: number | null = null): Target {
  const t: Target = { id: newWorldId(), kind: 'visit', params, edits: EMPTY_EDITS };
  return gen === null ? t : { ...t, from: 'url', gen };
}

/**
 * 打开网页时去哪(只算一次):
 *   分享短链接(s=)    → 先是一页空白,去服务器取存档;取到了打开那个世界,停了显示"这个分享已经停止了"
 *   分享链接(#)       → 那个世界(先按网址生成,解开以后套上修改)
 *   w=世界编号(存着)   → 这个世界(没建完的回到新建)
 *   new=1             → 新建(网址里的种子、参数)
 *   带种子的网址       → 直接看这个世界(改版前存过的就回到那个存档)
 *   都没有             → 我的世界(第一次来是空的那一页:一颗地球、一句话、「新建世界」;点了才生成星球)
 */
function firstRoute(init: ReturnType<typeof readUrl>): { stage: Stage; target: Target | null } {
  const q = new URLSearchParams(location.search);
  if (init.shortShare !== null && !init.share) return { stage: 'home', target: null };
  if (init.share) return { stage: 'world', target: visitTarget(init.params) };
  const w = q.get('w');
  const stored = isWorldId(w) ? loadWorld(w) : null;
  if (stored) return { stage: stored.draft ? 'draft' : 'world', target: storedTarget(stored, 'restore') };
  if (q.get('new') === '1') return { stage: 'draft', target: draftTarget(init.params) };
  if (q.has('seed')) {
    // 改版前自动存的世界:那时的网址只带种子、参数,刷新照旧回到它(带 gen= 的是改版后的网址,不是它)
    const old = init.gen === null ? legacyWorld(init.params) : null;
    if (old) return { stage: old.draft ? 'draft' : 'world', target: storedTarget(old, 'restore') };
    return { stage: 'world', target: visitTarget(init.params, init.gen) };
  }
  return { stage: 'home', target: null };
}

/** 新建时能看的样式(不用历史的那几种) */
const STUDIO_LAYERS: MapLayer[] = STUDIO_STYLES.map((x) => x.id);

/** 新建时列不出来的图层(要有历史):进新建时换成"地形",建好以后换回来 */
const HISTORY_LAYERS: MapLayer[] = ['political', 'cultures', 'faith'];

/** 把世界写进网址:种子 + 参数(和默认值相同的省略,别人打开是同一颗星球);存着的加 w=编号,新建中还没存的加 new=1 */
function writeWorldUrl(t: Target) {
  const q = new URLSearchParams(location.search);
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    if (k === 'seed' || t.params[k] !== DEFAULT_PARAMS[k]) q.set(k, String(t.params[k]));
    else q.delete(k);
  }
  q.delete('w');
  q.delete('new');
  q.delete('s');
  // 分享短链接打开的、还没存进我的世界:码留在网址里(刷新再取一次)
  if (t.shareCode && t.kind === 'visit' && !isStored(t.id)) q.set('s', t.shareCode);
  // 存着的记录还是换参数之前的(新建中换了种子、参数,正在生成):先不指向它,存好了再换成 w=
  const w = isStored(t.id) ? loadWorld(t.id) : null;
  if (w && worldKey(w.save.params) === worldKey(t.params)) q.set('w', t.id);
  else if (t.kind === 'draft') q.set('new', '1');
  // 生成器版本:复制这个网址发给别人,以后版本更新了对方打开会说清变了什么。
  // 网址来自更新的版本(页面是旧的)就留着那个号:刷新还是旧页面照样提示,换到新页面就对上了。
  // 新建中还没存的(new=1)不带:打开这种网址是接着新建,用的总是现在的版本
  if (q.has('new')) q.delete(GEN_KEY);
  else q.set(GEN_KEY, String(t.gen !== undefined && t.gen > GENERATOR_VERSION ? t.gen : GENERATOR_VERSION));
  const next = `?${q}`;
  if (next !== location.search) history.replaceState(null, '', next);
}

/** 回到"我的世界":网址里去掉这个世界(种子、参数、编号、年份……),留着图层、投影这些看法 */
function writeHomeUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of [...Object.keys(DEFAULT_PARAMS), 'w', 'new', 's', GEN_KEY, 'civYear', 'play', 'chron']) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, '', rest ? `?${rest}` : location.pathname);
}

/** 创建完要不要从第 0 年起放一遍历史(网址给了 play=0、无头浏览器里不放;play=1 一定放) */
function storyOk(): boolean {
  const play = new URLSearchParams(location.search).get('play');
  if (play === '0') return false;
  if (play === '1') return true;
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

/** 主线程最多留多少块各段的主图补丁(换了地形大事、撤销回去时用得上;先丢最早的) */
const PATCH_KEEP = 24;
/** 同一个世界画好的整张图留几张(地形大事前后各一张;见下面的 mapsOf) */
const MAP_KEEP = 2;

/** 请求里带的地形大事(没有 = 不带) */
const upsOpt = (u: readonly Upheaval[] | undefined) => (u?.length ? { upheavals: [...u] } : {});

/** 结束那一年现存几国(我的世界的卡片上写;没长出文明 = 0) */
function aliveAtEnd(civ: Civ): number {
  return civ.viable ? civ.polities.filter((x) => polityAlive(x, civ.endYear)).length : 0;
}

export function App() {
  const init = useMemo(readUrl, []);
  /** 打开网页时去哪:我的世界 / 新建 / 某个世界(见 firstRoute) */
  const route = useMemo(() => firstRoute(init), [init]);
  /** 进新建时换掉的图层(政区、民族、信仰要有历史);建好 / 打开别的世界时换回来 */
  const draftLayerRef = useRef<MapLayer | null>(null);
  // 网址里的投影、中央经线、经纬网:第一次渲染之前放进 store(等距圆柱的视图在世界出来以后再转过去,见 pendingLon)
  const start = useState(() => {
    setProjection(init.proj);
    if (init.lon !== null) publishMapCenter(init.lon);
    setGraticule(init.grat);
    setStage(route.stage, route.target?.base ?? null);
    // 网址里给的(或默认的)图层:国家 / 民族 / 信仰开不开跟着它;新建时只看地形
    let ml = init.mapLayer;
    let { style, layer } = init;
    // 新建:网址里给的是新建时能看的样式就照它,否则用实景(政区、民族要有历史;建好以后换回来)
    if (route.stage === 'draft') {
      const now = ml ?? layerOf(style, layer, getCivShow());
      if (!STUDIO_LAYERS.includes(now)) {
        if (HISTORY_LAYERS.includes(now)) draftLayerRef.current = now;
        ml = 'realistic';
        style = 'realistic';
        writeLayerUrl(ml);
      } else draftLayerRef.current = now;
    }
    if (ml) {
      const d = layerDef(ml);
      setCivShow({ polities: d.polities, cultures: d.cultures, faiths: d.faiths });
    }
    return { style, layer };
  })[0];
  const graticule = useGraticule();
  const projection = useProjection();
  const curved = isCurved(projection);
  const mapCenter = useMapCenter();
  const projMoving = useMapMoving() && curved;
  const [params, setParams] = useState<WorldParams>(route.target?.params ?? init.params);
  const [style, setStyle] = useState<Style>(start.style);
  const [layer, setLayer] = useState<LayerId>(start.layer);
  const { stage, base: stageBase } = useStage();
  const draft = stage === 'draft';
  const home = stage === 'home';
  /** 新建界面(Studio)创建以后还没走完:1 = 星球展开成平常的地图,2 = 新建界面淡出(底下平常的地图露出来) */
  const [studioOut, setStudioOut] = useState<0 | 1 | 2>(0);
  /** 新建界面盖着整页:深色、太空底,平常的地图藏起来(摊平改地形时铺在中间那块) */
  const studioOn = draft || studioOut === 1;
  const studioFlat = useStudioFlat();
  // 宽屏左边的卡片收起了(sideStore.ts):新建世界那一步左边是新建世界的卡片,不算收起(sideRoom 照常让出它)
  const sideUi = useSide();
  setSideHold(stage !== 'world');
  /** 正在打开 / 已经打开的世界(生成完按它套上修改、交给自动存) */
  const targetRef = useRef<Target | null>(route.target);
  /** 新建中的名字(卡片上的输入框;打开没建完的世界时是它存的名字) */
  const [draftTitle, setDraftTitle] = useState(route.target?.kind === 'draft' ? (route.target.title ?? '') : '');
  /** 生成出来的世界和主图(地形大事以前的;地图上画的是 data:时间轴那一段的) */
  const [baseData, setData] = useState<{ world: World; raster: Raster } | null>(null);
  /** 地形大事以后各段的世界(后台线程交来的;没有大事 = null)、各段主图的补丁(后台慢慢铺好交来;eras.ts) */
  const [eraMaps, setEraMaps] = useState<EraMaps | null>(null);
  const eraPatches = useRef(new Map<string, RasterPatch | null>());
  const [patchVer, setPatchVer] = useState(0);
  // 生成出来的文明("原始 civ")+ 用户的改名(editsStore)= 界面用的 civ。改名只重算这一步,不发给后台线程
  const [rawCiv, setRawCiv] = useState<Civ | null>(null);
  const edits = useEdits();
  // 助手的"先在地图上看看":地图、卡片、时间轴换成试推演的历史(州和宜居度和现在共用;作者的世界没动,rawCiv 还是原来的)
  const astOpen = useAstOpen();
  const preview = useAssistantPreview();
  const previewRaw = preview?.raw ?? null;
  /** 时间轴现在在第几段(地形大事以后,地图、州、地名、道路跟着换;eras.ts) */
  const eraWant = useEraIndex(previewRaw ?? rawCiv);
  /** 地图上实际画的那一段:那一段的主图还在后台铺时,先画前面铺好了的那一段(历史、世界、主图三样对得上) */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:后台交来新的补丁时重算
  const eraK = useMemo(() => eraShown(eraMaps, eraPatches.current, eraWant), [eraMaps, patchVer, eraWant]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:后台交来新的补丁时重拼
  const data = useMemo(() => (baseData ? eraData(baseData, eraMaps, eraPatches.current, eraK) : null), [baseData, eraMaps, patchVer, eraK]);
  /** 整段历史(最后一段的州、地名,套上改名):编年史这类按它算(见 Civ.history) */
  const realFull = useMemo(() => (rawCiv ? applyNames(rawCiv, edits.names) : null), [rawCiv, edits.names]);
  const previewFull = useMemo(() => (previewRaw ? applyNames(previewRaw, preview!.names) : null), [previewRaw, preview?.names]);
  /** 地图上那一段的历史:那一段的州、地名、道路,套上改名;更早一段时挂上整段历史 */
  const eraView = (raw: Civ, full: Civ, names: Record<string, string>) => {
    const e = civAtEra(raw, eraK);
    return e === raw ? full : withHistory(applyNames(e, names), full);
  };
  /** 现在这个世界的历史(时间轴那一段的) */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- eraView 只用到 eraK
  const realCiv = useMemo(() => (rawCiv && realFull ? eraView(rawCiv, realFull, edits.names) : null), [rawCiv, realFull, eraK, edits.names]);
  const shownRaw = useMemo(() => {
    const r = previewRaw ?? rawCiv;
    return r ? civAtEra(r, eraK) : null;
  }, [previewRaw, rawCiv, eraK]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- eraView 只用到 eraK
  const civ = useMemo(() => (previewRaw && previewFull ? eraView(previewRaw, previewFull, preview!.names) : realCiv), [previewRaw, previewFull, eraK, preview?.names, realCiv]);
  // 国旗(flagStore.ts):所有国家历代的旗,套上作者改过的和「换一面」「自己改」正在预览的那一面;历史和世界对不上(正在重新生成)时先不算。
  // 有地形大事的按第一件以前的地形配(拖时间轴跨过大事旗不跟着变,那以前的旗和没有大事时一样)
  const flagPreview = useFlagPreview();
  const flagGeo = useMemo(() => {
    const r = previewRaw ?? rawCiv;
    if (!r?.eras?.length || !baseData) return undefined;
    return { world: baseData.world, civ: applyNames(civAtEra(r, 0), previewRaw ? preview!.names : edits.names) };
  }, [previewRaw, rawCiv, baseData, preview?.names, edits.names]);
  const flagView = useMemo(
    () =>
      data && civ && civ.viable && civ.habitat.suitability.length === data.world.mesh.n ? makeFlagView(data.world, civ, edits.flags, flagPreview, flagGeo) : null,
    [data, civ, edits.flags, flagPreview, flagGeo],
  );
  useLayoutEffect(() => setFlagView(flagView), [flagView]);
  // 导出时"换回原名"用的:AI 起的名字换回原来的(没有 AI 起的名字、助手"先看看"时 = null,导出菜单不问)
  const plainCiv = useMemo(
    () => (rawCiv && !previewRaw && aiNameKeys(edits).length ? applyNames(civAtEra(rawCiv, eraK), namesWithoutAi(edits)) : null),
    [rawCiv, eraK, previewRaw, edits],
  );
  /** 右侧详情面板开着(右下角的地球仪 / 缩放按钮让开它) */
  const selState = useSelection();
  // 右侧面板开着(选目标、下了令正在推演时面板藏起来,右下按钮回到原位)
  const panelUi = usePanel();
  const pickNow = usePolityPick();
  /** 地形大事的卡片开着(UpheavalPanel.tsx;和选中的东西的卡片在同一处) */
  const upOn = useUpUi().on;
  const panelOpen = (!!selState.sel || upOn) && !!civ && !pickNow && !panelUi.run;
  /** 窄屏(手机):底部的世界 / 详情卡片、时间轴胶囊、右上竖排按钮(phone.css);触屏:没有悬停卡片、右下不放 + −(用双指捏合) */
  const narrow = useNarrow();
  const coarse = useCoarse();
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  /** 生成进度(提示条"正在生成世界"):regen = 按新地形重新生成;seed = 正在生成的种子 */
  const [progress, setProgress] = useState<{ stage: string; pct: number; regen?: boolean; seed?: number } | null>(null);
  /** 悬停小卡片:内容 + 鼠标位置(视口坐标) */
  const [hover, setHoverState] = useState<{ info: HoverInfo; x: number; y: number; place?: 'above' | 'left' } | null>(null);
  // 选目标时鼠标下的可选对象:名牌反色(TargetPlates)
  const setHover = (h: { info: HoverInfo; x: number; y: number; place?: 'above' | 'left' } | null) => {
    setPickHover(h?.info.pick ?? -1);
    setHoverState(h);
  };
  // ---- 图层(政区 / 民族 / 信仰 / 地形 / 生态 / 高程 / 实景 / 板块 / 气温 / 降水)= 画风 + 数据图层 + 国家 / 民族 / 信仰开关 ----
  const civShow = useCivShow();
  const mapLayer = layerOf(style, layer, civShow);
  const mapLayerRef = useRef(mapLayer);
  mapLayerRef.current = mapLayer;
  const theme = studioOn || layerDark(mapLayer) ? 'dark' : 'light';
  // 挂在 body 下的弹窗(AI 设置、史书)也跟着换主题;画第一帧之前就换好(首次打开深色图层时不先闪一下浅色底)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const applyLayer = useCallback((id: MapLayer) => {
    const d = layerDef(id);
    setStyle(d.style);
    if (d.data) setLayer(d.data);
    setCivShow({ polities: d.polities, cultures: d.cultures, faiths: d.faiths });
    writeLayerUrl(id);
  }, []);
  /** 第一次打开的操作提示(第一次拖动 / 缩放 / 点击之后不再出现) */
  const [hintOn, setHintOn] = useState(() => !hintSeen());
  const trashView = useTrashView();
  /** 分享短链接:正在取 / 停了 / 打不开(取到了 = null) */
  const [landing, setLanding] = useState<'loading' | 'gone' | { error: string } | null>(route.stage === 'home' && init.shortShare !== null && !init.share ? 'loading' : null);
  /** 打开别人分享的世界:地图下那条说明(这个世界的编号;点了"知道了"、改了存进我的世界以后不再显示) */
  const [sharedFor, setSharedFor] = useState<{ id: string; short: boolean; by: string } | null>(null);
  const touchRef = useRef(() => {});
  touchRef.current = () => {
    if (getStage().stage !== 'world') return;
    if (!hintOn) return;
    setHintOn(false);
    markHintSeen();
  };
  /** 鼠标最近在哪(视口坐标;地球仪的悬停只给像素,卡片位置用它) */
  const mouseAt = useRef<[number, number]>([0, 0]);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  /** 最上面的屏幕层(文字层放在这里,见 CivLayer 的 labelsHost) */
  const [labelsHost, setLabelsHost] = useState<HTMLDivElement | null>(null);
  /** 放大后的文明细节层放在这一层屏幕层里(见 CivLayer 的 detailHost) */
  const [civDetailHost, setCivDetailHost] = useState<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** 地形图、回放帧在右边接的那一份(左右无限拖动,见 mapWrap.ts) */
  const canvasCopyRef = useRef<HTMLCanvasElement>(null);
  const overlayCopyRef = useRef<HTMLCanvasElement>(null);

  /** 世界计算服务:线程的生死、requestId 发号、取消、错误都在它里面(worker/client.ts,RFC §5/§6) */
  const workerRef = useRef<WorldComputeService | null>(null);
  /** 回执的总处理:服务只建一次,回执经这个 ref 转到最新一次渲染的处理上(和 readyRef 一个路子) */
  const replyRef = useRef<(m: WorkerResponse) => void>(() => {});
  /** 线程报错的提示(worker/client.ts 的 onError);经 ref 转给最新一次渲染 */
  const workerErrRef = useRef<(e: AppError) => void>(() => {});
  /** 试推演发到第几次了(协议里的 tid;回执按 requestId 对上号,这个是和线程那边对齐口径用的) */
  const trialSeq = useRef(0);
  /** 世界的编号(协议里的 id;每换一个世界加一 —— 和 requestId 不是一回事,别再混用) */
  const reqId = useRef(0);
  // ---- 阶段 4 干预:带着干预在后台重推文明 ----
  /** 最近一次请求的文明是带着哪些干预推的(生成新世界时 = 没有) */
  const civEdits = useRef<readonly Intervention[]>(EMPTY_EDITS.interventions);
  /**
   * 地形大事:最近一次请求的文明带着哪些(civUps)、最近一次生成新世界时带着哪些(genUps)、地图上现在这份历史带着哪些(rawUps)。
   * 重推回来的和现在这份带着一样的大事,州才能沿用(地理没变)
   */
  const civUps = useRef<readonly Upheaval[] | undefined>(undefined);
  const genUps = useRef<readonly Upheaval[] | undefined>(undefined);
  const rawUps = useRef<readonly Upheaval[] | undefined>(undefined);
  /** 读档 / 自动恢复套上的地形大事(按它重推完不提示) */
  const restoredUps = useRef<readonly Upheaval[] | undefined | null>(null);
  /** 第几次重推(只认最新的一次);这次重推从哪一年起变、什么时候发出去的 */
  const resimSeq = useRef(0);
  /** 读档 / 自动恢复套上的干预列表(按它重推完不提示"已生效"、不打断自动播放) */
  const restoredIv = useRef<readonly Intervention[] | null>(null);
  const resimInfo = useRef<{
    seq: number;
    year: number;
    t0: number;
    workerMs?: number;
    arrived?: number;
    /** 这次重推是新加了一条干预 / 撤销了一条(推完在顶部提示"…,已从 N 年起重新推演""已撤销") */
    added?: Intervention;
    removed?: Intervention;
    /** 这次重推是新加了一件地形大事 / 撤销了一件 */
    upAdded?: Upheaval;
    upRemoved?: Upheaval;
    left?: number;
    /** 读档 / 自动恢复套上的干预:推完不提示、不打断自动播放 */
    quiet?: boolean;
    /** 这次重推是一次 AI 改写 / 撤销改写(推完说"已按你说的改写",带撤销) */
    note?: RewriteNote;
  } | null>(null);
  const [resim, setResim] = useState<{ year: number } | null>(null);
  /** 正在按新的干预重推历史(缩略图等推完再截) */
  const resimRef = useRef(false);
  resimRef.current = !!resim;
  const rawRef = useRef<Civ | null>(null);
  rawRef.current = rawCiv;
  /** 当前这个世界(编号 reqId.current)的参数;回放时带给线程,线程重开过也能按参数重算 */
  const genParams = useRef<WorldParams | null>(null);
  // ---- 阶段 4 改地形:世界 = 参数 + 地形修改 ----
  /** 最近一次请求的世界带着哪些地形修改(回放、重推时带给线程) */
  const genTerrain = useRef<readonly TerrainOp[]>(EMPTY_EDITS.terrain);
  /** 最近一次请求的世界照着哪张草图(没画 = undefined;回放、重推时带给线程) */
  const genSketch = useRef<SketchEdit | undefined>(undefined);
  /** 换了新世界、还没套上它的修改(自动恢复 / 读档)之前:这时的修改不属于这个世界,不按它重新生成 */
  const fresh = useRef(false);
  /** 正在进行的"按新地形重新生成"(编号 = 那次生成的请求编号);t0 = 发出去的时刻 */
  const regenRef = useRef<{ id: number; t0: number; terrain: readonly TerrainOp[]; sketch?: SketchEdit; workerMs?: number; arrived?: number } | null>(null);
  /** 正在进行的"按新地形重新生成"是一次 AI 改写 / 撤销改写(生成完说"已按你说的改写",带撤销) */
  const regenNote = useRef<RewriteNote | null>(null);
  /** 地图上现在这个世界带着的地形修改(覆盖层据此标出还在生成的那几处) */
  const [shownTerrain, setShownTerrain] = useState<readonly TerrainOp[]>(EMPTY_EDITS.terrain);
  const [shownSketch, setShownSketch] = useState<SketchEdit | undefined>(undefined);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>({ busy: false });
  const terrainTool = useTerrainTool();
  // 导入图片时地图上只看图(地名先藏起来)
  const importing = useImportOn();
  // 手机:改地形、回放世界形成都要看地图 —— 拉到顶的世界卡片先收起来(两样都是从卡片里的"地形"那一组点开的)
  useEffect(() => {
    if (terrainTool.on || replayOn) setWorldSheet('peek');
  }, [terrainTool.on, replayOn]);
  // 点了一条大事(卡片里的"最近大事"、编年史):时间轴跳过去、地图上标出来 —— 世界卡片也先收起
  const chronPick = useChroniclePick();
  useEffect(() => {
    if (chronPick.entry) setWorldSheet('peek');
  }, [chronPick]);
  // 3D 地球仪(网址 proj=globe,旧链接的 view=globe 也认 / 地图右下角的按钮):主图藏起来,同一套时间轴、详情面板、选中逻辑
  const globeOn = useGlobeOn();
  const globeApi = useRef<GlobeApi | null>(null);
  /** 世界坐标 → 屏幕坐标(地图上的事件标签、截图脚本用;下面 __wfWorldToClient 那里定义) */
  const worldToClient = useRef<WorldToClient | null>(null);
  /** 地球仪上的世界坐标 → 屏幕坐标(转到背面 = null),地球仪打开时给事件标签用 */
  const globeToClient = useRef<WorldToClient>((wx, wy) => globeApi.current?.worldToClient(wx, wy) ?? null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** 最近生成完的世界(打开的世界就是正在看的这一个时,不用重新生成) */
  const lastReady = useRef<{ world: World; civ: Civ } | null>(null);
  /** 打不开的分享链接(世界还在生成时解开的):生成完再提示 */
  const shareErr = useRef<string | null>(null);
  /** 世界生成完的处理(存档:自动恢复 / 读档套修改);线程回调里经 ref 调,拿到的总是最新的 */
  const readyRef = useRef<(world: World, civ: Civ) => void>(() => {});
  const dataRef = useRef(data);
  dataRef.current = data;
  /** 生成出来的世界(地形大事以前的;线程回调里用) */
  const baseRef = useRef(baseData);
  const eraMapsRef = useRef(eraMaps);
  eraMapsRef.current = eraMaps;
  /** 弯边投影:当前投影 + 中心放进地图平面(等距圆柱 = null,照原来的办法画) */
  const mp = useMemo(() => (data ? curvedProj(projection, mapCenter, data.world.width, data.world.height) : null), [data, projection, mapCenter]);
  const mpRef = useRef<MapProj | null>(mp);
  mpRef.current = mp;

  // ---- 后台线程(worker/client.ts 的 WorldComputeService) ----
  // 线程一次只能算一个世界。连续改参数时,与其排队把每个中间世界都算完,
  // 不如直接终止还在忙的旧线程、另开一个(启动只要几十毫秒),只算最后一次。
  // 回放帧、重推文明这些短活不打断线程,排在后面(打断了,线程手上的世界就没了,得按参数重新生成,反而更慢)。
  // 这三件事和"回执按 requestId 对上号""取消""错误序列化"都在服务里;这里只处理回执内容本身。
  /** 回执的总处理:服务已按 requestId 对上号,这里再按世界的编号、各自的序号丢掉过时的 */
  replyRef.current = (m: WorkerResponse) => {
    if (m.type === 'trial') return; // 试推演由等着它的那条 promise 收(setTrialRunner);世界换了的话那边已经停下
    if (m.id !== reqId.current) return; // 过时的请求(上一个世界的)
    if (m.type === 'eraPatch') {
      // 一段的主图补丁:记下,地图那一段换上(eras.ts);最多留 PATCH_KEEP 块,先丢最早的(现在这份历史要用的不丢;
      // 丢了的以后又要用,下一次推演时线程看 have 里没有会重新铺)
      const map = eraPatches.current;
      const k = patchKey(m.prev, m.key);
      map.delete(k);
      map.set(k, m.patch);
      const cur = eraMapsRef.current;
      const keep = new Set(cur ? cur.keys.map((key, i) => patchKey(i ? cur.keys[i - 1] : cur.baseKey, key)) : []);
      for (const old of [...map.keys()]) if (map.size > PATCH_KEEP && !keep.has(old)) map.delete(old);
      setPatchVer((v) => v + 1);
      return;
    }
    if (m.type === 'upPreview') return void takeUpPreview(m.pid, m.preview, m.water, m.ms);
    if (m.type === 'progress') setProgress((s) => ({ stage: m.stage, pct: m.pct, regen: regenRef.current?.id === m.id, seed: s?.seed }));
    else if (m.type === 'done') {
      noteGenSpeed(m.world.params.cells, m.genMs, m.ms);
      // 换了世界:各段的主图补丁都作废
      eraPatches.current.clear();
      dropComposed();
      baseRef.current = { world: m.world, raster: m.raster };
      setData(baseRef.current);
      setEraMaps(m.eras ? eraMapsOf(m.world, m.baseKey, m.eras) : null);
      rawUps.current = genUps.current;
      setRawCiv(m.civ);
      setProgress(null);
      const rg = regenRef.current;
      if (rg && rg.id === m.id) terrainDoneRef.current(m.world, m.civ, m.ms);
      else {
        fresh.current = false;
        readyRef.current(m.world, m.civ);
      }
    } else if (m.type === 'history') {
      setReplay({ w: m.w, h: m.h, frames: m.frames, mya: m.mya, idx: 0 });
    } else if (m.type === 'civ') {
      if (m.seq !== resimSeq.current) return; // 又下了新的干预,等最新的那一次
      applyResimRef.current(m.civ, m.ms, m.eras, m.baseKey);
    }
  };
  /** 线程报错:说明白出了什么事(结构化错误,worker/client.ts 的 onError),而不是让进度条停在那里 */
  workerErrRef.current = (e: AppError) => {
    showToast({ id: 'worker', kind: 'error', text: '计算线程出错', more: [e.message] });
    setProgress(null);
  };
  if (!workerRef.current) {
    workerRef.current = new WorldComputeService({
      onReply: (m) => replyRef.current(m),
      onError: (e) => workerErrRef.current(e),
    });
  }
  /** 服务是稳定的(getters / 方法都不随渲染变),渲染里直接用 */
  const compute = workerRef.current;
  // 助手的试推演:和重推一样交给线程(排在别的活后面),结果单独交回、不换上去;州和宜居度沿用现在这份。
  // 回执按 requestId 对上号(见 worker/client.ts);停下 = 取消这条活,世界换了 = 线程被换掉时以"世界换了…"失败
  useEffect(() => {
    setTrialRunner((interventions, signal) => {
      const p = genParams.current;
      if (!p || !rawRef.current) return Promise.reject(new Error('世界还没生成好'));
      if (signal?.aborted) return Promise.reject(new Error('已停下'));
      const tid = ++trialSeq.current;
      const ups = civUps.current;
      const job = compute.trial({ type: 'trial', id: reqId.current, tid, params: p, terrain: [...genTerrain.current], sketch: genSketch.current, interventions: [...interventions], ...upsOpt(ups) });
      const onAbort = () => job.cancel('已停下');
      signal?.addEventListener('abort', onAbort, { once: true });
      return job.result.then(
        (m) => {
          signal?.removeEventListener('abort', onAbort);
          const old = rawRef.current;
          return old ? reuseRegions(old, m.civ, sameUpheavals(ups, rawUps.current)) : m.civ;
        },
        (e: AppError) => {
          signal?.removeEventListener('abort', onAbort);
          throw new Error(e.message);
        },
      );
    });
    return () => setTrialRunner(null);
  }, [compute]);
  // 地形大事的"会怎么样":交给线程照"那一年的地形 + 这几笔"生成一遍(那一年的地形 = 地图上这份历史带着的大事)
  useEffect(() => {
    setUpRunner((pid, year, ops) => {
      const p = genParams.current;
      if (!p) return;
      compute.previewUpheaval({ type: 'upPreview', id: reqId.current, pid, params: p, terrain: [...genTerrain.current], sketch: genSketch.current, ...upsOpt(rawUps.current), year, ops: [...ops] });
    });
    return () => setUpRunner(null);
  }, [compute]);

  /**
   * 历史换了一份(重推完、在地图上看试推演 / 回到现在):选中的东西、编年史和人物页的国家筛选按稳定键换成新历史里的编号(指不到就取消)。
   * 选中的地方(山海河湖)在下面跟着地图上的地名表换
   */
  const remapSelection = (old: Civ, civ: Civ) => {
    const { sel } = getSelection();
    if (sel) {
      const key =
        sel.kind === 'polity' && old.polities[sel.id]
          ? polityKey(old, sel.id)
          : sel.kind === 'settlement' && old.settlements[sel.id]
            ? settlementKey(old, sel.id)
            : sel.kind === 'faith' && old.religion?.faiths[sel.id]
              ? faithKey(old, sel.id)
              : null;
      if (key) {
        const r = resolveKey(civ, key);
        if (r && r.kind === sel.kind) setSelection({ kind: sel.kind, id: r.id } as MapSelection);
        else clearSelection();
      } else if (sel.kind === 'person') {
        // 人物:同一国、同名、同年生的还在就还选着他(重推后历史变了,多半找不到了)
        const id = old.people?.[sel.id] ? resolvePersonKey(civ, personKey(old, sel.id)) : -1;
        if (id >= 0) setSelection({ kind: 'person', id });
        else clearSelection();
      }
    }
    const cp = getChronicle().polity;
    if (cp !== null) {
      const r = old.polities[cp] ? resolveKey(civ, polityKey(old, cp)) : null;
      setChronicle({ polity: r && r.kind === 'polity' ? r.id : null });
    }
    const pp = getPeople().polity;
    if (pp !== null) {
      const r = old.polities[pp] ? resolveKey(civ, polityKey(old, pp)) : null;
      // 世系图看哪一朝、圈出谁跟着旧历史的编号,作废
      setPeople({ polity: r && r.kind === 'polity' ? r.id : null, dynasty: null, focus: null });
    }
  };
  // 地图上的地名表换了一份(重推完、看试推演、时间轴跨过地形大事):选中的地方按稳定键换成这一份里的编号;
  // 锚点挪了的(海扩大了……)找同种类同名的那一处(大事前后同一处地方沿用地名),都没有就取消。换了世界的不管
  const shownRef = useRef<Civ | null>(null);
  useLayoutEffect(() => {
    const was = shownRef.current;
    shownRef.current = shownRaw;
    if (!was || !shownRaw || was.places === shownRaw.places || baseRegions(was) !== baseRegions(shownRaw)) return;
    const { sel } = getSelection();
    const p = sel?.kind === 'place' ? was.places[sel.id] : undefined;
    if (!sel || !p) return;
    const r = resolveKey(shownRaw, placeKeyOf(was, sel.id));
    const id = r && r.kind === 'place' ? r.id : shownRaw.places.findIndex((q) => q.kind === p.kind && q.name === p.name);
    if (id < 0) clearSelection();
    else if (id !== sel.id) setSelection({ kind: 'place', id });
  }, [shownRaw]);
  /**
   * 重推好的文明换上去(阶段 4 干预):州、宜居度沿用原来那一份(地理没变;时间轴、地图按它认"还是同一个世界"),
   * 选中的东西、编年史的国家筛选按稳定键换成新历史里的编号(指不到就取消),时间轴停在干预那一年
   */
  const applyResim = (next: Civ, workerMs: number, eras: EraWorld[] | undefined, baseKey: string) => {
    const old = rawRef.current;
    const sameUps = sameUpheavals(civUps.current, rawUps.current);
    const civ: Civ = old ? reuseRegions(old, next, sameUps) : next;
    rawUps.current = civUps.current;
    // 地形大事以后各段的世界:和现在一样(只改了干预)就不换,地图不用重画
    const base = baseRef.current;
    const cur = eraMapsRef.current;
    if (!eras?.length || !base) setEraMaps(null);
    else if (!cur || cur.baseKey !== baseKey || cur.keys.join('|') !== eras.map((e) => e.key).join('|')) setEraMaps(eraMapsOf(base.world, baseKey, eras));
    if (old) remapSelection(old, civ);
    clearChroniclePick();
    setPolityPick(null);
    const info = resimInfo.current;
    if (info) {
      info.workerMs = workerMs;
      info.arrived = performance.now() - info.t0;
      if (!info.quiet) playFrom(Math.min(civ.endYear, Math.max(0, info.year)));
      // 已生效(停 7 秒,带撤销)/ 已撤销(停 4 秒)
      const y = Math.max(0, Math.floor(info.year));
      if (info.note) {
        const n = info.note;
        if (n.kind === 'apply') {
          // 这一批新加的命令里有几条没生效(两国不接壤、州里没人住……;原因在概览"我的干预"页)
          const ks = (l: readonly Intervention[]) => l.map((v) => JSON.stringify(v));
          const had = ks(n.before.interventions);
          const done = ks(civ.interventions ?? []);
          const failed = ks(n.after.interventions)
            .filter((k) => !had.includes(k))
            .map((k) => done.indexOf(k))
            .filter((i) => i >= 0 && !interventionOutcome(civ, i).ok).length;
          showToast({
            id: 'resim-done',
            kind: failed ? 'warn' : 'ok',
            text: `已按你说的改写 · 从 ${y} 年重新推演`,
            more: failed ? [`${failed} 条命令没生效,原因见概览的"我的干预"`] : undefined,
            action: n.undo && {
              label: '撤销',
              act: 'rw-undo',
              onClick: () => {
                n.undo?.();
                clearToast('resim-done');
              },
            },
            ttl: 7000,
          });
        } else {
          showToast({ id: 'resim-done', kind: 'ok', text: info.left ? `已撤销改写,从 ${y} 年起重新推演` : `已撤销改写,${y} 年之后恢复原历史`, ttl: 4000 });
        }
      } else if (info.added) {
        const v = info.added;
        const named = applyNames(civ, getEdits().names);
        const idx = (civ.interventions ?? []).findIndex((x) => JSON.stringify(x) === JSON.stringify(v));
        // 国家面板下的令:写面板标题上的名字(用户点的那个);那一年它叫别的名字,第二行补一句
        const run = getPanel().run;
        const shown = run && run.from === v.from ? run.shown : undefined;
        const then = interventionActorThen(named, v);
        showToast({
          id: 'resim-done',
          kind: 'ok',
          text: `${interventionDoneText(named, v, idx, shown)},已从 ${y} 年起重新推演`,
          more: shown && then && then !== shown ? [`${v.from} 年时它叫${then}`] : undefined,
          action: {
            label: '撤销',
            onClick: () => {
              const i = getEdits().interventions.findIndex((x) => JSON.stringify(x) === JSON.stringify(v));
              if (i >= 0) removeIntervention(i);
              clearToast('resim-done');
            },
          },
          ttl: 7000,
        });
      } else if (info.upAdded) {
        const u = info.upAdded;
        showToast({
          id: 'resim-done',
          kind: 'ok',
          text: `${u.year} 年${upheavalName(u)} · 从这一年起重新推演`,
          action: {
            label: '撤销',
            onClick: () => {
              const i = (getEdits().upheavals ?? []).findIndex((x) => JSON.stringify(x) === JSON.stringify(u));
              if (i >= 0) removeUpheaval(i);
              clearToast('resim-done');
            },
          },
          ttl: 7000,
        });
      } else if (info.removed || info.upRemoved) {
        showToast({ id: 'resim-done', kind: 'ok', text: info.left ? `已撤销,从 ${y} 年起重新推演` : `已撤销,${y} 年之后恢复原历史`, ttl: 4000 });
      }
    }
    setRawCiv(civ);
    setResim(null);
  };
  const applyResimRef = useRef(applyResim);
  applyResimRef.current = applyResim;

  // ---- 生成 ----
  /** 按 t 的参数、地形修改生成世界;生成完(readyRef)套上 t 的修改 */
  const generate = useCallback(
    (t: Target) => {
      targetRef.current = t;
      const p = t.params;
      const id = ++reqId.current;
      genParams.current = p;
      setParams(p);
      setProgress({ stage: '准备', pct: 0, seed: p.seed });
      // 手机:新世界、打开存档都要看地图 —— 拉到顶的世界卡片先收起来
      setWorldSheet('peek');
      // 改过地形、画过草图的世界直接带着它们生成,不用先生成原样再重新生成一遍
      const terrain = t.edits.terrain;
      genTerrain.current = terrain;
      genSketch.current = t.edits.sketch;
      fresh.current = true;
      regenRef.current = null;
      setTerrainStatus({ busy: false });
      setShownTerrain(terrain);
      setShownSketch(t.edits.sketch);
      setTerrainTool({ on: false });
      closeUpheaval();
      compute.generate({ type: 'generate', id, params: p, scale: 1, terrain: [...terrain], sketch: t.edits.sketch });
      // 换世界:改名、干预、选中都属于旧世界,一起作废(先停掉旧世界的自动存,清空不算"改回默认";新世界先按"没有干预、没有地形大事"生成)
      detachWorld();
      civEdits.current = EMPTY_EDITS.interventions;
      civUps.current = genUps.current = undefined;
      resimSeq.current++;
      resimInfo.current = null;
      setResim(null);
      setPolityPick(null);
      clearEdits();
      clearSelection();
      if (getPeople().polity !== null) setPeople({ polity: null });
      // 正在进行 / 已算好的回放都属于旧世界,一起作废
      setReplay(null);
      setReplayOn(false);
      // 种子、参数写进网址(分享链接时对方看到的是同一个世界);存着的世界带上编号
      writeWorldUrl(t);
    },
    [compute],
  );

  useEffect(() => {
    // 分享链接:先把 # 那段从地址栏去掉(刷新不会重复导入),解开以后走读档流程;
    // 链接里的种子、参数和网址上的一样,所以照常先按网址生成,不用等
    if (init.share) {
      history.replaceState(null, '', location.pathname + location.search);
      decodeShare(init.share).then((r) => openShareRef.current(r));
    }
    // 邀请链接(invite=):记下邀请码,弹出登录窗(已经登录了就算了)
    if (takeInviteFromUrl() && serverBase() && !getSession()) openLogin();
    if (route.target) generate(route.target);
    else if (landing === 'loading') openShortShare(init.shortShare ?? '');
    else writeHomeUrl();
    // 页面开着时又粘贴了一个只有 # 不同的分享链接(浏览器不刷新页面)
    const onHash = () => {
      const h = location.hash;
      if (!isShareHash(h)) return;
      history.replaceState(null, '', location.pathname + location.search);
      decodeShare(h).then((r) => openShareRef.current(r));
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      workerRef.current?.dispose();
      workerRef.current = null;
    };
    // 只在首次挂载时自动生成;之后由操作触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 改地形(阶段 4):地形修改、草图一变,就在后台带着新地形重新生成世界(连同当时的干预重推文明;
  // 州、历史整个重来,改名和干预按稳定键尽量套上)。写在干预的前面:同时变了的话,干预跟着这次生成一起推 ----
  useEffect(() => {
    const t = edits.terrain;
    const sk = edits.sketch;
    if (!baseData || !genParams.current || fresh.current || (sameTerrain(t, genTerrain.current) && sameSketch(sk, genSketch.current))) return;
    const id = ++reqId.current;
    const interventions = getEdits().interventions;
    const ups = getEdits().upheavals;
    genTerrain.current = t;
    genSketch.current = sk;
    civEdits.current = interventions;
    civUps.current = genUps.current = ups;
    resimSeq.current++;
    resimInfo.current = null;
    setResim(null);
    regenRef.current = { id, t0: performance.now(), terrain: t, sketch: sk };
    regenNote.current = takeRewriteNote(getEdits());
    setTerrainStatus((s) => ({ ...s, busy: true }));
    setProgress({ stage: '准备', pct: 0, regen: true });
    // 回放、选中、编年史和人物页的国家筛选都属于旧地形上的历史
    setReplay(null);
    setReplayOn(false);
    clearSelection();
    setPolityPick(null);
    clearChroniclePick();
    if (getChronicle().polity !== null) setChronicle({ polity: null });
    if (getPeople().polity !== null) setPeople({ polity: null });
    compute.generate({ type: 'generate', id, params: genParams.current, scale: 1, terrain: [...t], sketch: sk, interventions: [...interventions], ...upsOpt(ups) });
  }, [edits.terrain, edits.sketch, baseData, compute]);

  // ---- 干预(阶段 4)、地形大事:干预列表或地形大事一变,就在后台带着新的重推文明(地形不动;变了的那一年以前和原来一样) ----
  useEffect(() => {
    const list = edits.interventions;
    const ups = edits.upheavals;
    if (!baseData || !genParams.current || (sameInterventions(list, civEdits.current) && sameUpheavals(ups, civUps.current))) return;
    if (!sameTerrain(getEdits().terrain, genTerrain.current) || !sameSketch(getEdits().sketch, genSketch.current)) return; // 等改地形那次生成一起推
    // 从哪一年起变:新加的 / 删掉的干预、地形大事里最早的那一年(重推完时间轴停在这里)
    const before = civEdits.current;
    const ks = <T,>(l: readonly T[]) => l.map((v) => JSON.stringify(v));
    const [a, b] = [ks(list), ks(before)];
    const changed = [...list.filter((_, i) => !b.includes(a[i])), ...before.filter((_, i) => !a.includes(b[i]))];
    const upBefore = civUps.current ?? [];
    const upNow = ups ?? [];
    const [ua, ub] = [ks(upNow), ks(upBefore)];
    const upChanged = [...upNow.filter((_, i) => !ub.includes(ua[i])), ...upBefore.filter((_, i) => !ua.includes(ub[i]))];
    const years = [...(changed.length || upChanged.length ? changed : list).map((v) => Math.floor(v.from)), ...upChanged.map((u) => u.year)].filter((y) => Number.isFinite(y));
    const year = years.length ? Math.max(0, Math.min(...years)) : 0;
    civEdits.current = list;
    civUps.current = ups;
    const seq = ++resimSeq.current;
    // 只多了一条 = 新下的干预 / 新加的大事;只少了一条 = 撤销(读档、自动恢复套上的不算,不提示)
    const quiet = list === restoredIv.current && ups === restoredUps.current;
    const one = changed.length + upChanged.length === 1;
    const added = !quiet && one && list.length === before.length + 1 ? changed[0] : undefined;
    const removed = !quiet && one && list.length === before.length - 1 ? changed[0] : undefined;
    const upAdded = !quiet && one && upNow.length === upBefore.length + 1 ? upChanged[0] : undefined;
    const upRemoved = !quiet && one && upNow.length === upBefore.length - 1 ? upChanged[0] : undefined;
    const note = takeRewriteNote(getEdits()) ?? undefined;
    resimInfo.current = { seq, year, t0: performance.now(), added, removed, upAdded, upRemoved, left: list.length + upNow.length, quiet, note };
    setResim({ year });
    compute.resimulate({
      type: 'resim',
      id: reqId.current,
      seq,
      params: genParams.current,
      terrain: [...genTerrain.current],
      sketch: genSketch.current,
      interventions: list,
      ...upsOpt(ups),
      have: [...eraPatches.current.keys()],
    });
  }, [edits.interventions, edits.upheavals, baseData, compute]);
  // 重推的文明画到地图上以后,记下"从下命令到地图更新"用了多久(冒烟检查用)
  useEffect(() => {
    const info = resimInfo.current;
    if (!info || info.arrived === undefined || !rawCiv) return;
    const drawn = performance.now() - info.t0;
    requestAnimationFrame(() => {
      (window as unknown as { __wfResim: unknown }).__wfResim = {
        seq: info.seq,
        year: info.year,
        workerMs: info.workerMs,
        arrivedMs: info.arrived,
        drawnMs: drawn,
        paintedMs: performance.now() - info.t0,
      };
    });
    resimInfo.current = null;
  }, [rawCiv]);

  /**
   * 按新地形重新生成完(阶段 4 改地形):记下新的地形校验(自动存的存档跟着改);
   * 数一数改名、干预有几处在新历史里对不上(面板里提示"暂未生效")
   */
  const terrainDoneRef = useRef<(world: World, civ: Civ, ms: number) => void>(() => {});
  terrainDoneRef.current = (world: World, rc: Civ, ms: number) => {
    const rg = regenRef.current;
    if (!rg) return;
    rg.workerMs = ms;
    rg.arrived = performance.now() - rg.t0;
    lastReady.current = { world, civ: rc };
    setShownTerrain(rg.terrain);
    setShownSketch(rg.sketch);
    const e = getEdits();
    if (sameTerrain(e.terrain, rg.terrain) && sameSketch(e.sketch, rg.sketch)) updateCheck(worldCheck(world));
    const lostNames = Object.keys(e.names).filter((k) => !resolveKey(rc, k)).length;
    // 干预:和世界概览"我的干预"页一个口径(这份历史带着哪些干预推的、哪几条没生效,见 chronicle.ts 的 interventionOutcome)
    const lostInterventions = (rc.interventions ?? []).filter((_, i) => !interventionOutcome(rc, i).ok).length;
    setTerrainStatus({ busy: false, last: { ms: rg.arrived, lostNames, lostInterventions } });
  };
  // 重新生成的世界画到地图上以后,记下"从改地形到地图更新"用了多久(冒烟检查用)
  useEffect(() => {
    const rg = regenRef.current;
    if (!rg || rg.arrived === undefined || !data) return;
    const drawn = performance.now() - rg.t0;
    requestAnimationFrame(() => {
      (window as unknown as { __wfTerrain: unknown }).__wfTerrain = {
        id: rg.id,
        ops: rg.terrain.length,
        workerMs: rg.workerMs,
        arrivedMs: rg.arrived,
        drawnMs: drawn,
        paintedMs: performance.now() - rg.t0,
      };
    });
    regenRef.current = null;
  }, [data]);

  // ---- 存档(阶段 4):自动存、自动恢复、读档 ----
  useEffect(() => startAutoSave(), []);
  // AI(阶段 5):登记服务商、恢复设置、调用记录存本地
  useEffect(() => setupAi(), []);
  // 「使用 AI 功能」关了:助手停下、回到现在、收起;正在写的史书停下(写到一半的不存),写史书的窗口、阅读页关上
  const aiOn = useAiOn();
  useEffect(() => {
    if (aiOn) return;
    stopAsk();
    exitPreview();
    closeAssistant();
    stopBook();
    closeHistoryBook();
    closeBookReader();
  }, [aiOn]);
  // 缩略图("我的世界"的卡片、存档菜单):手绘风的地形 480×240;建好的世界叠上结束那一年的国家色块(和正在看哪个图层、哪一年无关)。
  // 地形是结束那一年的(地形大事以后的那一段)。世界还在生成、按新地形重新生成、按新的干预重推历史、那一段的主图还没铺好时 = null,
  // saveStore 过一会儿再来要
  useEffect(() => {
    setThumbMaker((id) => {
      const t = targetRef.current;
      const b = baseRef.current;
      if (!dataRef.current || !b || fresh.current || regenRef.current || resimRef.current || !t || t.id !== id) return null;
      const kEnd = eraIndex(rawRef.current, null);
      if (!eraReady(eraMapsRef.current, eraPatches.current, kEnd)) return null;
      const d = eraData(b, eraMapsRef.current, eraPatches.current, kEnd);
      const base = baseCanvas('fantasy', d);
      if (!base) return null;
      const cv = document.createElement('canvas');
      cv.width = THUMB_W;
      cv.height = THUMB_H;
      const x = cv.getContext('2d');
      if (!x) return null;
      x.imageSmoothingQuality = 'high';
      x.drawImage(base, 0, 0, cv.width, cv.height);
      const rc = rawRef.current;
      const kind = currentWorld()?.kind;
      if (kind !== 'draft' && rc && rc.viable && rc.habitat.suitability.length === d.world.mesh.n) {
        const ov = document.createElement('canvas');
        ov.width = d.raster.w;
        ov.height = d.raster.h;
        const octx = ov.getContext('2d');
        if (octx) {
          drawCivOverlay(octx, { world: d.world, raster: d.raster, civ: rc, style: 'fantasy', year: rc.endYear, show: { ...CIV_SHOW_OFF, polities: true } });
          x.drawImage(ov, 0, 0, cv.width, cv.height);
        }
        ov.width = ov.height = 0;
      }
      const url = cv.toDataURL('image/jpeg', 0.8);
      cv.width = cv.height = 0;
      return url;
    });
    return () => setThumbMaker(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 推演完(重推历史以后也是):结束那一年现存几国记下来,我的世界的卡片上写
  useEffect(() => {
    const cur = currentWorld();
    if (!rawCiv || !cur || cur.kind === 'draft' || cur.id !== targetRef.current?.id || fresh.current) return;
    setWorldStats(aliveAtEnd(rawCiv));
  }, [rawCiv]);
  /**
   * 世界生成完(或要打开的就是正在看的这一个):套上 targetRef 的修改,交给 saveStore 自动存;
   * 核对版本和地形,有问题就提示
   */
  readyRef.current = (world: World, rc: Civ) => {
    lastReady.current = { world, civ: rc };
    const t = targetRef.current;
    if (!t || currentWorld()?.id === t.id) return;
    // 打不开的分享链接(世界还在生成时解开的):现在提示(单独一条,"已恢复"之类的排在它下面,关掉它再露出来)
    const err = shareErr.current;
    shareErr.current = null;
    if (err) showToast({ id: 'share', kind: 'error', text: '打不开这个分享链接', more: [err] });
    const say = (n: Parameters<typeof notify>[0]) => n && notify({ ...n, more: n.more?.map(briefWarning) });
    const check = worldCheck(world);
    // 投影和中央经线跟着世界存:换成存档里的(旧存档没有 = 等距圆柱、0°)
    if (t.view !== undefined) applyView(t.view ?? undefined);
    // 旧格式的键(r + 州号:GENERATOR_VERSION 2 以前的存档、链接)就地换成按地块的 c 格式,按这一刻的世界解析;
    // 换过的话自动存会写回去(套上的修改和存下的不是同一个对象就会重写)
    const sameT = sameTerrain(t.edits.terrain, genTerrain.current) && sameSketch(t.edits.sketch, genSketch.current);
    const edits = sameT ? upgradeLegacyKeys(t.edits, keySeats(rc.regions)) : t.edits;
    restoredIv.current = edits.interventions;
    restoredUps.current = edits.upheavals;
    // 同一张图换一份修改(打开同种子的另一份存档、分享链接)也算换了世界:正在填的标记、选中的标记作废
    resetMarkUi();
    resetCharacterUi();
    setEdits(edits);
    attachWorld({ id: t.id, params: world.params, check, kind: t.kind, title: t.title, saved: t.saved ?? edits, view: t.view ?? undefined, pristine: t.pristine, base: t.base, origin: t.origin });
    if (t.kind !== 'draft') setWorldStats(aliveAtEnd(rc));
    const save = t.save;
    // 带种子的网址(别人发的普通链接):是旧版本画的就说清现在变了什么
    if (t.from === 'url') {
      const note = t.gen !== undefined ? versionNote(t.gen, false) : null;
      if (note) say({ kind: 'warn', text: `已打开「种子 ${world.params.seed}」`, more: [note] });
      return;
    }
    if (!save || !t.from) return;
    const more: string[] = [...(t.warnings ?? [])];
    if (t.from === 'stored' || t.from === 'restore') {
      const note = versionNote(save.generator, (save.edits.terrain?.length ?? 0) > 0 || !!save.edits.sketch);
      if (note) more.push(note);
    }
    // 地形校验只在"生成时带的地形修改就是存档里的"时才核对
    const cw = sameT ? checkWarning(save, check) : null;
    if (cw) more.push(cw);
    const lost = Object.keys(edits.names).filter((k) => !resolveKey(rc, k)).length;
    if (lost) more.push(`${lost} 处改名没对上,先保留`);
    const n = editCount(save.edits);
    const name = save.title || `种子 ${world.params.seed}`;
    // 没建完的世界接着建:不用提示
    if (t.kind === 'draft') return more.length ? say({ kind: 'warn', text: `已打开「${name}」`, more }) : undefined;
    let text: string;
    if (t.from === 'file') text = `已打开存档「${name}」${n ? `(改了 ${n} 处)` : ''}`;
    // 分享的世界:地图下面那条说明已经讲了,没有要说的就不提示
    else if (t.from === 'link') {
      if (!more.length) return;
      text = `已打开分享的世界「${name}」`;
    }
    // 从我的世界点开的:看到的就是它,没有要说的就不提示
    else if (t.from === 'stored') return more.length ? say({ kind: 'warn', text: `已打开「${name}」`, more }) : undefined;
    else if (n) text = `已恢复上次的修改(${n} 处)`;
    else return more.length ? say({ kind: 'warn', text: `已打开「${name}」`, more }) : undefined;
    say({ kind: more.length ? 'warn' : 'ok', text, more });
  };
  /** 换成存档里的投影和中央经线(没有 = 等距圆柱、0°;认不出的投影、还没做好的地球仪 = 等距圆柱) */
  const applyView = (v: SaveView | undefined) => {
    const want = v?.projection;
    const p: MapProjection = isMapProjection(want) && (want !== 'globe' || GLOBE_READY) ? want : 'equirect';
    const lon = v && Number.isFinite(v.center) ? wrapLon(v.center) : 0;
    // 先放中心(换投影时按它摆视图),再换投影;等距圆柱再把视图转过去
    publishMapCenter(lon);
    setProjection(p);
    if (!isCurved(p)) requestMapCenter(lon);
  };
  // 投影 / 中心 / 经纬网停下来约半秒:写进网址(刷新、复制网址都还在),已经存着的世界跟着重存一次
  useEffect(() => {
    const t = setTimeout(() => {
      const q = new URLSearchParams(location.search);
      if (projection !== 'equirect') q.set('proj', projection);
      else q.delete('proj');
      q.delete('view'); // 旧的地球仪开关,换成 proj=globe
      if (graticule) q.set('grat', '1');
      else q.delete('grat');
      const lon = Math.round(mapCenter * 100) / 100;
      if (Math.abs(lon) >= 0.005) q.set('lon', String(lon));
      else q.delete('lon');
      const next = `?${q}`;
      if (next !== location.search) history.replaceState(null, '', next);
      viewChanged();
    }, 450);
    return () => clearTimeout(t);
  }, [projection, mapCenter, graticule]);
  /** 现在这张图(或正在生成的)就是这组参数 + 草图 + 地形修改 */
  const sameGen = (p: WorldParams, terrain: readonly TerrainOp[], sketch: SketchEdit | undefined) =>
    !!genParams.current && worldKey(genParams.current) === worldKey(p) && sameTerrain(terrain, genTerrain.current) && sameSketch(sketch, genSketch.current);
  /**
   * 换到哪一步:新建 / 世界 / 我的世界。进新建时政区、民族换成地形(还没有历史),
   * 离开新建时换回来;选中、概览、改地形属于上一步的,一起收起
   */
  const enterStage = (next: Stage, base: DraftBase | null = null) => {
    const was = getStage().stage;
    if (next !== 'home') closeTrash();
    if (next !== was) {
      clearSelection();
      setPolityPick(null);
      closeOverview();
      setTerrainTool({ on: false });
      closeUpheaval();
      setHover(null);
      clearToast('created');
    }
    // 进新建:默认实景(新建界面的开场就是实景);原来的图层记下,不建就离开时换回来
    if (next === 'draft' && was !== 'draft') {
      pausePlayback();
      const now = mapLayerRef.current;
      // 原来就是实景也记下:新建里换了别的样式、没建就离开,也换回实景
      draftLayerRef.current ??= now;
      if (now !== 'realistic') applyLayer('realistic');
    }
    if (next !== 'draft' && draftLayerRef.current) {
      applyLayer(draftLayerRef.current);
      draftLayerRef.current = null;
    }
    setStage(next, base);
  };
  /**
   * 打开一个世界:要的就是正在看的这一张图(参数、地形都一样,比如从我的世界打开同一个种子的另一份、以它为底稿新建)就不重新生成,
   * 直接换上它的修改;正在生成的就是它:等生成完;否则按它的参数生成
   */
  const openTarget = (t: Target) => {
    setWorldSheet('peek');
    enterStage(t.kind === 'draft' ? 'draft' : 'world', t.kind === 'draft' ? (t.base ?? null) : null);
    if (t.kind === 'draft') setDraftTitle(t.title ?? '');
    setParams(t.params);
    if (sameGen(t.params, t.edits.terrain, t.edits.sketch)) {
      if (fresh.current) {
        targetRef.current = t;
        writeWorldUrl(t);
        return;
      }
      const last = lastReady.current;
      if (!regenRef.current && last && rawRef.current) {
        detachWorld();
        targetRef.current = t;
        readyRef.current(last.world, rawRef.current);
        writeWorldUrl(t);
        return;
      }
    }
    generate(t);
  };
  /** 打开"我的世界"里的一个(没建完的回到新建) */
  const openStored = (id: string) => {
    const w = loadWorld(id);
    if (!w) return notify({ kind: 'error', text: '打不开这个存档', more: ['可能已在别的页面里删掉了'] });
    // 下面一直开着的就是它、存的和开着的一样(没在别的页面里改过):不用重新打开
    const cur = currentWorld();
    const same =
      !!cur &&
      (cur.kind === 'draft') === w.draft &&
      worldKey(cur.params) === worldKey(w.save.params) &&
      (cur.title ?? '') === (w.save.title ?? '') &&
      sameOrigin(cur.origin, w.save.origin) &&
      JSON.stringify(getEdits()) === JSON.stringify(w.save.edits);
    if (cur?.id === id && targetRef.current?.id === id && same) {
      markOpened(id);
      enterStage(w.draft ? 'draft' : 'world', w.draft ? (w.base ?? null) : null);
      if (w.draft) setDraftTitle(w.save.title ?? '');
      writeWorldUrl(targetRef.current);
      return;
    }
    openTarget(storedTarget(w, 'stored'));
  };
  /** 从文件打开:存进"我的世界"(算建好的),再打开它;存不下就只打开、不存。「全部存成文件」存的:全部放回我的世界,不打开 */
  const openText = (text: string, fileName?: string) => {
    if (openBundleText(text, fileName)) return;
    const r = parseSave(text);
    if (!r.ok) {
      notify({ kind: 'error', text: fileName ? `打不开 ${fileName}` : '打不开这个存档', more: [briefError(r.error)] });
      return;
    }
    const id = importSave(r.save);
    const w = id ? loadWorld(id) : null;
    const t: Target = w
      ? { ...storedTarget(w, 'stored'), view: r.save.view ?? null }
      : { id: newWorldId(), kind: 'visit', params: r.save.params, edits: r.save.edits, title: r.save.title, view: r.save.view ?? null, save: r.save, origin: r.save.origin ?? null };
    openTarget({ ...t, from: 'file', save: r.save, warnings: r.warnings });
  };
  /**
   * 打开分享链接(解开以后):别人的世界,先不存;改了(或起了名)才存进"我的世界"。
   * 短链接(short):改了另存时写明底稿出处(署名、这时的世界名、这个链接);长链接里没有分享人,不写
   */
  const openShare = (r: ParseResult, short?: { code: string; by?: string }) => {
    if (!r.ok) {
      const msg = briefError(r.error);
      // 世界还在生成:等生成完再说(生成时提示条上是进度)
      if (currentWorld()) showToast({ id: 'share', kind: 'error', text: '打不开这个分享链接', more: [msg] });
      else shareErr.current = msg;
      return;
    }
    const sv = r.save;
    const id = newWorldId();
    const by = short ? cleanSignature(short.by) : '';
    setSharedFor({ id, short: !!short, by });
    const origin: SaveOrigin | null = short ? { ...(by ? { by } : {}), title: sv.title ?? '', url: shortLink(short.code) } : null;
    openTarget({ id, kind: 'visit', params: sv.params, edits: sv.edits, saved: sv.edits, title: sv.title, view: sv.view ?? null, from: 'link', save: sv, warnings: r.warnings, shareCode: short?.code, origin });
  };
  /** 分享短链接:去服务器取存档(不用登录);停了、打不开就显示那一页 */
  const openShortShare = (code: string) => {
    if (!serverBase() || !SHARE_CODE_RE.test(code)) return setLanding('gone');
    showToast({ id: 'share', kind: 'progress', text: '正在打开分享的世界' });
    openShareCode(code)
      .then((r) => {
        clearToast('share');
        const p = parseSave(JSON.stringify(r.save));
        if (!p.ok) return setLanding({ error: briefError(p.error) });
        setLanding(null);
        openShareRef.current(p, { code, by: r.by });
      })
      .catch((e) => {
        clearToast('share');
        if (e instanceof ServerError && (e.code === 'share-gone' || e.code === 'not-found')) setLanding('gone');
        else setLanding({ error: e instanceof ServerError && e.code === 'network' ? '连不上服务器，请检查网络后刷新再试。' : e instanceof Error ? e.message : String(e) });
      });
  };
  const openShareRef = useRef(openShare);
  openShareRef.current = openShare;
  /** 新建世界(我的世界右上、第一次来):随机一颗星球 */
  const startDraft = () => openTarget(draftTarget({ ...DEFAULT_PARAMS, seed: randomSeedValue() }));
  /** 新建中的世界(在看的就是它)*/
  const draftNow = (): Target | null => {
    const t = targetRef.current;
    return t && t.kind === 'draft' && getStage().stage === 'draft' ? t : null;
  };
  /** 新建中:最新的名字、动没动过(存在 saveStore 里;还在生成时看 targetRef) */
  const draftState = (t: Target) => {
    const cur = currentWorld();
    const attached = cur?.id === t.id;
    return { title: attached ? cur.title : t.title, pristine: attached ? cur.pristine : t.pristine, edits: attached ? getEdits() : t.edits };
  };
  /** 新建中换种子:另一颗星球,草图留着(连同放的火山湖河);没画草图时放的那几处作废;没起名、参数也是默认的、没画草图 = 又算没动过(不存) */
  const draftSeed = (seed: number) => {
    const t = draftNow();
    if (!t || t.base) return;
    const st = draftState(t);
    // 换一颗:草图带过去,照它长出新的山河;陆地海洋是照草图长的,放的火山湖河也还对得上,一起带过去。
    // 没画草图 = 整颗星球都换了,放的那几处是照原来的地形放的,不带过去。助手的对话(说的是原来那颗)也清掉
    newConversation();
    const sketch = st.edits.sketch;
    const plain = !st.title && !sketch && worldKey({ ...t.params, seed: 0 }) === worldKey({ ...DEFAULT_PARAMS, seed: 0 });
    const edits = sketch ? { ...EMPTY_EDITS, sketch, terrain: st.edits.terrain } : EMPTY_EDITS;
    generate({ ...t, params: { ...t.params, seed }, edits, saved: undefined, title: st.title, pristine: st.pristine || plain, view: undefined, from: undefined, save: undefined });
  };
  /** 新建中调参数:改过的地形留着(按新参数重新生成) */
  const draftParams = (p: WorldParams) => {
    const t = draftNow();
    if (!t) return;
    const st = draftState(t);
    generate({ ...t, params: { ...p, seed: t.base ? t.params.seed : p.seed }, edits: st.edits, saved: undefined, title: st.title, pristine: false, view: undefined, from: undefined, save: undefined });
  };
  /** 新建中起名(点别处 / 回车):起了名就算动过,存进我的世界("没建完") */
  const draftRename = (title: string) => {
    const t = draftNow();
    if (!t) return;
    const clean = cleanTitle(title) || undefined;
    t.title = clean;
    setDraftTitle(clean ?? '');
    if (currentWorld()?.id === t.id) renameWorld(t.id, clean ?? '');
  };
  /** 创建世界:从此种子、参数、地形锁住;一直存着。从第 0 年起放一遍历史。建成了 = true */
  const createWorld = (title: string): boolean => {
    const t = draftNow();
    const cur = currentWorld();
    // 还在生成、在重推带过来的干预、在放这颗星球的形成:等它完
    if (!t || !cur || cur.id !== t.id || fresh.current || regenRef.current || resim || replayOn) return false;
    const clean = cleanTitle(title) || undefined;
    if ((clean ?? '') !== (cur.title ?? '')) renameWorld(t.id, clean ?? '');
    // 说存住了,要真的写进了浏览器(存储满了、删了旧的也写不下,或者浏览器不让存 = 只在这一页里)
    const stored = markCreated() && persistent();
    // 新建时执行过的改地形从此不能再撤销:⌘Z 也不再往回退(助手那边按锁换了,旧的确认单不能执行)
    clearEditHistory();
    targetRef.current = { ...t, kind: 'created', base: null, pristine: false, title: clean, from: undefined, save: undefined };
    enterStage('world');
    // 建好的世界看政区
    draftLayerRef.current = null;
    applyLayer('political');
    writeWorldUrl(targetRef.current);
    if (rawRef.current) setWorldStats(aliveAtEnd(rawRef.current));
    refreshThumb();
    const keep = persistent();
    showToast({
      id: 'created',
      kind: stored ? 'ok' : 'warn',
      dot: stored,
      text: `${clean ?? '新世界'}已创建`,
      more: [stored ? '自动存在这个浏览器里，在「我的世界」里随时能找到' : keep ? '浏览器存储已满，没能存下；关掉页面前请存成文件' : '浏览器不让网页存数据，关掉页面前请存成文件'],
      ttl: 7000,
    });
    // 历史从第 0 年起放一遍(这次打开网页不再另外自动播放);不放(play=0、无头浏览器)时,
    // 新建时放过"这颗星球的形成"、时间停在第 0 年的,回到结束那一年
    takeAutoplay();
    if (storyOk()) startCivReplay();
    else if (getCivTime().year === 0) resetCivTime();
    return true;
  };
  /**
   * 以正在看的世界为底稿新建:设定、改名、干预都带过去(还是这张图,不用重新生成);存成另一个世界。
   * 带着东西、起好了名,一开始就存(作为没建完的,刷新不丢);什么都没动就点返回,这一份删掉
   */
  const draftFromCurrent = () => {
    const t = targetRef.current;
    const cur = currentWorld();
    if (!t || !cur || cur.id !== t.id || fresh.current) return;
    const e = getEdits();
    const base: DraftBase = { id: cur.id, title: cur.title || '未命名世界', names: Object.keys(e.names).length, interventions: e.interventions.length };
    backRef.current = { ...t, kind: cur.kind, edits: e, saved: undefined, title: cur.title, from: undefined, save: undefined, view: undefined };
    const d = draftTarget(t.params, base, e, nextTitle(base.title));
    derivedRef.current = { id: d.id, sig: draftSig(d.params, d.edits, d.title) };
    openTarget({ ...d, pristine: false, view: undefined });
  };
  /** 以别的世界为底稿新建时,那个世界(没存过的也回得去) */
  const backRef = useRef<Target | null>(null);
  /** 以别的世界为底稿新建的那一份:编号和一开始的样子(返回时没动过就删掉) */
  const derivedRef = useRef<{ id: string; sig: string } | null>(null);
  /** 以底稿新建的那一份还是一开始的样子(参数、修改、名字都没动) */
  const derivedUntouched = (): string | null => {
    const d = derivedRef.current;
    const t = targetRef.current;
    const cur = currentWorld();
    if (!d || !t || !cur || t.id !== d.id || cur.id !== d.id) return null;
    return draftSig(t.params, getEdits(), cur.title) === d.sig ? d.id : null;
  };
  /** 回到"我的世界"(一个都没有时是空的那一页) */
  const showHome = () => {
    pausePlayback();
    setReplayOn(false);
    enterStage('home');
    writeHomeUrl();
  };
  const goHome = showHome;
  const showHomeRef = useRef(showHome);
  showHomeRef.current = showHome;
  const openStoredRef = useRef(openStored);
  openStoredRef.current = openStored;
  // 云同步:登录了就开始(account/sync.ts);正在看的世界在别的设备上、别的页面里改过,点"载入"重新打开它;账号窗里点"最近删除"回到我的世界
  useEffect(() => {
    const stop = startSync();
    setReloadHandler((id) => openStoredRef.current(id));
    setReopenHandler((id) => openStoredRef.current(id));
    setGoHome(() => {
      if (getStage().stage !== 'home') showHomeRef.current();
    });
    return () => {
      stop();
      setReloadHandler(null);
      setReopenHandler(null);
      setGoHome(null);
    };
  }, []);
  /** 新建卡片左上的返回:底稿那个世界 / 我的世界;第一次来(没有别的世界)不显示 */
  const v = useSavesVersion();
  const draftBack = useMemo(() => {
    if (!draft) return null;
    if (stageBase) {
      return {
        label: stageBase.title,
        onClick: () => {
          const b = backRef.current;
          const left = derivedUntouched();
          if (left) deleteWorld(left);
          if (isStored(stageBase.id)) openStored(stageBase.id);
          else if (b && b.id === stageBase.id) openTarget(b);
          else goHome();
        },
      };
    }
    return { label: '我的世界', onClick: goHome };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, stageBase, v]);
  // 只是看看的世界改了第一笔、新建中的动了第一下,就存下了:网址换成 w=编号,刷新还回到它
  useEffect(() => {
    const t = targetRef.current;
    const cur = currentWorld();
    if (home || !t || !cur || cur.id !== t.id) return;
    if (isStored(t.id) && new URLSearchParams(location.search).get('w') !== t.id) writeWorldUrl(t);
  }, [v, home]);
  // 把 .json 拖进页面 = 从文件打开;编辑地形时拖进来的图片 = 导入成草图
  const [dropping, setDropping] = useState<false | 'save' | 'image'>(false);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const onDragOver = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const kind = getTerrainTool().on && e.dataTransfer.items?.[0]?.type.startsWith('image/') ? 'image' : 'save';
    if (dropping !== kind) setDropping(kind);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.relatedTarget || !(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDropping(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (getTerrainTool().on && isImageFile(f)) return void startImport(f);
    f.text().then(
      (t) => openText(t, f.name),
      () => notify({ kind: 'error', text: `打不开 ${f.name}`, more: ['读不了这个文件'] }),
    );
  };

  // ---- 渲染 ----
  // 画好的整张图按「画风 / 图层」各存一份(离屏画布),同一个世界里切回去直接贴上;
  // 地形大事前后是两张图,各存一份(最近的 MAP_KEEP 张;来回拖时间轴不用重画),世界一换就清空。
  // 用画布对画布复制而不是 getImageData,不从显卡读回像素,
  // 免得浏览器把主画布降级成软件渲染(那样河流、墨线的抗锯齿会变样)。
  // 用 useLayoutEffect:地形先于文明层(CivLayer 里的 useEffect)画好 —— 手绘风的文明层要借地形的符号层给水彩"让位"。
  const cacheRef = useRef<{ data: { raster: Raster }; maps: Map<string, HTMLCanvasElement> }[]>([]);
  /** d 这一张图的缓存(用到的挪到最前);同一个世界(主图的地块索引是同一份)留最近 MAP_KEEP 张,别的释放 */
  const mapsOf = (d: { raster: Raster }): Map<string, HTMLCanvasElement> => {
    const list = cacheRef.current;
    const hit = list.find((e) => e.data === d);
    if (hit) {
      cacheRef.current = [hit, ...list.filter((e) => e !== hit)];
      return hit.maps;
    }
    const keep = list.filter((e) => e.data.raster.cell === d.raster.cell).slice(0, MAP_KEEP - 1);
    for (const e of list) if (!keep.includes(e)) for (const c of e.maps.values()) c.width = c.height = 0; // 尽快释放显存
    const maps = new Map<string, HTMLCanvasElement>();
    cacheRef.current = [{ data: d, maps }, ...keep];
    return maps;
  };
  /** 弯边投影:地形图(缓存里的等距圆柱原图)按投影铺到屏幕上 */
  const terrainProj = useRef(new ProjLayer());
  /** 上次画的是哪个世界、哪种画风 / 图层(弯边投影下只改中心时只重铺,不算"画了新的一张") */
  const drawnKey = useRef<{ data: unknown; key: string } | null>(null);
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data) return;
    const { world, raster } = data;
    const maps = mapsOf(data);
    const key = style === 'data' ? `data:${layer}` : style;
    const render = (ctx: CanvasRenderingContext2D) => {
      if (style === 'realistic') renderRealistic(ctx, world, raster);
      else if (style === 'fantasy') renderFantasy(ctx, world, raster);
      else renderLayer(ctx, world, raster, layer);
    };
    const t0 = performance.now();
    const hit = maps.get(key);
    const fresh = drawnKey.current?.data !== data || drawnKey.current.key !== key;
    drawnKey.current = { data, key };
    if (mp) {
      // 弯边投影:原图画在离屏画布上(和等距圆柱共用缓存),按投影铺到屏幕上;不接右边那一份
      let src = hit;
      if (!src) {
        src = document.createElement('canvas');
        src.width = raster.w;
        src.height = raster.h;
        render(src.getContext('2d')!);
        maps.set(key, src);
      }
      const t1 = performance.now();
      const proj = terrainProj.current;
      presentTerrain(cv, mp, { world, raster, style, src, layer: proj, moving: projMoving });
      mirrorCanvas(canvasCopyRef.current, null, false);
      const w = window as unknown as { __wf: unknown; __wfProj: unknown };
      w.__wfProj = { proj: mp.def.id, lon: mp.lon0, ms: performance.now() - t1 };
      if (fresh) w.__wf = { ready: true, renderMs: performance.now() - t0, style, layer, proj: mp.def.id };
      return;
    }
    terrainProj.current.release();
    cv.width = raster.w;
    cv.height = raster.h;
    const ctx = cv.getContext('2d')!;
    if (hit) ctx.drawImage(hit, 0, 0);
    else render(ctx);
    const renderMs = performance.now() - t0;
    if (!hit) {
      const copy = document.createElement('canvas');
      copy.width = raster.w;
      copy.height = raster.h;
      copy.getContext('2d')!.drawImage(cv, 0, 0);
      maps.set(key, copy);
    }
    // 右边再接一份(左右无限拖动)
    mirrorCanvas(canvasCopyRef.current, cv, true);
    (window as unknown as { __wf: unknown }).__wf = { ready: true, renderMs, style, layer };
  }, [data, style, layer, mp, projMoving]);

  /**
   * 某画风的整张底图(等距圆柱,和 raster 一样大):缓存里有就直接给,没有就画一张放进缓存(图层缩略图用;之后切过去也不用再画)。
   * 默认画地图上这一段的;d = 别的段的世界和主图(存档缩略图画结束那一年的)
   */
  const baseCanvas = useCallback((key: string, d0?: { world: World; raster: Raster }): HTMLCanvasElement | null => {
    const d = d0 ?? dataRef.current;
    if (!d) return null;
    const maps = mapsOf(d);
    let c = maps.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = d.raster.w;
      c.height = d.raster.h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      if (key === 'realistic') renderRealistic(ctx, d.world, d.raster);
      else if (key === 'fantasy') renderFantasy(ctx, d.world, d.raster);
      else renderLayer(ctx, d.world, d.raster, key.slice(5) as LayerId);
      maps.set(key, c);
    }
    return c;
  }, []);
  const { thumbs, request: requestThumbs } = useLayerThumbs({ data, civ: rawCiv, baseCanvas }, mapLayer);

  // ---- 回放:看世界长出来 ----
  const startReplay = () => {
    if (!data || !genParams.current) return;
    setTerrainTool({ on: false });
    closeUpheaval();
    prepareCivReplay(); // 文明层先退回第 0 年,等地质放完再接着放文明
    setReplayOn(true);
    if (replay) setReplay({ ...replay, idx: 0 });
    else compute.history({ type: 'history', id: reqId.current, params: genParams.current, terrain: [...genTerrain.current], sketch: genSketch.current });
  };
  /** 弯边投影:回放帧先放在离屏的等距圆柱原图上,再按投影铺到屏幕上 */
  const overlayProj = useRef(new ProjLayer());
  useEffect(() => {
    if (!replayOn || !replay) return;
    const cv = overlayRef.current;
    if (!cv) return;
    const frame = new ImageData(new Uint8ClampedArray(replay.frames[replay.idx]), replay.w, replay.h);
    const m = mpRef.current;
    if (m) {
      overlayProj.current.source(replay.w, replay.h).getContext('2d')!.putImageData(frame, 0, 0);
      overlayProj.current.present(cv, m, pageColor(style));
      mirrorCanvas(overlayCopyRef.current, null, false);
    } else {
      cv.width = replay.w;
      cv.height = replay.h;
      cv.getContext('2d')!.putImageData(frame, 0, 0);
      mirrorCanvas(overlayCopyRef.current, cv, !!data);
    }
    const last = replay.idx >= replay.frames.length - 1;
    const t = setTimeout(
      () => (last ? (setReplayOn(false), getStage().stage === 'world' && startCivReplay()) : setReplay((r) => (r ? { ...r, idx: r.idx + 1 } : r))),
      last ? 1400 : replay.idx === 0 ? 900 : 260,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayOn, replay]);
  // 回放时改了投影 / 中心:这一帧按新的重铺(不打断回放的节奏)
  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv || !replayOn || !replay) return;
    if (mp && overlayProj.current.has()) overlayProj.current.present(cv, mp, pageColor(style));
    else if (!mp) overlayProj.current.release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp]);

  // ---- 地图铺满全屏:2:1 的地图框按舞台"盖满"(舞台比 2:1 窄时上下正好顶到边、左右接着转;比 2:1 宽时左右顶到边) ----
  const [box, setBox] = useState({ w: 0, h: 0 });
  /** 舞台(视口)的大小:视窗、平移范围按它算 */
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const W = e.contentRect.width;
      const H = e.contentRect.height;
      const w = Math.max(100, W, H * 2);
      setBox({ w, h: w / 2 });
      setStageSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- 缩放 / 平移 ----
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  /** 按下时的位置、视图(弯边投影:还有当时的中央经线;拖动改的是它) */
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; lon: number; touch?: boolean } | null>(null);
  // 世界东西相连:左右无限拖动(见 mapWrap.ts)。wrapW = 一整圈的世界宽度,还没有世界时 0
  const wrapW = data ? wrapOf(data.world) : 0;
  setTerrainWrap(wrapW);
  /**
   * 窄屏底部被卡片和时间轴胶囊盖住的那一截:没选东西时是收起的世界卡片 + 胶囊,详情卡片开着时是半高的卡片 + 胶囊。
   * 地图可以往上推进这一截(见 mapWrap.ts 的 StageBox.padB),下半截的国家也能飞到上方看得见的地方;卡片收回去后慢慢回到原来的范围
   */
  const padB = !narrow || !stageSize.h ? 0 : Math.max(0, stageSize.h - phoneFree(stageSize.h, panelOpen)[1]);
  const geo = useRef<{ wrap: number; bw: number; bh: number; W: number; H: number; padB: number }>({ wrap: 0, bw: 0, bh: 0, W: 1, H: 1, padB: 0 });
  geo.current = { wrap: wrapW, bw: box.w, bh: box.h, W: data?.world.width ?? 1, H: data?.world.height ?? 1, padB };
  const curvedRef = useRef(curved);
  curvedRef.current = curved;
  /**
   * 平移范围:上下夹在两极以内;等距圆柱左右不限(挪整数圈),
   * 弯边投影横向正对外框(左右拖动改中央经线,见 mapWrap.ts 的 clampCurved)
   */
  const clampAny = (v: { k: number; x: number; y: number }, w: number, h: number) => {
    const g = geo.current;
    if (!g.bw) return v;
    const b = { sw: w, sh: h, bw: g.bw, bh: g.bh, padB: g.padB };
    return curvedRef.current ? clampCurved(v, b) : clampSphere(v, b);
  };
  const clampRef = useRef(clampAny);
  clampRef.current = clampAny;
  const sb: StageBox = { sw: stageSize.w, sh: stageSize.h, bw: box.w, bh: box.h, padB };
  /** 视窗中心的世界 x(舞台、地图框大小变了按它保持中心不动) */
  const centerRef = useRef<number | null>(null);
  /** 网址里带的中央经线:世界、舞台都出来以后把等距圆柱的视图转过去(只一次) */
  const pendingLon = useRef<number | null>(init.lon);
  // 换投影:缩放复位,中心不变(等距圆柱把视图转到这条经线;弯边投影横向正对外框)。
  // 在渲染时就换好视图,不会有一帧"新投影 + 旧视图"把中心记错
  const [viewProj, setViewProj] = useState<MapProjection>(projection);
  /** 从地球仪切出来时它正对着的经度:这一次提交后记进中心(渲染时只读、不改 store) */
  const handoffLon = useRef<number | null>(null);
  if (viewProj !== projection) {
    const fromGlobe = viewProj === 'globe' ? globeApi.current?.centerLon() : undefined;
    const lonNow = fromGlobe !== undefined ? wrapLon(fromGlobe) : getMapCenter();
    if (fromGlobe !== undefined) handoffLon.current = lonNow;
    setViewProj(projection);
    const base = { k: 1, x: 0, y: 0 };
    if (sb.sw && sb.bw) setView(curved || !wrapW ? clampCurved(base, sb) : viewCentredAt(base, sb, wrapW, xOfLon(lonNow, wrapW)));
    else setView(base);
  }
  useLayoutEffect(() => {
    if (handoffLon.current === null) return;
    publishMapCenter(handoffLon.current);
    handoffLon.current = null;
  });
  /** 这一次提交里视图刚被换掉(还是旧的):先不按它记中心,等下一次 */
  const settling = useRef(false);
  // 世界出来了、或者舞台大小变了,重新夹一下(保持中心经线不动)
  useEffect(() => {
    if (!sb.sw || !sb.bw || !wrapW) return;
    if (curvedRef.current) {
      pendingLon.current = null;
      setView((v) => clampCurved(v, sb));
      return;
    }
    let c = centerRef.current;
    if (pendingLon.current !== null) {
      c = xOfLon(pendingLon.current, wrapW);
      pendingLon.current = null;
      settling.current = true;
    }
    setView((v) => (c === null ? clampSphere(v, sb) : viewCentredAt(v, sb, wrapW, c)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wrapW, sb.sw, sb.sh, sb.bw, sb.bh]);
  // 窄屏详情卡片关上(地图不能再往上推进卡片那一截了):推上去的地图约 0.3 秒回到范围里
  const lastPadB = useRef(padB);
  useEffect(() => {
    const was = lastPadB.current;
    lastPadB.current = padB;
    if (padB >= was || !sb.sw || !sb.bw || flyRaf.current) return;
    const v0 = viewRef.current;
    const clamp = (v: { k: number; x: number; y: number }) => (curvedRef.current ? clampCurved(v, sb) : clampSphere(v, sb));
    const y1 = clamp(v0).y;
    if (Math.abs(y1 - v0.y) < 0.5) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = animProgress(now, t0, 300);
      // 用户按下地图 / 又飞走了:让给它们
      if (flyRaf.current || drag.current) return;
      const v = { k: v0.k, x: v0.x, y: v0.y + (y1 - v0.y) * easeOutCubic(t) };
      viewRef.current = v;
      setView(t < 1 ? v : clamp(v));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [padB]);
  // 当前中心经度:等距圆柱时视图一变就记下(之后的"中央经线"设置、导出读它);
  // 弯边投影和地球仪时中心就在 store 里,由它们自己改,不从平面视图推
  useEffect(() => {
    const ready = !!wrapW && !!sb.sw && !!sb.bw;
    if (projection !== 'equirect') {
      const lon = getMapCenter();
      centerRef.current = ready ? xOfLon(lon, wrapW) : null;
      (window as unknown as { __wfView: unknown }).__wfView = { ...view, wrap: wrapW, lon, bw: sb.bw, sw: sb.sw, proj: projection };
      return;
    }
    // 网址里带的中心还没转过去(世界还没出来),或者视图刚被换掉:先别把旧视图的中心记下
    if (pendingLon.current !== null) return;
    if (settling.current) {
      settling.current = false;
      return;
    }
    const cx = ready ? centerX(view, sb, wrapW) : null;
    centerRef.current = cx;
    const lon = cx === null ? getMapCenter() : lonOfX(cx, wrapW);
    publishMapCenter(lon);
    (window as unknown as { __wfView: unknown }).__wfView = { ...view, wrap: wrapW, lon, bw: sb.bw, sw: sb.sw, proj: projection };
  });
  useEffect(() => {
    handleMapCenterRequests((lon) => {
      stopFly(); // "设为中心"等:正在飞的停下,别再盖掉它
      if (getGlobeOn()) return globeApi.current?.flyTo(lon);
      const g = geo.current;
      const el = stageRef.current;
      // 弯边投影:中心就是中央经线,直接改(整图按它重投影)
      if (getProjection() !== 'equirect') {
        publishMapCenter(wrapLon(lon));
        return;
      }
      if (!g.wrap || !el || !g.bw) {
        publishMapCenter(wrapLon(lon));
        pendingLon.current = wrapLon(lon);
        return;
      }
      const b = { sw: el.clientWidth, sh: el.clientHeight, bw: g.bw, bh: g.bh };
      setView((v) => viewCentredAt(v, b, g.wrap, xOfLon(lon, g.wrap)));
    });
    // 截图脚本、冒烟检查用:转到某经度;世界坐标 ↔ 屏幕坐标(取视窗里的那一份;弯边投影按投影)
    const w = window as unknown as Record<string, unknown>;
    w.__wfSetCenter = (lon: number) => requestMapCenter(lon);
    // 冒烟检查用:把视图放回某个样子(点选会让地图飞走;要在同一个视图下接着点时先放回来)
    w.__wfSetView = (v: { k: number; x: number; y: number }) => {
      stopFly();
      viewRef.current = v;
      setView(v);
    };
    w.__wfSetProjection = (p: MapProjection) => setProjection(p);
    w.__wfWorldToClient = worldToClient.current = (wx: number, wy: number): [number, number] | null => {
      const el = stageRef.current;
      const g = geo.current;
      if (!el || !g.bw) return null;
      const r = el.getBoundingClientRect();
      const b = { sw: r.width, sh: r.height, bw: g.bw, bh: g.bh };
      const v = viewRef.current;
      const m = mpRef.current;
      let x = wx;
      let y = wy;
      if (m) [x, y] = projectWorld(m, wx, wy);
      else if (g.wrap) x = nearX(wx, stageToWorld(r.width / 2, 0, v, b, g.W, g.H)[0], g.wrap);
      const [X, Y] = worldToStage(x, y, v, b, g.W, g.H);
      return [r.left + X, r.top + Y];
    };
    // 某一点的完整读数(群落、海拔、国家、最近城市……;悬停卡片只露一两行,冒烟检查读这个)
    w.__wfProbe = (cx: number, cy: number): string[] | null => probeRef.current(cx, cy);
    w.__wfClientToWorld = (cx: number, cy: number): [number, number] | null => {
      const el = stageRef.current;
      const g = geo.current;
      if (!el || !g.bw) return null;
      const r = el.getBoundingClientRect();
      const b = { sw: r.width, sh: r.height, bw: g.bw, bh: g.bh };
      const [x, y] = stageToWorld(cx - r.left, cy - r.top, viewRef.current, b, g.W, g.H);
      const m = mpRef.current;
      if (m) return unprojectWorld(m, x, y);
      return [x - g.W * Math.floor(x / g.W), y];
    };
    return () => handleMapCenterRequests(null);
  }, []);
  // 弯边投影里拖动改中心:一帧最多改一次(每次改都要整图重铺)
  const centerFrame = useRef<{ raf: number; lon: number | null }>({ raf: 0, lon: null });
  const scheduleCenter = (lon: number) => {
    const c = centerFrame.current;
    c.lon = lon;
    if (c.raf) return;
    c.raf = requestAnimationFrame(() => {
      c.raf = 0;
      if (c.lon !== null) publishMapCenter(wrapLon(c.lon));
      c.lon = null;
    });
  };
  useEffect(() => () => cancelAnimationFrame(centerFrame.current.raf), []);
  /** 选中后地图正在飞过去(见下面"选中 → 暂停 + 地图飞过去");用户自己拖动、缩放就停下 */
  const flyRaf = useRef(0);
  const stopFly = () => {
    if (!flyRaf.current) return;
    cancelAnimationFrame(flyRaf.current);
    flyRaf.current = 0;
    if (curvedRef.current) setMapMoving(false);
  };
  /**
   * 以舞台上的 (mx, my) 为中心缩放 f 倍(滚轮、右下角的 + −)。
   * 弯边投影:上下照常以这一点为中心缩放;横向转中央经线,让这一点下的地方还在这一点下
   */
  const zoomAt = (mx: number, my: number, f: number) => {
    stopFly();
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const m = mpRef.current;
    const g = geo.current;
    if (m && g.bw) {
      const v = viewRef.current;
      const k = Math.min(12, Math.max(1, v.k * f));
      const b = { sw: rect.width, sh: rect.height, bw: g.bw, bh: g.bh, padB: g.padB };
      const nv = clampCurved({ k, x: v.x, y: my - (my - v.y) * (k / v.k) }, b);
      const [px, py] = stageToWorld(mx, my, v, b, g.W, g.H);
      const r = unprojectRel(m, px, py);
      if (r) {
        const kx = m.def.kx(r[1]);
        const [px2] = stageToWorld(mx, my, nv, b, g.W, g.H);
        if (kx > 1e-6) {
          const rel2 = Math.max(-Math.PI, Math.min(Math.PI, (px2 - g.W / 2) / (m.s * kx)));
          publishMapCenter(wrapLon(m.lon0 + ((r[0] - rel2) * 180) / Math.PI));
        }
      }
      viewRef.current = nv;
      setView(nv);
      return;
    }
    setView((v) => {
      const k = Math.min(12, Math.max(1, v.k * f));
      const q = k / v.k;
      const nx = mx - (mx - v.x) * q;
      const ny = my - (my - v.y) * q;
      return clampRef.current({ k, x: nx, y: ny }, rect.width, rect.height);
    });
  };
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  /**
   * 触控板两指滑动:平移(dx / dy = 滚轮的读数,地图往 −dx、−dy 挪,方向和滑动网页一样)。
   * 弯边投影:左右 = 转中央经线(和拖动一样),上下 = 平移;滑完停一小会儿算停下(国名按投影后的国土重新摆)
   */
  const panIdle = useRef(0);
  useEffect(() => () => clearTimeout(panIdle.current), []);
  const wheelPan = (dx: number, dy: number) => {
    stopFly();
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (hover) setHover(null);
    if (mp && box.w) {
      setMapMoving(true);
      clearTimeout(panIdle.current);
      panIdle.current = window.setTimeout(() => !drag.current && setMapMoving(false), 150);
      const pxPerDeg = view.k * (box.w / mp.W) * mp.s * mp.def.kx(0) * (Math.PI / 180);
      if (pxPerDeg > 0 && dx) scheduleCenter((centerFrame.current.lon ?? getMapCenter()) + dx / pxPerDeg);
      if (dy) setView((v) => clampRef.current({ k: v.k, x: v.x, y: v.y - dy }, rect.width, rect.height));
      return;
    }
    setView((v) => clampRef.current({ k: v.k, x: v.x - dx, y: v.y - dy }, rect.width, rect.height));
  };
  const panRef = useRef(wheelPan);
  panRef.current = wheelPan;
  // 滚轮:鼠标滚轮 / 捏合 = 缩放,触控板两指滑动 = 平移(怎么分见 wheel.ts)
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = createWheelReader();
    const onWheel = (e: WheelEvent) => {
      touchRef.current();
      // 详情面板里滚动 = 滚面板,不缩放地图;地球仪自己管缩放
      if ((e.target as HTMLElement | null)?.closest?.('.inspector') || getGlobeOn()) return;
      e.preventDefault();
      // Safari 的捏合已经按 gesture 事件缩放了(见下面"浏览器自己的页面缩放")
      if (e.ctrlKey && inGesturePinch()) return;
      const a = read(wheelSample(e));
      if (!a) return;
      const rect = el.getBoundingClientRect();
      if (a.kind === 'zoom') zoomRef.current(e.clientX - rect.left, e.clientY - rect.top, a.f);
      else panRef.current(a.dx, a.dy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  /** 右下角的 + −:以看得见的地图中间为中心(宽屏让出左边的侧栏卡片);地球仪里交给地球仪自己缩放 */
  const zoomButton = (f: number) => {
    touchRef.current();
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = (sideRoom(rect.width) + rect.width - astRoom(rect.width)) / 2;
    const cy = rect.height / 2;
    if (getGlobeOn()) return globeApi.current?.zoomBy(f, rect.left + cx, rect.top + cy);
    zoomAt(cx, cy, f);
  };

  // ---- 编年史点一条:事发地不在视野里,就把地图平移过去(不改缩放,约 0.4 秒滑过去) ----
  const chron = useChronicle();
  const hl = useCivHighlight();
  const picking = usePolityPick();
  const viewRef = useRef(view);
  viewRef.current = view;
  // 新建界面摊平改地形:舞台挪到中间那块(正好 2:1,地图框正好铺满),视图放回 1 倍、转到刚摊平时正中的经线
  // (等舞台换成那块的大小再转;同一次摊平只转一次)
  const flatSeq = useRef(0);
  useEffect(() => {
    const f = studioFlat;
    if (!studioOn || !f || f.lon === undefined || f.seq === flatSeq.current || !wrapW || !sb.bw) return;
    if (Math.abs(sb.sw - f.rect.w) > 1 || Math.abs(sb.sh - f.rect.h) > 1) return;
    flatSeq.current = f.seq;
    stopFly();
    // 整像素:主图和右边接的那一份正好对齐,接缝处不透出一道暗线
    const v0 = viewCentredAt({ k: 1, x: 0, y: 0 }, sb, wrapW, xOfLon(f.lon, wrapW));
    const v = { ...v0, x: Math.round(v0.x) };
    viewRef.current = v;
    setView(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioFlat, studioOn, sb.sw, sb.sh, sb.bw, wrapW]);
  // 新建界面收起平面地图时从平常的地图现在的样子变回星球:正中的经线、1 弧度多少像素、正中和赤道在视口里的位置
  useEffect(() => {
    setFlatGeomSource(() => {
      const el = stageRef.current;
      const g = geo.current;
      const v = viewRef.current;
      if (!el || !g.bw || !g.wrap || getProjection() !== 'equirect') return null;
      const r = el.getBoundingClientRect();
      return { lon: getMapCenter(), kpx: (v.k * g.bw) / (2 * Math.PI), cx: r.left + r.width / 2, cy: r.top + v.y + (v.k * r.height) / 2 };
    });
    return () => setFlatGeomSource(null);
  }, []);
  const hlStamp = hl?.stamp;
  /**
   * 编年史跳转时"看得见的地方"的上、下和目标放在哪个高度(舞台坐标):上面留出世界名、提示条,下面留出时间轴;
   * 窄屏:让出底部的卡片和时间轴胶囊(详情卡片开着时是它上方那一截)
   */
  const jumpBand = (H: number): [number, number, number] => {
    if (!narrow) return [80, H - 110, (H - 16) / 2];
    const [t, b] = phoneFree(H, panelOpen);
    return [t + 8, b - 16, (t + b) / 2];
  };
  /**
   * 弯边投影里的编年史跳转:事发地横向不在视野里就转中央经线过去(走短边),纵向不在就上下平移;约 0.4 秒转过去。
   * b = 事发地的外接框(世界坐标)
   */
  const curvedJump = (b: [number, number, number, number], m: MapProj, W: number, H: number) => {
    const g = geo.current;
    const v0 = viewRef.current;
    const sbx = { sw: W, sh: H, bw: box.w, bh: box.h };
    const bx = (b[0] + b[2]) / 2;
    const by = (b[1] + b[3]) / 2;
    const corners: [number, number][] = [
      [b[0], b[1]],
      [b[2], b[1]],
      [b[0], b[3]],
      [b[2], b[3]],
      [bx, by],
      [bx, b[1]],
      [bx, b[3]],
    ];
    const pts = corners.map(([x, y]) => {
      const [mx, my] = projectWorldNear(m, x, y, bx);
      return worldToStage(mx, my, v0, sbx, g.W, g.H);
    });
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [bandT, bandB, midY] = jumpBand(H);
    // 宽屏左边被侧栏卡片、右边被助手面板挡住的那一截不算看得见;转过去以后事发地落在两边中间那一块的正中(按赤道上每度多少像素估)
    const L = sideRoom(W);
    const R = astRoom(W);
    const inX = Math.min(...xs) >= L + 30 && Math.max(...xs) <= W - R - 30;
    const inY = Math.min(...ys) >= bandT && Math.max(...ys) <= bandB;
    if (inX && inY) return;
    const pxPerDeg = v0.k * (box.w / m.W) * m.s * m.def.kx(0) * (Math.PI / 180);
    const dLon = inX ? 0 : wrapLon(lonOfX(bx, g.W) - m.lon0 - (pxPerDeg > 0 ? (L - R) / 2 / pxPerDeg : 0));
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const toY = inY ? v0.y : Math.min(0, Math.max(H - H * v0.k, v0.y + midY - cy));
    if (Math.abs(dLon) < 0.5 && Math.abs(toY - v0.y) < 1) return;
    (window as unknown as { __wfPan: unknown }).__wfPan = { dLon, dy: toY - v0.y, stamp: hlStamp };
    const lon0 = m.lon0;
    const t0 = performance.now();
    let raf = 0;
    setMapMoving(true);
    const step = (now: number) => {
      const t = animProgress(now, t0, 400);
      const e = 1 - (1 - t) ** 3;
      if (dLon) publishMapCenter(wrapLon(lon0 + dLon * e));
      setView(clampRef.current({ k: v0.k, x: v0.x, y: v0.y + (toY - v0.y) * e }, W, H));
      if (t < 1) raf = requestAnimationFrame(step);
      else setMapMoving(false);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      setMapMoving(false);
    };
  };
  useEffect(() => {
    const el = stageRef.current;
    if (!hl || !data || !civ || !el || civ.regions.of.length !== data.world.mesh.n || getGlobeOn()) return;
    let b = highlightBox(data.world, civ, highlightMarks(civ, hl));
    if (!b) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    const v0 = viewRef.current;
    const ww = wrapOf(data.world);
    const m = mpRef.current;
    if (m && box.w) return curvedJump(b, m, W, H);
    if (box.w) {
      // 事发地取离视窗中心最近的那一份 —— 平移走短边(不会绕地球大半圈)
      // 视窗中心(展开的世界坐标,和 sx 同一套:主图那一份左边起算)
      const c = stageToWorld(W / 2, 0, v0, { sw: W, sh: H, bw: box.w, bh: box.h }, ww, 1)[0];
      const bc = (b[0] + b[2]) / 2;
      const sh = nearX(bc, c, ww) - bc;
      b = [b[0] + sh, b[1], b[2] + sh, b[3]];
    }
    // 世界坐标 → 舞台上的屏幕坐标(地图框在舞台里居中,再整体平移 x/y、放大 k)
    const sx = (wx: number) => v0.x + ((W - box.w) / 2 + (wx / data.world.width) * box.w) * v0.k;
    const sy = (wy: number) => v0.y + ((H - box.h) / 2 + (wy / data.world.height) * box.h) * v0.k;
    const x0 = sx(b[0]);
    const x1 = sx(b[2]);
    const y0 = sy(b[1]);
    const y1 = sy(b[3]);
    // 上面留出提示条,下面留出时间轴(窄屏:底部卡片和时间轴胶囊上方)
    const [bandT, bandB, midY] = jumpBand(H);
    // 宽屏左边被侧栏卡片、右边被助手面板挡住的那一截不算看得见,平移到两边中间那一块的正中
    const L = sideRoom(W);
    const R = astRoom(W);
    if (x0 >= L + 30 && x1 <= W - R - 30 && y0 >= bandT && y1 <= bandB) return;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // 左右不夹(每一帧再挪整数圈,画面是连着的);上下夹在两极以内
    const to = { k: v0.k, x: v0.x + (L + W - R) / 2 - cx, y: Math.min(0, Math.max(H - H * v0.k, v0.y + midY - cy)) };
    if (Math.abs(to.x - v0.x) < 1 && Math.abs(to.y - v0.y) < 1) return;
    (window as unknown as { __wfPan: unknown }).__wfPan = { dx: to.x - v0.x, dy: to.y - v0.y, stamp: hlStamp };
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = animProgress(now, t0, 400);
      const e = 1 - (1 - t) ** 3;
      const v = { k: v0.k, x: v0.x + (to.x - v0.x) * e, y: v0.y + (to.y - v0.y) * e };
      setView(clampRef.current(v, W, H));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // 只在点了新的一条时平移
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hlStamp]);

  // ---- 选中 → 暂停 + 地图飞过去(国家面板):不管选中来自点地图、面板里的链接、概览还是搜索 ----
  // 国家:平移缩放到能看全当年的疆域,右边让出面板;城 / 州 / 地理实体:平移过去,缩放不变或适度放大;0.6 秒,ease-out 三次方。
  // 地球仪用它自己的 flyTo。选目标时 / 下了令之后缩回整张图('home')
  const flyNow = (to: 'sel' | 'home') => {
    stopFly();
    const el = stageRef.current;
    if (!data || !el || !box.w || replayOn || getTerrainTool().on) return;
    const sel = getSelection().sel;
    const year = civ ? Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear)) : 0;
    const focus =
      to === 'sel' && sel && civ
        ? sel.kind === 'mark'
          ? selectedMarkFocus(civ, sel.id)
          : sel.kind === 'character'
            ? selectedCharacterFocus(civ, sel.id)
            : selectionFocus(data.world, civ, sel, year)
        : null;
    if (to === 'sel' && (!focus || !sel)) return;
    // 人物按他的国家飞(看全疆域)
    const goal: FlyGoal = { focus, kind: to === 'sel' && sel ? (sel.kind === 'person' ? 'polity' : sel.kind) : 'home' };
    if (getGlobeOn()) {
      // 作者标记:已经在球的正面、看得见的地方就不转
      if (focus && sel?.kind === 'mark') {
        const p = globeApi.current?.worldToClient(focus.x, focus.y);
        const r = el.getBoundingClientRect();
        if (p && p[0] > r.left + sideRoom(r.width) + 60 && p[0] < r.right - 60 && p[1] > r.top + 80 && p[1] < r.bottom - 110) return;
      }
      if (focus) globeApi.current?.flyTo(focus.lon, focus.lat);
      return;
    }
    const b: StageBox = { sw: el.clientWidth, sh: el.clientHeight, bw: box.w, bh: box.h, padB: geo.current.padB };
    const W = data.world.width;
    const H = data.world.height;
    const m = mpRef.current;
    const flat = m ? null : flatFly(viewRef.current, b, W, H, goal);
    const step = m ? curvedFly(viewRef.current, b, m, (lon) => curvedProj(getProjection(), lon, W, H) ?? m, goal) : flat && ((e: number) => ({ v: flat(e), lon: null }));
    if (!step) return;
    const t0 = performance.now();
    if (m) setMapMoving(true);
    // 用户自己拖动 / 缩放时 stopFly 让给用户(按下地图、滚轮、右下的 + −)
    const frame = (now: number) => {
      const t = animProgress(now, t0, FLY_MS);
      const r = step(easeOutCubic(t));
      if (r.lon !== null) publishMapCenter(wrapLon(r.lon));
      viewRef.current = r.v;
      setView(r.v);
      if (t < 1) flyRaf.current = requestAnimationFrame(frame);
      else stopFly();
    };
    flyRaf.current = requestAnimationFrame(frame);
  };
  /** 选中的作者标记(正在填的那一份优先:新建的还没存)在地图上的位置 */
  const selectedMarkFocus = (civ: Civ, id: number) => {
    if (!data) return null;
    const d = getMarkUi().draft;
    if (d && d.id === id) return markFocus(data.world, civ, d.scope === 'point' ? { at: d.at ?? undefined } : { regions: d.regions });
    const m = getEdits().marks?.find((x) => x.id === id);
    return m ? markFocus(data.world, civ, m) : null;
  };
  /** 选中的作者人物(正在填的那一份优先)一生去过的地方的范围 */
  const selectedCharacterFocus = (civ: Civ, id: number) => {
    if (!data) return null;
    const d = getCharUi().draft;
    const year = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    const c = d && d.id === id ? draftAsCharacter(d, year) : getEdits().characters?.find((x) => x.id === id);
    if (!c) return null;
    const pts = lifeStops(c)
      .map((s) => placeOf(civ, data.world, data.raster, s.where, s.year).at)
      .filter((p): p is [number, number] => !!p);
    return pointsFocus(data.world, pts);
  };
  const flyRef = useRef(flyNow);
  flyRef.current = flyNow;
  useEffect(() => () => stopFly(), []);
  // 按稳定键认"选中的是不是换了":重推历史后编号变了、还是同一个东西,不再飞
  const selStable = shownRaw && selState.sel ? selectionKey(shownRaw, selState.sel) : '';
  useEffect(() => {
    if (!selStable) return;
    pausePlayback();
    flyRef.current('sel');
  }, [selStable]);
  const flyReq = panelUi.fly;
  useEffect(() => {
    if (flyReq) flyRef.current(flyReq.to);
  }, [flyReq]);

  /** 这次按下以后拖动过(拖过就不算单击,不选中) */
  const moved = useRef(false);
  // ---- 手指(触屏):单指拖动平移、双指捏合缩放(以两指中点为中心)、点一下 = 单击、点两下 = 回正 ----
  /** 按在地图上的手指(id → 屏幕坐标;地球仪上的也记,双击回正用) */
  const touches = useRef(new Map<number, Pt>());
  /** 双指捏合:上一次用到的两指位置;手指移动先记下,下一帧一起缩放 / 平移(一帧最多一次) */
  const pinch = useRef<{ a: Pt; b: Pt; raf: number } | null>(null);
  /** 改地形正用手指画线(这时第二根手指不捏合) */
  const terrainStroke = useRef(false);
  /** 正在画的那一笔是哪根手指 / 哪个指针按下的:别的手指的移动、松开不算进这一笔 */
  const terrainPointer = useRef<number | null>(null);
  /** 这一下手指按下的位置、时刻(松手时判断是不是"点一下");中途多了一根手指就不算 */
  const tapStart = useRef<(Tap & { id: number; multi: boolean }) | null>(null);
  /** 上一下"点一下"(和这一下够近就是双击) */
  const lastTap = useRef<Tap | null>(null);
  /** 刚被手指双击过(时刻):紧跟着的 click 按双击的第二下处理(恢复原来的选中) */
  const dblTapAt = useRef(-1e9);
  /** 平移(屏幕像素);弯边投影左右 = 转中央经线 */
  const panBy = (dx: number, dy: number) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const m = mpRef.current;
    const g = geo.current;
    if (m && g.bw) {
      const v = viewRef.current;
      const pxPerDeg = v.k * (g.bw / m.W) * m.s * m.def.kx(0) * (Math.PI / 180);
      if (pxPerDeg > 0 && dx) publishMapCenter(wrapLon(getMapCenter() - dx / pxPerDeg));
      const nv = clampRef.current({ k: v.k, x: v.x, y: v.y + dy }, rect.width, rect.height);
      viewRef.current = nv;
      setView(nv);
      return;
    }
    setView((v) => clampRef.current({ k: v.k, x: v.x + dx, y: v.y + dy }, rect.width, rect.height));
  };
  const startPinch = () => {
    const [a, b] = [...touches.current.values()];
    if (!a || !b) return;
    drag.current = null;
    moved.current = true;
    setHover(null);
    // 单指拖动时排着的"转中央经线"作废(不然下一帧把捏合的结果盖掉)
    const c = centerFrame.current;
    cancelAnimationFrame(c.raf);
    c.raf = 0;
    c.lon = null;
    if (pinch.current) cancelAnimationFrame(pinch.current.raf);
    pinch.current = { a: { ...a }, b: { ...b }, raf: 0 };
    if (curvedRef.current) setMapMoving(true);
  };
  const schedulePinch = () => {
    const p = pinch.current;
    if (!p || p.raf) return;
    p.raf = requestAnimationFrame(() => {
      p.raf = 0;
      if (pinch.current !== p) return;
      const [a, b] = [...touches.current.values()];
      const el = stageRef.current;
      if (!a || !b || !el) return;
      const st = pinchStep(p.a, p.b, a, b);
      p.a = { ...a };
      p.b = { ...b };
      const r = el.getBoundingClientRect();
      // 先以上一帧的中点为中心缩放,再跟着中点平移:两指下面的地方一直在两指下面
      if (Math.abs(st.f - 1) > 1e-4) zoomRef.current(st.mx - st.dx - r.left, st.my - st.dy - r.top, st.f);
      if (st.dx || st.dy) panBy(st.dx, st.dy);
    });
  };
  /** 捏合结束:还剩一根手指就接着单指拖动 */
  const endPinch = () => {
    const p = pinch.current;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    pinch.current = null;
    const [rest] = [...touches.current.values()];
    if (rest) {
      const v = viewRef.current;
      drag.current = { x: rest.x, y: rest.y, vx: v.x, vy: v.y, lon: getMapCenter(), touch: true };
      return;
    }
    drag.current = null;
    setMapMoving(false);
  };
  // 手指的登记放在捕获阶段(地球仪自己的处理会拦住冒泡):哪几根手指按着、是不是"点一下"、双击回正
  const onTouchDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 1) tapStart.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false };
    else if (tapStart.current) tapStart.current.multi = true;
  };
  const onTouchMoveCapture = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onTouchUpCapture = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    touches.current.delete(e.pointerId);
    const ts = tapStart.current;
    if (!ts || ts.id !== e.pointerId) return;
    tapStart.current = null;
    const now = performance.now();
    const onMap = !!(e.target as HTMLElement | null)?.closest?.('.canvas-wrap, .globe');
    if (e.type !== 'pointerup' || ts.multi || !onMap || now - ts.t > 500 || Math.hypot(e.clientX - ts.x, e.clientY - ts.y) > TOUCH_SLOP) {
      lastTap.current = null;
      return;
    }
    const tap: Tap = { x: e.clientX, y: e.clientY, t: now };
    if (!isDoubleTap(lastTap.current, tap)) {
      lastTap.current = tap;
      return;
    }
    // 点两下:回正(和鼠标双击一样;浏览器自己也发了 dblclick 的话再回正一次也不要紧)
    lastTap.current = null;
    dblTapAt.current = now;
    if (getGlobeOn()) globeApi.current?.reset();
    else resetView();
  };
  const onPointerDown = (e: React.PointerEvent) => {
    touchRef.current();
    stopFly();
    if (getGlobeOn()) return; // 地球仪自己管拖动
    const touch = e.pointerType === 'touch';
    // 第二根手指:开始捏合(编辑地形刚按下第一根手指就跟上第二根 = 想捏合,那一笔不算;已经画了一阵的不管)
    if (touch && touches.current.size >= 2) {
      if (terrainStroke.current) {
        if (!(getUpUi().on ? upCancel() : terrainCancel())) return;
        terrainStroke.current = false;
        terrainPointer.current = null;
      }
      if (touches.current.size === 2) startPinch();
      return;
    }
    // 改地形:画线的工具按下就开始画(不平移);点地图收菜单的那一下不画
    if (!dismissing(e.nativeEvent) && (terrainDown(worldAt(e.clientX, e.clientY), e.button) || upDown(worldAt(e.clientX, e.clientY), e.button))) {
      moved.current = true;
      terrainStroke.current = touch;
      terrainPointer.current = e.pointerId;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return; // 只用左键
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, lon: getMapCenter(), touch };
    moved.current = false;
    if (stageRef.current) stageRef.current.style.cursor = '';
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  /**
   * 屏幕坐标 → 主图上的像素(不在地图上 = null)。
   * 视窗外面(宽屏两边的空白)不算;主图右边接的那一份、跨过 180° 经线的地方按列取模 —— 接缝两边点到的是同一块地
   */
  const pixelAt = (cx: number, cy: number): [number, number] | null => {
    if (getGlobeOn()) return data ? (globeApi.current?.pixelAt(cx, cy) ?? null) : null;
    if (!data || !canvasRef.current) return null;
    if (mp) {
      // 弯边投影:屏幕 → 地图平面 → 反投影回世界坐标(外轮廓外面 = 不在地图上)
      const w = worldAt(cx, cy);
      if (!w) return null;
      const s = data.raster.scale;
      return [Math.min(data.raster.w - 1, Math.floor(w[0] * s)), Math.min(data.raster.h - 1, Math.floor(w[1] * s))];
    }
    const cr = canvasRef.current.getBoundingClientRect();
    let px = Math.floor(((cx - cr.left) / cr.width) * data.raster.w);
    const py = Math.floor(((cy - cr.top) / cr.height) * data.raster.h);
    if (!inWindow(cx)) return null;
    px = ((px % data.raster.w) + data.raster.w) % data.raster.w;
    if (px < 0 || py < 0 || px >= data.raster.w || py >= data.raster.h) return null;
    return [px, py];
  };
  /** 屏幕上这一点在不在视窗(外框 ∩ 舞台)里 */
  const inWindow = (cx: number): boolean => {
    const el = stageRef.current;
    if (!el || !box.w) return false;
    const r = el.getBoundingClientRect();
    const [wl, wr] = windowSpan(view.k, { sw: r.width, sh: r.height, bw: box.w, bh: box.h });
    return cx - r.left >= wl && cx - r.left <= wr;
  };
  /** 屏幕坐标 → 地块(不在地图上 = −1) */
  const cellAt = (cx: number, cy: number): number => {
    const p = pixelAt(cx, cy);
    return p && data ? data.raster.cell[p[1] * data.raster.w + p[0]] : -1;
  };
  /**
   * 屏幕坐标 → 世界坐标(地图原图的像素坐标;不在地图上 = null)。
   * x 取模到 [0, 宽)(改地形画线时由 TerrainTools 按上一个点展开,跨接缝的线是连着的一笔)
   */
  const worldAt = (cx: number, cy: number): [number, number] | null => {
    if (!data || !canvasRef.current) return null;
    const cr = canvasRef.current.getBoundingClientRect();
    let u = (cx - cr.left) / cr.width;
    const v = (cy - cr.top) / cr.height;
    if (!inWindow(cx)) return null;
    if (mp) {
      if (!(u >= 0 && v >= 0 && u <= 1 && v <= 1)) return null;
      return unprojectWorld(mp, u * data.world.width, v * data.world.height);
    }
    u -= Math.floor(u);
    if (!(u >= 0 && v >= 0 && u <= 1 && v <= 1)) return null;
    return [u * data.world.width, v * data.world.height];
  };
  // ---- 作者标记(MarkLayer.tsx 画、markStore.ts 管放标记和正在填的那一份) ----
  /** 屏幕坐标 → 世界坐标(地球仪按球上的像素;不在地图上 = null) */
  const markWorldAt = (cx: number, cy: number): [number, number] | null => {
    if (!data) return null;
    if (getGlobeOn()) {
      const p = globeApi.current?.pixelAt(cx, cy);
      const sc = data.raster.scale;
      return p ? [(p[0] + 0.5) / sc, (p[1] + 0.5) / sc] : null;
    }
    return worldAt(cx, cy);
  };
  /** 屏幕坐标 → 州号(海上、地图外 = −1) */
  const regionAtClient = (cx: number, cy: number): number => {
    const c = cellAt(cx, cy);
    return civ && c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
  };
  const markApi = useRef<MarkApi | null>(null);
  markApi.current = {
    // 世界坐标 → 舞台坐标:平面主图(左右相连,按视窗裁)、弯边投影、地球仪
    frame: () => {
      const el = stageRef.current;
      const g = geo.current;
      if (!el || !g.bw) return null;
      const r = el.getBoundingClientRect();
      const at = `${r.left},${r.top},${r.width},${r.height}`;
      const base = { left: r.left, top: r.top, w: r.width, h: r.height };
      if (getGlobeOn()) {
        const ga = globeApi.current;
        const gv = ga?.viewSig();
        if (!ga || !gv) return null;
        const pt = (wx: number, wy: number): [number, number] | null => {
          const p = ga.worldToClient(wx, wy);
          return p ? [p[0] - r.left, p[1] - r.top] : null;
        };
        return { ...base, pt, period: 0, win: [0, r.width], k: gv.k, cut: 0, sig: `g|${gv.sig}|${at}` };
      }
      const b = { sw: r.width, sh: r.height, bw: g.bw, bh: g.bh };
      const v = viewRef.current;
      const m = mpRef.current;
      const sig = `${m?.key ?? 'f'}|${v.k},${v.x},${v.y}|${at}|${g.bw},${g.bh}`;
      if (m) {
        const pt = (wx: number, wy: number): [number, number] => {
          const [x, y] = projectWorld(m, wx, wy);
          return worldToStage(x, y, v, b, g.W, g.H);
        };
        return { ...base, pt, period: 0, win: [0, r.width], k: v.k, cut: 0.4 * g.bw * v.k, sig };
      }
      const pt = (wx: number, wy: number) => worldToStage(wx, wy, v, b, g.W, g.H);
      return { ...base, pt, period: g.wrap ? (g.wrap / g.W) * g.bw * v.k : 0, win: g.wrap ? windowSpan(v.k, b) : [0, r.width], k: v.k, cut: 0, sig };
    },
    regionAt: regionAtClient,
    onMap: (cx, cy) => !!pixelAt(cx, cy),
    // 地球仪上的字另画,不躲
    textBoxes: () => (getGlobeOn() ? { ver: -1, list: [] } : mapTextBoxes()),
  };
  /** 这一年(时间轴当前那年,取整) */
  const markYear = () => (civ ? Math.floor(Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear))) : 0);
  /**
   * 悬停时标记要说的:放标记、圈州时写鼠标下是哪(海上也行);正在填一个点的标记时图钉上是"能拖"的光标;
   * 停在地图上的标记上 = 它的名字和年份(停在图钉、名字上时 tip = 图钉尖,小卡片放在它左上方;圈州时小卡片放在鼠标左边)。
   * info 不给 = 照常的悬停小卡片;整个不归标记管 = null
   */
  const markHoverAt = (cx: number, cy: number): { info?: HoverInfo | null; cursor: string; tip?: [number, number] | null; left?: boolean } | null => {
    if (!civ || !data) return null;
    const mk = getMarkUi();
    const year = markYear();
    const owner = (r: number) => ownerName(civ, ownersAt(civ, year).polity[r], year);
    if (mk.placing || mk.draft?.scope === 'regions') {
      const w = markWorldAt(cx, cy);
      if (!w) return { info: null, cursor: '' };
      const r = regionAtClient(cx, cy);
      if (mk.placing) {
        const name = r >= 0 ? regionLabel(civ, r) : (markSpot(civ, data.world, data.raster, w, year).sea ?? '海上');
        return { info: { name, sub: r >= 0 ? owner(r) : undefined, extra: '点一下，在这里放标记' }, cursor: 'none' };
      }
      if (r < 0) return { info: null, cursor: '' };
      const on = mk.draft!.regions.includes(regionKey(civ, r));
      return { info: { name: regionLabel(civ, r), sub: owner(r), extra: on ? '再点一下去掉' : '点一下加进来' }, cursor: 'pointer', left: true };
    }
    if (mk.draft) return markPinAt(cx, cy, mk.draft.id) ? { info: null, cursor: 'grab' } : { cursor: 'crosshair' };
    const hit = markHitAt(cx, cy);
    if (!hit) return null;
    if (hit.kind === 'cluster') return { info: null, cursor: 'zoom-in' };
    const m = getEdits().marks?.find((x) => x.id === hit.ids[0]);
    return m ? { info: markHover(m), cursor: 'pointer', tip: hit.kind === 'pill' ? null : markPinTip(m.id) } : null;
  };
  /** 挑地方时点地图得到的地方:城镇符号、城名 = 那座城;陆地 = 那一州;海上 = 那一点 */
  const whereAtClient = (cx: number, cy: number): Where | null => {
    if (!civ) return null;
    const hit = labelAt(cx, cy);
    if (hit?.kind === 'settlement' && civ.settlements[hit.id]) return whereOfCity(civ, hit.id);
    const r = regionAtClient(cx, cy);
    if (r >= 0) return whereOfRegion(civ, r);
    return markWorldAt(cx, cy);
  };
  /**
   * 悬停时作者的人物要说的:挑地方时写鼠标下是哪(那一年归谁);停在地图上的头像上 = 名字、那年多大、在哪。
   * 不归人物管 = null(再看标记的)
   */
  const charHoverAt = (cx: number, cy: number): { info?: HoverInfo | null; cursor: string; tip?: [number, number] | null; left?: boolean } | null => {
    if (!civ || !data) return null;
    const cu = getCharUi();
    if (cu.picking && cu.draft) {
      const w = whereAtClient(cx, cy);
      if (!w) return { info: null, cursor: '' };
      const t = cu.picking === 'birth' ? cu.draft.bornText : cu.draft.sub?.kind === 'life' ? cu.draft.sub.d.yearText : '';
      const ty = parseCharYear(t);
      const year = ty === null || Number.isNaN(ty) ? markYear() : ty;
      const pl = placeOf(civ, data.world, data.raster, w, year);
      const sub = pl.region !== undefined ? ownerName(civ, ownersAt(civ, Math.min(civ.endYear, year)).polity[pl.region], year) : undefined;
      return { info: { name: pl.name, sub, extra: '点一下，选这里' }, cursor: 'none' };
    }
    const id = characterPinAt(cx, cy);
    if (id === null) return null;
    const c = getEdits().characters?.find((x) => x.id === id);
    return c ? { info: characterHover(civ, data.world, data.raster, c, markYear()), cursor: 'pointer', tip: characterPinTip() } : { info: null, cursor: 'pointer' };
  };
  /** 标记说的悬停小卡片(有图钉尖就放在图钉左上方,圈州时放在鼠标左边) */
  const markHoverCard = (mh: { info?: HoverInfo | null; tip?: [number, number] | null; left?: boolean }, x: number, y: number) =>
    setHover(mh.info ? (mh.tip ? { info: mh.info, x: mh.tip[0], y: mh.tip[1], place: 'above' } : { info: mh.info, x, y, place: mh.left ? 'left' : undefined }) : null);
  /** 正在拖的图钉(按下的那根手指 / 鼠标);松手的时刻(紧跟着的 click 不算点地图) */
  const pinDrag = useRef<number | null>(null);
  const pinDragEnd = useRef(-1e9);
  // 按在正在填的标记的图钉上:拖图钉(捕获阶段:地图、地球仪都不拖)
  const onMarkDownCapture = (e: React.PointerEvent) => {
    const d = getMarkUi().draft;
    if (!d || d.scope !== 'point' || !d.at || replayOn || (e.pointerType === 'mouse' && e.button !== 0) || touches.current.size > 1) return;
    if (!markPinAt(e.clientX, e.clientY, d.id)) return;
    e.stopPropagation();
    stopFly();
    pinDrag.current = e.pointerId;
    setMarkDragging(true);
    setHover(null);
    if (stageRef.current) stageRef.current.style.cursor = 'grabbing';
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMarkMoveCapture = (e: React.PointerEvent): boolean => {
    if (pinDrag.current !== e.pointerId) return false;
    e.stopPropagation();
    const w = markWorldAt(e.clientX, e.clientY);
    if (w) patchDraft({ at: w });
    return true;
  };
  const onMarkUpCapture = (e: React.PointerEvent) => {
    if (pinDrag.current !== e.pointerId) return;
    e.stopPropagation();
    pinDrag.current = null;
    pinDragEnd.current = performance.now();
    setMarkDragging(false);
    if (stageRef.current) stageRef.current.style.cursor = '';
  };
  /** 点到合并的圆:以它为中心放大到写名字的程度(至少 1.6 倍) */
  const zoomToCluster = (cx: number, cy: number) => {
    const el = stageRef.current;
    if (!el) return;
    const k = getGlobeOn() ? (globeApi.current?.viewSig()?.k ?? 1) : viewRef.current.k;
    const f = Math.max(1.6, (NAME_ZOOM * 1.05) / k);
    if (getGlobeOn()) return globeApi.current?.zoomBy(f, cx, cy);
    const r = el.getBoundingClientRect();
    zoomAt(cx - r.left, cy - r.top, f);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = stageRef.current;
    if (!el || getGlobeOn()) return;
    // 双指捏合:等下一帧一起算
    if (pinch.current) {
      if (e.pointerType === 'touch') schedulePinch();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (terrainPointer.current === null || e.pointerId === terrainPointer.current) {
      terrainMove(worldAt(e.clientX, e.clientY));
      upMove(worldAt(e.clientX, e.clientY));
    }
    let label: ReturnType<typeof pickLabelAt> = null;
    let mh: ReturnType<typeof markHoverAt> = null;
    if (drag.current) {
      const d = drag.current;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > (d.touch ? TOUCH_SLOP : CLICK_SLOP)) moved.current = true;
      if (mp && box.w) {
        // 弯边投影:左右拖 = 转中央经线(赤道上的地方跟着鼠标走),上下拖 = 平移
        if (moved.current) setMapMoving(true);
        const pxPerDeg = view.k * (box.w / mp.W) * mp.s * mp.def.kx(0) * (Math.PI / 180);
        if (pxPerDeg > 0) scheduleCenter(d.lon - (e.clientX - d.x) / pxPerDeg);
        setView((v) => clampRef.current({ k: v.k, x: v.x, y: d.vy + e.clientY - d.y }, rect.width, rect.height));
      } else setView((v) => clampRef.current({ k: v.k, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }, rect.width, rect.height));
    } else {
      // 鼠标停在能点的字 / 城镇符号上:手指光标(改地形时不管字);作者标记上 / 放标记 / 圈州时按标记的
      const tool = getTerrainTool().on || getUpUi().on;
      label = tool || draft ? null : pickLabelAt(e.clientX, e.clientY);
      mh = tool || draft || replayOn ? null : (charHoverAt(e.clientX, e.clientY) ?? markHoverAt(e.clientX, e.clientY));
      el.style.cursor = mh ? mh.cursor : label ? 'pointer' : '';
    }
    // 悬停小卡片:拖动、改地形、回放、新建时不显示;手指没有"悬停"(点了直接出面板)
    if (!data || (drag.current && moved.current) || getTerrainTool().on || getUpUi().on || replayOn || draft || e.pointerType === 'touch') return setHover(null);
    if (mh && mh.info !== undefined) return markHoverCard(mh, e.clientX, e.clientY);
    const p = pixelAt(e.clientX, e.clientY);
    if (!p) return setHover(null);
    showHover(p, label, e.clientX, e.clientY);
  };
  const probeRef = useRef<(cx: number, cy: number) => string[] | null>(() => null);
  probeRef.current = (cx, cy) => {
    const p = pixelAt(cx, cy);
    return p && data ? probeLines(data.world, data.raster, civ, p[0], p[1]) : null;
  };
  const showHover = (p: [number, number], label: ReturnType<typeof pickLabelAt>, x: number, y: number) => {
    if (!data) return;
    const info = hoverInfo({ world: data.world, raster: data.raster, civ, px: p[0], py: p[1], layer: mapLayer, label, year: getCivTime().year });
    setHover(info ? { info, x, y } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (getGlobeOn()) return;
    if (pinch.current) {
      // 还有两根手指按着(第三根松开了):接着捏合;否则结束捏合,剩下的一根接着拖
      if (touches.current.size >= 2) startPinch();
      else endPinch();
      return;
    }
    // 捏合以后剩下的那根手指:别的手指松开时不结束它的拖动
    if (e.pointerType === 'touch' && drag.current?.touch && touches.current.size > 0) return;
    // 正在画的那一笔:只认按下它的那根手指松开
    if (terrainPointer.current !== null && e.pointerId !== terrainPointer.current) return;
    terrainPointer.current = null;
    terrainUp();
    upUp();
    terrainStroke.current = false;
    drag.current = null;
    setMapMoving(false);
  };
  /** 双击:缩放复位(中央经线不变 —— 它是这个世界的设置,拖远了、放大了双击回到整张图) */
  const resetView = () => {
    const el = stageRef.current;
    if (!el || !box.w) return setView({ k: 1, x: 0, y: 0 });
    const b = { sw: el.clientWidth, sh: el.clientHeight, bw: box.w, bh: box.h };
    const base = { k: 1, x: 0, y: 0 };
    setView(curved || !wrapW ? clampCurved(base, b) : viewCentredAt(base, b, wrapW, xOfLon(getMapCenter(), wrapW)));
  };
  // 改地形只在等距圆柱主图上改:地球仪、弯边投影里打开改地形就先切回等距圆柱(中心不变,地球仪的接上它正对着的经度);
  // 改地形时换成别的投影 = 收起改地形
  useEffect(() => {
    if (terrainTool.on && getProjection() !== 'equirect') setProjection('equirect');
  }, [terrainTool.on]);
  useEffect(() => {
    if (projection !== 'equirect' && getTerrainTool().on) setTerrainTool({ on: false });
    if (projection !== 'equirect' && getUpUi().on) closeUpheaval();
  }, [projection]);
  // 地形大事同样只在等距圆柱主图上放、涂:打开时先切回等距圆柱;打开时详情、选目标、放标记、改地形一起收起
  useEffect(() => {
    if (!upOn) return;
    if (getProjection() !== 'equirect') setProjection('equirect');
    setSheet('half');
    clearSelection();
    setPolityPick(null);
    stopPlacing();
    setTerrainTool({ on: false });
    setHover(null);
  }, [upOn]);
  // 选中了别的东西(搜索、编年史):卡片让给它;改地形打开:收起
  useEffect(() => {
    if (selState.sel && getUpUi().on) closeUpheaval();
  }, [selState.sel]);
  useEffect(() => {
    if (terrainTool.on) closeUpheaval();
  }, [terrainTool.on]);

  // ---- 点选(阶段 4):单击(不是拖动)选中 城镇符号 / 城名 → 城,国名 → 国家,地名 → 地理实体;
  // 都没点到:"国家"开着时点到国土 → 国家,否则 → 州;点到海上 / 地图外 = 取消。双击(复位视图)不改选中 ----
  /** 双击的第一下之前选中的是什么(第二下时恢复) */
  const beforeClick = useRef<MapSelection | null>(null);
  const onStageClick = (e: React.MouseEvent) => {
    // 只管点在地图(或地图外的空白)上的:时间轴、按钮、图例上的点击冒泡上来不算
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.closest('.canvas-wrap, .globe')) return;
    // 点地图收起菜单的那一下只收起菜单(dismissClick.ts)
    if (tookDismissClick()) return;
    if ((getGlobeOn() ? globeApi.current?.dragged() : moved.current) || replayOn) return;
    // 改地形:单击放火山 / 挖湖,不看详情(双击的第二下不再放)
    if (getTerrainTool().on) {
      if (e.detail < 2) terrainClick(worldAt(e.clientX, e.clientY));
      return;
    }
    // 地形大事:单击放火山,不看详情
    if (getUpUi().on) {
      if (e.detail < 2) upClick(worldAt(e.clientX, e.clientY));
      return;
    }
    // 新建时还没有历史,点了不看详情
    if (draft) return;
    // 作者的人物:正在填的时候点地图不选别的;挑地方时 = 选好那一处(城 / 州 / 海上那一点)
    const cu = getCharUi();
    if (civ && cu.draft) {
      if (e.detail >= 2 || !cu.picking) return;
      const w = whereAtClient(e.clientX, e.clientY);
      if (w) {
        pickPlace(w);
        setHover(null);
      }
      return;
    }
    // 作者标记:放标记 = 在点到的地方新建一个;正在填的标记:一个点 = 图钉挪到点到的地方,几个州 = 点到的州加进来 / 去掉(都不选别的)
    const mk = getMarkUi();
    if (civ && (mk.placing || mk.draft)) {
      if (e.detail >= 2 || performance.now() - pinDragEnd.current < 400) return;
      if (mk.draft?.scope === 'regions') {
        const r = regionAtClient(e.clientX, e.clientY);
        if (r >= 0) toggleDraftRegion(regionKey(civ, r));
        return;
      }
      const w = markWorldAt(e.clientX, e.clientY);
      if (!w) return;
      if (mk.placing) {
        newMarkDraft({ at: w, year: markYear() });
        setHover(null);
      } else patchDraft({ at: w });
      return;
    }
    // 双击的第二下(手指点两下时浏览器不一定数成 detail = 2):恢复第一下之前的选中
    if (e.detail >= 2 || performance.now() - dblTapAt.current < 600) {
      setSelection(beforeClick.current);
      return;
    }
    // 干预选对象国 / 迁都选城(阶段 4):点到的国家 / 城交给干预区,不改选中
    const pk = getPolityPick();
    if (pk) {
      const city = pk.target === 'settlement';
      const id = city ? settlementAtClick(e.clientX, e.clientY) : polityAtClick(e.clientX, e.clientY);
      const err = id >= 0 ? pk.accept(id) : city ? '这里没有城,点一座城的符号或城名' : '这里没有国家,点一个国家的国土或国名';
      setPolityPick(err ? { ...pk, msg: err } : null);
      return;
    }
    beforeClick.current = getSelection().sel;
    const el = stageRef.current;
    const rect = el?.getBoundingClientRect();
    const side = rect && e.clientX - rect.left > rect.width * 0.55 ? 'left' : 'right';
    // 作者的人物的头像(画在最上面,先看它)
    const ch = characterPinAt(e.clientX, e.clientY);
    if (ch !== null) return setSelection({ kind: 'character', id: ch }, side);
    // 作者标记(画在地名上面,先看它):图钉、名字、名字牌 = 选中它;合并的圆 = 在那里放大
    const mh = markHitAt(e.clientX, e.clientY);
    if (mh) {
      if (mh.kind === 'cluster') return zoomToCluster(e.clientX, e.clientY);
      return setSelection({ kind: 'mark', id: mh.ids[0] }, side);
    }
    const hit = labelAt(e.clientX, e.clientY);
    if (hit) return setSelection(hit, side);
    const c = cellAt(e.clientX, e.clientY);
    const r = civ && c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (!civ || r < 0) return clearSelection();
    // 信仰图层:点陆地 = 那里信的那个教(国名、城名照旧打开国家、城)
    if (getCivShow().faiths && civ.religion) {
      const y = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
      const f = faithAt(civ, y)[r];
      if (f >= 0) return setSelection({ kind: 'faith', id: f }, side);
    }
    if (getCivShow().polities && civ.polities.length) {
      const y = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
      const po = ownersAt(civ, y).polity[r];
      if (po >= 0) return setSelection({ kind: 'polity', id: po }, side);
    }
    setSelection({ kind: 'region', id: r }, side);
  };
  /** 点到的城镇符号 / 城名 / 国名 / 地名(主图:文字层;地球仪:球上的符号文字层) */
  const labelAt = (x: number, y: number) => (getGlobeOn() ? (globeApi.current?.labelAt(x, y) ?? null) : pickLabelAt(x, y));
  /** 单击处的国家(时间轴当前那一年;点到国名也算;没有 = −1) */
  const polityAtClick = (x: number, y: number): number => {
    if (!civ) return -1;
    const hit = labelAt(x, y);
    if (hit?.kind === 'polity') return hit.id;
    const c = cellAt(x, y);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r < 0) return -1;
    const yr = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    return ownersAt(civ, yr).polity[r];
  };

  // 打开改地形:单击不再看详情,已经打开的详情面板、"在地图上点一个国家"一起收起
  useEffect(() => {
    if (!terrainTool.on) return;
    clearSelection();
    setPolityPick(null);
    stopPlacing();
  }, [terrainTool.on]);
  // 作者标记:放标记时顶部一条提示(取消 = Esc);换了世界、回到我的世界、回放世界形成时放标记、正在填的一律作废。
  // 开始放标记时,"在地图上点一个国家"(干预选目标)收起,免得两件事抢同一下点击
  const markPlacing = useMarkUi().placing;
  useEffect(() => {
    if (markPlacing) setPolityPick(null);
  }, [markPlacing]);
  useEffect(() => {
    if (markPlacing) showToast({ id: 'mk', kind: 'info', text: '点地图放标记', more: ['陆地、海上都可以'], action: { label: coarse ? '取消' : '取消 · Esc', act: 'mark-cancel', onClick: stopPlacing } });
    else clearToast('mk');
  }, [markPlacing, coarse]);
  // 作者的人物:挑地方时顶部一条提示(取消 = Esc);开始挑时"在地图上点一个国家"收起
  const charPicking = useCharUi().picking;
  useEffect(() => {
    if (charPicking) {
      setPolityPick(null);
      showToast({
        id: 'oc-pick',
        kind: 'info',
        text: charPicking === 'birth' ? '点地图选出生地' : '点地图选这段经历在哪',
        more: ['城、州、海上都可以'],
        action: { label: coarse ? '取消' : '取消 · Esc', act: 'character-pick-cancel', onClick: stopPicking },
      });
    } else clearToast('oc-pick');
  }, [charPicking, coarse]);
  /** 能放标记:建好的世界、有历史(新建、回放世界形成时不行) */
  const markable = !!data && stage === 'world' && !!civ && !replayOn;
  const markWorld = data?.world;
  useEffect(() => {
    resetMarkUi();
    resetCharacterUi();
  }, [markWorld, home, replayOn, draft]);

  /** 单击处的城(点到城镇符号 / 城名;否则点到的州里时间轴当前那一年还在的城;没有 = −1) */
  const settlementAtClick = (x: number, y: number): number => {
    if (!civ) return -1;
    const hit = labelAt(x, y);
    if (hit?.kind === 'settlement') return hit.id;
    const c = cellAt(x, y);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r < 0) return -1;
    const yr = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    const s = civ.settlements.find((q) => q.region === r && q.founded <= yr && (q.ended === undefined || q.ended > yr));
    return s ? s.id : -1;
  };
  // 浏览器自己的页面缩放不抢捏合:
  // - 手机:双指捏合(Safari 的 gesture 事件;别的浏览器靠 touch-action,见 app.css),交给上面的手指处理
  // - 电脑上 Safari 的触控板捏合也是 gesture 事件(没有手指按在屏幕上):落在地图上就缩放地图
  // - Chrome、Firefox 的触控板捏合是按着 Ctrl 的滚轮:落在侧栏、时间轴、按钮上时也拦下,不放大整个网页
  useEffect(() => {
    /** 这次触控板捏合上一回的倍数(0 = 不归地图管) */
    let pinchAt = 0;
    const onMap = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el?.closest?.('.stage') && !el.closest('.inspector');
    };
    const start = (e: Event) => {
      e.preventDefault();
      const fingers = touches.current.size > 0;
      setGesturePinch(!fingers);
      pinchAt = !fingers && onMap(e.target) ? 1 : 0;
    };
    const change = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      if (!pinchAt || touches.current.size || !(typeof g.scale === 'number' && g.scale > 0)) return;
      const f = g.scale / pinchAt;
      pinchAt = g.scale;
      const el = stageRef.current;
      if (!el || !Number.isFinite(f)) return;
      const rect = el.getBoundingClientRect();
      const cx = g.clientX ?? mouseAt.current[0];
      const cy = g.clientY ?? mouseAt.current[1];
      touchRef.current();
      if (getGlobeOn()) globeApi.current?.zoomBy(f, cx, cy, true);
      else zoomRef.current(cx - rect.left, cy - rect.top, f);
    };
    const end = () => {
      pinchAt = 0;
      setGesturePinch(false);
    };
    const isPinch = createPinchGuard();
    const pageZoom = (e: WheelEvent) => {
      if (e.ctrlKey && isPinch(wheelSample(e))) e.preventDefault();
    };
    document.addEventListener('gesturestart', start, { passive: false });
    document.addEventListener('gesturechange', change, { passive: false });
    document.addEventListener('gestureend', end);
    window.addEventListener('wheel', pageZoom, { passive: false, capture: true });
    return () => {
      document.removeEventListener('gesturestart', start);
      document.removeEventListener('gesturechange', change);
      document.removeEventListener('gestureend', end);
      window.removeEventListener('wheel', pageZoom, { capture: true });
    };
  }, []);
  // Esc:先取消"在地图上点一个国家 / 城",再取消选中(在输入框里打字时不管)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (escapeCharacter()) return;
      if (getUpUi().on) return closeUpheaval();
      const mk = getMarkUi();
      if (mk.placing) return stopPlacing();
      if (mk.draft) return cancelDraft();
      if (getPolityPick()) return setPolityPick(null);
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 键盘快捷键(按键对照见 shortcuts.ts;光标在输入框里、弹窗开着时不管,见 useShortcuts.ts)。返回 false = 这一下不归快捷键管
  useShortcuts((a) => {
    if (home || !data) return false;
    const end = civ?.endYear ?? 0;
    // 有历史可放:建好的世界、长出了文明、不在回放世界形成
    const history = !draft && !!civ && civ.viable && !replayOn;
    // 宽屏、建好的世界:左边的卡片能收起(sideStore.ts);收起着要用卡片里的搜索框、存档时先展开
    const foldable = !narrow && !!world && stage === 'world';
    const sideHidden = () => foldable && getSide().collapsed && !getSide().peek;
    const showSide = () => sideHidden() && flushSync(expandSide);
    switch (a) {
      case 'play':
        if (!history) return false;
        togglePlayback(end, replayStart(end));
        return true;
      case 'back':
      case 'forward':
      case 'back100':
      case 'forward100':
        if (!history) return false;
        stepYear(end, (a === 'back' || a === 'back100' ? -1 : 1) * (a.endsWith('100') ? 100 : 10));
        return true;
      case 'zoomIn':
      case 'zoomOut':
        zoomButton(a === 'zoomIn' ? 1.5 : 1 / 1.5);
        return true;
      case 'layer1':
      case 'layer2':
      case 'layer3':
      case 'layer4':
      case 'layer5': {
        const id = (draft ? DRAFT_SEG : SEG_LAYERS)[Number(a.slice(5)) - 1];
        if (!id) return false;
        applyLayer(id);
        return true;
      }
      case 'search': {
        showSide();
        const box = [...document.querySelectorAll<HTMLInputElement>('input.search-input')].find(
          (el) => !el.disabled && el.getClientRects().length > 0 && !el.closest('[inert]'),
        );
        if (!box) return false;
        box.focus();
        box.select();
        return true;
      }
      case 'undo':
      case 'redo':
        // 改地形工具开着:它自己管(撤销一笔);新建世界时 ⌘Z 也是撤销一笔地形
        if (getTerrainTool().on) return false;
        // 地形大事的卡片开着:撤销这一件里的最后一笔
        if (getUpUi().on) {
          if (a === 'undo') undoUpOp();
          return true;
        }
        if (draft) {
          if (a === 'undo') undoTerrainOp();
          return true;
        }
        if (a === 'undo') undoLastEdit();
        else redoLastEdit();
        return true;
      case 'save':
        if (draft) return false;
        showSide();
        return openSaveMenu();
      case 'side':
        // 和卡片上的收起按钮、收起后左上角的小按钮一样(卡片弹出来显示选中的东西时 = 收回去)
        if (!foldable) return false;
        if (sideHidden()) expandSide();
        else collapseSide();
        return true;
      case 'help':
        openShortcuts();
        return true;
    }
  });

  /** 平面主图 ⇄ 地球仪:两边的中心经度接上(地球仪从主图当前的中心转起;切回主图时转到地球仪正对着的经度) */
  const toggleGlobe = () => {
    setHover(null);
    if (!getGlobeOn()) return setGlobeOn(true);
    // 切回上一个平面投影(中心接上地球仪正对着的经度,见上面换投影那一段)
    setGlobeOn(false);
  };
  // 地球仪:回放帧、地形画布什么时候重画过(换世界 / 画风 / 图层)
  const globeReplay = useMemo(
    () => (replayOn && replay ? { w: replay.w, h: replay.h, frame: replay.frames[replay.idx] } : null),
    [replayOn, replay],
  );
  const terrainKey = useMemo(() => ({ data, style, layer }), [data, style, layer]);
  const onGlobeHover = (p: [number, number] | null) => {
    if (!p || !data || replayOn) return setHover(null);
    const [x, y] = mouseAt.current;
    const mh = draft ? null : (charHoverAt(x, y) ?? markHoverAt(x, y));
    if (stageRef.current) stageRef.current.style.cursor = mh ? mh.cursor : '';
    if (mh && mh.info !== undefined) return markHoverCard(mh, x, y);
    showHover(p, globeApi.current?.labelAt(x, y) ?? null, x, y);
  };
  // ---- 顶部提示条:生成进度、重推历史、选目标、改地形的结果(同一时间只显示最近的一条) ----
  // 生成世界(首次打开、换种子、调参数、读档)/ 按新地形重新生成:一行"正在…",小字是种子和这一步在做什么
  useEffect(() => {
    if (progress)
      showToast({
        id: 'progress',
        kind: 'progress',
        text: progress.regen ? '正在按新地形重新生成' : '正在生成世界',
        more: [progress.seed !== undefined && !progress.regen ? `种子 ${progress.seed}，${progress.stage}` : progress.stage],
        progress: progress.pct,
      });
    else clearToast('progress');
  }, [progress]);
  // 回放世界形成:后台算各个年代的地形那一两秒(算好以后是地图上的字幕)
  const replayWait = replayOn && !replay;
  useEffect(() => {
    if (replayWait) showToast({ id: 'replay', kind: 'progress', text: '正在准备回放' });
    else clearToast('replay');
  }, [replayWait]);
  // 重推历史的进度、选目标的提示在 TargetPlates.tsx(和名牌、压暗一起)
  const terrainLast = terrainStatus.last;
  useEffect(() => {
    if (!terrainLast) return;
    // 对不上的改名先留着(撤销地形修改就会回来),没生效的干预概览里写了原因
    const lost = [
      terrainLast.lostNames ? `${terrainLast.lostNames} 处改名` : '',
      terrainLast.lostInterventions ? `${terrainLast.lostInterventions} 条干预` : '',
    ].filter(Boolean);
    const more = lost.length ? [`${lost.join('、')}暂未生效`] : undefined;
    const n = regenNote.current;
    regenNote.current = null;
    // 新建界面里助手执行、撤销以后不放提示条(撤销在助手那一行和左边「地形」里)
    if (n && getStage().stage === 'draft') return;
    if (n) {
      showToast({
        id: 'terrain',
        kind: lost.length ? 'warn' : 'ok',
        text: n.kind === 'apply' ? '已按你说的改写 · 按新地形重新生成' : '已撤销改写 · 按原来的地形重新生成',
        more,
        action:
          n.kind === 'apply' && n.undo
            ? {
                label: '撤销',
                act: 'rw-undo',
                onClick: () => {
                  n.undo?.();
                  clearToast('terrain');
                },
              }
            : undefined,
      });
      return;
    }
    showToast({ id: 'terrain', kind: lost.length ? 'warn' : 'ok', text: '已按新地形重新生成', more });
  }, [terrainLast]);

  // 推演出来没有文明(宜居的陆地太少):建好的世界说一句(新建时卡片上写,可以换一颗)
  const noCiv = !!rawCiv && !rawCiv.viable;
  const noCivToast = noCiv && stage === 'world';
  useEffect(() => {
    if (!noCivToast) return clearToast('world');
    showToast({ id: 'world', kind: 'warn', text: '这个世界没有文明', more: ['宜居的陆地太少'] });
  }, [noCivToast]);

  const civReady = !!civ && civ.viable;
  /** 正在重推 / 按新地形重新生成 / 生成新世界:助手这时发不了话、确认单也不能执行 */
  const worldBusy = !!resim || terrainStatus.busy || !!progress;
  // 助手:换了世界、世界建好了,对话跟着换;离开建好的世界(回我的世界、新建)不再看试推演。
  // 打开另一个参数、地形、名字都一样的存档时历史原样复用,所以还要跟着世界的 id(存档一变 App 就重新渲染)
  const worldId = currentWorld()?.id ?? null;
  useEffect(() => syncAssistantWorld(draft ? 'history' : 'terrain'), [rawCiv, draft, data, worldId]);
  useEffect(() => {
    if (stage !== 'world') exitPreview();
  }, [stage]);
  // 在地图上看试推演:面板里是试推演的历史,只许改两份历史里是同一个的国家、城(改名、下令用它的键)
  useEffect(() => {
    const real = rawCiv;
    const sim = previewRaw;
    if (!real || !sim) return;
    setEditGate((keys) => (keys.every((k) => sameInBoth(real, sim, k)) ? null : PREVIEW_EDIT_BLOCK));
    return () => setEditGate(null);
  }, [rawCiv, previewRaw]);
  // 在地图上看试推演 / 回到现在:选中的东西按稳定键换到另一份历史里;刚开始看时没选东西,选上关注的那个国家
  const prevPreview = useRef<Civ | null>(null);
  useLayoutEffect(() => {
    const was = prevPreview.current;
    prevPreview.current = previewRaw;
    const real = rawRef.current;
    const from = was ?? real;
    const to = previewRaw ?? real;
    if (was === previewRaw || !from || !to || from === to) return;
    remapSelection(from, to);
    if (!previewRaw || was || getSelection().sel || !real) return;
    const p = getAssistant().preview;
    const v = p ? getAssistant().turns.find((t) => t.id === p.turn)?.proposal?.trial : undefined;
    const id = v && v.focus > 0 ? v.rows[0].id : -1;
    if (id < 0 || !real.polities[id]) return;
    const r = resolveKey(previewRaw, polityKey(real, id));
    if (r && r.kind === 'polity') setSelection({ kind: 'polity', id: r.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRaw]);
  // 详情面板只挂一份:挂进一个自己建的容器,窄屏把容器放在底部卡片的位置,宽屏放进侧栏(放哪儿由那边的空位 ref 决定)。
  // 窗口跨过窄屏断点(比如手机横过来)时面板不重新挂,正在干预的那几步、填了一半的年份和名字都留着
  const inspectorHost = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'inspector-host';
    return el;
  }, []);
  const inspectorSlot = useCallback(
    (slot: HTMLElement | null) => {
      if (slot && inspectorHost.parentNode !== slot) slot.appendChild(inspectorHost);
    },
    [inspectorHost],
  );
  /** 建好的世界(不是新建中、不在我的世界):时间轴、详情、概览、事件标签这些才有 */
  const world = stage === 'world';
  const curWorld = currentWorld();
  /** 打开别人分享的世界、还没改过:地图下那条说明代替第一次打开的操作提示 */
  const sharedOn = world && !!data && !!sharedFor && curWorld?.id === sharedFor.id && curWorld.kind === 'visit' && !terrainTool.on;
  const layerProps = { layer: mapLayer, civ, onLayer: applyLayer, thumbs, requestThumbs, disabled: !data };
  /** 新建界面确认创建:建好了就让平常的地图从星球展开时正中的经线接着看(放回 1 倍) */
  const studioCreate = (title: string, lon: number): boolean => {
    if (!createWorld(title)) return false;
    setStudioOut(1);
    stopFly();
    publishMapCenter(wrapLon(lon));
    const el = stageRef.current;
    const g = geo.current;
    if (getProjection() === 'equirect' && el && g.bw && g.wrap) {
      const b = { sw: el.clientWidth, sh: el.clientHeight, bw: g.bw, bh: g.bh, padB: g.padB };
      const v0 = viewCentredAt({ k: 1, x: 0, y: 0 }, b, g.wrap, xOfLon(lon, g.wrap));
      const v = { ...v0, x: Math.round(v0.x) };
      viewRef.current = v;
      setView(v);
    }
    return true;
  };
  const studio = (draft || studioOut > 0) && (
    <Studio
      phone={narrow}
      params={params}
      title={draftTitle}
      base={stageBase}
      back={draftBack}
      onSeed={draftSeed}
      onRandomSeed={() => draftSeed(randomSeedValue())}
      onParams={draftParams}
      onTitle={draftRename}
      onCreate={studioCreate}
      // 以它为底稿新建、调过参数:带过来的干预要等重推完(不然创建时截的缩略图、放的历史是没干预的)
      busy={!!progress || !!resim}
      ready={!!data && !progress}
      noCiv={noCiv}
      data={data}
      civ={realCiv}
      raw={rawCiv}
      worldBusy={worldBusy}
      layer={mapLayer}
      onLayer={applyLayer}
      baseCanvas={baseCanvas}
      thumbs={thumbs}
      requestThumbs={requestThumbs}
      onFade={() => setStudioOut(2)}
      onGone={() => setStudioOut(0)}
    />
  );
  // 摊平改地形时舞台摆在新建界面中间那块
  const fr = studioOn ? studioFlat?.rect : undefined;
  const stagePos: CSSProperties | undefined = fr && { left: fr.x, top: fr.y, width: fr.w, height: fr.h, right: 'auto', bottom: 'auto' };
  // 两层放大的地图框共用一个变换、按视窗裁;两层屏幕层按同一个视窗裁(见下面的 JSX)
  const wrapStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, clipPath: wrapClip(view, sb, wrapW), display: globeOn ? 'none' : undefined };
  const screenStyle: CSSProperties = { clipPath: screenClip(view, sb, wrapW), display: globeOn ? 'none' : undefined };
  return (
    <div
      className={`app${narrow ? ' phone' : ' has-side'}${chron.open ? ' chron-open' : ''}${panelOpen ? ' panel-open' : ''}${narrow && panelOpen && panelUi.sheet === 'full' ? ' sheet-full' : ''}${narrow && !selState.sel && !upOn && panelUi.world === 'full' ? ' world-full' : ''}${narrow && panelUi.drag ? ' sheet-drag' : ''}${narrow && selState.sel && !panelOpen ? ' sheet-away' : ''}${!narrow && world && sideUi.collapsed && !sideUi.peek ? ' side-collapsed' : ''}${picking ? ' picking' : ''}${globeOn ? ' globe-on' : ''}${data ? '' : ' booting'}${home ? ' home' : ''}${draft ? ' draft' : ''}${studioOn ? ' studio-on' : ''}${fr ? ' studio-flat' : ''}${astOpen && !narrow && !home && !draft ? ' ast-open' : ''}${preview ? ' ast-preview' : ''}`}
      data-theme={theme}
      data-layer={mapLayer}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 地图铺满全屏(地形画布是页面上第一张 canvas:画面回归检查、截图脚本按它取图) */}
      <main
        ref={stageRef}
        className={`stage${terrainTool.on ? ' terrain-on' : ''}${upOn ? ' up-on' : ''}`}
        style={stagePos}
        onPointerDown={onPointerDown}
        onPointerDownCapture={(e) => {
          onTouchDownCapture(e);
          onMarkDownCapture(e);
        }}
        onPointerMove={onPointerMove}
        onPointerMoveCapture={(e) => {
          mouseAt.current = [e.clientX, e.clientY];
          onTouchMoveCapture(e);
          onMarkMoveCapture(e);
        }}
        onPointerUp={onPointerUp}
        onPointerUpCapture={(e) => {
          onTouchUpCapture(e);
          onMarkUpCapture(e);
        }}
        onPointerCancel={onPointerUp}
        onPointerCancelCapture={(e) => {
          onTouchUpCapture(e);
          onMarkUpCapture(e);
        }}
        onClick={onStageClick}
        onPointerLeave={() => {
          setHover(null);
          terrainMove(null);
          upMove(null);
        }}
        onDoubleClick={resetView}
      >
        {/* 地图分四层叠(见 mapWrap.ts 的"屏幕层"):和世界一样大的画布放在被 CSS 放大的地图框里,
            按屏幕像素画的(细节层、视窗装饰、文字层)放在不缩放的屏幕层里 */}
        <div className="canvas-wrap" style={wrapStyle}>
          <div className="map-box" data-wrap={curved ? undefined : '1'} data-proj={projection} style={{ width: box.w, height: box.h }}>
            <canvas ref={canvasRef} />
            {/* 右边接的那一份(左右无限拖动,见 mapWrap.ts;弯边投影时不用) */}
            <canvas ref={canvasCopyRef} className="wrap-copy" />
          </div>
        </div>
        <div className="screen-layer" style={screenStyle}>
          {/* 放大后的地形细节(弯边投影:按投影一行一行铺) */}
          {data && <TerrainDetail world={data.world} raster={data.raster} style={style} view={view} mp={mp} />}
          {data && <MapDecor world={data.world} style={style} view={view} mp={mp} />}
        </div>
        {/* 放大后的文明细节层(CivLayer 放进来):盖住下面的地形,在文明底图那一层地图框之下 */}
        <div className="screen-layer" ref={setCivDetailHost} style={screenStyle} />
        <div className="canvas-wrap-upper" style={wrapStyle}>
          <div className="map-box-upper" style={{ width: box.w, height: box.h }}>
            {data && (
              <CivLayer world={data.world} raster={data.raster} civ={civ} geo={shownRaw} style={style} view={view} mp={mp} labelsHost={labelsHost} detailHost={civDetailHost} flags={flagView} />
            )}
            <canvas ref={overlayRef} className={`overlay ${replayOn && replay ? 'show' : ''}`} />
            <canvas ref={overlayCopyRef} className={`overlay wrap-copy ${replayOn && replay ? 'show' : ''}`} />
            {data && !curved && (
              <TerrainOverlay width={data.world.width} height={data.world.height} shown={shownTerrain} shownSketch={shownSketch} wrap={wrapW} scale={(box.w / data.world.width) * view.k} />
            )}
          </div>
        </div>
        {/* 文字层(CivLayer 放进来);回放世界形成时、导入图片时藏起来(回放画面盖住文明层,字也不露出来;导入时只看图) */}
        <div className="screen-layer" ref={setLabelsHost} style={(replayOn && replay) || importing ? { ...screenStyle, display: 'none' } : screenStyle} />
        {/* 地形大事:涂的地方、会变的地块、会没了的城盖在地名上面(和地图一起缩放) */}
        {data && !curved && upOn && (
          <div className="canvas-wrap-upper" style={wrapStyle}>
            <div className="map-box-upper" style={{ width: box.w, height: box.h }}>
              <UpheavalOverlay civ={civ} world={data.world} wrap={wrapW} scale={(box.w / data.world.width) * view.k} />
            </div>
          </div>
        )}
        {/* 地图上钉在事发地的事件标签 */}
        {data && world && <EventPins civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} hidden={replayOn} />}
        {data && globeOn && (
          <Globe
            world={data.world}
            raster={data.raster}
            civ={civ}
            geo={shownRaw}
            style={style}
            layer={layer}
            terrain={canvasRef.current}
            terrainKey={terrainKey}
            replay={globeReplay}
            startLon={getMapCenter()}
            apiRef={globeApi}
            onHover={onGlobeHover}
            leftRoom={sideRoom(stageSize.w)}
            rightRoom={astOpen ? astRoom(stageSize.w) : 0}
          />
        )}
        {/* 作者标记(图钉、圈的州;地球仪上也画):在地名、地球仪上面 */}
        {data && world && <MarkLayer civ={civ} world={data.world} api={markApi} hidden={replayOn || draft || home} />}
        {/* 作者的人物一生的足迹(选中一个人物时;地球仪上也画):在标记上面 */}
        {data && world && <CharacterLayer civ={civ} world={data.world} raster={data.raster} api={markApi} hidden={replayOn || draft || home} />}
      </main>
      {/* 选干预目标 / 推演中:压暗地图、浮出名牌;选中国家:国都的圆环(TargetPlates.tsx) */}
      {data && world && <TargetLayer civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} resim={resim} generating={!!progress} labelAt={labelAt} />}

      {replayOn && replay && !home && (
        <div className="caption">
          <div className="big">{replay.idx === replay.frames.length - 1 ? '今天' : `约 ${replay.mya[replay.idx]} 百万年前`}</div>
          <div className="small">板块碰撞抬起山脉,河流一点点把它切开</div>
          <div className="track">
            <div style={{ width: `${((replay.idx + 1) / replay.frames.length) * 100}%` }} />
          </div>
        </div>
      )}

      {home ? (
        /* 我的世界:盖住整个页面(地图留在底下,回到刚才的世界不用重新生成) */
        landing ? (
          <ShareGone
            phone={narrow}
            state={landing}
            onHome={() => {
              setLanding(null);
              goHome();
            }}
            onNew={() => {
              setLanding(null);
              startDraft();
            }}
          />
        ) : (
          <MyWorlds phone={narrow} onOpen={openStored} onNew={startDraft} onOpenText={openText} />
        )
      ) : narrow ? (
        <>
          {/* 手机:底部的世界卡片(没选东西时;选中了东西换成详情卡片)、右上竖排的毛玻璃按钮(图层、地球);数据图层的图例在左上。
              界面都在卡片和毛玻璃按钮上,地图上不再压字、不用渐变遮罩;最近大事在世界卡片拉到顶时的列表里。
              新建时这些都不放(新建界面自己一套) */}
          {!draft && !selState.sel && !upOn && (
              <PhoneSheet
                data={data}
                civ={civ}
                raw={shownRaw}
                params={params}
                generating={!!progress}
                replay={{ on: replayOn, ready: !!replay }}
                onReplay={startReplay}
                onHome={goHome}
                exp={{ data, civ, plain: plainCiv, style, layer }}
              />
          )}
          {!draft && <PhoneButtons layers={{ ...layerProps, draft }} globeOn={globeOn} onToggleGlobe={toggleGlobe} marking={markable ? markPlacing : undefined} />}
          {!draft && style === 'data' && (
            <div className="corner-tl">
              <Legend layer={layer} />
            </div>
          )}
        </>
      ) : (
        <>
          {/* 宽屏:左边侧栏(世界 / 选中的东西的详情、搜索、存档);右上图层、导出、编年史;数据图层的图例在地图左上。新建时都不放(新建界面自己一套) */}
          {!draft && (
            <Sidebar
              data={data}
              civ={civ}
              raw={shownRaw}
              params={params}
              generating={!!progress}
              replay={{ on: replayOn, ready: !!replay }}
              onReplay={startReplay}
              onHome={goHome}
              inspectorSlot={inspectorSlot}
            />
          )}
          {!draft && <MapBar civ={civ} layers={layerProps} exp={{ data, civ, plain: plainCiv, style, layer }} draft={draft} />}
          {!draft && style === 'data' && !terrainTool.on && (
            <div className="corner-tl">
              <Legend layer={layer} />
            </div>
          )}
        </>
      )}
      {/* 新建世界:和平常页面分开的一套深色界面,盖在地图上面(创建以后展开成平常的地图、淡出) */}
      {studio}
      {/* 助手面板(宽屏右边一张卡片,手机是拉到顶的底部卡片;窗口跨过窄屏断点时不重新挂,没发出去的话留着)、在地图上看试推演时的提示条 */}
      {astOpen && aiOn && !home && !studioOn && data && realCiv && rawCiv && (
        <AssistantPanel phone={narrow} world={data.world} raster={data.raster} civ={realCiv} raw={rawCiv} lock={draft ? 'history' : 'terrain'} busy={worldBusy} />
      )}
      {world && <PreviewBanner busy={worldBusy} phone={narrow} />}
      {/* 顶部居中:提示条(同一时间只有一条) */}
      <ToastBar />
      {/* 右下(时间轴上方):地球 / 平面、放大、缩小。触屏不放 + −(用双指捏合);窄屏整个不放(地球在右上竖排的按钮里) */}
      <MapControls globeOn={globeOn} onToggleGlobe={toggleGlobe} onZoom={zoomButton} shifted={false} hidden={!data || narrow || home || draft} zoom={!coarse} marking={markable ? markPlacing : undefined} />
      {sharedOn ? <SharedHint phone={narrow} short={sharedFor.short} by={sharedFor.by} onOk={() => setSharedFor(null)} /> : <FirstHint show={hintOn && !!data && world && !terrainTool.on && !upOn} touch={coarse} />}
      {world && !narrow && <UpheavalHint />}
      {/* 底部:时间轴(宽屏是卡片右边那一块底下的胶囊;手机是浮在底部卡片上面的胶囊);新建时还没有历史,不放 */}
      <div className="bottom-row">
        <div className="bottom-tl">{data && world && <CivTimeline civ={civ} hidden={replayOn} dock="inline" />}</div>
      </div>
      {/* 详情面板:窄屏是从屏幕底升起的卡片(在这儿的空位里),宽屏在侧栏里(见上面的 inspectorHost) */}
      {data && world && createPortal(<Inspector civ={civ} raw={shownRaw} raster={data.raster} world={data.world} />, inspectorHost)}
      {narrow && world && <div className="inspector-slot" ref={inspectorSlot} />}
      {hover && world && <HoverCard info={hover.info} x={hover.x} y={hover.y} place={hover.place} />}
      {/* 世界概览(点左上角的世界名打开):国家 / 编年史 / 我的干预 / 世界设定 */}
      {world && (
        <WorldOverview
          params={params}
          data={data}
          civ={civ}
          generating={!!progress}
          resimBusy={!!resim}
          replay={{ on: replayOn, ready: !!replay }}
          onReplay={startReplay}
          onDraftFrom={draftFromCurrent}
        />
      )}
      {realCiv && <HistoryBook civ={realCiv} />}
      <AiSettingsHost />
      <AccountHost phone={narrow} />
      <ShortcutsHost />
      <TipLayer />
      {dropping && (
        <div className="drop-hint">
          <div>{dropping === 'image' ? '松手导入这张图' : '松手打开存档(.json)'}</div>
        </div>
      )}
    </div>
  );
}

/** 按下到松开移动不超过这么多(屏幕像素,横 + 竖)算单击 */
const CLICK_SLOP = 5;
/** 手指按下时总会抖一点:移动不超过这么多还算"点一下" */
const TOUCH_SLOP = 10;

/**
 * 只露出视窗(外框 ∩ 舞台)里的那一段 —— 主图和右边接的那一份在视窗外的部分裁掉,同一个地方不会出现两次。
 * clip-path 在地图层自己的坐标里(缩放、平移之前)。还没有世界时不裁
 */
function wrapClip(v: { k: number; x: number; y: number }, b: StageBox, wrap: number): string | undefined {
  if (!wrap || !b.sw || !b.bw) return undefined;
  const [wl, wr] = windowSpan(v.k, b);
  const l = (wl - v.x) / v.k;
  const r = b.sw - (wr - v.x) / v.k;
  return `inset(-100000px ${r}px -100000px ${l}px)`;
}

/** 屏幕层(不缩放,铺满舞台)按同一个视窗裁:舞台坐标 */
function screenClip(v: { k: number }, b: StageBox, wrap: number): string | undefined {
  if (!wrap || !b.sw || !b.bw) return undefined;
  const [wl, wr] = windowSpan(v.k, b);
  return `inset(0px ${b.sw - wr}px 0px ${wl}px)`;
}
