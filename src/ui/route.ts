/**
 * 网址 → 要打开的世界(RFC TASK-003:从 App.tsx 顶上搬出来的那一块)。
 *
 * 这一块管的是"打开网页时看哪个世界"和"把当前世界写回网址":
 *
 *   readUrl()        网址上的 query / # → 参数、画风、图层、投影、分享码、生成器版本
 *   firstRoute()     打开网页时去哪:分享短链接 / 分享链接 / w=世界编号 / new=1 / 带种子的网址 / 我的世界
 *   Target           一个"要打开的世界":参数 + 用户的修改 + 投影 + 出处(生成完按它套上修改、交给自动存)
 *   writeWorldUrl()  把当前世界写进网址(别人打开是同一颗星球);writeHomeUrl() 回到"我的世界"
 *   writeLayerUrl()  换了图层写进网址(旧链接的 style= / civ= 照旧认)
 *   storyOk()        创建完要不要从第 0 年起放一遍历史(网址给了 play=,无头浏览器里不放)
 *
 * 纯函数:只依赖 imports 和 location / history,不碰 React,也不碰 DOM 的其余部分
 * (stageStore / saveStore 是模块级的 store,本来就能在组件外读)。
 */
import { DEFAULT_PARAMS, type WorldParams } from '../gen/world';
import { EMPTY_EDITS, GENERATOR_VERSION, type WorldEdits } from '../gen/edits';
import { GEN_KEY, isShareHash, type SaveFile, type SaveOrigin, type SaveView, worldKey } from '../gen/savefile';
import { GLOBE_READY, isMapProjection, type MapProjection } from './projection';
import { LAYERS, type LayerId } from '../render/layers';
import { layerDef, layerFromUrl, type MapLayer, type Style } from './mapLayers';
import { wrapLon } from '../render/projection';
import { isStored, isWorldId, legacyWorld, loadWorld, newWorldId, type StoredWorld, type WorldKind } from './saveStore';
import { OWN_KEY } from './oldSite';
import type { DraftBase, Stage } from './stageStore';

export function readUrl() {
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
export function writeLayerUrl(id: MapLayer) {
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
export interface Target {
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
export function randomSeedValue(): number {
  return Math.floor(Math.random() * 999999) + 1;
}

/** 新建中的世界现在的样子(参数、修改、名字),比较动没动过用 */
export function draftSig(params: WorldParams, edits: WorldEdits, title?: string): string {
  return JSON.stringify([worldKey(params), edits, title ?? '']);
}

/** 一个新建中的世界(还没动过) */
export function draftTarget(params: WorldParams, base: DraftBase | null = null, edits: WorldEdits = EMPTY_EDITS, title?: string): Target {
  return { id: newWorldId(), kind: 'draft', params, edits, pristine: true, base, title };
}

/** 存着的一个世界(刷新页面回到它时投影照网址,不换) */
export function storedTarget(w: StoredWorld, from: 'stored' | 'restore'): Target {
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
export function firstRoute(init: ReturnType<typeof readUrl>): { stage: Stage; target: Target | null } {
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

/** 把世界写进网址:种子 + 参数(和默认值相同的省略,别人打开是同一颗星球);存着的加 w=编号,新建中还没存的加 new=1 */
export function writeWorldUrl(t: Target) {
  const q = new URLSearchParams(location.search);
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) {
    if (k === 'seed' || t.params[k] !== DEFAULT_PARAMS[k]) q.set(k, String(t.params[k]));
    else q.delete(k);
  }
  q.delete('w');
  q.delete('new');
  q.delete('s');
  q.delete(OWN_KEY);
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
export function writeHomeUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of [...Object.keys(DEFAULT_PARAMS), 'w', 'new', 's', GEN_KEY, 'civYear', 'play', 'chron']) q.delete(k);
  const rest = q.toString();
  history.replaceState(null, '', rest ? `?${rest}` : location.pathname);
}

/** 创建完要不要从第 0 年起放一遍历史(网址给了 play=0、无头浏览器里不放;play=1 一定放) */
export function storyOk(): boolean {
  const play = new URLSearchParams(location.search).get('play');
  if (play === '0') return false;
  if (play === '1') return true;
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

