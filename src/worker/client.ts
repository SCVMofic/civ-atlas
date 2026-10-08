/**
 * 世界计算服务(RFC §5):界面只跟它打交道,不直接 `new Worker` / `worker.postMessage`。
 *
 *   UI  →  WorldComputeService  →  计算线程(worker/worker.ts)
 *
 * 它管四件事:
 * - **发号**:每条请求带一个 `requestId`(r1、r2……),回执按它对上号 —— 不再靠消息先后来猜归属
 * - **取消**:`cancel(requestId)` 明确语义 = 放弃这次结果(回执到了也不采纳,`result` 以 compute:cancelled 失败);
 *   线程真正停下来的办法只有 `restart()` / `dispose()`(worker 中途无法打断,只能换一个)
 * - **换线程**:发 generate 时如果线程还在忙,直接终止再开一个(界面上连续改参数时只算最后一次),
 *   在跑的活按"世界换了"失败、排着的试推演作废
 * - **错误**:线程里的异常回一条可序列化的 error 回执,这里包成 AppError 交给界面 —— 而不是让进度条停在那里
 *
 * 计数的口径和以前一样:`progress` / `eraPatch` 是线程自己插播的,不算"一件回音"。
 * 扩张节拍(tempo)也在这里注入:请求不是 history / upPreview 时带上最近一次线程回报的节拍。
 */
import type { TempoNote, WorkerRequest, WorkerRequestType, WorkerResponse, RequestInput, AppError } from './protocol';
import { appError, countsAsReply } from './protocol';

/** 只用到 Worker 的这几样(测试里拿假线程替换) */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
}

export type JobState = 'pending' | 'cancelled' | 'settled';

export interface ComputeJob<T extends WorkerResponse = WorkerResponse> {
  readonly requestId: string;
  readonly kind: WorkerRequestType;
  /** 这条请求的结果;取消 / 换线程 / 线程报错都会以 AppError 失败 */
  readonly result: Promise<T>;
  readonly state: JobState;
  /** 放弃这次结果(回执到了也不采纳) */
  cancel(reason?: string): void;
}

/** 世界换了 / 线程被重开:在跑的活和排着的试推演都按它失败(和以前 trials 的措辞一致) */
export const WORLD_CHANGED = '世界换了,试推演作废';
/** 明确取消 */
export const CANCELLED = '已取消';

export interface ComputeServiceOptions {
  /** 造一个线程(默认 `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`) */
  createWorker?: () => WorkerLike;
  /** 回执总入口(progress / eraPatch / upPreview / done / civ / history / error 都从这里过一遍) */
  onReply?: (m: WorkerResponse) => void;
  /** 线程自己出错(createWorker 之后构造失败、worker 的 error 事件) */
  onError?: (e: AppError) => void;
}

interface Pending {
  requestId: string;
  kind: WorkerRequestType;
  resolve: (m: WorkerResponse) => void;
  reject: (e: AppError) => void;
}

export class WorldComputeService {
  private worker: WorkerLike | null = null;
  /** 发号器:r1、r2……(断开线程也不重置,编号在会话里唯一) */
  private seq = 0;
  /** requestId → 还没回音、等着兑现的活(只用来对上号) */
  private pending = new Map<string, Pending>();
  /** requestId → 这件活现在的状态(给调用方看;兑现完还留着,便于查"刚才那件到底怎么了") */
  private states = new Map<string, JobState>();
  private replies: ((m: WorkerResponse) => void)[] = [];
  private errors: ((e: AppError) => void)[] = [];
  private create: () => WorkerLike;
  /** 发给当前线程、还没回音的活有几件(progress / eraPatch 不算) */
  private busyCount = 0;
  private tempoNote: TempoNote | null = null;

  constructor(opts: ComputeServiceOptions = {}) {
    this.create = opts.createWorker ?? defaultCreateWorker;
    if (opts.onReply) this.replies.push(opts.onReply);
    if (opts.onError) this.errors.push(opts.onError);
  }

  /** 发给当前线程、还没回音的活有几件 */
  get busy(): number {
    return this.busyCount;
  }

  /** 线程回报的扩张节拍(改过地形的世界推文明要用);下面发请求时自动带上 */
  get tempo(): TempoNote | null {
    return this.tempoNote;
  }

  set tempo(note: TempoNote | null) {
    this.tempoNote = note;
  }

  /** 回执总入口;返回退订函数 */
  onReply(fn: (m: WorkerResponse) => void): () => void {
    this.replies.push(fn);
    return () => {
      const i = this.replies.indexOf(fn);
      if (i >= 0) this.replies.splice(i, 1);
    };
  }

  onError(fn: (e: AppError) => void): () => void {
    this.errors.push(fn);
    return () => {
      const i = this.errors.indexOf(fn);
      if (i >= 0) this.errors.splice(i, 1);
    };
  }

  // ---- 五件活(请求类型 → 回执类型一一对应) ----

  generate(input: RequestInput<'generate'>): ComputeJob<Extract<WorkerResponse, { type: 'done' }>> {
    return this.submit<'done'>(input);
  }

  resimulate(input: RequestInput<'resim'>): ComputeJob<Extract<WorkerResponse, { type: 'civ' }>> {
    return this.submit<'civ'>(input);
  }

  trial(input: RequestInput<'trial'>): ComputeJob<Extract<WorkerResponse, { type: 'trial' }>> {
    return this.submit<'trial'>(input);
  }

  history(input: RequestInput<'history'>): ComputeJob<Extract<WorkerResponse, { type: 'history' }>> {
    return this.submit<'history'>(input);
  }

  previewUpheaval(input: RequestInput<'upPreview'>): ComputeJob<Extract<WorkerResponse, { type: 'upPreview' }>> {
    return this.submit<'upPreview'>(input);
  }

  /**
   * 发一件活。generate 会先把还在忙的线程换掉(见 restart);
   * 返回的 job 用 requestId 对上号,`result` 在对应的回执到达时兑现。
   */
  private submit<C extends WorkerResponse['type']>(input: RequestInput): ComputeJob<Extract<WorkerResponse, { type: C }>> {
    if (input.type === 'generate') this.restart(WORLD_CHANGED);
    const svc = this;
    const requestId = `r${++this.seq}`;
    const worker = this.ensure();
    const req: WorkerRequest = { ...input, requestId, ...(this.tempoFor(input) as object) } as WorkerRequest;
    const result = new Promise<Extract<WorkerResponse, { type: C }>>((resolve, reject) => {
      this.pending.set(requestId, {
        requestId,
        kind: input.type,
        resolve: (m) => resolve(m as Extract<WorkerResponse, { type: C }>),
        reject,
      });
      this.states.set(requestId, 'pending');
    });
    const job: ComputeJob<Extract<WorkerResponse, { type: C }>> = {
      requestId,
      kind: input.type,
      result,
      get state(): JobState {
        return svc.states.get(requestId) ?? 'settled';
      },
      cancel: (reason?: string) => svc.cancel(requestId, reason),
    };
    // 没人接住也不会变成"未处理的 promise 拒绝"(该提示的走 onError / 界面自己接)
    result.catch(() => {});
    this.busyCount++;
    worker.postMessage(req);
    return job;
  }

  /** 放弃这次结果:回执到了也不采纳(线程本身还在算,真要停下来用 restart / dispose) */
  cancel(requestId: string, reason = CANCELLED): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    this.states.set(requestId, 'cancelled');
    p.reject(appError('compute:cancelled', reason));
  }

  /** 放弃所有还没回音的活 */
  cancelAll(reason = CANCELLED): void {
    for (const id of [...this.pending.keys()]) this.cancel(id, reason);
  }

  /**
   * 世界换了:线程还在忙就终止它再开一个新的(启动只要几十毫秒),在跑的活按 reason 失败;
   * 不忙就什么都不做(短活不打断,排在后面 —— 打断了线程手上的世界就没了,得按参数重新生成,反而更慢)
   */
  restart(reason: string = WORLD_CHANGED): void {
    if (!this.worker || this.busyCount === 0) return;
    this.killWorker(reason);
  }

  /** 主线程不再用这个服务了(组件卸载) */
  dispose(): void {
    this.killWorker('页面关掉了');
    this.replies.length = 0;
    this.errors.length = 0;
  }

  // ---- 内部 ----

  /** 终止当前线程:在跑的活全部按 reason 失败 */
  private killWorker(reason: string): void {
    const w = this.worker;
    this.worker = null;
    this.busyCount = 0;
    for (const id of [...this.pending.keys()]) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      this.states.set(id, 'cancelled');
      p.reject(appError('worker:replaced', reason));
    }
    if (w) w.terminate();
  }

  private reportError(e: AppError): void {
    for (const f of [...this.errors]) f(e);
  }

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    let w: WorkerLike;
    try {
      w = this.create();
    } catch (e) {
      this.reportError(appError('worker:unavailable', e, false));
      throw e;
    }
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (this.worker !== w) return; // 已被换掉的线程
      this.handle(e.data);
    };
    this.worker = w;
    this.busyCount = 0;
    return w;
  }

  private handle(m: WorkerResponse): void {
    if (!m || typeof m.type !== 'string' || typeof m.requestId !== 'string') {
      // 线程不该发出不带 requestId 的消息;发出来了 = 版本对不上,明确报错而不是猜
      this.reportError(appError('protocol:bad-message', `计算线程发了一条看不懂的回执:${JSON.stringify(m)}`, false));
      return;
    }
    if (countsAsReply(m)) this.busyCount = Math.max(0, this.busyCount - 1);
    if ((m.type === 'done' || m.type === 'civ' || m.type === 'trial') && m.tempo) this.tempoNote = m.tempo;
    const p = this.pending.get(m.requestId);
    if (m.type === 'error') {
      const err: AppError = { code: 'worker:exception', message: m.error.message, cause: m.error, recoverable: true };
      if (p) {
        this.pending.delete(m.requestId);
        this.states.set(m.requestId, 'settled');
        p.reject(err);
      }
      this.reportError(err);
      return;
    }
    // 总入口先过一遍(界面按 id / seq / pid 丢过时的回执),再兑现给等着的那条请求
    for (const f of [...this.replies]) f(m);
    if (!p) return; // 已经被取消 / 换线程丢掉的活:不给它兑现
    if (expects(p.kind, m.type)) {
      this.pending.delete(m.requestId);
      this.states.set(m.requestId, 'settled');
      p.resolve(m);
    }
  }

  /** 发请求时补的节拍:history / upPreview 不带(和以前 send 的口径一致) */
  private tempoFor(input: RequestInput): Partial<Record<'tempo', TempoNote>> {
    if (input.type === 'history' || input.type === 'upPreview') return {};
    return this.tempoNote ? { tempo: this.tempoNote } : {};
  }
}

/** 请求类型 → 兑现它的回执类型 */
function expects(kind: WorkerRequestType, type: WorkerResponse['type']): boolean {
  return (
    (kind === 'generate' && type === 'done') ||
    (kind === 'resim' && type === 'civ') ||
    (kind === 'trial' && type === 'trial') ||
    (kind === 'history' && type === 'history') ||
    (kind === 'upPreview' && type === 'upPreview')
  );
}

/** 默认:模块线程(Vite 按这条 URL 单独打包 worker.ts) */
function defaultCreateWorker(): WorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
