/**
 * 世界会话(worldSession.ts)的回归测试:编号、版本、状态在生命周期各点的转移,以及订阅只在真变了时通知。
 * 这是"世界运行时状态从 React 根组件里抽出来"之后,那份状态的唯一写入点 —— 转移错了,界面就会拿着旧世界乱画。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWorldSession,
  clearSessionError,
  getWorldSession,
  invalidateSimulation,
  newGeneration,
  sessionFailed,
  setSessionParams,
  setShownEdits,
  simulationReady,
  simulationStarted,
  subscribeWorldSession,
  worldReady,
  type WorldBody,
} from '../src/session/worldSession';
import type { World, WorldParams } from '../src/gen/world';
import type { TerrainOp } from '../src/gen/edits';
import { DEFAULT_PARAMS } from '../src/gen/world';

const PARAMS: WorldParams = { ...DEFAULT_PARAMS, seed: 7 };
const PARAMS2: WorldParams = { ...DEFAULT_PARAMS, seed: 2024 };
const body = (tag: string): WorldBody => ({ world: { tag } as unknown as World, raster: { tag } as unknown as World['mesh'] } as unknown as WorldBody);
const civOf = (tag: string) => ({ tag }) as unknown as NonNullable<ReturnType<typeof getWorldSession>['civ']>;

beforeEach(() => _resetWorldSession());

describe('世界会话 · 开世界与版本', () => {
  it('刚开始:idle、编号 0、什么也没有', () => {
    const s = getWorldSession();
    expect(s.status).toBe('idle');
    expect(s.worldId).toBe(0);
    expect(s.simulationVersion).toBe(0);
    expect(s.params).toBeNull();
    expect(s.body).toBeNull();
    expect(s.civ).toBeNull();
    expect(s.error).toBeNull();
  });

  it('换一代:编号 +1、参数换上、状态 = generating;旧的世界和文明**先留着**(生成期间地图上还是上一张图)', () => {
    worldReady(body('a'), civOf('a'));
    const id = newGeneration(PARAMS);
    expect(id).toBe(1);
    const s = getWorldSession();
    expect(s.worldId).toBe(1);
    expect(s.params).toEqual(PARAMS);
    expect(s.status).toBe('generating');
    // 旧的一直留到新的回来
    expect((s.body?.world as unknown as { tag: string }).tag).toBe('a');
    expect((s.civ as unknown as { tag: string }).tag).toBe('a');
  });

  it('生成完:换上世界 + 各段 + 文明,状态 = ready', () => {
    newGeneration(PARAMS);
    worldReady(body('b'), civOf('b'), { baseKey: 'k', keys: ['e1'], worlds: [{ tag: 'e1' } as unknown as World] });
    const s = getWorldSession();
    expect((s.body?.world as unknown as { tag: string }).tag).toBe('b');
    expect((s.civ as unknown as { tag: string }).tag).toBe('b');
    expect(s.eras?.keys).toEqual(['e1']);
    expect(s.status).toBe('ready');
  });

  it('不带各段世界时把 eras 清掉(上一份大事的地图不能留着)', () => {
    worldReady(body('a'), civOf('a'), { baseKey: 'k', keys: ['e1'], worlds: [{ tag: 'e1' } as unknown as World] });
    worldReady(body('b'), civOf('b'), null);
    expect(getWorldSession().eras).toBeNull();
  });

  it('改地形重新生成:换一代(编号 +1、状态 = generating),世界和文明由 done / civ 回执换上', () => {
    worldReady(body('a'), civOf('a'));
    newGeneration();
    const s = getWorldSession();
    expect(s.worldId).toBe(1);
    // 生成期间地图上还是上一份
    expect((s.body?.world as unknown as { tag: string }).tag).toBe('a');
    expect((s.civ as unknown as { tag: string }).tag).toBe('a');
    worldReady(body('a2'), civOf('a'), null);
    expect((getWorldSession().body?.world as unknown as { tag: string }).tag).toBe('a2');
  });

  it('参数不给就不动(改地形时参数没变)', () => {
    newGeneration(PARAMS);
    newGeneration();
    expect(getWorldSession().params).toEqual(PARAMS);
    expect(getWorldSession().worldId).toBe(2);
  });
});

describe('世界会话 · 推演版本与状态', () => {
  it('重推:版本 +1、状态 = resimulating;推完换上文明、状态 = ready', () => {
    newGeneration(PARAMS);
    worldReady(body('a'), civOf('a'));
    const v = simulationStarted();
    expect(v).toBe(1);
    expect(getWorldSession().status).toBe('resimulating');
    expect(getWorldSession().simulationVersion).toBe(1);
    simulationReady(civOf('a2'));
    const s = getWorldSession();
    expect((s.civ as unknown as { tag: string }).tag).toBe('a2');
    expect(s.status).toBe('ready');
    expect(s.simulationVersion).toBe(1);
  });

  it('每一次重推都加一(界面按它丢掉不是最新的那一次回执)', () => {
    newGeneration(PARAMS);
    expect(simulationStarted()).toBe(1);
    expect(simulationStarted()).toBe(2);
    expect(simulationStarted()).toBe(3);
    expect(getWorldSession().simulationVersion).toBe(3);
  });

  it('作废重推(换世界 / 改地形):版本也加一,但状态不动(那边正在生成)', () => {
    newGeneration(PARAMS);
    worldReady(body('a'), civOf('a'));
    expect(getWorldSession().status).toBe('ready');
    const v = invalidateSimulation();
    expect(v).toBe(1);
    expect(getWorldSession().simulationVersion).toBe(1);
    expect(getWorldSession().status).toBe('ready'); // 不动 —— 谁在生成谁自己设
  });

  it('生成和推演是两本账(换世界不重置推演版本,重推不改编号)', () => {
    newGeneration(PARAMS);
    simulationStarted();
    simulationStarted();
    newGeneration(PARAMS2);
    expect(getWorldSession().simulationVersion).toBe(2);
    expect(getWorldSession().worldId).toBe(2);
  });
});

describe('世界会话 · 修改、错误与订阅', () => {
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

  it('出错:状态 = error,错误留着;重新开一代会清掉', () => {
    const err = { code: 'worker:exception', message: '炸了', recoverable: true };
    sessionFailed(err);
    expect(getWorldSession().status).toBe('error');
    expect(getWorldSession().error).toEqual(err);
    newGeneration(PARAMS);
    expect(getWorldSession().error).toBeNull();
    expect(getWorldSession().status).toBe('generating');
  });

  it('clearSessionError 只清错误,不动状态之外的东西', () => {
    newGeneration(PARAMS);
    worldReady(body('a'), civOf('a'));
    sessionFailed({ code: 'x', message: 'y', recoverable: true });
    clearSessionError();
    expect(getWorldSession().error).toBeNull();
    expect((getWorldSession().civ as unknown as { tag: string }).tag).toBe('a');
  });

  it('订阅:真变了才通知;字段没变的写入不打扰订阅者', () => {
    const fn = vi.fn();
    const off = subscribeWorldSession(fn);
    newGeneration(PARAMS);
    expect(fn).toHaveBeenCalledTimes(1);
    // 同一个数组/对象再写一次:值是同一个引用 → 不算变
    const t: TerrainOp[] = [{ kind: 'lake', pts: [1, 2], r: 10, s: 1 }];
    setShownEdits(t, undefined);
    setShownEdits(t, undefined);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    newGeneration(PARAMS2);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
