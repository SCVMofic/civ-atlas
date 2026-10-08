/**
 * 世界计算服务(worker/client.ts)的回归测试(RFC §6 的那几条要求):requestId 能追踪、回执能对上请求、
 * 不靠消息先后判断归属、取消有明确语义、错误可序列化。
 *
 * 用假的线程(WorkerLike)替掉真 Worker:这里测的是**约定**,不是计算 ——
 * 世界本身算得对不对由 determinism / save 那些测试守着。
 */
import { describe, expect, it } from 'vitest';
import { WorldComputeService, WORLD_CHANGED, type WorkerLike } from '../src/worker/client';
import type { RequestInput, WorkerRequest, WorkerResponse } from '../src/worker/protocol';

/** Omit 在联合类型上要逐支拆开,不然联合会被压成一个对象 */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 回执去掉 requestId 的"响应体"(requestId 由假线程按对应请求补上) */
type ReplyBody = DistOmit<WorkerResponse, 'requestId'>;

/** 假线程:记下发出去的请求,可以按测试的意思回任何一条回执 */
class FakeWorker implements WorkerLike {
  sent: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    this.sent.push(message as WorkerRequest);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** 最后一条请求 */
  get last(): WorkerRequest {
    return this.sent[this.sent.length - 1];
  }

  /** 按第 i 条请求的 requestId 回一条回执 */
  reply(i: number, body: ReplyBody): void {
    this.emit({ ...body, requestId: this.sent[i].requestId } as WorkerResponse);
  }

  emit(m: WorkerResponse): void {
    this.onmessage?.({ data: m } as MessageEvent);
  }
}

/** 造一个服务和它的线程(线程记在 created 里,便于断言"换了线程") */
function setup(onReply?: (m: WorkerResponse) => void) {
  const created: FakeWorker[] = [];
  const errors: { code: string; message: string }[] = [];
  const svc = new WorldComputeService({
    createWorker: () => {
      const w = new FakeWorker();
      created.push(w);
      return w;
    },
    onReply,
    onError: (e) => errors.push(e),
  });
  return { svc, created, errors, worker: () => created[created.length - 1] };
}

const PARAMS = { seed: 7, cells: 2000, landFraction: 0.33, plates: 30, mountains: 1, temperature: 0, rainfall: 1 };
const generateInput: RequestInput<'generate'> = { type: 'generate', id: 1, scale: 1, params: PARAMS, terrain: [] };
const resimInput: RequestInput<'resim'> = { type: 'resim', id: 1, seq: 1, params: PARAMS, terrain: [], interventions: [] };
const trialInput: RequestInput<'trial'> = { type: 'trial', id: 1, tid: 1, params: PARAMS, terrain: [], interventions: [] };
const historyInput: RequestInput<'history'> = { type: 'history', id: 1, params: PARAMS };
const previewInput: RequestInput<'upPreview'> = { type: 'upPreview', id: 1, pid: 1, params: PARAMS, year: 1200, ops: [] };

/** 只关心 requestId 对不对得上,内容给个最小占位 */
const doneBody = (id: number): ReplyBody => ({ type: 'done', id, world: {}, raster: {}, civ: {}, ms: 1, genMs: 1, baseKey: 'k' }) as unknown as ReplyBody;

describe('计算服务 · 发号与对上号', () => {
  it('每条请求带自己的 requestId;回执**乱序**到达也能各归各位(不靠消息先后)', async () => {
    const { svc, worker } = setup();
    const a = svc.generate({ ...generateInput });
    // 第二条用 resim:generate 会换线程,而这里要看的是同一条线程上两条请求乱序回
    const b = svc.resimulate({ ...resimInput });
    expect(a.requestId).toBe('r1');
    expect(b.requestId).toBe('r2');
    const w = worker();
    expect(w.sent.map((r) => r.requestId)).toEqual(['r1', 'r2']);

    // 后发的先回
    w.reply(1, { type: 'civ', id: 1, seq: 1, civ: {}, ms: 1, baseKey: 'k' } as unknown as ReplyBody);
    w.reply(0, doneBody(1));
    expect((await a.result).type).toBe('done');
    expect((await b.result).type).toBe('civ');
  });

  it('五件活各自兑现对应的回执', async () => {
    const { svc, worker } = setup();
    const g = svc.generate({ ...generateInput });
    const r = svc.resimulate({ ...resimInput });
    const h = svc.history({ ...historyInput });
    const t = svc.trial({ ...trialInput });
    const p = svc.previewUpheaval({ ...previewInput });
    const w = worker();
    expect(w.sent.map((x) => x.type)).toEqual(['generate', 'resim', 'history', 'trial', 'upPreview']);

    w.reply(0, doneBody(1));
    w.reply(1, { type: 'civ', id: 1, seq: 1, civ: {}, ms: 1, baseKey: 'k' } as unknown as ReplyBody);
    w.reply(2, { type: 'history', id: 1, w: 8, h: 4, frames: [], mya: [] } as unknown as ReplyBody);
    w.reply(3, { type: 'trial', id: 1, tid: 1, civ: {}, ms: 1 } as unknown as ReplyBody);
    w.reply(4, { type: 'upPreview', id: 1, pid: 1, preview: {}, water: new Uint8Array(0), ms: 1 } as unknown as ReplyBody);
    expect((await g.result).type).toBe('done');
    expect((await r.result).type).toBe('civ');
    expect((await h.result).type).toBe('history');
    expect((await t.result).type).toBe('trial');
    expect((await p.result).type).toBe('upPreview');
    // 全兑现完,没有回音挂着
    expect(svc.busy).toBe(0);
  });

  it('回执都从总入口过一遍(progress / eraPatch 也在内)', () => {
    const seen: string[] = [];
    const { svc, worker } = setup((m) => seen.push(m.type));
    svc.generate({ ...generateInput });
    const w = worker();
    w.reply(0, { type: 'progress', id: 1, stage: '地形', pct: 0.1 });
    w.reply(0, { type: 'eraPatch', id: 1, key: 'a>b', prev: 'a', patch: null });
    w.reply(0, doneBody(1));
    expect(seen).toEqual(['progress', 'eraPatch', 'done']);
  });
});

describe('计算服务 · 回音计数', () => {
  it('progress / eraPatch 不算一件回音;done 算', () => {
    const { svc, worker } = setup();
    svc.generate({ ...generateInput });
    expect(svc.busy).toBe(1);
    const w = worker();
    w.reply(0, { type: 'progress', id: 1, stage: 'x', pct: 0.5 });
    expect(svc.busy).toBe(1);
    w.reply(0, { type: 'eraPatch', id: 1, key: 'a', prev: 'b', patch: null });
    expect(svc.busy).toBe(1);
    w.reply(0, doneBody(1));
    expect(svc.busy).toBe(0);
  });

  it('不忙时发 generate 不换线程(短活不打断,线程手里的世界留着)', () => {
    const { svc, created } = setup();
    svc.generate({ ...generateInput });
    const w = created[0];
    w.reply(0, doneBody(1));
    svc.generate({ ...generateInput, id: 2 });
    expect(created.length).toBe(1);
    expect(w.terminated).toBe(false);
  });
});

describe('计算服务 · 取消与换线程', () => {
  it('cancel:这次结果以 compute:cancelled 失败;回执到了也不再兑现', async () => {
    const { svc, worker } = setup();
    const job = svc.generate({ ...generateInput });
    svc.cancel(job.requestId, '不要了');
    await expect(job.result).rejects.toMatchObject({ code: 'compute:cancelled', message: '不要了' });
    expect(job.state).toBe('cancelled');
    // 回执迟到了:总入口照旧收得到(界面自己按 id / seq / pid 丢过时的),但不再兑现给这条活
    worker().reply(0, doneBody(1));
    expect(svc.busy).toBe(0);
  });

  it('cancelAll:没回音的活一起作废', async () => {
    const { svc } = setup();
    const a = svc.generate({ ...generateInput });
    const b = svc.resimulate({ ...resimInput });
    svc.cancelAll('页面关了');
    await expect(a.result).rejects.toMatchObject({ code: 'compute:cancelled' });
    await expect(b.result).rejects.toMatchObject({ code: 'compute:cancelled' });
  });

  it('线程还在忙时发 generate:换掉旧线程,在跑的活按"世界换了"失败,新请求发到新线程', async () => {
    const { svc, created } = setup();
    svc.generate({ ...generateInput });
    const old = created[0];
    const trial = svc.trial({ ...trialInput });
    expect(old.terminated).toBe(false);
    // 试推演还挂着 → 忙 → 这次 generate 换线程
    const gen2 = svc.generate({ ...generateInput, id: 2 });
    expect(old.terminated).toBe(true);
    expect(created.length).toBe(2);
    await expect(trial.result).rejects.toMatchObject({ code: 'worker:replaced', message: WORLD_CHANGED });
    expect(created[1].last.requestId).toBe(gen2.requestId);
    expect(svc.busy).toBe(1); // 旧线程那份不再算
  });

  it('dispose:线程停掉,在跑的活一起失败', async () => {
    const { svc, created } = setup();
    const job = svc.generate({ ...generateInput });
    svc.dispose();
    expect(created[0].terminated).toBe(true);
    await expect(job.result).rejects.toMatchObject({ code: 'worker:replaced' });
  });

  it('已被换掉的线程发来的回执一律不理(不污染新一代)', () => {
    const seen: string[] = [];
    const { svc, created } = setup((m) => seen.push(m.requestId));
    svc.generate({ ...generateInput });
    const old = created[0];
    svc.generate({ ...generateInput, id: 2 }); // 忙 → 换线程
    old.emit({ type: 'progress', requestId: 'r1', id: 1, stage: 'x', pct: 0.5 });
    expect(seen).toEqual([]);
    created[1].emit({ type: 'progress', requestId: created[1].last.requestId, id: 2, stage: 'x', pct: 0.5 });
    expect(seen.length).toBe(1);
  });
});

describe('计算服务 · 错误与节拍', () => {
  it('线程回 error:这条活以 AppError 失败,onError 也收到(界面据此提示,而不是卡住)', async () => {
    const { svc, worker, errors } = setup();
    const job = svc.generate({ ...generateInput });
    worker().reply(0, { type: 'error', id: 1, error: { name: 'RangeError', message: '炸了', stack: 'at x' } });
    await expect(job.result).rejects.toMatchObject({ code: 'worker:exception', message: '炸了', recoverable: true });
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe('worker:exception');
    expect(svc.busy).toBe(0); // 出错也算一件回音,不能把计数漏在那里
  });

  it('回执不带 requestId:明确报协议错误,不去猜属于哪条请求', () => {
    const { svc, errors, worker } = setup();
    svc.generate({ ...generateInput });
    worker().emit({ type: 'progress', id: 1, stage: 'x', pct: 0.5 } as unknown as WorkerResponse);
    expect(errors.map((e) => e.code)).toContain('protocol:bad-message');
  });

  it('节拍:发请求时自动带上最近回报的节拍;history / upPreview 不带', () => {
    const { svc, worker } = setup();
    svc.tempo = { key: 'k', tempo: 12 };
    svc.generate({ ...generateInput });
    svc.history({ ...historyInput });
    svc.previewUpheaval({ ...previewInput });
    const w = worker();
    expect((w.sent[0] as { tempo?: unknown }).tempo).toEqual({ key: 'k', tempo: 12 });
    expect((w.sent[1] as { tempo?: unknown }).tempo).toBeUndefined();
    expect((w.sent[2] as { tempo?: unknown }).tempo).toBeUndefined();
  });

  it('线程回报的节拍被记下来(下次发请求带上)', () => {
    const { svc, worker } = setup();
    svc.generate({ ...generateInput });
    worker().reply(0, { ...doneBody(1), tempo: { key: 'k7', tempo: null } } as ReplyBody);
    expect(svc.tempo).toEqual({ key: 'k7', tempo: null });
  });
});
