/**
 * 主线程 ↔ 计算线程的消息约定(RFC §6)。这是**唯一的**一份:worker.ts 实现它,client.ts 和界面照它发请求。
 *
 * 每条请求和每条回执都带 `requestId`(字符串,由 client.ts 发号),回执按它对上号 ——
 * 不再靠"消息的先后顺序"猜哪条回执属于哪条请求。`id` 是另一回事:
 * 它是**世界的编号**(每换一个世界加一),用来丢掉上一个世界过时的回执;两者不要混用。
 *
 * 错误:线程里抛出的异常原来只会变成线程的 error 事件(界面既看不到原因、进度条也停在那里),
 * 现在同时回一条 `{ type: 'error', requestId, error }` —— `error` 是可序列化的
 * (Error 本身过不了 structured clone 的规矩,见 SerializedError)。
 */
import type { World, WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { HistoryFrames } from '../gen/history';
import type { Civ } from '../gen/civ';
import type { Intervention, TerrainOp, Upheaval } from '../gen/edits';
import type { SketchEdit } from '../gen/sketch';
import type { UpheavalPreview } from '../gen/civ/upheaval';
import type { RasterPatch } from '../gen/rasterPatch';

/**
 * 一组参数 + 草图(没改地形的星球)的扩张节拍(gen/civ 的 planetTempo;null = 长不出文明),key = 这颗星球在线程里的键。
 * 线程推文明后回报给主线程,主线程下次生成、重推时带回来:线程被重开过也不用多生成一遍没改过的地形
 */
export interface TempoNote {
  key: string;
  tempo: number | null;
}

/**
 * 地形大事以后的一段世界(按年份先后;第 k 段 = 套上前 k + 1 件大事以后的)。key = 这一段在线程里的键(主图补丁按它对上);
 * world 不带网格(和原来的世界是同一套,主线程接上自己那份)、不带回放快照
 */
export interface EraWorld {
  key: string;
  world: World;
}

/** 推文明的请求里共有的:地形修改、草图、干预、地形大事、主线程记着的扩张节拍 */
export interface CivInput {
  params: WorldParams;
  terrain?: TerrainOp[];
  sketch?: SketchEdit;
  /** 地形大事(不给 = 没有) */
  upheavals?: Upheaval[];
  tempo?: TempoNote;
  /** 主线程已经有了的主图补丁("上一段的键>这一段的键");没给的才在后台铺 */
  have?: string[];
}

/** 可序列化的错误(Error 本身带着方法和原型链,过不了 structured clone) */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** 界面用的错误(RFC §30):界面不显示 error.toString(),按 code 和 recoverable 决定怎么说 */
export interface AppError {
  code: string;
  message: string;
  cause?: unknown;
  recoverable: boolean;
}

export type WorkerRequest =
  /**
   * 生成世界。terrain = 地形修改(不给 = 没改);sketch = 草图(不给 = 没画);interventions = 推文明时带上的干预(改地形重新生成时用;不给 = 没有);
   * tempo = 主线程记着的扩张节拍(星球对不上就不用)
   */
  | ({ type: 'generate'; requestId: string; id: number; scale: number; interventions?: Intervention[] } & CivInput)
  /** 回放帧。带上参数:线程被重开过、手里没有这个世界时,按参数重新生成(同参数 = 同世界) */
  | { type: 'history'; requestId: string; id: number; params: WorldParams; terrain?: TerrainOp[]; sketch?: SketchEdit }
  /**
   * 阶段 4 干预:只重推文明(世界已在线程里,不重新生成地形;线程被重开过就按参数重新生成)。
   * seq = 第几次重推(主线程只认最新的一次)
   */
  | ({ type: 'resim'; requestId: string; id: number; seq: number; interventions: Intervention[] } & CivInput)
  /** 试推演(助手用):和 resim 一样重推(同样带节拍),但只把结果交回去,主线程不换上它;tid = 第几次试推演 */
  | ({ type: 'trial'; requestId: string; id: number; tid: number; interventions: Intervention[] } & CivInput)
  /** 地形大事的预览:upheavals = 已经有的大事,在 year 那一年再加上 ops 会怎么样;pid = 第几次预览(主线程只认最新的) */
  | { type: 'upPreview'; requestId: string; id: number; pid: number; params: WorldParams; terrain?: TerrainOp[]; sketch?: SketchEdit; upheavals?: Upheaval[]; year: number; ops: TerrainOp[] };

/** 请求的类型名(回执按它分类) */
export type WorkerRequestType = WorkerRequest['type'];

/** 发号之前的请求:requestId 由 client.ts 加,节拍由 client.ts 按星球自动补上 */
export type RequestInput<T extends WorkerRequestType = WorkerRequestType> = Omit<Extract<WorkerRequest, { type: T }>, 'requestId' | 'tempo'>;

export type WorkerResponse =
  | { type: 'progress'; requestId: string; id: number; stage: string; pct: number }
  /** ms = 线程里花的时间(生成 + 文明 + 铺像素),genMs = 其中生成世界那一步;tempo = 这组参数的扩张节拍(知道的话);eras = 地形大事以后的各段世界(没有大事 = 不给) */
  | { type: 'done'; requestId: string; id: number; world: World; raster: Raster; civ: Civ; ms: number; genMs: number; tempo?: TempoNote; eras?: EraWorld[]; baseKey: string }
  | ({ type: 'history'; requestId: string; id: number } & HistoryFrames)
  /** 重推好的文明;ms = 线程里花的时间(含按参数重新生成世界);tempo、eras 同 done */
  | { type: 'civ'; requestId: string; id: number; seq: number; civ: Civ; ms: number; tempo?: TempoNote; eras?: EraWorld[]; baseKey: string }
  /** 试推演的结果;tempo 同 done */
  | { type: 'trial'; requestId: string; id: number; tid: number; civ: Civ; ms: number; tempo?: TempoNote }
  /** 一段的主图补丁:key 这一段比 prev 那一段(原来的世界或上一件大事以后)变了的那一块;null = 看不出变化 */
  | { type: 'eraPatch'; requestId: string; id: number; key: string; prev: string; patch: RasterPatch | null }
  /** 地形大事的预览;water = 加上这几笔以后各地块的海陆(0 陆地 / 1 海 / 2 湖) */
  | { type: 'upPreview'; requestId: string; id: number; pid: number; preview: UpheavalPreview; water: Uint8Array; ms: number }
  /** 这条请求失败了(线程里的异常);error 可序列化 */
  | { type: 'error'; requestId: string; id: number; error: SerializedError };

export type WorkerResponseType = WorkerResponse['type'];

/** 这条回执属于哪条请求(所有回执都带 requestId) */
export function requestIdOf(m: WorkerResponse): string {
  return m.requestId;
}

/** 回执要不要算"一件回音"(progress / eraPatch 是线程自己插播的,不算) */
export function countsAsReply(m: WorkerResponse): boolean {
  return m.type !== 'progress' && m.type !== 'eraPatch';
}

/** 异常 → 可序列化:{ name, message, stack? } */
export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    return { name: e.name || 'Error', message: e.message, ...(e.stack ? { stack: e.stack } : {}) };
  }
  return { name: 'Error', message: typeof e === 'string' ? e : JSON.stringify(e) ?? String(e) };
}

/** 可序列化的错误 → 界面错误;code 用来分类(线程里的异常 = worker:exception) */
export function appError(code: string, e: unknown, recoverable = true): AppError {
  const s = serializeError(e);
  return { code, message: s.message, cause: s, recoverable };
}
