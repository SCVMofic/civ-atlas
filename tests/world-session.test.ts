/**
 * 世界会话(worldSession.ts)的回归测试:编号、版本、**正在算的那件活**、状态与错误在生命周期各点的转移,
 * 以及"只有当前这件活能收尾 / 能落地"的不变量。
 *
 * 这是"世界运行时状态从 React 根组件里抽出来"之后那份状态的唯一写入点 —— 转移错了,
 * 界面就会拿着旧世界乱画,或者一直锁在"正在算"里点不动。
 * 状态的转移要和审查 TASK-007B 的验收一一对上:正常算完可操作、失败解锁但保留旧世界、
 * 被顶掉的活不许覆盖新世界、重复收尾不多做事。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWorldSession,
  beginWorldTask,
  clearSessionError,
  endWorldTask,
  erasReady,
  getWorldSession,
  invalidateSimulation,
  newGeneration,
  nextSimulationVersion,
  sessionFailed,
  setSessionParams,
  setShownEdits,
  simulationReady,
  subscribeWorldSession,
  worldReady,
  type WorldBody,
  type WorldTaskKind,
} from '../src/session/worldSession';
import type { World, WorldParams } from '../src/gen/world';
import { DEFAULT_PARAMS } from '../src/gen/world';
import type { TerrainOp } from '../src/gen/edits';

const PARAMS: WorldParams = { ...DEFAULT_PARAMS, seed: 7 };
const PARAMS2: WorldParams = { ...DEFAULT_PARAMS, seed: 2024 };
const body = (tag: string): WorldBody => ({ world: { tag } as unknown as World, raster: {} as WorldBody['raster'] });
const civOf = (tag: string) => ({ tag }) as unknown as NonNullable<ReturnType<typeof getWorldSession>['civ']>;
const tagOf = (w: unknown) => (w as { tag: string }).tag;
/** 一件正式活开始(登记任务);返回它的 requestId 由调用方给 */
const run = (kind: WorldTaskKind, id: string, year?: number) => beginWorldTask(kind, id, year);

beforeEach(() => _resetWorldSession());

describe('世界会话 · 开世界与版本', () => {
  it('刚开始:idle、编号 0、什么也没有、没有在算的活', () => {
    const s = getWorldSession();
    expect(s.status).toBe('idle');
    expect(s.worldId).toBe(0);
    expect(s.simulationVersion).toBe(0);
    expect(s.params).toBeNull();
    expect(s.body).toBeNull();
    expect(s.civ).toBeNull();
    expect(s.task).toBeNull();
    expect(s.error).toBeNull();
  });

  it('换一代:编号 +1、参数换上;旧的世界和文明**先留着**(生成期间地图上还是上一张图)', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    run('generate', 'r2');
    const id = newGeneration(PARAMS);
    expect(id).toBe(1);
    const s = getWorldSession();
    expect(s.worldId).toBe(1);
    expect(s.params).toEqual(PARAMS);
    expect(tagOf(s.body?.world)).toBe('a');
    expect(tagOf(s.civ)).toBe('a');
  });

  it('生成完:换上世界 + 各段 + 文明,任务收尾,状态 = ready', () => {
    newGeneration(PARAMS);
    run('generate', 'r1');
    expect(worldReady(body('b'), civOf('b'), { baseKey: 'k', keys: ['e1'], worlds: [{ tag: 'e1' } as unknown as World] }, 'r1')).toBe(true);
    const s = getWorldSession();
    expect(tagOf(s.body?.world)).toBe('b');
    expect(tagOf(s.civ)).toBe('b');
    expect(s.eras?.keys).toEqual(['e1']);
    expect(s.task).toBeNull();
    expect(s.status).toBe('ready');
  });

  it('不带各段世界时把 eras 清掉(上一份大事的地图不能留着)', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), { baseKey: 'k', keys: ['e1'], worlds: [] }, 'r1');
    run('generate', 'r2');
    worldReady(body('b'), civOf('b'), null, 'r2');
    expect(getWorldSession().eras).toBeNull();
  });

  it('参数不给就不动(改地形时参数没变)', () => {
    newGeneration(PARAMS);
    newGeneration();
    expect(getWorldSession().params).toEqual(PARAMS);
    expect(getWorldSession().worldId).toBe(2);
  });

  it('重推版本只由 nextSimulationVersion / invalidateSimulation 加', () => {
    newGeneration(PARAMS);
    expect(nextSimulationVersion()).toBe(1);
    expect(invalidateSimulation()).toBe(2);
    expect(nextSimulationVersion()).toBe(3);
    expect(getWorldSession().simulationVersion).toBe(3);
  });

  it('生成和推演是两本账(换世界不重置推演版本,重推不改编号)', () => {
    newGeneration(PARAMS);
    nextSimulationVersion();
    nextSimulationVersion();
    newGeneration(PARAMS2);
    expect(getWorldSession().simulationVersion).toBe(2);
    expect(getWorldSession().worldId).toBe(2);
  });
});

describe('世界会话 · 正在算的那件活(忙碌的唯一来源)', () => {
  it('登记任务 → 状态就是计算中;收尾 → 回到可操作(idle / ready)', () => {
    expect(getWorldSession().status).toBe('idle');
    run('generate', 'r1');
    expect(getWorldSession().status).toBe('generating');
    expect(getWorldSession().task?.requestId).toBe('r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    expect(getWorldSession().status).toBe('ready');
    expect(getWorldSession().task).toBeNull();
  });

  it('重推是 resimulating(不是 generating);改地形重新生成是 generating', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    run('resimulate', 'r2', 1200);
    expect(getWorldSession().status).toBe('resimulating');
    expect(getWorldSession().task?.year).toBe(1200);
    simulationReady(civOf('a2'), undefined, 'r2');
    expect(getWorldSession().status).toBe('ready');
    run('regenerate', 'r3');
    expect(getWorldSession().status).toBe('generating');
  });

  it('endWorldTask:是当前这一件才清;别人的号 / 重复收尾都不动它', () => {
    run('generate', 'r1');
    expect(endWorldTask('r9')).toBe(false);
    expect(getWorldSession().task?.requestId).toBe('r1');
    expect(endWorldTask('r1')).toBe(true);
    expect(getWorldSession().task).toBeNull();
    expect(endWorldTask('r1')).toBe(false); // 再来一次不多做事
  });

  it('被顶掉:旧的活收尾不了新的那件(忙碌不会被误清)', () => {
    run('generate', 'r1');
    run('generate', 'r2'); // 换一代:新的一件接手
    expect(getWorldSession().task?.requestId).toBe('r2');
    expect(endWorldTask('r1')).toBe(false);
    expect(getWorldSession().task?.requestId).toBe('r2');
    expect(getWorldSession().status).toBe('generating');
  });

  it('重复调用完成处理不产生额外变化(订阅者不会被无谓打扰)', () => {
    const fn = vi.fn();
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    const off = subscribeWorldSession(fn);
    expect(worldReady(body('a'), civOf('a'), null, 'r1')).toBe(false);
    expect(endWorldTask('r1')).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    off();
  });
});

describe('世界会话 · 只认当前这件活的回执', () => {
  it('没有登记任务时,生成 / 重推的回执都不落地(过时的回执不许改真值)', () => {
    expect(worldReady(body('x'), civOf('x'), null, 'r1')).toBe(false);
    expect(getWorldSession().body).toBeNull();
    expect(simulationReady(civOf('x'), undefined, 'r2')).toBe(false);
    expect(getWorldSession().civ).toBeNull();
  });

  it('换世界后,上一代生成的回执落不了地(不会用旧世界覆盖新世界)', () => {
    run('generate', 'r1');
    const id2 = newGeneration(PARAMS2);
    run('generate', 'r2'); // 新的一代接手
    expect(id2).toBe(1);
    // 上一代的 done 迟到:会话不采纳
    expect(worldReady(body('old'), civOf('old'), null, 'r1')).toBe(false);
    expect(getWorldSession().body).toBeNull();
    // 这一代的 done 才落地
    expect(worldReady(body('new'), civOf('new'), null, 'r2')).toBe(true);
    expect(tagOf(getWorldSession().body?.world)).toBe('new');
  });

  it('换世界后,上一代的重推回执落不了地(旧历史不许盖在新世界上)', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    run('resimulate', 'r2', 1200);
    newGeneration(PARAMS2);
    run('generate', 'r3'); // 新的一代接手
    expect(simulationReady(civOf('stale'), undefined, 'r2')).toBe(false);
    expect(tagOf(getWorldSession().civ)).toBe('a'); // 还是上一份有效的
    expect(worldReady(body('b'), civOf('b'), null, 'r3')).toBe(true);
    expect(tagOf(getWorldSession().body?.world)).toBe('b');
  });

  it('各段世界另有入口(交回来时不一定跟着新的文明)', () => {
    erasReady({ baseKey: 'k', keys: ['e2'], worlds: [] });
    expect(getWorldSession().eras?.keys).toEqual(['e2']);
    erasReady(null);
    expect(getWorldSession().eras).toBeNull();
  });
});

describe('世界会话 · 失败与恢复(FINDING-002)', () => {
  it('算炸了:任务收尾(界面解锁)、旧世界和文明留着、状态 = error', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    run('resimulate', 'r2', 1200);
    // App 的 taskFailed:先收尾(只有当前那件能收),再把错误记进会话
    expect(endWorldTask('r2')).toBe(true);
    sessionFailed({ code: 'worker:crashed', message: '线程崩了', recoverable: true });
    const s = getWorldSession();
    expect(s.task).toBeNull();
    expect(s.status).toBe('error');
    expect(s.error?.message).toBe('线程崩了');
    // 最后一份有效的东西都在
    expect(tagOf(s.body?.world)).toBe('a');
    expect(tagOf(s.civ)).toBe('a');
  });

  it('下一件活开始时把错误清掉(状态回到计算中)', () => {
    sessionFailed({ code: 'worker:exception', message: '炸了', recoverable: true });
    expect(getWorldSession().status).toBe('error');
    run('generate', 'r1');
    expect(getWorldSession().error).toBeNull();
    expect(getWorldSession().status).toBe('generating');
  });

  it('clearSessionError 只清错误,不动世界', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    sessionFailed({ code: 'x', message: 'y', recoverable: true });
    clearSessionError();
    expect(getWorldSession().error).toBeNull();
    expect(tagOf(getWorldSession().civ)).toBe('a');
    expect(getWorldSession().status).toBe('ready');
  });

  it('线程崩了(在算的活一起失败)时:任务收尾 + 错误 → 状态 error,不会一直锁着', () => {
    run('regenerate', 'r1');
    expect(getWorldSession().status).toBe('generating');
    // 崩溃:client.ts 让在跑的活全部以 worker:crashed 失败,App 逐件调 taskFailed
    expect(endWorldTask('r1')).toBe(true);
    sessionFailed({ code: 'worker:crashed', message: '计算线程崩了', recoverable: true });
    expect(getWorldSession().status).toBe('error');
    expect(getWorldSession().task).toBeNull();
  });

  it('临时活(试推演 / 预览 / 回放帧)不登记任务:界面不会被锁住', () => {
    run('generate', 'r1');
    worldReady(body('a'), civOf('a'), null, 'r1');
    // 试推演、预览这些不走 beginWorldTask —— 状态就还是 ready(可操作)
    expect(getWorldSession().status).toBe('ready');
    expect(getWorldSession().task).toBeNull();
  });
});

describe('世界会话 · 修改与订阅', () => {
  it('当前世界的参数换一份(打开同一个世界时也会走一次)', () => {
    newGeneration(PARAMS);
    setSessionParams(PARAMS2);
    expect(getWorldSession().params).toEqual(PARAMS2);
  });

  it('地图上现在这份世界带着哪些修改', () => {
    setShownEdits([{ kind: 'volcano', pts: [10, 20], r: 20, s: 1 }], { rest: 'auto', strokes: [] });
    const s = getWorldSession();
    expect(s.shownTerrain.length).toBe(1);
    expect(s.shownSketch?.rest).toBe('auto');
  });

  it('订阅:真变了才通知;字段没变的写入不打扰订阅者', () => {
    const fn = vi.fn();
    const off = subscribeWorldSession(fn);
    newGeneration(PARAMS);
    expect(fn).toHaveBeenCalledTimes(1);
    const t: TerrainOp[] = [{ kind: 'lake', pts: [1, 2], r: 10, s: 1 }];
    setShownEdits(t, undefined);
    setShownEdits(t, undefined);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    newGeneration(PARAMS2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
