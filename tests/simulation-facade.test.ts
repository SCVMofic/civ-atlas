/**
 * Simulation façade(TASK-008B)的单元测试。要证明的四件事(审查里写死的验收条件):
 *
 * 1. 参数与 progress 原样转给 `generateCiv`;
 * 2. 返回的 `Civ` 与旧入口**逐字段一致**;
 * 3. 异常继续往上抛(没被吞掉、也没变成静默成功);
 * 4. 不新增引擎实例 / 状态副本 / 异步包装 —— `run` 同步返回,façade 自己不存东西。
 *
 * 外加一条静态护栏:façade 只许依赖 `src/gen/**`(不许 import 界面 / 渲染 / Worker)。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World, type WorldParams } from '../src/gen/world';
import { generateCiv, type CivParams } from '../src/gen/civ';
import { mergeUpheavals } from '../src/gen/civ/upheaval';
import { polityKey, type TerrainOp, type Upheaval } from '../src/gen/edits';
import { simulation } from '../src/simulation/simulation';
import { changedFields, fieldsOf, hashOf } from './lib/fingerprint';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, cells: 8000, seed: 7 };
const world = generateWorld(SMALL);

/** 各段世界:第 k 段 = 原来的地形套上前 k + 1 件大事的修改(和 worker.ts 的 stepsOf 同一套) */
function eraSteps(list: readonly Upheaval[]) {
  let all: TerrainOp[] = [];
  return mergeUpheavals(list).map((m) => {
    all = [...all, ...m.ops];
    return { year: m.year, ops: m.ops, items: m.items, world: generateWorld(SMALL, undefined, all, null) };
  });
}

const BASE = generateCiv(world);
const INTERVENTIONS = [{ kind: 'protect' as const, a: polityKey(BASE, 0), from: 1200 }];
const UPHEAVALS = eraSteps([{ year: 1200, ops: [{ kind: 'volcano', pts: [600, 500], r: 60, s: 1.4 }] }]);

describe('Simulation façade · 参数与进度原样传递', () => {
  it('params 原样生效(和旧入口同一个结果)', () => {
    const cut: Partial<CivParams> = { endYear: 1200 };
    expect(simulation.run({ world, params: cut }).endYear).toBe(1200);
    expect(generateCiv(world, cut).endYear).toBe(1200);
  });

  it('progress 原样转给 generateCiv:同样的输入,收到同一串阶段与百分比', () => {
    const viaOld: [string, number][] = [];
    const viaFacade: [string, number][] = [];
    const cut: Partial<CivParams> = { endYear: 1200 };
    generateCiv(world, cut, (stage, pct) => viaOld.push([stage, pct]));
    simulation.run({ world, params: cut, progress: (stage, pct) => viaFacade.push([stage, pct]) });
    expect(viaFacade.length).toBeGreaterThan(0);
    expect(viaFacade).toEqual(viaOld);
  });

  it('不给 params / progress 也照跑(用 generateCiv 自己的默认)', () => {
    const via = simulation.run({ world });
    expect(via.endYear).toBe(generateCiv(world).endYear);
    expect(changedFields(fieldsOf('civ.', generateCiv(world)), fieldsOf('civ.', via))).toEqual([]);
  });
});

describe('Simulation façade · 与旧入口逐字段一致', () => {
  const cases: { name: string; params?: Partial<CivParams> }[] = [
    { name: '默认参数' },
    { name: 'endYear 截到 1200' },
    { name: '带干预(保护)', params: { interventions: INTERVENTIONS } },
    { name: '带地形大事(一件火山)', params: { upheavals: UPHEAVALS } },
    { name: '干预 + 大事 + endYear', params: { interventions: INTERVENTIONS, upheavals: UPHEAVALS, endYear: 2000 } },
  ];
  it.each(cases)('$name:每个字段的指纹都一样', ({ params }) => {
    const via = simulation.run({ world, params });
    const viaOld = generateCiv(world, params);
    expect(changedFields(fieldsOf('civ.', viaOld), fieldsOf('civ.', via))).toEqual([]);
    expect(hashOf(via)).toBe(hashOf(viaOld));
  }, 120_000);
});

describe('Simulation façade · 异常继续上抛', () => {
  it('推演炸了就是炸了:抛出同样的错,不会吞掉、也不会静默返回', () => {
    const bad = {} as World;
    let oldErr: unknown = null;
    try {
      generateCiv(bad);
    } catch (e) {
      oldErr = e;
    }
    expect(oldErr).toBeInstanceOf(Error);
    let viaErr: unknown = null;
    let returned = false;
    try {
      simulation.run({ world: bad });
      returned = true;
    } catch (e) {
      viaErr = e;
    }
    expect(returned, 'façade 把异常吞掉了').toBe(false);
    expect((viaErr as Error).constructor).toBe((oldErr as Error).constructor);
    expect((viaErr as Error).message).toBe((oldErr as Error).message);
  });
});

describe('Simulation façade · 不新增引擎 / 状态副本 / 异步包装', () => {
  it('同步返回 Civ 本身,不是 Promise / thenable', () => {
    const via = simulation.run({ world });
    expect(via).toBeTruthy();
    expect(typeof (via as unknown as { then?: unknown }).then).toBe('undefined');
    expect(Object.prototype.toString.call(via)).toBe('[object Object]');
  });

  it('façade 自己不存东西:只有 run 一个成员(没有引擎、没有缓存)', () => {
    expect(Object.keys(simulation)).toEqual(['run']);
  });

  it('无状态:连着跑、中间插一次别的推演,结果都不受影响(也没有第二份真值)', () => {
    const first = hashOf(simulation.run({ world }));
    simulation.run({ world, params: { endYear: 900 } }); // 中间插一次别的推演
    const again = hashOf(simulation.run({ world }));
    expect(again).toBe(first);
    expect(first).toBe(hashOf(generateCiv(world))); // 和旧入口一致
  });
});

describe('Simulation façade · 只依赖纯计算(静态护栏)', () => {
  const src = readFileSync(new URL('../src/simulation/simulation.ts', import.meta.url), 'utf8');

  it('只 import src/gen/**;不碰界面 / 渲染 / Worker / DOM / React', () => {
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.startsWith('../gen/'), `façade 不该 import ${i}`).toBe(true);
    // 只看代码:文件头那些"不依赖 React / DOM / Worker"的话是注释,不算
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(/new Worker|document\.|window\.|React/.test(code)).toBe(false);
  });
});
