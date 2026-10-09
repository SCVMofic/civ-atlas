/**
 * 文明推演的入口(RFC §6 / TASK-008B):**只做委托**。
 *
 *   UI / Worker / 脚本  →  Simulation.run(input)  →  generateCiv(world, params, progress)  →  Civ
 *
 * 这一版的全部内容就是"把调用收进一个稳定的入口",**不重写任何东西**:
 * - 内部原样调用 `gen/civ/index.ts` 的 `generateCiv`(那一个同步函数:建引擎 → 装系统 → 推演 → 拼结果);
 * - **不**另建引擎实例、**不**复制一份文明状态、**不**加第二真值;
 * - **不**改 install 顺序、`scheduleInterventions` 的先后、`sim.run` 的分段与事件序号(`seq`)的分配;
 * - **不**把 `CivSim` / 事件调度 / 事件池的细节暴露给调用方;
 * - **不**吞异常、**不**自动重试 —— 现在什么样就什么样往上抛(worker 层再把它变成 error 回执);
 * - **不**包成 async/Promise:现有推演是同步的,包装只会改执行时序;
 * - **不**依赖 React / DOM / Worker:只依赖 `src/gen/**`(纯计算)。
 *
 * 为什么返回 `Civ` 本身、而不是再造一个 `SimulationResult` 壳:今天调用方要的就是这份 `Civ`
 * (worker 把它发回去、脚本拿它算指纹),壳里没有别的东西可放 —— 等真有了再包(见
 * `docs/simulation-boundary.md` §8)。
 *
 * 边界清单(调用点、所有权、顺序、现有入口之间的不一致)见 `docs/simulation-boundary.md`。
 * **本文件不迁移任何调用点**:Worker / 脚本 / 测试仍走旧入口,等 façade 独立通过测试后再逐个迁(TASK-008C)。
 */
import { generateCiv, type Civ, type CivParams } from '../gen/civ';
import type { World, Progress } from '../gen/world';

export interface SimulationInput {
  /** 要推演的世界(只读) */
  world: World;
  /** 推演参数(endYear / cultures / polities / regionArea / pace / birthSpan / interventions / tempo / upheavals);不给 = 默认 */
  params?: Partial<CivParams>;
  /** 进度回调(原样转给 generateCiv;不给 = 不报进度) */
  progress?: Progress;
}

export interface Simulation {
  /** 跑一遍推演,同步返回结果(就是 `generateCiv` 的返回,同一个对象) */
  run(input: SimulationInput): Civ;
}

/**
 * 唯一的实现:一行委托。**无状态** —— 不持有引擎、不缓存上次的结果,
 * 所以同一个实例连着跑多少次、和别的推演交错着跑,结果都互不影响(测试里有这一条)。
 */
export const simulation: Simulation = {
  run: ({ world, params, progress }) => generateCiv(world, params, progress),
};
