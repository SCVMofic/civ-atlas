/**
 * 应用内视图 ↔ 浏览器历史(阶段 2)。设计见 `docs/phase2-navigation-design.md`。
 *
 * 现状(改之前):全仓只有 `replaceState`、没有 `pushState`、没有 `popstate` 监听 —— 打开国家 / 编年史
 * 只改模块 store、不动历史,所以浏览器后退不是"回上一个视图",而是**离开整个应用**。
 *
 * 这里加一层极薄的历史封装(不引路由库),三个接口各管一件事,**不混用**:
 *
 *   pushView(view)        进入一个新视图 → 新增一条历史(描述相同则 no-op)
 *   replaceNavView(view)  只更新**当前条目**的导航描述(世界切换重置 base、启动归一化)→ 不加记录
 *   replaceUrl(next)      只改 URL,原样保留当前导航 state(现有 7 处 replaceState 统一用它)
 *
 * 契约:调用方只构造 `NavView`(只有视图字段);`world` 一律由这里补。写进 `history.state` 的一定是
 * 完整的 `NavState`。`popstate` 恢复**只读不写**(见 `onPopView`)。
 *
 * 纯函数(`worldOf` / `restoreOnStart` / `sameView`)不碰 DOM,Node 里可测(tests/nav.test.ts);
 * 其余几个只在浏览器里调用。
 */
import { getWorldSession } from '../session/worldSession';

/** 一个应用内视图(调用方构造;不含 world) */
export type NavView =
  | { v: 'base' }
  /** 详情:`kind` 是选中东西的种类(国家 / 城 / 州 / 信仰 / 地点 / 人物 / 作者标记 / 作者人物),
   *  `id` 是**稳定标识**(调用方决定怎么编码;别存会随重推变化的下标) */
  | { v: 'detail'; kind: string; id: string }
  /** 概览 / 编年史:按页签区分 */
  | { v: 'overview'; tab: string };

/** 写进 `history.state` 的完整描述 = 视图 + 它属于哪个世界 */
export type NavState = NavView & { world: string };

/**
 * 页面加载时生成一次的随机串。刷新会重新生成,于是**刷新前**写进历史的 `world` 与刷新后的对不上 ——
 * "刷新后回 base" 就由世界标识比较保证,而不是靠 `history.state === null`。
 */
export const SESSION_NONCE: string = Math.random().toString(36).slice(2);

/** 世界标识:同一 worldId + 同一 nonce 相等;两者任一变就不等(§3.3) */
export function worldOf(nonce: string, worldId: number): string {
  return `${nonce}:${worldId}`;
}

/** 当前世界标识(`worldId` 每换一代加一,见 session/worldSession.ts) */
export function currentWorld(): string {
  return worldOf(SESSION_NONCE, getWorldSession().worldId);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/**
 * 从 `history.state` 还原出要应用的视图。**不合法、或不是这个世界(含 `null`)** → `base`。
 * 启动时用它归一化;`popstate` 也用它(启动与运行期同一条判定)。
 */
export function restoreOnStart(state: unknown, world: string): NavView {
  if (!isRecord(state) || state.world !== world) return { v: 'base' };
  if (state.v === 'base') return { v: 'base' };
  if (state.v === 'detail' && typeof state.kind === 'string' && typeof state.id === 'string') return { v: 'detail', kind: state.kind, id: state.id };
  if (state.v === 'overview' && typeof state.tab === 'string') return { v: 'overview', tab: state.tab };
  return { v: 'base' };
}

/** 两个视图是不是同一个(用于"重复打开同一实体不新增记录") */
export function sameView(a: NavView | null | undefined, b: NavView | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.v !== b.v) return false;
  if (a.v === 'detail' && b.v === 'detail') return a.kind === b.kind && a.id === b.id;
  if (a.v === 'overview' && b.v === 'overview') return a.tab === b.tab;
  return true; // 两个都是 base
}

/** `history.state` 与目标描述是不是同一条(同世界 + 同视图)—— `pushView` 用它决定是否 no-op */
export function sameNavEntry(state: unknown, next: NavState): boolean {
  return isRecord(state) && state.world === next.world && sameView(restoreOnStart(state, next.world), next);
}

/** 当前条目里的视图(不合法 = base) */
export function currentView(): NavView {
  return restoreOnStart(history.state, currentWorld());
}

/**
 * 进入一个新视图:描述与当前条目相同 = 不做事;否则新增一条历史。
 * **只在用户主动打开视图时调用**(拖动 / 缩放 / 换图层 / 播放 / 悬停都不写历史)。
 */
export function pushView(view: NavView): void {
  const next: NavState = { ...view, world: currentWorld() };
  if (sameNavEntry(history.state, next)) return;
  history.pushState(next, '');
}

/**
 * 只更新**当前条目**的导航描述,不加记录:
 * 世界切换后把当前条目重置为 base;启动时把条目归一化(旧世界的 detail → 新 base)。
 */
export function replaceNavView(view: NavView): void {
  history.replaceState({ ...view, world: currentWorld() }, '', location.href);
}

/** 只改 URL,**原样保留**当前导航 state(现有 7 处 replaceState 统一用它) */
export function replaceUrl(next: string): void {
  history.replaceState(history.state, '', next);
}

/** 浏览器后退 / 前进:只读 state 恢复视图,**绝不写历史**(§4) */
export function onPopView(fn: (view: NavView) => void): () => void {
  const h = (e: PopStateEvent) => {
    restoring = true;
    try {
      fn(restoreOnStart(e.state, currentWorld()));
    } finally {
      restoring = false;
    }
  };
  window.addEventListener('popstate', h);
  return () => window.removeEventListener('popstate', h);
}

/** 正在 popstate 恢复?恢复流程里 store 变化不该再 pushView(否则回环) */
let restoring = false;
export function navRestoring(): boolean {
  return restoring;
}

/** 当前条目是不是一个"可关闭的应用内视图"(base = 没有) */
export function hasView(): boolean {
  return currentView().v !== 'base';
}

/**
 * 关闭当前视图:只有当前**确实位于一个应用内视图条目**时才回退(否则 Esc 会把整个应用退出去)。
 * 返回 true = 已发起回退(**异步**:之后由 `popstate` 恢复界面,调用方不要紧接着再 setSelection(null))。
 * 返回 false = 当前没有可关闭的视图,什么都不做。
 */
export function backIfView(): boolean {
  if (!hasView()) return false;
  history.back();
  return true;
}
