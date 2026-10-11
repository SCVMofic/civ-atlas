/**
 * 导航状态模型(阶段 2,ui/nav.ts):纯函数部分 —— 视图描述、世界标识、启动恢复判定、no-op 判定。
 * 这些都不碰 DOM,Node 里直接测;浏览器端行为(Back / Forward / 刷新)见 scripts/replay-check.ts 的场景。
 */
import { describe, expect, it } from 'vitest';
import { restoreOnStart, sameNavEntry, sameView, worldOf, type NavState, type NavView } from '../src/ui/nav';

const D = (kind: string, id: string): NavView => ({ v: 'detail', kind, id });
const O = (tab: string): NavView => ({ v: 'overview', tab });
const BASE: NavView = { v: 'base' };

describe('导航视图描述(U1)', () => {
  it('同一实体 = 同一视图;不同实体 / 不同页签 = 不同;base 与 detail 不等', () => {
    expect(sameView(D('polity', 'p1'), D('polity', 'p1'))).toBe(true);
    expect(sameView(D('polity', 'p1'), D('polity', 'p2'))).toBe(false);
    // 种类不同、id 相同也算不同
    expect(sameView(D('polity', '1'), D('region', '1'))).toBe(false);
    expect(sameView(O('chronicle'), O('chronicle'))).toBe(true);
    expect(sameView(O('chronicle'), O('countries'))).toBe(false);
    expect(sameView(BASE, BASE)).toBe(true);
    expect(sameView(BASE, D('polity', 'p1'))).toBe(false);
    expect(sameView(null, BASE)).toBe(false);
  });
});

describe('重复打开不新增记录(U2)', () => {
  const entry: NavState = { v: 'detail', kind: 'polity', id: 'p1', world: 'w1' };
  it('同世界 + 同视图 = 同一条(no-op);换实体 / 换世界 / 换页签 = 不同', () => {
    expect(sameNavEntry(entry, { ...entry })).toBe(true);
    expect(sameNavEntry(entry, { v: 'detail', kind: 'polity', id: 'p2', world: 'w1' })).toBe(false);
    expect(sameNavEntry(entry, { ...entry, world: 'w2' })).toBe(false);
    expect(sameNavEntry(entry, { v: 'overview', tab: 'chronicle', world: 'w1' })).toBe(false);
  });
  it('state 不是合法记录(null / 非对象 / 结构不对)= 不同,应新增', () => {
    expect(sameNavEntry(null, entry)).toBe(false);
    expect(sameNavEntry('x', entry)).toBe(false);
    expect(sameNavEntry({ v: 'detail', world: 'w1' }, entry)).toBe(false);
  });
});

describe('世界标识(U4)', () => {
  it('同一 worldId + 同一 nonce 相等;worldId 变 / nonce 变就不等', () => {
    expect(worldOf('n1', 3)).toBe(worldOf('n1', 3));
    expect(worldOf('n1', 3)).not.toBe(worldOf('n1', 4));
    expect(worldOf('n1', 3)).not.toBe(worldOf('n2', 3));
  });
});

describe('启动恢复判定(U5)', () => {
  const world = worldOf('n1', 3);
  it('state 为 null / 非法 / 世界不匹配 → base', () => {
    expect(restoreOnStart(null, world)).toEqual(BASE);
    expect(restoreOnStart(undefined, world)).toEqual(BASE);
    expect(restoreOnStart('x', world)).toEqual(BASE);
    expect(restoreOnStart({ v: 'detail', kind: 'polity', id: 'p1' }, world)).toEqual(BASE); // 没有 world
    expect(restoreOnStart({ v: 'detail', kind: 'polity', id: 'p1', world: worldOf('n0', 1) }, world)).toEqual(BASE); // 旧世界(刷新前的 nonce)
    expect(restoreOnStart({ v: 'detail', kind: 'polity', world }, world)).toEqual(BASE); // 结构不全
    expect(restoreOnStart({ v: 'overview', world }, world)).toEqual(BASE); // 结构不全
    expect(restoreOnStart({ v: 'nope', world }, world)).toEqual(BASE); // 认不出的视图
  });
  it('世界匹配且结构完整 → 返回该视图', () => {
    expect(restoreOnStart({ v: 'base', world }, world)).toEqual(BASE);
    expect(restoreOnStart({ v: 'detail', kind: 'polity', id: 'p1', world }, world)).toEqual(D('polity', 'p1'));
    expect(restoreOnStart({ v: 'overview', tab: 'chronicle', world }, world)).toEqual(O('chronicle'));
  });
  it('刷新:nonce 变 → 旧记录一律 base(这就是"刷新后回 base"的保证)', () => {
    const before = worldOf('oldNonce', 3); // 刷新前
    const after = worldOf('newNonce', 3); // 刷新后(同一 worldId,nonce 重新生成)
    expect(restoreOnStart({ v: 'detail', kind: 'polity', id: 'p1', world: before }, after)).toEqual(BASE);
  });
});
