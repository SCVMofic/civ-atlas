/**
 * 世界会话(WorldSession,RFC §3):**一个世界在运行时的那份真值** —— 它的编号、参数、身体(地形 + 像素 + 各段世界)、
 * 推演出来的文明、进度状态、生成 / 推演版本、错误。
 *
 * 为什么不在 React 里:这些数据不是"界面状态"。worker 的回执处理、存档、助手、以后的事件系统都要读写同一份真值,
 * 界面只是**订阅**它(useSyncExternalStore,和 ui/sideStore.ts、ui/panelStore.ts 一个路子)。
 * 这样一来,"世界是什么"和"世界正在生成"不再散落在根组件的十几个 useState / useRef 里。
 *
 * 谁负责什么:
 * - 会话负责:世界是谁(编号 / 参数 / 版本)、世界长什么样(body:world + raster + 各段世界 + civ)、
 *   地图上现在这份世界带着哪些修改(shownTerrain / shownSketch)、状态与错误
 * - 会话不负责:画图、投影、按钮、面板、选中、时间轴 —— 那些是界面的(见 App.tsx);试推演 / 助手预览也不改会话的真值
 * - 用户的修改(改名、干预、地形……)在 ui/editsStore.ts 里(那已经是个非 React 的 store):会话**不复制一份**,
 *   要读就读 getEdits()<br>—— RFC 里 WorldSession.edits 那一项在这个项目里由它承担
 *
 * 版本号的口径(和协议对齐,别自己发明计数):
 * - `worldId`:协议里的 `id`。每换一代加一(生成新世界、按新地形重新生成都算)。回执按它丢掉上一个世界的;
 *   RFC 里的 `generationVersion` 就是它 —— 这个项目里没有第二个"生成版本",再造一个就是形式主义
 * - `simulationVersion`:重推了几次(干预、地形大事)。回执按它丢掉不是最新的那一次(RFC 里的 simulationVersion)
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

/** 世界在做什么(RFC §3 的 status;试推演 / 助手预览不改会话的真值,所以这里没有 previewing) */
export type WorldStatus = 'idle' | 'generating' | 'resimulating' | 'ready' | 'error';

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
  status: WorldStatus;
  /** 最近一次失败(线程报错);成功后清掉 */
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
  status: 'idle',
  error: null,
};

let state: WorldSessionState = EMPTY;
const subs = new Set<() => void>();

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
  for (const f of [...subs]) f();
}

/**
 * 换一代:编号 +1(协议里的 id 用它),参数换成新的(不给 = 不动),状态 = generating。
 * **不清空 body / civ**:生成期间地图上还是上一张图,新的一到手再换(和以前一样)。
 * 返回新的编号 —— 发请求时带在 `id` 里。
 */
export function newGeneration(params?: WorldParams | null): number {
  const worldId = state.worldId + 1;
  set({ worldId, ...(params ? { params } : {}), status: 'generating', error: null });
  return worldId;
}

/** 世界生成完(worker 的 done):换上世界 + 像素 + 各段世界 + 文明,状态 = ready */
export function worldReady(body: WorldBody, civ: Civ, eras?: EraWorlds | null): void {
  set({ body, civ, eras: eras ?? null, status: 'ready', error: null });
}

/**
 * 作废正在算、还没回来的重推(换世界、改地形时):推演版本 +1,那些回执自然对不上号。
 * 状态不动 —— 调用方那边正在生成(newGeneration 已经设过)。
 */
export function invalidateSimulation(): number {
  const simulationVersion = state.simulationVersion + 1;
  set({ simulationVersion });
  return simulationVersion;
}

/** 重推开始:推演版本 +1,状态 = resimulating;返回这次是第几版 */
export function simulationStarted(): number {
  const simulationVersion = state.simulationVersion + 1;
  set({ simulationVersion, status: 'resimulating', error: null });
  return simulationVersion;
}

/** 重推完(worker 的 civ):换上文明,状态 = ready。`eras` 给了才动(不给 = 各段世界没变,别白白重算地图);null = 清掉 */
export function simulationReady(civ: Civ, eras?: EraWorlds | null): void {
  set({ civ, ...(eras === undefined ? {} : { eras }), status: 'ready' });
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

/** 出错了(线程报错、打不开这个世界):状态 = error,错误放着给界面说 */
export function sessionFailed(error: AppError): void {
  set({ status: 'error', error });
}

/** 清一下错误(重开一次生成时也会清) */
export function clearSessionError(): void {
  if (state.error) set({ error: null });
}

/** 测试用:回到刚开始的样子 */
export function _resetWorldSession(): void {
  set(EMPTY);
  subs.clear();
}
