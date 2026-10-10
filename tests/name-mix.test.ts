/**
 * 地名风格(每种语感几份,gen/names 的 NameMix):清理、按份数抽;不配 = 自动,和没有这一项逐字节一样;
 * 配了只换名字、不改历史,各民族只用有份数的语感、中式和音译的占比接近份数;没人住的地方按份数抽;存档往返。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ } from '../src/gen/civ/types';
import { MIX_SHARE_MAX, NAME_STYLES, NAME_STYLE_META, cleanMix, mixStyles, pickStyle, sameMix, type NameMix } from '../src/gen/names';
import { worldNameStyle } from '../src/gen/civ/places';
import { worldStyleId } from '../src/ai/prompts/names';
import { editCount, editsLost, makeSave, parseSave, saveText } from '../src/gen/savefile';
import type { Upheaval, WorldEdits } from '../src/gen/edits';
import { upheavalSteps } from '../src/gen/civ/upheaval';
import { reuseRegions } from '../src/ui/eras';
import { MIX_PRESETS, MIX_STYLES, autoMix, mixSummary, styleAreas } from '../src/ui/nameMix';

const SMALL = { ...DEFAULT_PARAMS, cells: 12000 };
const worlds = new Map<number, World>();
const worldOf = (seed: number) => {
  let w = worlds.get(seed);
  if (!w) worlds.set(seed, (w = generateWorld({ ...SMALL, seed })));
  return w;
};
const autos = new Map<number, Civ>();
const autoOf = (seed: number) => {
  let c = autos.get(seed);
  if (!c) autos.set(seed, (c = generateCiv(worldOf(seed))));
  return c;
};

const EASTERN = new Set(NAME_STYLES.filter((s) => s.family === 'eastern').map((s) => s.id));

/** 推演结束时各民族住的州数 */
function areas(civ: Civ): number[] {
  const a = new Array<number>(civ.cultures.length).fill(0);
  for (const c of civ.culture) if (c >= 0) a[c]++;
  return a;
}
/** 中式占的地方(百分比) */
function easternShare(civ: Civ): number {
  const a = areas(civ);
  const total = a.reduce((x, y) => x + y, 0);
  return (civ.cultures.reduce((s, cu, i) => (EASTERN.has(cu.style) ? s + a[i] : s), 0) / total) * 100;
}
/** 历史(和名字无关的部分) */
const history = (c: Civ) =>
  JSON.stringify({
    annals: c.annals.map((x) => [x.year, x.kind, x.a, x.b]),
    culture: Array.from(c.culture),
    polity: Array.from(c.polity),
    polities: c.polities.map((p) => [p.founded, p.ended, p.capital, p.dynasties?.length ?? 0]),
    settlements: c.settlements.map((s) => [s.cell, s.founded]),
    people: (c.people ?? []).map((p) => [p.born, p.died, p.polity, p.role]),
  });

describe('清理、按份数抽', () => {
  it('不带词库的语感清单(界面、存档用)和起名器的一一对应、顺序一致', () => {
    expect(NAME_STYLE_META.map((s) => [s.id, s.label, s.family])).toEqual(NAME_STYLES.map((s) => [s.id, s.label, s.family]));
  });

  it('cleanMix:认不出的语感、不是正数的去掉,取整、最多 MIX_SHARE_MAX 份;一份都没有 = 自动', () => {
    expect(cleanMix({ xianxia: 2.6, central: 0, desert: -1, nope: 3, imperial: 99 })).toEqual({ imperial: MIX_SHARE_MAX, xianxia: 3 });
    expect(cleanMix({})).toBeUndefined();
    expect(cleanMix({ central: 0 })).toBeUndefined();
    expect(cleanMix('xianxia')).toBeUndefined();
    expect(cleanMix([1, 2])).toBeUndefined();
    expect(cleanMix(null)).toBeUndefined();
    // 写出来按 NAME_STYLES 的顺序:同样的配比写出来的字一样
    expect(JSON.stringify(cleanMix({ xianxia: 1, imperial: 2 }))).toBe(JSON.stringify(cleanMix({ imperial: 2, xianxia: 1 })));
    expect(sameMix({ xianxia: 1, central: 0 }, { xianxia: 1 })).toBe(true);
    expect(sameMix(undefined, {})).toBe(true);
    expect(sameMix({ xianxia: 1 }, { xianxia: 2 })).toBe(false);
  });

  it('pickStyle:自动 = 全部等可能(和加这一项以前一样);配了按份数,0 份的抽不到', () => {
    for (let i = 0; i < 120; i++) {
      const r = i / 120;
      expect(pickStyle(undefined, r)).toBe(NAME_STYLES[Math.floor(r * NAME_STYLES.length)].id);
    }
    const mix = { xianxia: 3, imperial: 1 };
    const got = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      const s = pickStyle(mix, i / 400);
      got.set(s, (got.get(s) ?? 0) + 1);
    }
    // NAME_STYLES 里音译在前:帝国 1 份 = 前 1/4,江南 3 份 = 后 3/4
    expect(Object.fromEntries(got)).toEqual({ imperial: 100, xianxia: 300 });
    expect(mixStyles(undefined).length).toBe(NAME_STYLES.length);
    expect(mixStyles({ central: 2 }).map((x) => [x.style.id, x.share])).toEqual([['central', 2]]);
  });

  it('没人住的地方的语感:按份数抽,和 AI 那边说的一样', () => {
    const mixes: (NameMix | undefined)[] = [undefined, { xianxia: 1 }, { central: 2, desert: 1, elven: 5 }];
    for (const seed of [1, 7, 2024, 99999])
      for (const mix of mixes) {
        const st = worldNameStyle(seed, mix);
        expect(worldStyleId(seed, mix)).toBe(st);
        if (mix) expect(mix[st]).toBeGreaterThan(0);
      }
  });
});

describe('按份数起名(seed 7、2024)', () => {
  it('不配 / 一份都没有 = 自动:逐字节一样,civ 上不记', () => {
    const auto = autoOf(7);
    expect(auto.names).toBeUndefined();
    const empty = generateCiv(worldOf(7), { names: {} });
    expect(JSON.stringify(empty.cultures)).toBe(JSON.stringify(auto.cultures));
    expect(JSON.stringify(empty.polities)).toBe(JSON.stringify(auto.polities));
    expect(JSON.stringify(empty.places)).toBe(JSON.stringify(auto.places));
    expect(empty.names).toBeUndefined();
  });

  it('只换名字,历史一样;各民族只用有份数的语感;civ 上记清理过的配比', () => {
    for (const seed of [7, 2024]) {
      const auto = autoOf(seed);
      const mix = { central: 3, xianxia: 3, frontier: 1, imperial: 2, nordic: 1 };
      const civ = generateCiv(worldOf(seed), { names: mix });
      expect(history(civ)).toBe(history(auto));
      expect(civ.names).toEqual(cleanMix(mix));
      for (const cu of civ.cultures) expect(mix).toHaveProperty(cu.style);
      // 记下自动时会挑的语感(「照自动」用);自动时不记
      expect(civ.cultures.map((c) => c.autoStyle)).toEqual(auto.cultures.map((c) => c.style));
      expect(auto.cultures.some((c) => 'autoStyle' in c)).toBe(false);
      // 名字确实换了
      expect(civ.polities.map((p) => p.name)).not.toEqual(auto.polities.map((p) => p.name));
    }
  });

  it('新建时换了配比、重推回来:沿用原来的州(同一个对象),换上新起的州名', () => {
    const auto = autoOf(7);
    const before = auto.regions.name!.slice();
    const old = { ...auto, regions: { ...auto.regions, name: before.slice() } };
    const next = generateCiv(worldOf(7), { names: { central: 1, xianxia: 1 } });
    expect(next.regions.name).not.toEqual(before);
    const got = reuseRegions(old, next, true, true);
    expect(got.regions).toBe(old.regions);
    expect(got.regions.name).toEqual(next.regions.name);
    // 试推演(不换上去)不动原来那份
    const old2 = { ...auto, regions: { ...auto.regions, name: before.slice() } };
    expect(reuseRegions(old2, next, true).regions.name).toEqual(before);
  });

  it('只配一种:全世界都是它', () => {
    const civ = generateCiv(worldOf(7), { names: { mythic: 1 } });
    expect(new Set(civ.cultures.map((c) => c.style))).toEqual(new Set(['mythic']));
    expect(civ.polities.every((p) => p.eastern)).toBe(true);
  });

  it('中式、音译的占比接近份数(按推演结束时各民族住的州算)', () => {
    const cases: [NameMix, number][] = [
      [{ central: 2, xianxia: 2, frontier: 1, mythic: 2, imperial: 1, kingdom: 1, nordic: 1 }, 70],
      [{ central: 2, xianxia: 2, frontier: 2, mythic: 2, imperial: 1, kingdom: 1, nordic: 1, slavic: 1, hellenic: 1, desert: 1, steppe: 1, elven: 1 }, 50],
      [{ nordic: 8, xianxia: 2 }, 20],
    ];
    for (const seed of [7, 2024])
      for (const [mix, want] of cases) expect(Math.abs(easternShare(generateCiv(worldOf(seed), { names: mix })) - want)).toBeLessThanOrEqual(6);
  });

  it('配了份数的语感,民族够分时都有活着的民族用上(份数不匀、有的只配一两份也一样)', () => {
    const cases: [number, NameMix][] = [
      [7, { central: 1, xianxia: 1, frontier: 1, mythic: 1 }],
      [5, { hellenic: 4, frontier: 5, slavic: 3, central: 2, kingdom: 3, desert: 2 }],
      [2, { elven: 5, imperial: 5, central: 2, desert: 6, kingdom: 5, frontier: 2, hellenic: 4 }],
    ];
    for (const [seed, mix] of cases) {
      const civ = generateCiv(worldOf(seed), { names: mix });
      const a = areas(civ);
      expect(a.filter((x) => x > 0).length).toBeGreaterThanOrEqual(Object.keys(mix).length);
      expect(new Set(civ.cultures.filter((_, i) => a[i] > 0).map((c) => c.style))).toEqual(new Set(Object.keys(mix)));
    }
  });

  it('尽量少换(默认大小的 seed 7):照自动配好份数、把沙海调成 0 份,别的民族大多照旧', () => {
    const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
    const auto = generateCiv(world);
    const a = areas(auto);
    const total = a.reduce((x, y) => x + y, 0);
    const share = new Map<string, number>();
    auto.cultures.forEach((cu, i) => share.set(cu.style, (share.get(cu.style) ?? 0) + a[i]));
    expect(share.get('desert')).toBeGreaterThan(0);
    // 照自动:每种大约 5% 一份(界面上的「照自动」也这么折)
    const mix: Record<string, number> = {};
    for (const [s, n] of share) if (n > 0) mix[s] = Math.max(1, Math.round(((n / total) * 100) / 5));
    expect(generateCiv(world, { names: mix }).cultures.map((c) => c.style)).toEqual(auto.cultures.map((c) => c.style));
    delete mix.desert;
    const civ = generateCiv(world, { names: mix });
    expect(civ.cultures.some((c) => c.style === 'desert')).toBe(false);
    const others = auto.cultures.map((cu, i) => i).filter((i) => auto.cultures[i].style !== 'desert');
    const kept = others.filter((i) => civ.cultures[i].style === auto.cultures[i].style).length;
    expect(kept / others.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe('地形大事', () => {
  it('有地形大事的世界(默认大小的 seed 7):照样只换名字,大事前后的民族用同一种语感', () => {
    const params = { ...DEFAULT_PARAMS, seed: 7 };
    const flood: Upheaval = { year: 1600, ops: [{ kind: 'sink', pts: [1856, 574, 1936, 584], r: 40, s: 1.1 }] };
    const world = generateWorld(params);
    const upheavals = upheavalSteps(params, [], null, [flood]);
    const mix = { xianxia: 2, central: 1, kingdom: 1 };
    const auto = generateCiv(world, { upheavals });
    const civ = generateCiv(world, { upheavals, names: mix });
    expect(history(civ)).toBe(history(auto));
    for (const cu of civ.cultures) expect(mix).toHaveProperty(cu.style);
    expect(civ.cultures.map((c) => c.autoStyle)).toEqual(auto.cultures.map((c) => c.style));
    expect(civ.eras?.length).toBeGreaterThan(0);
  });

  it('大事改变了大片地方(早早沉下一大片):份数照真正的结局凑,不照没有大事的那份', () => {
    const params = { ...DEFAULT_PARAMS, seed: 7 };
    const sink: Upheaval = { year: 800, ops: [{ kind: 'sink', pts: [600, 300, 1400, 500, 1000, 800], r: 160, s: 1.2 }] };
    const world = generateWorld(params);
    const upheavals = upheavalSteps(params, [], null, [sink]);
    const auto = generateCiv(world, { upheavals });
    const civ = generateCiv(world, { upheavals, names: { central: 3, imperial: 7 } });
    expect(history(civ)).toBe(history(auto));
    // 照没有大事的那份结局凑时,这里只有 19%
    expect(Math.abs(easternShare(civ) - 30)).toBeLessThanOrEqual(5);
    expect(civ.eras?.[0].places.length).toBeGreaterThan(0);
  });
});

describe('存档', () => {
  const base: WorldEdits = { names: {}, interventions: [], terrain: [] };

  it('配比原样存、原样读回;自动不写', () => {
    const save = makeSave(DEFAULT_PARAMS, { ...base, nameMix: { xianxia: 6, central: 4 } }, 'abc');
    const back = parseSave(saveText(save));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.save.edits.nameMix).toEqual({ central: 4, xianxia: 6 });
    expect(back.warnings).toEqual([]);
    const plain = makeSave(DEFAULT_PARAMS, base, 'abc');
    expect('nameMix' in plain.edits).toBe(false);
  });

  it('认不出的语感、坏的份数去掉,提示一句;一份都不剩按自动', () => {
    const save = JSON.parse(saveText(makeSave(DEFAULT_PARAMS, base, 'abc')));
    save.edits.nameMix = { xianxia: 2, future: 3 };
    let back = parseSave(JSON.stringify(save));
    expect(back.ok && back.save.edits.nameMix).toEqual({ xianxia: 2 });
    expect(back.ok && back.warnings.some((w) => w.includes('地名风格'))).toBe(true);
    save.edits.nameMix = 'xianxia';
    back = parseSave(JSON.stringify(save));
    expect(back.ok && back.save.edits.nameMix).toBeUndefined();
    expect(back.ok && back.warnings.some((w) => w.includes('地名风格认不出来'))).toBe(true);
  });

  it('改了几处:配了地名风格算一处,自动不算', () => {
    expect(editCount(base)).toBe(0);
    expect(editCount({ ...base, nameMix: { xianxia: 6, central: 4 } })).toBe(1);
    expect(editCount({ ...base, names: { 'state:0': '大靖' }, nameMix: { xianxia: 1 } })).toBe(2);
  });

  it('打开别人的链接会丢掉的改动:配比不同只算一处', () => {
    const a = makeSave(DEFAULT_PARAMS, { ...base, nameMix: { xianxia: 6, central: 4, desert: 1 } }, 'abc');
    const b = makeSave(DEFAULT_PARAMS, { ...base, nameMix: { xianxia: 1 } }, 'abc');
    expect(editsLost(a, b)).toBe(1);
    expect(editsLost(a, a)).toBe(0);
  });
});

describe('界面上的地名风格', () => {
  it('12 种都有颜色和例子,中式在前', () => {
    expect(MIX_STYLES.map((s) => s.id).sort()).toEqual(NAME_STYLES.map((s) => s.id).sort());
    expect(MIX_STYLES.slice(0, 4).every((s) => s.family === 'eastern')).toBe(true);
    for (const s of MIX_STYLES) {
      expect(s.color).toMatch(/^#[0-9A-F]{6}$/);
      expect(s.examples).not.toBe('');
      expect(s.label).toMatch(/（.+）$/);
    }
    expect(new Set(MIX_STYLES.map((s) => s.color)).size).toBe(MIX_STYLES.length);
  });

  it('占比按推演结束时住的州算;照自动的份数按自动时的风格折(大约 5% 一份),自己配时也照自动那份算', () => {
    const auto = autoOf(7);
    const { share, peoples } = styleAreas(auto);
    expect(Object.values(share).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(peoples).toBe(areas(auto).filter((a) => a > 0).length);
    const m = autoMix(auto);
    for (const [id, v] of Object.entries(share)) expect(m[id]).toBe(Math.min(MIX_SHARE_MAX, Math.max(1, Math.round((v * 100) / 5))));
    expect(Object.keys(m).length).toBe(Object.keys(share).length);
    const civ = generateCiv(worldOf(7), { names: { central: 1, imperial: 1 } });
    expect(autoMix(civ)).toEqual(m);
    // 没有文明:每种 1 份
    expect(Object.values(autoMix(null))).toEqual(new Array(12).fill(1));
  });

  it('摘要和快捷按钮', () => {
    expect(mixSummary(undefined)).toBe('自动');
    expect(mixSummary({})).toBe('自动');
    expect(mixSummary({ central: 3, xianxia: 3, frontier: 1, imperial: 2, nordic: 1 })).toBe('中式 70%、音译 30%');
    const [east, west, half] = MIX_PRESETS;
    expect(mixSummary(east.mix)).toBe('全中式');
    expect(mixSummary(west.mix)).toBe('全音译');
    expect(mixSummary(half.mix)).toBe('中式 50%、音译 50%');
    expect(Object.keys(west.mix).length).toBe(8);
  });
});
