/**
 * 世界会话(WorldSession,RFC §3):**一个世界在运行时的那份真值** —— 它的编号、参数、身体(地形 + 像素 + 各段世界)、
 * 推演出来的文明、正在算的那件活、生成 / 推演版本、错误。
 *
 * 为什么不在 React 里:这些数据不是"界面状态"。worker 的回执处理、存档、助手、以后的事件系统都要读写同一份真值,
 * 界面只是**订阅**它(useSyncExternalStore,和 ui/sideStore.ts、ui/panelStore.ts 一个路子)。
 * 这样一来,"世界是什么"和"世界正在算什么"不再散落在根组件的十几个 useState / useRef 里。
 *
 * 谁负责什么:
 * - 会话负责:世界是谁(编号 / 参数 / 版本)、世界长什么样(body:world + raster + 各段世界 + civ)、
 *   地图上现在这份世界带着哪些修改(shownTerrain / shownSketch)、**正式世界正在算哪件活**(task)、状态与错误
 * - 会话不负责:画图、投影、按钮、面板、选中、时间轴 —— 那些是界面的(见 App.tsx)
 * - 用户的修改(改名、干预、地形……)在 ui/editsStore.ts 里(那已经是个非 React 的 store):会话**不复制一份**,
 *   要读就读 getEdits()<br>—— RFC 里 WorldSession.edits 那一项在这个项目里由它承担
 *
 * 任务的两种:
 * - **正式世界的活**(task):生成、改地形重新生成、干预 / 地形大事重推。它们改变这份世界的真值,
 *   所以登记进会话 —— 界面靠它知道"现在能不能操作";失败 / 取消 / 被顶掉时都有确定的收尾
 * - **临时活**:助手试推演、地形大事"会怎么样"预览、回放帧。它们算完只交回一份结果,
 *   **不改**正式世界的真值,也不许把状态写成 resimulating;它们的生命周期由调用方(ui/assistantStore.ts、upheavalStore.ts、App)管
 *
 * 版本号的口径(和协议对齐,别自己发明计数):
 * - `worldId`:协议里的 `id`。每换一代加一(生成新世界、按新地形重新生成都算)。回执按它丢掉上一个世界的;
 *   RFC 里的 `generationVersion` 就是它 —— 这个项目里没有第二个"生成版本",再造一个就是形式主义
 * - `simulationVersion`:重推了几次(干预、地形大事)。回执按它丢掉不是最新的那一次(RFC 里的 simulationVersion)
 *
 * 状态由数据推出来(`statusOf`),不是各写各的:`task` 在 → generating / resimulating;
 * 没有任务而有 error → error;有世界 → ready;什么都没有 → idle。写任何字段都会重算一遍,所以不会漂。
 *
 * 纯状态 + 订阅,不碰 DOM;Node 里可测(tests/world-session.test.ts)。
 */
import { useSyncExternalStore } from 'react';
import type { World, WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ';
import type { TerrainOp } from '../gen/edits';
import type { SketchEdit } from '../gen/sketch';
import type { AppError } from '../worker/protocol';

/** 世界在做什么(RFC §3 的 status)。由 task / error / body 推出来,别直接写 */
export type WorldStatus = 'idle' | 'generating' | 'resimulating' | 'ready' | 'error';

/** 正式世界的活:生成新世界 / 按新地形重新生成 / 带着干预(或地形大事)重推 */
export type WorldTaskKind = 'generate' | 'regenerate' | 'resimulate';

/** 正在算的那件活。requestId = 那条请求的号(client.ts 发的),回执按它对上号 */
export interface WorldTask {
  kind: WorldTaskKind;
  requestId: string;
  /** 重推从哪一年起变(只有 resimulate 有;界面用它把时间轴停在那一带) */
  year?: number;
  /** 什么时候开始的(performance.now;界面按它估进度) */
  since: number;
}

/** 世界的身体:生成出来的那一份地形 + 铺好的像素 */
export interface WorldBody {
  world: World;
  raster: Raster;
}

/**
 * 地形大事以后各段的世界(结构和 ui/eras.ts 的 EraMaps 一致)。
 * 这里按结构写、不从 ui/ import:会话不该依赖界面。
 */
export interface EraWorlds {
  baseKey: string;
  keys: string[];
  worlds: World[];
}

export interface WorldSessionState {
  /** 世界的编号(协议里的 id);每换一代加一 */
  worldId: number;
  /** 重推了几次(协议里的 seq / 会话里的 simulationVersion) */
  simulationVersion: number;
  /** 当前这个世界的参数(还没开世界 = null) */
  params: WorldParams | null;
  /** 生成出来的世界 + 像素;换世界时旧的一直留到新的回来(生成期间地图上还是上一张图) */
  body: WorldBody | null;
  /** 地形大事以后各段的世界(没有大事 = null) */
  eras: EraWorlds | null;
  /** 推演出来的文明(改名之前的原始那份) */
  civ: Civ | null;
  /** 地图上现在这个世界带着的地形修改 */
  shownTerrain: readonly TerrainOp[];
  /** 地图上现在这个世界照着哪张草图 */
  shownSketch: SketchEdit | undefined;
  /** 正式世界正在算的那件活(没在算 = null)。界面"能不能操作"就看它 */
  task: WorldTask | null;
  /** 由 task / error / body 推出来的状态 */
  status: WorldStatus;
  /** 最近一次失败(线程崩了、算炸了);下一件活开始或算成时清掉 */
  error: AppError | null;
}

const EMPTY: WorldSessionState = {
  worldId: 0,
  simulationVersion: 0,
  params: null,
  body: null,
  eras: null,
  civ: null,
  shownTerrain: [],
  shownSketch: undefined,
  task: null,
  status: 'idle',
  error: null,
};

let state: WorldSessionState = EMPTY;
const subs = new Set<() => void>();

/** 状态从数据里推出来:这样"会话说在算什么"和"界面看到的忙碌"不会有第二份说法 */
function statusOf(s: WorldSessionState): WorldStatus {
  if (s.task) return s.task.kind === 'resimulate' ? 'resimulating' : 'generating';
  if (s.error) return 'error';
  return s.body ? 'ready' : 'idle';
}

export function getWorldSession(): WorldSessionState {
  return state;
}

export function useWorldSession(): WorldSessionState {
  return useSyncExternalStore(subscribeWorldSession, getWorldSession, getWorldSession);
}

export function subscribeWorldSession(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** 换一份状态(字段没变就不通知);会话是唯一的写入点,外面只经下面这些动作改 */
function set(patch: Partial<WorldSessionState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof WorldSessionState)[]) {
    if (state[k] !== patch[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  state.status = statusOf(state);
  for (const f of [...subs]) f();
}

/**
 * 换一代:编号 +1(协议里的 id 用它),参数换成新的(不给 = 不动)。
 * **不清空 body / civ / task**:生成期间地图上还是上一张图,新的一到手再换。
 * 返回新的编号 —— 发请求时带在 `id` 里。
 */
export function newGeneration(params?: WorldParams | null): number {
  const worldId = state.worldId + 1;
  set({ worldId, ...(params ? { params } : {}) });
  return worldId;
}

/**
 * 一件正式世界的活开始了(生成 / 重新生成 / 重推):登记任务,状态跟着变成 generating / resimulating。
 * `requestId` 是 client.ts 发号的;算完(或失败)时按它收尾 —— 只有当前这一件能收尾。
 */
export function beginWorldTask(kind: WorldTaskKind, requestId: string, year?: number): void {
  set({ task: { kind, requestId, ...(year !== undefined ? { year } : {}), since: performance.now() }, error: null });
}

/**
 * 一件正式世界的活收尾了:是当前这一件才清(返回 true);已经被新的一代顶掉了就不动(返回 false),
 * 免得把接手的那件活的忙碌状态误清了。
 */
export function endWorldTask(requestId: string): boolean {
  if (state.task?.requestId !== requestId) return false;
  set({ task: null });
  return true;
}

/** 重推开始:推演版本 +1(请求里要带它,回执按它丢过时的);返回新的版本号 */
export function nextSimulationVersion(): number {
  const simulationVersion = state.simulationVersion + 1;
  set({ simulationVersion });
  return simulationVersion;
}

/**
 * 作废正在算、还没回来的重推(换世界、改地形时):推演版本 +1,那些回执自然对不上号。
 * 任务不在这里动 —— 换世界 / 重新生成自己会登记新的那一件。
 */
export function invalidateSimulation(): number {
  const simulationVersion = state.simulationVersion + 1;
  set({ simulationVersion });
  return simulationVersion;
}

/**
 * 世界生成完(worker 的 done):换上世界 + 像素 + 各段世界 + 文明,并结束这件活。
 * **只认当前这件活的回执**(requestId 对得上才落地,返回 true):过时的 / 没人认的回执不改变真值。
 */
export function worldReady(body: WorldBody, civ: Civ, eras: EraWorlds | null, requestId: string): boolean {
  if (state.task?.requestId !== requestId) return false;
  set({ body, civ, eras, task: null, error: null });
  return true;
}

/**
 * 重推完(worker 的 civ):换上文明,并结束这件活。`eras` 给了才动
 * (不给 = 各段世界没变,别白白重算地图);null = 清掉。同样只认当前这件活。
 */
export function simulationReady(civ: Civ, eras: EraWorlds | null | undefined, requestId: string): boolean {
  if (state.task?.requestId !== requestId) return false;
  set({ civ, ...(eras === undefined ? {} : { eras }), task: null, error: null });
  return true;
}

/** 各段世界换了(交回来的时候不一定跟着新的文明) */
export function erasReady(eras: EraWorlds | null): void {
  set({ eras });
}

/** 地图上现在这份世界带着哪些修改(改地形、画草图、换段) */
export function setShownEdits(terrain: readonly TerrainOp[], sketch: SketchEdit | undefined): void {
  set({ shownTerrain: terrain, shownSketch: sketch });
}

/** 当前世界的参数换一份(打开同一个世界、参数一样时也会走一次:和新的一份对象对上) */
export function setSessionParams(params: WorldParams): void {
  set({ params });
}

/** 出错了(线程崩了、算炸了、打不开这个世界):状态 = error,错误放着给界面说 */
export function sessionFailed(error: AppError): void {
  set({ error });
}

/** 清一下错误(下一件活开始时也会清) */
export function clearSessionError(): void {
  if (state.error) set({ error: null });
}

/** 测试用:回到刚开始的样子 */
export function _resetWorldSession(): void {
  state = EMPTY;
  subs.clear();
  state.status = statusOf(state);
}
