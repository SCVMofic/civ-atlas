/**
 * "文明"显示开关和时间轴的共享状态:图层弹层里的开关(CivPanel.tsx)、时间轴 CivTimeline 改,地图上的 CivLayer、悬停信息读。
 * 放在这里而不是 App.tsx 里,这样以后加开关 / 时间轴时只改文明自己的文件。
 *
 * 网址参数(截图脚本用):
 *   civ=habitat,regions,sites,routes,cultures,polities,faiths,wars   直接打开对应显示;前面加减号是关掉,
 *                                               如 civ=-labels 关掉默认打开的地名、civ=-wars 关掉默认打开的战事
 *   civYear=1200                                时间轴停在第 1200 年(不给 = 结束年份);给了就不自动播放
 *   chron=1 / chron=all                         打开世界概览的编年史页(1 = 只看大事,all = 全部)
 *   play=0 / play=1                             打开网页时不自动播放 / 自动播放
 *                                               (不给:自动播放;无头浏览器(截图、冒烟检查)里默认不播,画面才固定)
 */
import { useSyncExternalStore } from 'react';
import { CIV_SHOW_DEFAULT, type CivShow } from '../render/civ/overlay';
import type { ChronicleEntry } from '../gen/civ/chronicle';

function fromUrl(): CivShow {
  const s: CivShow = { ...CIV_SHOW_DEFAULT };
  if (typeof location === 'undefined') return s;
  const v = new URLSearchParams(location.search).get('civ');
  if (!v) return s;
  for (const raw of v.split(/[,+ ]/)) {
    const off = raw.startsWith('-');
    const k = off ? raw.slice(1) : raw;
    if (k in s) s[k as keyof CivShow] = !off;
  }
  return s;
}

function store<T>(init: T) {
  let state = init;
  const subs = new Set<() => void>();
  const get = () => state;
  return {
    get,
    set(patch: Partial<T>) {
      state = { ...state, ...patch };
      for (const f of subs) f();
    },
    /** 不经过 React 直接订阅(编年史回放时只滚动列表、不重新渲染) */
    subscribe(f: () => void): () => void {
      subs.add(f);
      return () => subs.delete(f);
    },
    use(): T {
      return useSyncExternalStore(
        (f) => {
          subs.add(f);
          return () => subs.delete(f);
        },
        get,
        get,
      );
    },
  };
}

// ---- 显示开关 ----

const show = store<CivShow>(fromUrl());

export function getCivShow(): CivShow {
  return show.get();
}

export function setCivShow(patch: Partial<CivShow>) {
  show.set(patch);
}

export function useCivShow(): CivShow {
  return show.use();
}

// ---- 时间轴(1× / 4×、自动播放) ----

export type PlaySpeed = 1 | 4;

export interface CivTime {
  /** 时间轴停在哪一年;null = 结束年份("现在") */
  year: number | null;
  /** 正在自动播放 */
  playing: boolean;
  /** 正在拖动时间轴 */
  scrubbing: boolean;
  /** 这次播放是接着"回放世界形成"放的(从第 0 年放完一遍,不看 1× / 4×) */
  story: boolean;
  /** 播放速度:1× = 每秒 20 年,4× = 每秒 80 年(timelineLayout.ts 的 PLAY_RATE) */
  speed: PlaySpeed;
}

function yearFromUrl(): number | null {
  if (typeof location === 'undefined') return null;
  const v = new URLSearchParams(location.search).get('civYear');
  return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
}

const time = store<CivTime>({ year: yearFromUrl(), playing: false, scrubbing: false, story: false, speed: 1 });

export function getCivTime(): CivTime {
  return time.get();
}

export function setCivTime(patch: Partial<CivTime>) {
  time.set(patch);
}

export function useCivTime(): CivTime {
  return time.use();
}

/** 年份一变就调 f(不经过 React;回放时每帧都会调) */
export function subscribeCivTime(f: (t: CivTime) => void): () => void {
  return time.subscribe(() => f(time.get()));
}

/** 从某一年起按 1× 播放(干预重推完,App 从生效年份接着放) */
export function playFrom(year: number) {
  time.set({ year: Math.max(0, year), playing: true, scrubbing: false, story: false, speed: 1 });
}

/** 暂停(停在当前这一年;点开国家等详情时调) */
export function pausePlayback() {
  const t = time.get();
  if (t.playing || t.story) time.set({ playing: false, story: false });
}

/** 播放 / 暂停(时间轴上的播放键、空格):停在结束年份(放到头了)时从 restart 那一年重播 */
export function togglePlayback(end: number, restart: number) {
  const t = time.get();
  if (t.playing) return pausePlayback();
  const year = Math.min(end, Math.max(0, t.year ?? end));
  time.set({ playing: true, story: false, scrubbing: false, year: year >= end ? restart : year });
}

/** 往前 / 往后走 dy 年(时间轴上的方向键、← →;从显示的那一年算起),停下播放 */
export function stepYear(end: number, dy: number) {
  const t = time.get();
  const cur = Math.floor(Math.min(end, Math.max(0, t.year ?? end)));
  time.set({ year: Math.min(end, Math.max(0, cur + dy)), playing: false, story: false });
}

/**
 * 打开网页后第一次显示世界时,要不要自动播放(只问一次,之后都是 false):
 * 网址给了 civYear(看某一年)或 play=0 不播;play=1 一定播;无头浏览器(截图脚本、冒烟检查)里默认不播
 */
let autoplayAsked = false;
export function takeAutoplay(): boolean {
  if (autoplayAsked) return false;
  autoplayAsked = true;
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  const play = q.get('play');
  if (play === '0' || q.has('civYear')) return false;
  if (play === '1') return true;
  return !(typeof navigator !== 'undefined' && navigator.webdriver);
}

/** 自动播放:从 from 年起按 1× 放;还一个文明层都没开(网址也没指定 civ=)就打开"国家",看得见国界在变 */
export function startAutoplay(from: number) {
  const s = show.get();
  const civInUrl = typeof location !== 'undefined' && new URLSearchParams(location.search).has('civ');
  if (!s.cultures && !s.polities && !civInUrl) show.set({ polities: true });
  playFrom(from);
}

/** 回放世界形成开始:文明层先退回第 0 年(被地质回放的画面盖着),停止正在放的文明回放 */
export function prepareCivReplay() {
  time.set({ year: 0, playing: false, scrubbing: false, story: false });
}

/** 地质回放放完:接着放文明,从第 0 年到结束年份(CivTimeline 负责推进年份、打开"民族"和"国家"显示) */
export function startCivReplay() {
  time.set({ year: 0, playing: true, scrubbing: false, story: true });
}

/** 换了新世界:时间轴回到结束年份 */
export function resetCivTime() {
  time.set({ year: null, playing: false, scrubbing: false, story: false });
}

// ---- 编年史(阶段 3;是世界概览的一页,见 overviewStore.ts) ----

export interface ChronicleView {
  /**
   * 编年史开着 = 世界概览开在编年史页。setChronicle({ open: true }) 打开概览的编年史页、{ open: false } 收起
   * (overviewStore.ts 两边同步;新代码直接用 openOverview('chronicle', { polity }))
   */
  open: boolean;
  /** 只看大事 */
  major: boolean;
  /** 只看这个国家的事(null = 全部国家;编年史页顶上的国家下拉框、国家面板的"编年史"设它) */
  polity: number | null;
  /** 打开后滚到这一年(人物卡片的"编年史":滚到他在位 / 领兵那段;滚过去就清掉) */
  at?: number | null;
}

function chronFromUrl(): ChronicleView {
  const v = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('chron');
  return { open: !!v && v !== '0', major: v !== 'all', polity: null };
}

const chron = store<ChronicleView>(chronFromUrl());

export function getChronicle(): ChronicleView {
  return chron.get();
}

export function setChronicle(patch: Partial<ChronicleView>) {
  chron.set(patch);
}

export function useChronicle(): ChronicleView {
  return chron.use();
}

/** 编年史的开关 / 筛选一变就调 f(overviewStore.ts 用它把老的 setChronicle({ open }) 换成开关概览) */
export function subscribeChronicle(f: () => void): () => void {
  return chron.subscribe(f);
}

/** 只看这国的事(同时打开编年史);再点同一国取消 */
export function toggleChroniclePolity(id: number) {
  const c = chron.get();
  chron.set(c.polity === id ? { polity: null } : { polity: id, open: true });
}

/**
 * 地图高亮(点编年史的一条):事发的州(浓)、相关国家那一年的国土(淡),闪约两秒。
 * stamp 每次点都不同 —— 同一条点两次也重新闪、重新把地图平移过去。
 */
export interface CivHighlightState {
  regions: number[];
  polities: number[];
  year: number;
  stamp: number;
}

const highlight = store<{ h: CivHighlightState | null }>({ h: null });
let stamp = 0;

export function setCivHighlight(h: Omit<CivHighlightState, 'stamp'> | null) {
  highlight.set({ h: h ? { ...h, stamp: ++stamp } : null });
}

export function getCivHighlight(): CivHighlightState | null {
  return highlight.get().h;
}

export function useCivHighlight(): CivHighlightState | null {
  return highlight.use().h;
}

// ---- 点编年史的一条(编年史面板里的一行、时间轴上的大事刻度共用) ----

const pick = store<{ entry: ChronicleEntry | null; stamp: number }>({ entry: null, stamp: 0 });

/**
 * 点编年史的一条:时间轴跳到那一年并暂停,换到政区图层(宗教大事:正在信仰图层上就留在信仰图层),地图上闪烁高亮事发地
 * (事发地不在视野里时 App 把地图平移过去);编年史面板里这一条标成选中(战争自动展开,不在视野里就滚过去)。
 */
export function pickChronicleEntry(e: ChronicleEntry) {
  setCivTime({ year: e.year, playing: false, scrubbing: false, story: false });
  setCivShow(e.kind === 'faith' && getCivShow().faiths ? { polities: true } : { polities: true, cultures: false, faiths: false });
  setCivHighlight({ regions: e.regions, polities: e.polities, year: e.year });
  pick.set({ entry: e, stamp: pick.get().stamp + 1 });
}

/** 换了新世界:清掉上一个世界选中的那一条 */
export function clearChroniclePick() {
  if (pick.get().entry) pick.set({ entry: null });
}

/** 最近点的那一条(stamp 每点一次都不同,同一条点两次也算) */
export function useChroniclePick(): { entry: ChronicleEntry | null; stamp: number } {
  return pick.use();
}

// ---- 点选(阶段 4):地图上单击选中一个东西,详情面板(Inspector.tsx)显示它、在里面改名 ----

/**
 * 选中的东西(这个世界里的编号;改名不改编号,换世界时清掉):
 * 国家、城(含故城遗址)、地理实体(civ.places 的下标)、州(没点到别的东西时)、信仰(civ.religion.faiths 的下标)、
 * 人物(civ.people 的下标;点编年史、卡片、人物页里的人名选中,地图上亮出、飞到他的国家,见 flyTo.ts 的 mapTarget)、
 * 作者标记(AuthorMark.id,存在修改里、不在历史里,重推历史编号也不变;0 = 正在新建、还没存的那个,见 markStore.ts)、
 * 作者的人物(AuthorCharacter.id,同样存在修改里;0 = 正在新建的,见 characterStore.ts)
 */
export type MapSelection =
  | { kind: 'polity'; id: number }
  | { kind: 'settlement'; id: number }
  | { kind: 'place'; id: number }
  | { kind: 'region'; id: number }
  | { kind: 'faith'; id: number }
  | { kind: 'person'; id: number }
  | { kind: 'mark'; id: number }
  | { kind: 'character'; id: number };

export interface SelectionState {
  sel: MapSelection | null;
  /** 面板放在地图的哪一边(躲开点的地方):点在右半边 = 放左边 */
  side: 'left' | 'right';
}

const selection = store<SelectionState>({ sel: null, side: 'right' });

export function getSelection(): SelectionState {
  return selection.get();
}

/**
 * 内部更新标记:重推 remap、时间轴换段重新解析、助手预览自动选中这类**不是用户主动打开详情**的选中变化。
 * nav 的订阅器读它,决定不写历史(阶段 2 审查:内部状态更新不创建导航记录)。
 */
let internal = false;

/** 选中一个东西;side 不给 = 面板留在原来那一边。选中新的东西(看详情)时暂停播放 */
export function setSelection(sel: MapSelection | null, side?: 'left' | 'right') {
  if (sel && !sameSelection(sel, selection.get().sel)) pausePlayback();
  selection.set(side ? { sel, side } : { sel });
}

/** 同 `setSelection`,但标记为**内部更新**(不当作"用户打开详情",nav 不据此写历史) */
export function setSelectionSilent(sel: MapSelection | null, side?: 'left' | 'right') {
  internal = true;
  try {
    setSelection(sel, side);
  } finally {
    internal = false;
  }
}

/** 这次 selection 变化是不是内部更新(只在 setSelection 同步通知期间为 true) */
export function selectionIsInternal(): boolean {
  return internal;
}

export function clearSelection() {
  if (selection.get().sel) selection.set({ sel: null });
}

export function useSelection(): SelectionState {
  return selection.use();
}

/** 不经过 React 订阅选中的变化(sideStore.ts:侧栏收起时选中了东西,卡片弹出来) */
export function subscribeSelection(f: () => void): () => void {
  return selection.subscribe(f);
}

export function sameSelection(a: MapSelection | null, b: MapSelection | null): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id);
}
