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
 * - **错误**:三种故障都有确定的终态,任何一个已提交的任务都不会永远挂着:
 *     1. 线程里的某条请求抛异常 → 线程回一条可序列化的 error 回执 → 那条活失败(界面能说明白)
 *     2. 线程**整体崩掉**(没接住的异常 / 回执过不了序列化 / postMessage 同步抛错)→ 线程作废,
 *        在跑的活全部按 worker:crashed 失败;下一次请求会另起一个线程,**不自动重放**(有副作用的活不重来)
 *     3. 世界换了 / 服务销毁 → 在跑的活按 worker:replaced / worker:disposed 失败 —— 这些是**正常收尾**,
 *        用 isTaskCancellation() 一眼分辨,界面不该当成故障提示
 *
 * "还在忙"只有一个口径:`busy` = 还没拿到终态回执的请求数(pending 表的大小)。
 * progress / eraPatch 是线程插播的,不算一件回音;重复的终态回执、认不出的 requestId 都不会扰动别的活。
 * 扩张节拍(tempo)也在这里注入:请求不是 history / upPreview 时带上最近一次线程回报的节拍。
 */
import type { TempoNote, WorkerRequest, WorkerRequestType, WorkerResponse, RequestInput, AppError } from './protocol';
import { appError, countsAsReply } from './protocol';

/** 只用到 Worker 的这几样(测试里拿假线程替换) */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  /** 线程里没接住的异常(线程级故障);环境不支持时可以没有 */
  onerror?: ((e: unknown) => void) | null;
  /** 线程发来的回执过不了 structured clone(序列化失败) */
  onmessageerror?: ((e: unknown) => void) | null;
}

export type JobState = 'pending' | 'settled' | 'cancelled' | 'failed';

export interface ComputeJob<T extends WorkerResponse = WorkerResponse> {
  readonly requestId: string;
  readonly kind: WorkerRequestType;
  /** 这条请求的结果;取消 / 换线程 / 线程崩了 / 发不出去都会以 AppError 失败(永远不会一直等着) */
  readonly result: Promise<T>;
  readonly state: JobState;
  /** 放弃这次结果(回执到了也不采纳) */
  cancel(reason?: string): void;
}

/** 世界换了 / 线程被重开:在跑的活按它失败(和以前 trials 的措辞一致) */
export const WORLD_CHANGED = '世界换了,试推演作废';
/** 明确取消 */
export const CANCELLED = '已取消';

/** 这些不是故障,是正常收尾(换世界、关掉服务、自己取消):界面不该弹"出错了" */
export function isTaskCancellation(e: AppError): boolean {
  return e.code === 'worker:replaced' || e.code === 'worker:disposed' || e.code === 'compute:cancelled';
}

export interface ComputeServiceOptions {
  /** 造一个线程(默认 `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`) */
  createWorker?: () => WorkerLike;
  /** 回执总入口(progress / eraPatch / upPreview / done / civ / history / error 都从这里过一遍) */
  onReply?: (m: WorkerResponse) => void;
  /** 出错(线程里的异常、线程崩了、造线程失败)。取消类的收尾不走这里,免得界面把正常收尾当故障 */
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
  /** requestId → 还没拿到终态回执的活;`busy` 就是它的大小 */
  private pending = new Map<string, Pending>();
  /** requestId → 这件活现在的状态(给调用方看;终态之后还留着,便于查"刚才那件到底怎么了") */
  private states = new Map<string, JobState>();
  private replies: ((m: WorkerResponse) => void)[] = [];
  private errors: ((e: AppError) => void)[] = [];
  private create: () => WorkerLike;
  private disposed = false;
  private tempoNote: TempoNote | null = null;

  constructor(opts: ComputeServiceOptions = {}) {
    this.create = opts.createWorker ?? defaultCreateWorker;
    if (opts.onReply) this.replies.push(opts.onReply);
    if (opts.onError) this.errors.push(opts.onError);
  }

  /** 还没拿到终态回执的活有几件(progress / eraPatch 不算) */
  get busy(): number {
    return this.pending.size;
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
   * **不发异常**:发不出去(线程起不来、postMessage 抛错、服务已经销毁)也是一件有终态的活 ——
   * `result` 以 AppError 失败,onError 也说一声,调用方不必再包一层 try。
   */
  private submit<C extends WorkerResponse['type']>(input: RequestInput): ComputeJob<Extract<WorkerResponse, { type: C }>> {
    if (input.type === 'generate') this.restart(WORLD_CHANGED);
    const svc = this;
    const requestId = `r${++this.seq}`;
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
    try {
      if (this.disposed) throw new Error('计算服务已经关掉了');
      const req: WorkerRequest = { ...input, requestId, ...(this.tempoFor(input) as object) } as WorkerRequest;
      this.ensure().postMessage(req);
    } catch (e) {
      // 发不出去:这条活当场失败,请求记录和忙碌计数都不留(线程没崩就留着,下一条还能用)
      const err = appError('worker:unavailable', e, true);
      const p = this.pending.get(requestId);
      this.pending.delete(requestId);
      this.states.set(requestId, 'failed');
      p?.reject(err);
      this.reportError(err);
    }
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
    if (!this.worker || this.pending.size === 0) return;
    this.killWorker(reason, 'worker:replaced');
  }

  /** 主线程不再用这个服务了(组件卸载):在跑的活一起失败,之后不再起线程 */
  dispose(): void {
    this.disposed = true;
    this.killWorker('页面关掉了', 'worker:disposed');
    this.replies.length = 0;
    this.errors.length = 0;
  }

  // ---- 内部 ----

  /** 线程没了(崩了 / 被换掉 / 服务关掉):在跑的活全部按 code 失败,记录和计数一起清干净 */
  private killWorker(reason: string, code: string, state: JobState = 'cancelled'): void {
    const w = this.worker;
    this.worker = null;
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const p of pend) {
      this.states.set(p.requestId, state);
      p.reject(appError(code, reason));
    }
    if (w) {
      try {
        w.terminate();
      } catch {
        /* 关不掉也接着走:引用已经摘掉,后面的回执不会再采纳 */
      }
    }
  }

  /** 线程整体崩了:作废当前线程,在跑的活按 worker:crashed 失败;下一条请求会另起一个(不自动重放) */
  private crash(reason: string, cause: unknown): void {
    if (this.disposed) return;
    const err = appError('worker:crashed', cause ?? reason, true);
    this.killWorker(reason, 'worker:crashed', 'failed');
    this.reportError(err);
  }

  private reportError(e: AppError): void {
    if (this.disposed) return;
    for (const f of [...this.errors]) f(e);
  }

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    if (this.disposed) throw new Error('计算服务已经关掉了');
    const w = this.create(); // 起不来就同步抛;submit 会把它变成一件失败的活
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (this.worker !== w || this.disposed) return; // 已被换掉的线程 / 服务已关:不采纳
      this.handle(e.data);
    };
    w.onerror = (e: unknown) => {
      if (this.worker !== w || this.disposed) return;
      this.crash('计算线程崩了', e);
    };
    // 回执过不了 structured clone:这条通道已经不可信,同样按线程崩了处理(否则请求会一直挂着)
    w.onmessageerror = (e: unknown) => {
      if (this.worker !== w || this.disposed) return;
      this.crash('计算线程的回执读不出来', e);
    };
    this.worker = w;
    return w;
  }

  private handle(m: WorkerResponse): void {
    if (!m || typeof m.type !== 'string' || typeof m.requestId !== 'string') {
      // 线程不该发出不带 requestId 的消息;发出来了 = 版本对不上,明确报错而不是猜
      this.reportError(appError('protocol:bad-message', `计算线程发了一条看不懂的回执:${JSON.stringify(m)}`, false));
      return;
    }
    if (!countsAsReply(m)) {
      // progress / eraPatch:线程自己插播的,不改变任何一条活的生命周期
      this.notify(m);
      return;
    }
    if ((m.type === 'done' || m.type === 'civ' || m.type === 'trial') && m.tempo) this.tempoNote = m.tempo;
    const p = this.pending.get(m.requestId);
    if (m.type === 'error') {
      const err: AppError = { code: 'worker:exception', message: m.error.message, cause: m.error, recoverable: true };
      if (p) {
        this.pending.delete(m.requestId);
        this.states.set(m.requestId, 'failed');
        p.reject(err);
      }
      this.reportError(err);
      return;
    }
    // 总入口先过一遍(界面按 id / seq / pid 丢过时的回执),再兑现给等着的那条请求
    this.notify(m);
    if (!p) return; // 认不出的 / 已经取消的 / 重复的回执:不许动别的活(也不许重复扣忙碌计数)
    if (expects(p.kind, m.type)) {
      this.pending.delete(m.requestId);
      this.states.set(m.requestId, 'settled');
      p.resolve(m);
    }
  }

  private notify(m: WorkerResponse): void {
    for (const f of [...this.replies]) f(m);
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
