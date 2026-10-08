/**
 * 存档往返回归(RFC TASK-006):`生成 → 存 → 读 → 重新生成` 走完一整圈,重新长出来的世界和存的时候**逐字段一样**。
 *
 * 这是"存档只存种子 + 参数 + 修改"这套设计的前提:同种子 + 同参数 + 同修改 = 同一个世界,
 * 所以读档不是"把地形读回来",而是"按存档里的输入重新算一遍"。只要生成器改过、或某个修改没存全,
 * 读出来的就不是同一个世界 —— 这个文件守的就是这条。
 *
 * 覆盖:默认参数 / 全部参数都非默认 / 地形修改 / 草图 / 两者一起 /
 * 干预(推演结果一样)/ 地形大事(各段世界一样)/ 全部修改字段的保真 /
 * 序列化幂等 / 参数超范围(夹回并提示,不是静默生成错误世界)/ 生成器版本不同(明确提示)。
 *
 * 跨平台稳定性的分工见 tests/regression-determinism.test.ts 文件头;
 * 这里比的是"同一台机器上,重新生成的和原来的是不是同一个"。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World, type WorldParams } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { mergeUpheavals, type UpheavalStep } from '../src/gen/civ/upheaval';
import { sketchGrid, type Sketch, type SketchEdit } from '../src/gen/sketch';
import { buildChronicle } from '../src/gen/civ/chronicle';
import { rasterize } from '../src/gen/raster';
import {
  EMPTY_EDITS,
  GENERATOR_VERSION,
  polityKey,
  type AuthorMark,
  type Intervention,
  type TerrainOp,
  type Upheaval,
  type WorldEdits,
} from '../src/gen/edits';
import type { AuthorCharacter } from '../src/gen/characters';
import { SAVE_FORMAT, checkWarning, makeSave, parseSave, saveText, versionNote, worldCheck, type SaveFile } from '../src/gen/savefile';
import { changedFields, fieldsOf, hashOf } from './lib/fingerprint';

const SMALL: WorldParams = { ...DEFAULT_PARAMS, cells: 8000 };

// ---------------------------------------------------------------------------
// 完整一圈

/** 生成 → 存档 → 序列化 → 读档 → 按存档重新生成 */
function roundtrip(params: WorldParams, edits: WorldEdits) {
  const world = generateWorld(params, undefined, edits.terrain, sketchGrid(edits.sketch));
  const save = makeSave(params, edits, worldCheck(world));
  const text = saveText(save);
  const r = parseSave(text);
  if (!r.ok) throw new Error(`读档失败:${r.error}`);
  const again = generateWorld(r.save.params, undefined, r.save.edits.terrain, sketchGrid(r.save.edits.sketch));
  return { world, save, text, parsed: r.save, warnings: r.warnings, again };
}

/** 世界 + 文明 + 编年史 + 铺像素的全部字段(比 worldCheck 宽:worldCheck 只看网格数、海拔、海陆、生物群系) */
function fullFields(w: World, civ?: Civ): Record<string, string> {
  const out = { ...fieldsOf('world.', w) };
  if (civ) Object.assign(out, fieldsOf('civ.', civ), { chronicle: hashOf(buildChronicle(civ)) });
  return { ...out, ...fieldsOf('raster.', rasterize(w)) };
}

/** 一条断言:整圈下来重新生成的世界和原来逐字段一样 */
function expectSameWorld(params: WorldParams, edits: WorldEdits): { world: World; parsed: SaveFile; warnings: string[] } {
  const { world, save, parsed, warnings, again } = roundtrip(params, edits);
  const diff = changedFields(fieldsOf('world.', world), fieldsOf('world.', again));
  expect(diff, '重新生成的世界和存档前不是一个').toEqual([]);
  expect(worldCheck(again)).toBe(save.check);
  expect(checkWarning(parsed, worldCheck(again))).toBeNull();
  return { world, parsed, warnings };
}

// 各段世界:第 k 段 = 原来的地形套上前 k + 1 件大事的修改(和 worker.ts 的 stepsOf 同一套)
function eraSteps(params: WorldParams, terrain: readonly TerrainOp[] | undefined, sketch: Sketch | null, list: readonly Upheaval[]): UpheavalStep[] {
  let all: TerrainOp[] = [...(terrain ?? [])];
  return mergeUpheavals(list).map((m) => {
    all = [...all, ...m.ops];
    return { year: m.year, ops: m.ops, items: m.items, world: generateWorld(params, undefined, all, sketch) };
  });
}

const TERRAIN: TerrainOp[] = [
  { kind: 'volcano', pts: [640, 380], r: 40, s: 1 },
  { kind: 'range', pts: [900, 300, 1000, 420, 1150, 460], r: 25, s: 1.2 },
  { kind: 'lake', pts: [1300, 600], r: 30, s: 1 },
];
const SKETCH: SketchEdit = {
  rest: 'auto',
  strokes: [
    { kind: 'land', r: 60, pts: [700, 300, 760, 310, 820, 330] },
    { kind: 'mountain', r: 40, h: 2, pts: [700, 300, 760, 310] },
    { kind: 'isles', r: 30, pts: [1200, 600] },
  ],
};
const UPHEAVALS: Upheaval[] = [
  { year: 1200, ops: [{ kind: 'volcano', pts: [600, 500], r: 60, s: 1.4 }] },
  { year: 2200, ops: [{ kind: 'raise', pts: [1400, 400, 1600, 520], r: 70, s: 1.2 }] },
];

// ---------------------------------------------------------------------------

describe('存档往返 · 地形', () => {
  it('默认参数:读档重新生成,世界逐字段一样', () => {
    const { world } = expectSameWorld({ ...SMALL, seed: 7 }, EMPTY_EDITS);
    expect(worldCheck(world)).toMatch(/^[0-9a-f]{12}$/);
  }, 60_000);

  it('每个参数都非默认:参数一个不丢地存回来', () => {
    const params: WorldParams = { seed: 2024, cells: 6000, landFraction: 0.55, plates: 7, mountains: 1.7, temperature: -9, rainfall: 0.6 };
    const { parsed } = expectSameWorld(params, EMPTY_EDITS);
    expect(parsed.params).toEqual(params);
  }, 60_000);

  it('改了 3 处地形:重新生成的地形一样', () => {
    expectSameWorld({ ...SMALL, seed: 7 }, { ...EMPTY_EDITS, terrain: TERRAIN });
  }, 60_000);

  it('画了草图:照草图长出来的世界重新生成也一样', () => {
    expectSameWorld({ ...SMALL, seed: 7 }, { ...EMPTY_EDITS, sketch: SKETCH });
  }, 60_000);

  it('地形修改 + 草图一起:一样', () => {
    expectSameWorld({ ...SMALL, seed: 7 }, { ...EMPTY_EDITS, terrain: TERRAIN, sketch: SKETCH });
  }, 60_000);

  it('存档格式 / 生成器版本钉在这里:改了必须是有意识的(动它就得动这个测试)', () => {
    expect(SAVE_FORMAT).toBe(1);
    expect(GENERATOR_VERSION).toBe(9);
    const { save } = roundtrip({ ...SMALL, seed: 7 }, EMPTY_EDITS);
    expect(save.app).toBe('文明与地图');
    expect(save.format).toBe(SAVE_FORMAT);
    expect(save.generator).toBe(GENERATOR_VERSION);
  }, 60_000);
});

describe('存档往返 · 干预与地形大事', () => {
  /** 按不干预时的历史挑几条干预(键按结果取,确定性) */
  function pick(civ: Civ): Intervention[] {
    const out: Intervention[] = [];
    const P = civ.polities.length;
    if (P >= 2) {
      out.push({ kind: 'declare', a: polityKey(civ, 0), b: polityKey(civ, 1), from: 900 });
      out.push({ kind: 'protect', a: polityKey(civ, 1), from: 1000 });
    }
    if (P >= 3) out.push({ kind: 'halt', a: polityKey(civ, 2), from: 600, until: 1800 });
    return out;
  }

  it('干预:读档后按同样的干预推演,文明逐字段一样(人没丢、时序没变)', () => {
    const params = { ...SMALL, seed: 7 };
    // 先按不干预时的历史挑出干预(键按结果取,确定性),再带着它们存档 —— 存的就是推演时用的那一份
    const world = generateWorld(params, undefined, TERRAIN, null);
    const list = pick(generateCiv(world));
    expect(list.length).toBeGreaterThan(0);
    const edits: WorldEdits = { ...EMPTY_EDITS, terrain: TERRAIN, interventions: list };

    const { parsed, warnings, again } = roundtrip(params, edits);
    expect(warnings).toEqual([]);
    expect(parsed.edits.interventions).toEqual(list);
    expect(changedFields(fieldsOf('world.', world), fieldsOf('world.', again))).toEqual([]);

    const diff = changedFields(
      fieldsOf('civ.', generateCiv(world, { interventions: list })),
      fieldsOf('civ.', generateCiv(again, { interventions: parsed.edits.interventions })),
    );
    expect(diff, '按存档里的干预推出来的历史和原来不一样').toEqual([]);
  }, 120_000);

  it('地形大事:读档后各段世界、之后的历史都一样', () => {
    const params = { ...SMALL, seed: 7 };
    const edits: WorldEdits = { ...EMPTY_EDITS, terrain: TERRAIN, upheavals: UPHEAVALS };
    const { world, parsed } = expectSameWorld(params, edits);
    // 存的时候 check 只核对"原来的地形"(不含大事),读回来的也是
    expect(parsed.check).toBe(worldCheck(world));

    const before = eraSteps(params, TERRAIN, null, UPHEAVALS);
    const after = eraSteps(parsed.params, parsed.edits.terrain, sketchGrid(parsed.edits.sketch), parsed.edits.upheavals ?? []);
    expect(after.length).toBe(before.length);
    expect(hashOf(after.map((s) => ({ year: s.year, ops: s.ops, items: s.items })))).toBe(hashOf(before.map((s) => ({ year: s.year, ops: s.ops, items: s.items }))));
    for (let i = 0; i < before.length; i++) {
      expect(changedFields(fieldsOf('world.', before[i].world), fieldsOf('world.', after[i].world)), `第 ${i} 段不一样`).toEqual([]);
    }
    // 带着大事推出来的历史也一样
    const diff = changedFields(
      fieldsOf('civ.', generateCiv(world, { upheavals: before })),
      fieldsOf('civ.', generateCiv(generateWorld(parsed.params, undefined, parsed.edits.terrain, sketchGrid(parsed.edits.sketch)), { upheavals: after })),
    );
    expect(diff, '按存档里的大事推出来的历史和原来不一样').toEqual([]);
  }, 180_000);
});

describe('存档往返 · 修改字段的保真', () => {
  const MARKS: AuthorMark[] = [
    { id: 1, title: '主角的故乡', color: 'red', from: 2490, at: [1852, 512] },
    { id: 2, title: '旧战场', note: '两国在这里打过一仗', color: 'teal', from: 1200, to: 1800, regions: ['region:c812'] },
  ];
  const CHARACTERS: AuthorCharacter[] = [
    {
      id: 1,
      name: '林小满',
      color: 'red',
      born: 2490,
      died: 2561,
      birthplace: [1852, 512],
      role: '游历者',
      note: '作者写的',
      life: [{ year: 2506, text: '随军西征', where: 'region:c812' }],
    },
  ];

  it('改名 / AI 起名的记号 / 改的旗 / 标记 / 人物 / 干预:原样存、原样读回', () => {
    const edits: WorldEdits = {
      names: { 'settlement:c4567#0': '饕餮城', 'region:c812': '九嶷州' },
      aiNames: { 'settlement:c4567#0': { name: '饕餮城', was: '饕餮' } },
      flags: { 'polity:c45#0': 'b/plain/W/e=R/k=long' },
      marks: MARKS,
      characters: CHARACTERS,
      interventions: [{ kind: 'protect', a: 'polity:c45#0', from: 1200 }],
      terrain: TERRAIN,
    };
    const { parsed, warnings } = roundtrip({ ...SMALL, seed: 7 }, edits);
    expect(warnings).toEqual([]);
    expect(parsed.edits.names).toEqual(edits.names);
    expect(parsed.edits.aiNames).toEqual(edits.aiNames);
    expect(parsed.edits.flags).toEqual(edits.flags);
    expect(parsed.edits.marks).toEqual(edits.marks);
    expect(parsed.edits.characters).toEqual(edits.characters);
    expect(parsed.edits.interventions).toEqual(edits.interventions);
    expect(parsed.edits.terrain).toEqual(edits.terrain);
  }, 60_000);

  it('没起名 / 没改任何东西时,可选字段不写进文件(存档保持精简)', () => {
    const save = makeSave({ ...SMALL, seed: 7 }, EMPTY_EDITS, 'aaaaaaaaaaaa');
    const raw = JSON.parse(saveText(save)) as Record<string, unknown>;
    expect(raw.title).toBeUndefined();
    expect(raw.view).toBeUndefined();
    expect(raw.origin).toBeUndefined();
    const ed = raw.edits as Record<string, unknown>;
    for (const k of ['aiNames', 'sketch', 'upheavals', 'marks', 'flags', 'characters']) expect(ed[k], `${k} 不该写进去`).toBeUndefined();
  });

  it('世界名 / 投影 / 出处:往返不变', () => {
    const save = makeSave({ ...SMALL, seed: 7 }, EMPTY_EDITS, 'aaaaaaaaaaaa', '九州大陆', '2026-10-09T00:00:00.000Z', { projection: 'robinson', center: 120 }, {
      by: '明月',
      title: '苍澜界',
      url: 'https://example.com/s/k7Qm2xPa',
    });
    const r = parseSave(saveText(save));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.title).toBe('九州大陆');
    expect(r.save.savedAt).toBe('2026-10-09T00:00:00.000Z');
    expect(r.save.view).toEqual({ projection: 'robinson', center: 120 });
    expect(r.save.origin).toEqual({ by: '明月', title: '苍澜界', url: 'https://example.com/s/k7Qm2xPa' });
  });
});

describe('存档往返 · 序列化与降级', () => {
  it('序列化幂等:读出来再写回去,文本一模一样(存进浏览器 / 再分享不会越滚越大)', () => {
    const save = makeSave(
      { ...SMALL, seed: 7 },
      { ...EMPTY_EDITS, terrain: TERRAIN, sketch: SKETCH, marks: [{ id: 1, title: '甲', color: 'red', from: 100, at: [900, 500] }] },
      'aaaaaaaaaaaa',
      '九州',
    );
    const once = saveText(save);
    const r = parseSave(once);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(saveText(r.save)).toBe(once);
  }, 60_000);

  it('参数超出范围:读档时夹回合理值并**明确提示**,而不是静默当作同一个世界', () => {
    // 故意不按这些参数生成(40 万地块太慢):这里只验证"存档 → 读档"这一段的降级行为
    const wild = { ...SMALL, seed: 7, cells: 400000, plates: 999 };
    const save = makeSave(wild, EMPTY_EDITS, 'aaaaaaaaaaaa');
    const r = parseSave(saveText(save));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.join()).toContain('精细度');
    expect(r.warnings.join()).toContain('板块数量');
    expect(r.save.params.cells).toBe(200000);
    expect(r.save.params.plates).toBe(64);
    // 读档给出的参数和写进去的不是一回事 —— 这就是必须提示的原因(不提示 = 静默换了世界)
    expect(r.save.params.cells).not.toBe(wild.cells);
    // 夹过以后是稳定的:再存再读不再提示、值也不再变(不会每次打开都改一次)
    const again = parseSave(saveText(r.save));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.warnings).toEqual([]);
    expect(again.save.params).toEqual(r.save.params);
  }, 60_000);

  it('生成器版本不同:明确提示"来自旧版本"和变了什么,而不是静默当作同一个世界', () => {
    // 版本不同的存档:parseSave 给提示;checkWarning 不再重复(地形对不上是版本变化导致的)
    const older = { ...makeSave({ ...SMALL, seed: 7 }, EMPTY_EDITS, 'aaaaaaaaaaaa'), generator: 4 };
    const r = parseSave(saveText(older));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes('版本'))).toBe(true);
    expect(versionNote(4, false)).not.toBeNull();
    expect(checkWarning({ ...older, generator: 4 }, 'bbbbbbbbbbbb')).toBeNull();
    // 同版本、地形却对不上:这时必须提示(存档描述的世界和现在生成的不是同一个)
    expect(checkWarning({ ...older, generator: GENERATOR_VERSION }, 'bbbbbbbbbbbb')).not.toBeNull();
  });

  it('全流程一体的对账:世界 + 文明 + 编年史 + 铺像素,存档前后逐字段一样', () => {
    const params = { ...SMALL, seed: 7 };
    const edits: WorldEdits = { ...EMPTY_EDITS, terrain: TERRAIN, sketch: SKETCH };
    const world = generateWorld(params, undefined, edits.terrain, sketchGrid(edits.sketch));
    const save = makeSave(params, edits, worldCheck(world));
    const r = parseSave(saveText(save));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const again = generateWorld(r.save.params, undefined, r.save.edits.terrain, sketchGrid(r.save.edits.sketch));
    const diff = changedFields(fullFields(world, generateCiv(world)), fullFields(again, generateCiv(again)));
    expect(diff, '存档前后这些字段变了').toEqual([]);
  }, 120_000);
});
