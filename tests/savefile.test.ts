/**
 * 存档 / 读档(阶段 4):makeSave → JSON → parseSave 往返不变;坏文件、别的 JSON、未来版本给中文错误 / 提示;
 * worldCheck 确定性;州改名的稳定键 region:r123 往返;浏览器存储(saveStore)= "我的世界":一个世界一个编号、
 * 新建中 / 建好的 / 打开的链接各自什么时候存、复制一份、从文件打开、旧编号迁移、自动存 / 恢复、
 * 存储不可用(隐私模式)时退回内存、配额满了删最旧的;这几种情况顶部提示条上说一句;读档提示的短说法。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyNotes, getNote, listNotes, putNote, replaceNotes } from '../src/ai/library';
import { asHistoryNote } from '../src/ai/history';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ } from '../src/gen/civ/types';
import { buildChronicle, chronicleText, interventionOutcome } from '../src/gen/civ/chronicle';
import { regionLabel } from '../src/gen/civ/display';
import { EMPTY_EDITS, GENERATOR_CHANGES, GENERATOR_VERSION, applyNames, regionKey, resolveKey, upgradeLegacyKeys, type WorldEdits } from '../src/gen/edits';
import {
  CHECK_WARNING,
  NEWER_NOTE,
  SAVE_APP,
  DEFAULT_VIEW,
  checkWarning,
  cleanView,
  decodeShare,
  editCount,
  encodeShare,
  fileBaseName,
  makeSave,
  parseSave,
  saveFileName,
  saveText,
  versionNote,
  worldCheck,
  worldKey,
  cleanOrigin,
  cleanSignature,
  type SaveFile,
  type SaveOrigin,
} from '../src/gen/savefile';
import { BUNDLE_FORMAT, bundleFileName, bundleText, importBundle, openBundleText, parseBundle } from '../src/ui/bundle';
import { forgetNotes } from '../src/ai/library';
import * as saveStore from '../src/ui/saveStore';
import { clearEdits, getEdits, setEdits, setName } from '../src/ui/editsStore';
import { getProjection, setProjection } from '../src/ui/projection';
import { getMapCenter, publishMapCenter } from '../src/ui/mapWrap';
import { _resetToasts, clearToast, getToast, peekToast } from '../src/ui/toastStore';

const SMALL = { ...DEFAULT_PARAMS, cells: 12000 };
const worlds = new Map<number, World>();
function worldOf(seed: number): World {
  let w = worlds.get(seed);
  if (!w) worlds.set(seed, (w = generateWorld({ ...SMALL, seed })));
  return w;
}
let civ7: Civ | undefined;
const civOf7 = () => (civ7 ??= generateCiv(worldOf(7)));

const EDITS: WorldEdits = {
  names: { 'settlement:r123#0': '饕餮城', 'polity:r45#0': '秦', 'region:r7': '九嶷州', 'place:river@c4567#0': '弱水' },
  // 干预:存档里当成不透明的数组,原样存、原样读回
  // (第二条是认不出的种类:存档照样原样存、原样读回,推演时由 cleanInterventions 丢掉)
  interventions: [
    { kind: 'protect', a: 'polity:r45#0', from: 1200 },
    { kind: 'war', from: 1800, a: 'polity:r1#0', b: 'polity:r2#0', extra: { deep: [1, 2] } },
  ] as unknown as WorldEdits['interventions'],
  // 地形修改的往返在 terrain-edits.test.ts
  terrain: [],
};
/** 一条 AI 写的东西(史书) */
const NOTE = { key: '史书:world', kind: '史书', title: '世界通史', text: '……', createdAt: '2026-10-04T08:00:00.000Z', provider: 'mock', model: 'mock' };

describe('存档文件 · 往返', () => {
  it('makeSave → JSON → parseSave 不变', () => {
    const p = { ...DEFAULT_PARAMS, seed: 7, landFraction: 0.41, plates: 20 };
    const save = makeSave(p, EDITS, 'abc123def456', '九州大陆', '2026-09-27T08:00:00.000Z');
    expect(save).toMatchObject({ app: SAVE_APP, format: 1, generator: GENERATOR_VERSION, seed: 7, check: 'abc123def456', title: '九州大陆' });
    const r = parseSave(saveText(save));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.save).toEqual(save);
    expect(r.save.edits.interventions).toEqual(EDITS.interventions);
    // 存档是复制出来的:之后改原来的修改不影响存档
    const names = { ...EDITS.names };
    const s2 = makeSave(p, { ...EDITS, names }, 'x');
    names['region:r7'] = '别的名字';
    expect(s2.edits.names['region:r7']).toBe('九嶷州');
  });

  it('没起名的存档不带 title;参数按固定顺序、缺的补默认值', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 9 }, EMPTY_EDITS, 'c', '   ');
    expect('title' in save).toBe(false);
    expect(Object.keys(save.params)).toEqual(Object.keys(DEFAULT_PARAMS));
    const r = parseSave(JSON.stringify({ app: SAVE_APP, format: 1, generator: GENERATOR_VERSION, seed: 9, params: { seed: 9 }, edits: {}, check: 'c', savedAt: '' }));
    expect(r.ok && r.save.params).toEqual({ ...DEFAULT_PARAMS, seed: 9 });
    expect(r.ok && r.save.edits).toEqual({ names: {}, interventions: [], terrain: [] });
    expect(r.ok && r.warnings).toEqual([]);
  });

  it('文件名:带世界名,没名字用种子;去掉文件名里不能用的字符', () => {
    expect(saveFileName({ title: '九州大陆', seed: 7 })).toBe('文明与地图-九州大陆.json');
    expect(saveFileName({ seed: 2024 })).toBe('文明与地图-种子2024.json');
    expect(saveFileName({ title: 'a/b:c*?', seed: 1 })).toBe('文明与地图-abc.json');
    // 导出的图片、编年史用同一个开头
    expect(fileBaseName({ title: '九州大陆', seed: 7 })).toBe('文明与地图-九州大陆');
    expect(fileBaseName({ title: '  ', seed: 7 })).toBe('文明与地图-种子7');
  });

  it('改了几处 = 改名条数 + 干预条数', () => {
    expect(editCount(EDITS)).toBe(6);
    expect(editCount(EMPTY_EDITS)).toBe(0);
  });

  it('世界的身份:种子 + 全部参数', () => {
    expect(worldKey({ ...DEFAULT_PARAMS, seed: 7 })).toBe(worldKey({ ...DEFAULT_PARAMS, seed: 7 }));
    expect(worldKey({ ...DEFAULT_PARAMS, seed: 7 })).not.toBe(worldKey({ ...DEFAULT_PARAMS, seed: 7, plates: 15 }));
  });
});

describe('存档文件 · 坏文件、别的 JSON、别的版本', () => {
  const good = () => JSON.parse(saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c'))) as Record<string, unknown>;
  const err = (text: string) => {
    const r = parseSave(text);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.error;
  };
  const zh = /[一-鿿]/;

  it('不是 JSON / 空文件 / 别的 JSON:中文错误', () => {
    for (const t of ['', '   ', '{坏了', '<html></html>', 'null', '[]', '42', '"文明与地图"', '{"name":"package","version":"1.0.0"}', '{"app":"别的应用","format":1,"seed":7}']) {
      const e = err(t);
      expect(e).toMatch(zh);
    }
    expect(err('{"name":"x"}')).toContain('不是「文明与地图」的存档');
  });

  it('缺格式版本、缺种子:中文错误', () => {
    const a = good();
    delete a.format;
    expect(err(JSON.stringify(a))).toContain('格式');
    const b = good();
    delete b.seed;
    (b.params as Record<string, unknown>).seed = 'abc';
    expect(err(JSON.stringify(b))).toContain('种子');
  });

  it('未来的存档格式:不读,提示更新页面', () => {
    const a = { ...good(), format: 2 };
    expect(err(JSON.stringify(a))).toMatch(/更新版本.*刷新页面/);
  });

  it('生成器版本不同:照样打开,提示"来自旧版本"和变了什么 / "来自更新的版本"', () => {
    const old = parseSave(JSON.stringify({ ...good(), generator: 6 }));
    expect(old.ok && old.warnings).toEqual(['来自旧版本：陆地和山没变，气候、河流和历史都重算了']);
    const newer = parseSave(JSON.stringify({ ...good(), generator: GENERATOR_VERSION + 1 }));
    expect(newer.ok && newer.warnings).toEqual([NEWER_NOTE]);
    expect(old.ok && old.save.edits).toEqual(EDITS);
  });

  it('只动了改过地形的世界的那一版:没改地形的世界不按它说,改过的按它说', () => {
    // 7 → 现在:第 8 版只动了改过地形的世界(历史重新推演),第 9 版人人都有(编年史的字)
    const plain = parseSave(JSON.stringify({ ...good(), generator: 7 }));
    expect(plain.ok && plain.warnings).toEqual(['来自旧版本：疆域和兴亡没变，编年史写得更细了']);
    const g = good();
    g.generator = 7;
    (g.edits as Record<string, unknown>).terrain = [{ kind: 'volcano', pts: [812, 403], r: 28, s: 1.05 }];
    const edited = parseSave(JSON.stringify(g));
    expect(edited.ok && edited.warnings).toEqual(['来自旧版本：地形和气候没变，历史重新推演了']);
    // 地形修改全是坏的(读进来一处都没有)= 按没改地形生成,也就没变
    (g.edits as Record<string, unknown>).terrain = [{ kind: 'meteor', pts: [1, 2] }];
    const bad = parseSave(JSON.stringify(g));
    expect(bad.ok && bad.warnings).toEqual(['来自旧版本：疆域和兴亡没变，编年史写得更细了', '有 1 处地形修改格式不对,已跳过']);
  });

  it('版本提示排在参数提示之后、改名提示之前', () => {
    const a = good();
    a.generator = 4;
    a.params = { ...(a.params as object), plates: 'many' };
    (a.edits as Record<string, unknown>).names = { 'region:r7': '九嶷州', bad: 3 };
    const r = parseSave(JSON.stringify(a));
    expect(r.ok && r.warnings).toEqual(['存档里的板块数量不对,已改成合理的值', versionNote(4, false), '有 1 处改名格式不对,已跳过']);
  });

  it('参数超出范围 / 不是数:调回合理的值并提示', () => {
    const a = good();
    a.params = { ...(a.params as object), cells: 1e9, plates: 'many', rainfall: -3 };
    const r = parseSave(JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.params.cells).toBe(200000);
    expect(r.save.params.plates).toBe(DEFAULT_PARAMS.plates);
    expect(r.save.params.rainfall).toBe(0);
    expect(r.warnings.join()).toMatch(/精细度.*板块数量.*降水/);
  });

  it('个别改名、干预格式不对:跳过那几条,其余照读', () => {
    const a = good();
    a.edits = { names: { 'settlement:r1#0': '好名字', 'settlement:r2#0': 42, ['x'.repeat(200)]: '太长', nokey: '没冒号', 'place:sea@c1#0': '' }, interventions: [{ kind: 'protect', from: 1 }, 'bad', null, 3] };
    const r = parseSave(JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.edits.names).toEqual({ 'settlement:r1#0': '好名字' });
    expect(r.save.edits.interventions).toEqual([{ kind: 'protect', from: 1 }]);
    expect(r.warnings).toEqual(['有 4 处改名格式不对,已跳过', '有 3 条干预格式不对,已跳过']);
  });

  it('带 BOM 的文件照样读;世界名去掉控制字符、超长截断', () => {
    const a = { ...good(), title: '九州\u0000大陆' + '长'.repeat(40) };
    const r = parseSave('﻿' + JSON.stringify(a));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.title!.startsWith('九州大陆')).toBe(true);
    expect([...r.save.title!].length).toBe(24);
  });
});

describe('地形校验', () => {
  it('worldCheck:确定性(同种子 + 参数两次生成一样)、不同世界不一样、12 位十六进制', () => {
    const a = worldCheck(worldOf(7));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(worldCheck(generateWorld({ ...SMALL, seed: 7 }))).toBe(a);
    expect(worldCheck(worldOf(8))).not.toBe(a);
    expect(worldCheck(generateWorld({ ...SMALL, seed: 7, mountains: 1.05 }))).not.toBe(a);
  });

  it('checkWarning:同版本地形对不上才提示(版本不同、世界变了的 parseSave 已经提示过)', () => {
    const s = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EMPTY_EDITS, 'aaaa');
    expect(checkWarning(s, 'aaaa')).toBeNull();
    expect(checkWarning(s, 'bbbb')).toBe(CHECK_WARNING);
    expect(checkWarning({ ...s, generator: 6 }, 'bbbb')).toBeNull();
    expect(checkWarning({ ...s, check: '' }, 'bbbb')).toBeNull();
  });
});

describe('州改名 · region:c4567', () => {
  it('稳定键往返(按治所地块);旧格式 region:r123 照样认;格式不对 / 越界 / 水上的认不出', () => {
    const civ = civOf7();
    for (const r of [0, 1, Math.floor(civ.regions.count / 2), civ.regions.count - 1]) {
      expect(regionKey(civ, r)).toBe(`region:c${civ.regions.seat[r]}`);
      expect(resolveKey(civ, regionKey(civ, r))).toEqual({ kind: 'region', id: r });
      expect(resolveKey(civ, `region:r${r}`)).toEqual({ kind: 'region', id: r });
    }
    // 州里任何一个地块都指这一州
    const r = 5;
    const cells = Array.from(civ.regions.cells.subarray(civ.regions.cellStart[r], civ.regions.cellStart[r + 1]));
    for (const c of cells.slice(0, 5)) expect(resolveKey(civ, `region:c${c}`)).toEqual({ kind: 'region', id: r });
    const sea = civ.regions.of.findIndex((x) => x < 0);
    for (const k of ['region:r-1', `region:r${civ.regions.count}`, 'region:rabc', 'region:r1#0', 'region:', 'region:12', `region:c${sea}`, 'region:c-3', `region:c${civ.regions.of.length}`])
      expect(resolveKey(civ, k), k).toBeNull();
  });

  it('applyNames:州名换了,原 Civ 和 civ.regions 不动(画国土的缓存按它存),编年史跟着变', () => {
    const civ = civOf7();
    const before = JSON.stringify(civ.regions.name);
    // 编年史里出现过的一个州
    const text0 = chronicleText(buildChronicle(civ), '编年史');
    let r = civ.regions.name?.findIndex((n, i) => n && text0.includes(n) && civ.regions.name!.indexOf(n) === i) ?? -1;
    if (r < 0) r = 0;
    const old = regionLabel(civ, r);
    const c2 = applyNames(civ, { [regionKey(civ, r)]: '九嶷州' });
    expect(c2).not.toBe(civ);
    expect(c2.regions).toBe(civ.regions);
    expect(regionLabel(c2, r)).toBe('九嶷州');
    expect(regionLabel(civ, r)).toBe(old);
    expect(JSON.stringify(civ.regions.name)).toBe(before);
    // 别的州不变
    const other = (r + 1) % civ.regions.count;
    expect(regionLabel(c2, other)).toBe(regionLabel(civ, other));
    if (text0.includes(old)) {
      const text = chronicleText(buildChronicle(c2), '编年史');
      expect(text).toContain('九嶷州');
    }
    // 改回生成时的名字 = 没改
    const same = applyNames(civ, { [regionKey(civ, r)]: old });
    if (civ.regions.name?.[r]) expect(same).toBe(civ);
  });
});

// ---------------------------------------------------------------------------
// 浏览器存储

/** 假的 localStorage:可以限制总字数(模拟配额满了) */
class FakeStorage {
  map = new Map<string, string>();
  constructor(public cap = Infinity) {}
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    let used = 0;
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length;
    if (used + k.length + v.length > this.cap) {
      const e = new Error('quota') as Error & { name: string };
      e.name = 'QuotaExceededError';
      throw e;
    }
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** 隐私模式:一碰就抛错 */
const throwing = {
  get length(): number {
    throw new Error('SecurityError');
  },
  key() {
    throw new Error('SecurityError');
  },
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

const g = globalThis as { localStorage?: unknown };
let stopAuto: (() => void) | null = null;

function useStorage(s: unknown) {
  g.localStorage = s;
  saveStore._resetForTest();
  clearEdits();
  stopAuto?.();
  stopAuto = saveStore.startAutoSave();
}

/** 模拟 App 打开一个世界:换世界(先 detach 再清空),生成完套上修改(存着的就套存着的),再 attach */
function openWorld(seed: number, o: { id?: string; kind?: saveStore.WorldKind; title?: string; pristine?: boolean; edits?: WorldEdits; origin?: SaveOrigin; original?: SaveFile } = {}) {
  const p = { ...DEFAULT_PARAMS, seed };
  saveStore.detachWorld();
  clearEdits();
  const id = o.id ?? saveStore.newWorldId();
  const stored = saveStore.loadWorld(id);
  const edits = o.edits ?? stored?.save.edits ?? EMPTY_EDITS;
  setEdits(edits);
  saveStore.attachWorld({
    id,
    params: p,
    check: `check${seed}`,
    kind: o.kind ?? (stored ? (stored.draft ? 'draft' : 'created') : 'created'),
    title: o.title ?? stored?.save.title,
    saved: stored?.save.edits ?? edits,
    view: stored?.save.view,
    pristine: o.pristine,
    origin: o.origin ?? stored?.save.origin,
    original: o.original,
  });
  return id;
}

/** 时钟往前走一秒(存档时间、最近打开按毫秒记,同一毫秒里的先后分不出) */
let clock = Date.parse('2026-10-04T08:00:00.000Z');
function tick() {
  clock += 1000;
  vi.setSystemTime(clock);
}

describe('浏览器存储(saveStore)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    tick();
    useStorage(new FakeStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    stopAuto?.();
    stopAuto = null;
    delete g.localStorage;
    saveStore._resetForTest();
    clearEdits();
    _resetToasts();
  });

  it('世界编号:w + 小写字母数字,每次不同;网址里的 w= 先过一遍', () => {
    const a = saveStore.newWorldId();
    const b = saveStore.newWorldId();
    expect(a).toMatch(/^w[0-9a-z]{6,24}$/);
    expect(a).not.toBe(b);
    expect(saveStore.isWorldId(a)).toBe(true);
    expect(saveStore.isWorldId(worldKey({ ...DEFAULT_PARAMS, seed: 7 }))).toBe(true);
    for (const bad of [null, '', 'W123', 'w<script>', 'x'.repeat(500), 7]) expect(saveStore.isWorldId(bad)).toBe(false);
  });

  it('建好的世界一直存着(没有修改也在);改名自动存;换个世界再回来,修改自动恢复;改回原样也不删', () => {
    const id7 = openWorld(7);
    expect(saveStore.listWorlds().map((w) => [w.id, w.count, w.draft])).toEqual([[id7, 0, false]]);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.persistent()).toBe(true);
    expect(saveStore.loadWorld(id7)?.count).toBe(1);
    // 换世界:清空修改不算"改回原样"
    const id8 = openWorld(8);
    expect(getEdits()).toBe(EMPTY_EDITS);
    expect(saveStore.loadWorld(id7)?.count).toBe(1);
    // 回来:恢复
    openWorld(7, { id: id7 });
    expect(getEdits().names).toEqual({ 'settlement:r1#0': '饕餮城' });
    setName('settlement:r1#0', null);
    expect(saveStore.loadWorld(id7)?.count).toBe(0);
    expect(saveStore.listWorlds().map((w) => w.id).sort()).toEqual([id7, id8].sort());
  });

  it('同一个种子 + 参数能存好几个世界,各走各的', () => {
    const a = openWorld(7, { title: '苍澜界' });
    setName('settlement:r1#0', '饕餮城');
    const b = openWorld(7, { title: '苍澜界(另一段)' });
    setName('settlement:r1#0', '梼杌城');
    expect(a).not.toBe(b);
    expect(saveStore.loadWorld(a)?.save.edits.names['settlement:r1#0']).toBe('饕餮城');
    expect(saveStore.loadWorld(b)?.save.edits.names['settlement:r1#0']).toBe('梼杌城');
    expect(saveStore.listWorlds().length).toBe(2);
  });

  it('新建中:没动过不存;起了名就存成"没建完"(带着底稿);点了创建就算建好的,底稿不再记', () => {
    const base = { id: 'wbase000001', title: '苍澜界', names: 2, interventions: 1 };
    const id = saveStore.newWorldId();
    saveStore.detachWorld();
    clearEdits();
    saveStore.attachWorld({ id, params: { ...DEFAULT_PARAMS, seed: 7 }, check: 'c7', kind: 'draft', saved: EMPTY_EDITS, pristine: true, base });
    expect(saveStore.loadWorld(id)).toBeNull();
    expect(saveStore.currentWorld()).toMatchObject({ kind: 'draft', pristine: true });
    saveStore.renameWorld(id, '苍澜界(二)');
    const w = saveStore.loadWorld(id)!;
    expect(w).toMatchObject({ draft: true, base });
    expect(w.save.title).toBe('苍澜界(二)');
    expect(saveStore.currentWorld()?.pristine).toBe(false);
    saveStore.markCreated();
    expect(saveStore.loadWorld(id)).toMatchObject({ draft: false, base: undefined });
    expect(saveStore.currentWorld()?.kind).toBe('created');
    // 动过的新建世界重新打开(调了参数 = 换了参数生成):照常存
    const d = openWorld(9, { kind: 'draft', pristine: false });
    expect(saveStore.loadWorld(d)?.draft).toBe(true);
  });

  it('打开别人的链接(visit):先不存;改了才存进我的世界,从此算建好的', () => {
    const id = openWorld(7, { kind: 'visit', edits: EDITS });
    expect(saveStore.loadWorld(id)).toBeNull();
    // 只换投影不存
    setProjection('robinson');
    saveStore.viewChanged();
    expect(saveStore.loadWorld(id)).toBeNull();
    setProjection('equirect');
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)).toMatchObject({ draft: false, count: editCount(EDITS) + 1 });
    expect(saveStore.currentWorld()?.kind).toBe('created');
  });

  it('只是看看的世界里存了 AI 写的东西:这个世界跟着存进我的世界(刷新还找得到);新建中的不存', () => {
    const id = openWorld(7, { kind: 'visit' });
    putNote(id, { key: '史书:world', kind: '史书', title: '世界通史', text: '……', createdAt: '2026-10-04T08:00:00.000Z', provider: 'mock', model: 'mock' });
    expect(saveStore.loadWorld(id)).toMatchObject({ draft: false, count: 0 });
    expect(saveStore.currentWorld()?.kind).toBe('created');
    const d = openWorld(8, { kind: 'draft', pristine: true });
    saveStore.keepWorld(d);
    expect(saveStore.loadWorld(d)).toBeNull();
  });

  it('改名、删除;另起的名字加(二)(三),不和别的世界重名', () => {
    const id = openWorld(7);
    saveStore.renameWorld(id, '九州大陆');
    expect(saveStore.loadWorld(id)?.save.title).toBe('九州大陆');
    expect(saveStore.currentSave()?.title).toBe('九州大陆');
    expect(saveStore.nextTitle('九州大陆')).toBe('九州大陆（二）');
    // 不是当前世界的也能改名
    openWorld(8, { title: '九州大陆（二）' });
    saveStore.renameWorld(id, '神州');
    expect(saveStore.loadWorld(id)?.save.title).toBe('神州');
    expect(saveStore.nextTitle('九州大陆')).toBe('九州大陆（三）');
    expect(saveStore.nextTitle('九州大陆（二）')).toBe('九州大陆（三）');
    expect(saveStore.nextTitle('')).toBe('未命名世界（二）');
    saveStore.deleteWorld(id);
    expect(saveStore.listWorlds().map((w) => w.save.title)).toEqual(['九州大陆（二）']);
  });

  it('复制一份时存满了(世界个数到上限):删的是别的旧世界,不删原件(哪怕它最旧)', () => {
    const src = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 1 }, EDITS, 'check1', '最旧的'))!;
    const ids: string[] = [];
    for (let i = 2; i <= saveStore.MAX_WORLDS; i++) {
      tick();
      ids.push(saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: i }, EMPTY_EDITS, `check${i}`, `世界${i}`))!);
    }
    expect(saveStore.listWorlds().length).toBe(saveStore.MAX_WORLDS);
    tick();
    const copy = saveStore.duplicateWorld(src);
    expect(copy).toBeTruthy();
    const left = saveStore.listWorlds().map((w) => w.id);
    expect(left.length).toBe(saveStore.MAX_WORLDS);
    expect(left).toContain(src);
    expect(left).toContain(copy);
    // 删的是除原件以外最旧的那个
    expect(left).not.toContain(ids[0]);
  });

  it('复制一份:名字加(二),修改、缩略图、AI 写的东西都带上;删掉复制的那份不动原来的', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const id = openWorld(7, { title: '苍澜界', edits: EDITS });
    fake.setItem(`wenming-ditu:thumb:${id}`, 'data:image/jpeg;base64,AAAA');
    putNote(id, NOTE);
    saveStore.setWorldStats(13);
    const copy = saveStore.duplicateWorld(id)!;
    const w = saveStore.loadWorld(copy)!;
    expect(w.save.title).toBe('苍澜界（二）');
    expect(w.save.edits).toEqual(EDITS);
    expect(w).toMatchObject({ thumb: 'data:image/jpeg;base64,AAAA', alive: 13, draft: false });
    expect(copyNotes(id, copy)).toBe(true);
    expect(listNotes(copy)).toEqual([NOTE]);
    expect(JSON.parse(fake.getItem(`civ-atlas:ai-notes:${copy}`)!)).toEqual([NOTE]);
    saveStore.deleteWorld(copy);
    expect(fake.getItem(`civ-atlas:ai-notes:${copy}`)).toBeNull();
    expect(saveStore.loadWorld(id)?.save.edits).toEqual(EDITS);
    expect(saveStore.duplicateWorld('wnothere001')).toBeNull();
  });

  it('删除后撤销:存档、缩略图、AI 写的东西原样放回,列表里回到原来的位置;存不下 = 说没放回去', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const a = openWorld(7, { title: '苍澜界', edits: EDITS });
    fake.setItem(`wenming-ditu:thumb:${a}`, 'data:image/jpeg;base64,AAAA');
    putNote(a, NOTE);
    tick();
    const b = openWorld(8, { title: '赤霄纪' });
    const order = saveStore.listWorlds().map((w) => w.id);
    const before = new Map(fake.map);
    const gone = saveStore.deleteWorld(a)!;
    expect(saveStore.listWorlds().map((w) => w.id)).toEqual([b]);
    expect([...fake.map.keys()].some((k) => k.endsWith(a))).toBe(false);
    expect(saveStore.restoreWorld(gone)).toBe(true);
    expect(saveStore.listWorlds().map((w) => w.id)).toEqual(order);
    expect(new Map(fake.map)).toEqual(before);
    expect(saveStore.loadWorld(a)).toMatchObject({ thumb: 'data:image/jpeg;base64,AAAA' });
    expect(saveStore.loadWorld(a)?.save.edits).toEqual(EDITS);
    expect(listNotes(a)).toEqual([NOTE]);

    // 删了以后别的世界占满了存储:存档写不回去就不留半个(缩略图之类也不留)
    const again = saveStore.deleteWorld(a)!;
    let used = 0;
    for (const [k, v] of fake.map) used += k.length + v.length;
    fake.cap = used + 10;
    expect(saveStore.restoreWorld(again)).toBe(false);
    expect([...fake.map.keys()].some((k) => k.endsWith(a))).toBe(false);
    expect(saveStore.listWorlds().map((w) => w.id)).toEqual([b]);
  });

  it('撤销删除碰上别的页面:那边删了 = 没有可撤销的;那边又存过 = 以那边为准只补缺的;打开记录写不下 = 整个不放回', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const a = openWorld(7, { title: '苍澜界', edits: EDITS });
    fake.setItem(`wenming-ditu:thumb:${a}`, 'data:image/jpeg;base64,AAAA');
    putNote(a, NOTE);
    tick();
    const b = openWorld(8, { title: '赤霄纪' });
    const key = (p: string) => `${p}${a}`;
    const size = (ks: string[]) => ks.reduce((n, k) => n + k.length + (fake.getItem(k) ?? '').length, 0);
    const used = () => [...fake.map].reduce((n, [k, v]) => n + k.length + v.length, 0);

    // 删了以后别的页面(那边还开着)又自动存了一版:撤销不盖掉那一版,只补回缩略图、AI 写的东西这些没有的
    const gone = saveStore.deleteWorld(a)!;
    const newer = gone.keys.find(([k]) => k === key('wenming-ditu:world:'))![1].replace('苍澜界', '苍澜界二');
    fake.setItem(key('wenming-ditu:world:'), newer);
    expect(saveStore.restoreWorld(gone)).toBe(true);
    expect(fake.getItem(key('wenming-ditu:world:'))).toBe(newer);
    expect(saveStore.loadWorld(a)).toMatchObject({ thumb: 'data:image/jpeg;base64,AAAA' });
    expect(listNotes(a)).toEqual([NOTE]);
    expect(fake.getItem(key('wenming-ditu:meta:'))).not.toBeNull();

    // 存档写得下、打开记录写不下:整个不放回(不留一个"看着建完了"的半截)
    const must = [key('wenming-ditu:world:'), key('wenming-ditu:meta:'), key('civ-atlas:ai-notes:')];
    const mustSize = size(must);
    const again = saveStore.deleteWorld(a)!;
    fake.cap = used() + mustSize - 3;
    expect(saveStore.restoreWorld(again)).toBe(false);
    expect([...fake.map.keys()].some((k) => k.endsWith(a))).toBe(false);
    // 只差缩略图写不下:照样放回,缩略图再打开会重画
    fake.cap = used() + mustSize + 3;
    expect(saveStore.restoreWorld(again)).toBe(true);
    expect(fake.getItem(key('wenming-ditu:thumb:'))).toBeNull();
    expect(saveStore.listWorlds().map((w) => w.id)).toContain(a);
    fake.cap = Infinity;

    // 别的页面里已经删掉了(这一页还显示着):再删 = 清掉剩下的,没有可撤销的
    fake.removeItem(`wenming-ditu:world:${b}`);
    expect(saveStore.deleteWorld(b)).toBeNull();
    expect([...fake.map.keys()].some((k) => k.endsWith(b))).toBe(false);
  });

  it('复制 AI 写的东西:只在内存里的也带上;原来那份存在浏览器里、复制的存不下 = 说没存成', () => {
    // 隐私模式:都只在内存里,照样带上,不算失败
    useStorage(throwing);
    const a = openWorld(7, { title: '苍澜界' });
    putNote(a, NOTE);
    expect(copyNotes(a, 'wcopy000001')).toBe(true);
    expect(listNotes('wcopy000001')).toEqual([NOTE]);
    // 存储满了:内存里有,但说没存成
    const fake = new FakeStorage();
    useStorage(fake);
    const b = openWorld(8, { title: '赤水纪' });
    putNote(b, NOTE);
    fake.cap = 0;
    expect(copyNotes(b, 'wcopy000002')).toBe(false);
    expect(listNotes('wcopy000002')).toEqual([NOTE]);
    // 没写过东西的:什么都不用做
    expect(copyNotes('wnothere002', 'wcopy000003')).toBe(true);
  });

  it('不是当前世界的改名:最后修改时间跟着变,排到前面', () => {
    const a = openWorld(7, { title: '苍澜界' });
    tick();
    openWorld(8, { title: '赤水纪' });
    tick();
    saveStore.detachWorld();
    expect(saveStore.listWorlds().map((w) => w.save.title)).toEqual(['赤水纪', '苍澜界']);
    tick();
    saveStore.renameWorld(a, '九州大陆');
    expect(saveStore.loadWorld(a)?.save.savedAt).toBe(new Date(clock).toISOString());
    expect(saveStore.listWorlds().map((w) => w.save.title)).toEqual(['九州大陆', '赤水纪']);
  });

  it('本地信息写不进去:新存的没建完的世界不存(不然下次打开会当成建好的锁住);创建时说没存成', () => {
    // 存档写得进、本地信息写不进(只拦本地信息那一条)
    class NoMeta extends FakeStorage {
      setItem(k: string, v: string) {
        if (k.startsWith('wenming-ditu:meta:')) {
          const e = new Error('quota') as Error & { name: string };
          e.name = 'QuotaExceededError';
          throw e;
        }
        super.setItem(k, v);
      }
    }
    useStorage(new NoMeta());
    const d = openWorld(7, { kind: 'draft', pristine: true });
    setEdits({ ...EMPTY_EDITS, names: { a: '临川' } });
    expect(saveStore.loadWorld(d)).toBeNull();
    expect(saveStore.markCreated()).toBe(false);
    expect(saveStore.isStored(d)).toBe(false);
    // 写得进:创建时说存住了
    useStorage(new FakeStorage());
    openWorld(9, { kind: 'draft', pristine: true });
    expect(saveStore.markCreated()).toBe(true);
  });

  it('从文件打开:存成一个建好的世界;同一个文件再打开一次不重复存', () => {
    const file = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '九州大陆');
    const id = saveStore.importSave(file)!;
    const w = saveStore.loadWorld(id)!;
    expect(w).toMatchObject({ draft: false, count: editCount(EDITS) });
    expect(w.save.title).toBe('九州大陆');
    expect(w.save.edits).toEqual(EDITS);
    expect(saveStore.importSave(file)).toBe(id);
    // 名字不同:另存一个
    expect(saveStore.importSave({ ...file, title: '神州' })).not.toBe(id);
    expect(saveStore.listWorlds().length).toBe(2);
    // 打开它:套上的就是存着的,不重写
    openWorld(7, { id });
    expect(getEdits()).toEqual(EDITS);
  });

  it('从文件打开:只差投影的同一个世界,用文件里的投影;刚存进来的没有缩略图,打开后截一张', async () => {
    const file = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '九州大陆');
    const id = saveStore.importSave(file)!;
    tick();
    const view = { projection: 'robinson', center: 30 };
    expect(saveStore.importSave({ ...file, view })).toBe(id);
    expect(saveStore.loadWorld(id)?.save.view).toEqual(view);
    expect(saveStore.listWorlds().length).toBe(1);
    // 缩略图
    expect(saveStore.loadWorld(id)?.thumb).toBeFalsy();
    saveStore.setThumbMaker(() => 'data:image/jpeg;base64,CCCC');
    try {
      openWorld(7, { id });
      await new Promise((r) => setTimeout(r, 800));
      expect(saveStore.loadWorld(id)?.thumb).toBe('data:image/jpeg;base64,CCCC');
    } finally {
      saveStore.setThumbMaker(null);
    }
  });

  it('下了干预(历史重推):缩略图重截,紧接着改名也不会把这次重截盖掉;只改名不重截;重推中截不到就等等', async () => {
    const wait = () => new Promise((r) => setTimeout(r, 800));
    let n = 0;
    let busy = false;
    saveStore.setThumbMaker(() => (busy ? null : `data:image/jpeg;base64,T${++n}`));
    try {
      const id = openWorld(7, { title: '苍澜界' });
      await wait();
      expect(saveStore.loadWorld(id)?.thumb).toBe('data:image/jpeg;base64,T1');
      // 只改名:结束那一年的国家没变,缩略图不动
      setName('region:c1', '九嶷州');
      await wait();
      expect(saveStore.loadWorld(id)?.thumb).toBe('data:image/jpeg;base64,T1');
      // 下了一条干预(App 在重推,截不到),紧接着又改了个名
      busy = true;
      setEdits({ ...getEdits(), interventions: EDITS.interventions.slice(0, 1) });
      setName('region:c2', '赤水州');
      await wait();
      expect(saveStore.loadWorld(id)?.thumb).toBe('data:image/jpeg;base64,T1');
      // 推完了:重截
      busy = false;
      await wait();
      expect(saveStore.loadWorld(id)?.thumb).toBe('data:image/jpeg;base64,T2');
      // 加了一件地形大事(结束那一年的地形跟着变):同样重截
      setEdits({ ...getEdits(), upheavals: [{ year: 1600, ops: [{ kind: 'volcano', pts: [100, 100], r: 28, s: 1 }] }] });
      await wait();
      expect(saveStore.loadWorld(id)?.thumb).toBe('data:image/jpeg;base64,T3');
    } finally {
      saveStore.setThumbMaker(null);
    }
  });

  it('新建中改了地形(存成没建完)又换了一颗星球、没起名、参数默认:又算没动过,原来存的那份拿掉', () => {
    const id = openWorld(7, { kind: 'draft', pristine: true });
    setEdits({ ...EMPTY_EDITS, terrain: [{ kind: 'volcano', pts: [100, 100], r: 28, s: 1 }] as unknown as WorldEdits['terrain'] });
    expect(saveStore.loadWorld(id)).toMatchObject({ draft: true });
    // App 换种子:同一个编号、地形作废、又算没动过
    openWorld(8, { id, kind: 'draft', pristine: true, edits: EMPTY_EDITS });
    expect(saveStore.loadWorld(id)).toBeNull();
    expect(saveStore.listWorlds()).toEqual([]);
  });

  it('回到我的世界、又点开下面一直开着的那个:记一下最近打开,排到前面', () => {
    const a = openWorld(7, { title: '苍澜界' });
    tick();
    const b = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 8 }, EDITS, 'check8', '赤水纪'))!;
    expect(saveStore.listWorlds().map((w) => w.id)).toEqual([b, a]);
    tick();
    saveStore.markOpened(a);
    expect(saveStore.listWorlds().map((w) => w.id)).toEqual([a, b]);
    // 不是当前世界的:不管
    tick();
    saveStore.markOpened(b);
    expect(saveStore.listWorlds()[0].id).toBe(a);
  });

  it('以前按"种子 + 参数"存的世界:换成新编号,缩略图、AI 写的东西、旧版本的原样跟过去,当作建好的', () => {
    const fake = new FakeStorage();
    const old = worldKey({ ...DEFAULT_PARAMS, seed: 7 });
    fake.setItem(`wenming-ditu:world:${old}`, saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '九州大陆')));
    fake.setItem(`wenming-ditu:thumb:${old}`, 'data:image/jpeg;base64,BBBB');
    fake.setItem(`civ-atlas:ai-notes:${old}`, '{"n":2}');
    fake.setItem(`wenming-ditu:orig:${old}`, '{"原样":1}');
    useStorage(fake);
    const list = saveStore.listWorlds();
    expect(list.length).toBe(1);
    const w = list[0];
    expect(w.id).toMatch(/^w[0-9a-z]+$/);
    expect(w).toMatchObject({ draft: false, thumb: 'data:image/jpeg;base64,BBBB' });
    expect(w.save.title).toBe('九州大陆');
    expect(fake.getItem(`civ-atlas:ai-notes:${w.id}`)).toBe('{"n":2}');
    expect(fake.getItem(`wenming-ditu:orig:${w.id}`)).toBe('{"原样":1}');
    expect(fake.getItem(`wenming-ditu:world:${old}`)).toBeNull();
    expect(fake.getItem(`wenming-ditu:thumb:${old}`)).toBeNull();
    expect(fake.getItem(`wenming-ditu:orig:${old}`)).toBeNull();
    // 改版前的网址(只带种子、参数)刷新还找得回它;别的种子、参数不算
    expect(saveStore.legacyWorld({ ...DEFAULT_PARAMS, seed: 7 })?.id).toBe(w.id);
    expect(saveStore.legacyWorld({ ...DEFAULT_PARAMS, seed: 7, plates: 15 })).toBeNull();
    expect(saveStore.legacyWorld({ ...DEFAULT_PARAMS, seed: 8 })).toBeNull();
    // 删掉以后就找不回了(对照也一起清掉)
    saveStore.deleteWorld(w.id);
    expect(saveStore.legacyWorld({ ...DEFAULT_PARAMS, seed: 7 })).toBeNull();
    expect(fake.getItem(`wenming-ditu:legacy:${old}`)).toBeNull();
  });

  it('以前的世界换不了新编号(存储满了):照旧用老编号,改版前的网址照样找得回', () => {
    const text = saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '九州大陆'));
    const old = worldKey({ ...DEFAULT_PARAMS, seed: 7 });
    // 放得下这一份(和打开时探测用的一个小键),放不下第二份
    const fake = new FakeStorage(`wenming-ditu:world:${old}`.length + text.length + 100);
    fake.setItem(`wenming-ditu:world:${old}`, text);
    useStorage(fake);
    expect(saveStore.legacyWorld({ ...DEFAULT_PARAMS, seed: 7 })).toMatchObject({ id: old, draft: false });
    expect(saveStore.legacyWorld({ ...DEFAULT_PARAMS, seed: 7 })?.save.title).toBe('九州大陆');
  });

  it('列表按最近打开 / 修改排;现存几国记在本地(存着的才记)', () => {
    const a = openWorld(7);
    tick();
    const b = openWorld(8);
    expect(saveStore.listWorlds()[0].id).toBe(b);
    // 再打开 a:排到最前
    tick();
    openWorld(7, { id: a });
    expect(saveStore.listWorlds()[0].id).toBe(a);
    saveStore.setWorldStats(13);
    expect(saveStore.loadWorld(a)?.alive).toBe(13);
    // 没存的(打开的链接)不为这个占列表
    const v = openWorld(9, { kind: 'visit' });
    saveStore.setWorldStats(4);
    expect(saveStore.loadWorld(v)).toBeNull();
  });

  it('隐私模式(localStorage 一碰就抛错):不报错,退回只在内存里', () => {
    useStorage(throwing);
    expect(() => {
      const id = openWorld(7);
      setName('settlement:r1#0', '饕餮城');
      expect(saveStore.persistent()).toBe(false);
      expect(saveStore.listWorlds().map((w) => w.id)).toEqual([id]);
      openWorld(8);
      openWorld(7, { id });
      expect(getEdits().names).toEqual({ 'settlement:r1#0': '饕餮城' });
      saveStore.renameWorld(id, '九州');
      saveStore.deleteWorld(id);
    }).not.toThrow();
    // 第一次存的时候提示一句"浏览器不让存"(只说一次)
    expect(peekToast('storage')).toMatchObject({ kind: 'warn', text: '浏览器不让网页存数据', ttl: 10_000 });
    clearToast('storage');
    setName('settlement:r1#0', '梼杌城');
    expect(peekToast('storage')).toBe(null);
    // 没有 localStorage(Node、禁用了存储)也一样
    useStorage(undefined);
    openWorld(7);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.persistent()).toBe(false);
    expect(saveStore.listWorlds().length).toBe(1);
  });

  it('配额满了:删最旧的世界腾地方,当前世界存得下', () => {
    const fake = new FakeStorage(2000);
    useStorage(fake);
    const ids: string[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      tick();
      ids.push(openWorld(seed));
      setName('settlement:r1#0', `城${seed}`);
    }
    const left = saveStore.listWorlds().map((w) => w.id);
    expect(left).toContain(ids[5]);
    expect(left.length).toBeLessThan(6);
    // 删的是最旧的;顶部提示"浏览器存储已满 · 已删掉最旧的存档……"
    expect(left).not.toContain(ids[0]);
    const t = peekToast('storage');
    expect(t?.text).toBe('浏览器存储已满');
    expect(t?.more?.[0]).toMatch(/^已删掉最旧的存档「种子 \d+」/);
  });

  it('只记"最近打开"时存满了:删了最旧的世界,也提示一句', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const a = openWorld(7, { title: '最旧的' });
    tick();
    const b = openWorld(8, { title: '新的' });
    tick();
    // 存满:再多一个字都写不下
    let used = 0;
    for (const [k, v] of fake.map) used += k.length + v.length;
    fake.cap = used;
    _resetToasts();
    openWorld(8, { id: b });
    expect(saveStore.loadWorld(a)).toBeNull();
    expect(saveStore.loadWorld(b)).not.toBeNull();
    const t = peekToast('storage');
    expect(t?.text).toBe('浏览器存储已满');
    expect(t?.more?.[0]).toContain('最旧的');
  });

  it('配额满了、删光别的也存不下:提示"没能自动存档"(同一次满只说一回),腾出地方后接着存', () => {
    const fake = new FakeStorage(120);
    useStorage(fake);
    const id = openWorld(7);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)).toBe(null);
    expect(saveStore.storageIsFull()).toBe(true);
    expect(peekToast('storage')).toMatchObject({ kind: 'warn', text: '没能自动存档:浏览器存储已满' });
    clearToast('storage');
    setName('settlement:r1#0', '梼杌城');
    expect(peekToast('storage')).toBe(null);
    // 腾出地方:下一次改动就存下了,菜单里的"已满"也收起
    fake.cap = Infinity;
    setName('settlement:r1#0', '混沌城');
    expect(saveStore.loadWorld(id)?.save.edits.names['settlement:r1#0']).toBe('混沌城');
    expect(saveStore.storageIsFull()).toBe(false);
  });

  it('提示条上的"存成文件":同时挂着几个存档菜单时卸下其中一个,按钮还在,调的是还挂着的那个', () => {
    useStorage(new FakeStorage(120));
    const calls: string[] = [];
    const offA = saveStore.addFileSaver(() => calls.push('a'));
    const offB = saveStore.addFileSaver(() => calls.push('b'));
    offB();
    openWorld(7);
    setName('settlement:r1#0', '饕餮城');
    const t = peekToast('storage');
    expect(t?.action?.label).toBe('存成文件');
    t?.action?.onClick();
    expect(calls).toEqual(['a']);
    expect(peekToast('storage')).toBe(null);
    offA();
    offA();
  });

  it('浏览器里存的坏条目:读不出来就当没有,不报错', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const id = saveStore.newWorldId();
    fake.setItem(`wenming-ditu:world:${id}`, '{坏了');
    fake.setItem(`wenming-ditu:meta:${id}`, '也坏了');
    expect(saveStore.listWorlds()).toEqual([]);
    openWorld(7, { id });
    expect(getEdits()).toBe(EMPTY_EDITS);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.count).toBe(1);
    // 读不出来的坏存档不当成旧版本留底
    expect(fake.getItem(`wenming-ditu:orig:${id}`)).toBeNull();
  });

  it('旧版本存的世界:第一次按新版重存之前原样留一份,只留最早那份;删除、撤销、复制、同步、全删跟着走', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const orig = (id: string) => fake.getItem(`wenming-ditu:orig:${id}`);
    /** 旧版本生成器存的存档原文 */
    const oldText = (seed: number, generator: number) =>
      JSON.stringify({ ...makeSave({ ...DEFAULT_PARAMS, seed }, EDITS, `check${seed}`, '苍澜界', '2026-10-01T08:00:00.000Z'), generator });
    const id = saveStore.newWorldId();
    const text = oldText(7, GENERATOR_VERSION - 1);
    fake.setItem(`wenming-ditu:world:${id}`, text);

    // 原样打开、什么都没动:不重存,也不留
    openWorld(7, { id });
    expect(fake.getItem(`wenming-ditu:world:${id}`)).toBe(text);
    expect(orig(id)).toBeNull();
    // 拖了一下地图换了中心:按新版重存之前,原来那份原样留着
    publishMapCenter(30);
    saveStore.viewChanged();
    publishMapCenter(0);
    expect(saveStore.loadWorld(id)?.save.generator).toBe(GENERATOR_VERSION);
    expect(orig(id)).toBe(text);
    // 以后再改、换个世界再回来再改:留的还是最早那份;本来就是新版的世界不留
    setName('settlement:r1#0', '饕餮城');
    const now = openWorld(8);
    setName('settlement:r1#0', '梼杌城');
    expect(orig(now)).toBeNull();
    openWorld(7, { id });
    setName('settlement:r1#0', '穷奇城');
    expect(saveStore.loadWorld(id)?.save.edits.names['settlement:r1#0']).toBe('穷奇城');
    expect(orig(id)).toBe(text);

    // 删除跟着删,撤销跟着回来;复制一份也带上
    const gone = saveStore.deleteWorld(id)!;
    expect(orig(id)).toBeNull();
    expect(saveStore.restoreWorld(gone)).toBe(true);
    expect(orig(id)).toBe(text);
    const copy = saveStore.duplicateWorld(id)!;
    expect(orig(copy)).toBe(text);

    // 同步带来另一台设备在新版里重存过的同一个世界:这里原来那份原样留着
    const synced = saveStore.newWorldId();
    const text9 = oldText(9, GENERATOR_VERSION - 2);
    fake.setItem(`wenming-ditu:world:${synced}`, text9);
    const newer = (names: Record<string, string>) => JSON.stringify(makeSave({ ...DEFAULT_PARAMS, seed: 9 }, { ...EDITS, names }, 'check9', '苍澜界', '2026-10-09T08:00:00.000Z'));
    expect(saveStore.putSyncedWorld(synced, { save: newer(EDITS.names), meta: {}, thumb: null })).toBe(true);
    expect(orig(synced)).toBe(text9);
    // 同步带来的存得下、原样留不下(存储快满了):照样存上,不留
    const full = saveStore.newWorldId();
    const text10 = oldText(10, GENERATOR_VERSION - 1);
    fake.setItem(`wenming-ditu:world:${full}`, text10);
    const used = () => [...fake.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
    fake.cap = used() + 200;
    expect(saveStore.putSyncedWorld(full, { save: newer(EDITS.names), meta: {}, thumb: null })).toBe(true);
    expect(fake.getItem(`wenming-ditu:world:${full}`)).toBe(newer(EDITS.names));
    expect(orig(full)).toBeNull();
    fake.cap = Infinity;

    // 退出登录选了从这台设备上删掉:一起删
    expect(saveStore.removeAllWorlds()).toBe(true);
    expect([...fake.map.keys()].some((k) => k.startsWith('wenming-ditu:orig:'))).toBe(false);

    // 自动存时存储快满了:新版的存档照样存上,不为留底删别的世界;留不下就不留,之后接着自动存
    const tight = new FakeStorage();
    useStorage(tight);
    const other = openWorld(8, { title: '赤霄纪' });
    tick();
    const id2 = saveStore.newWorldId();
    tight.setItem(`wenming-ditu:world:${id2}`, text);
    openWorld(7, { id: id2 });
    tight.cap = [...tight.map].reduce((n, [k, v]) => n + k.length + v.length, 0) + 200;
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id2)?.save).toMatchObject({ generator: GENERATOR_VERSION, edits: { names: { 'settlement:r1#0': '饕餮城' } } });
    expect(tight.getItem(`wenming-ditu:orig:${id2}`)).toBeNull();
    expect(saveStore.loadWorld(other)).not.toBeNull();
    setName('settlement:r1#0', '梼杌城');
    expect(saveStore.loadWorld(id2)?.save.edits.names['settlement:r1#0']).toBe('梼杌城');
    expect(saveStore.storageIsFull()).toBe(false);
  });

  it('看原样:找得到旧版本的世界原来那一份;打开旧版本的链接以后改了才存的,第一次存时也留着', () => {
    const fake = new FakeStorage();
    useStorage(fake);
    const oldSave = (seed: number, generator: number) => ({ ...makeSave({ ...DEFAULT_PARAMS, seed }, EDITS, `check${seed}`, '苍澜界', '2026-10-01T08:00:00.000Z'), generator });
    // 存着、还没按新版重存:就是存着的这份
    const id = saveStore.newWorldId();
    fake.setItem(`wenming-ditu:world:${id}`, JSON.stringify(oldSave(7, GENERATOR_VERSION - 1)));
    openWorld(7, { id });
    expect(saveStore.originalOf(id)?.generator).toBe(GENERATOR_VERSION - 1);
    expect(saveStore.currentOriginal()?.generator).toBe(GENERATOR_VERSION - 1);
    // 按新版重存以后:是留的那份
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.save.generator).toBe(GENERATOR_VERSION);
    expect(saveStore.originalOf(id)).toMatchObject({ generator: GENERATOR_VERSION - 1, edits: { names: EDITS.names } });
    // 交出去的是留的原文(存档格式、各项都是当时写的),不是按现在的读法重新拼的
    expect(saveStore.originalOf(id)).toEqual(JSON.parse(fake.getItem(`wenming-ditu:orig:${id}`)!));
    // 新版建的世界:没有
    const now = openWorld(8);
    setName('settlement:r1#0', '梼杌城');
    expect(saveStore.originalOf(now)).toBeNull();
    expect(saveStore.currentOriginal()).toBeNull();

    // 打开旧版本的分享链接(还没存):原来那份跟着当前世界;改了存进来时原样留着,以后照样找得到
    const link = openWorld(9, { kind: 'visit', original: oldSave(9, GENERATOR_VERSION - 1) });
    expect(fake.getItem(`wenming-ditu:world:${link}`)).toBeNull();
    expect(saveStore.currentOriginal()?.seed).toBe(9);
    setName('settlement:r1#0', '穷奇城');
    expect(saveStore.loadWorld(link)?.save.generator).toBe(GENERATOR_VERSION);
    expect(saveStore.originalOf(link)).toMatchObject({ seed: 9, generator: GENERATOR_VERSION - 1 });
    // 带的那份不比现在旧(新版的链接):不留
    const fresh = openWorld(10, { kind: 'visit', original: { ...oldSave(10, GENERATOR_VERSION) } });
    expect(saveStore.currentOriginal()).toBeNull();
    setName('settlement:r1#0', '混沌城');
    expect(fake.getItem(`wenming-ditu:orig:${fresh}`)).toBeNull();

    // 从文件打开、和存着的一样(存着的已经是新版的、没留过原样):用存着的那个,文件这份留作原样
    const same = saveStore.newWorldId();
    fake.setItem(`wenming-ditu:world:${same}`, JSON.stringify(makeSave({ ...DEFAULT_PARAMS, seed: 11 }, EDITS, 'check11', '苍澜界', '2026-10-09T08:00:00.000Z')));
    const file = parseSave(JSON.stringify(oldSave(11, GENERATOR_VERSION - 1)));
    expect(file.ok && saveStore.importSave(file.save)).toBe(same);
    expect(saveStore.originalOf(same)?.generator).toBe(GENERATOR_VERSION - 1);
  });
});

describe('旧版本的提示:照实说变了什么', () => {
  it('每一版都记了改了什么(加 GENERATOR_VERSION 时忘了补就不过)', () => {
    for (let v = 2; v <= GENERATOR_VERSION; v++) expect(GENERATOR_CHANGES[v], `第 ${v} 版`).toBeDefined();
  });
  it('按跨过的几版里最大的那种改动说', () => {
    expect(versionNote(GENERATOR_VERSION, false)).toBeNull();
    expect(versionNote(GENERATOR_VERSION, true)).toBeNull();
    // 第 9 版:君主的世系,只改了编年史的字
    expect(versionNote(8, false)).toBe('来自旧版本：疆域和兴亡没变，编年史写得更细了');
    expect(versionNote(8, true)).toBe('来自旧版本：疆域和兴亡没变，编年史写得更细了');
    // 第 8 版只动了改过地形的世界
    expect(versionNote(7, false)).toBe('来自旧版本：疆域和兴亡没变，编年史写得更细了');
    expect(versionNote(7, true)).toBe('来自旧版本：地形和气候没变，历史重新推演了');
    // 第 6、7 版:人物和战役 < 洋流(气候、河流、历史)
    expect(versionNote(6, false)).toBe('来自旧版本：陆地和山没变，气候、河流和历史都重算了');
    expect(versionNote(5, true)).toBe(versionNote(6, true));
    // 第 4、5 版换了整颗星球,再往前的都算进去
    for (const v of [4, 3, 2, 1, 0, -3]) expect(versionNote(v, false)).toBe('来自旧版本：整颗星球重新生成了，地形和历史都和原来不同');
    expect(versionNote(GENERATOR_VERSION + 1, false)).toBe(NEWER_NOTE);
    // 不是整数的版本号认不出:按整颗星球说,不当成哪一版
    expect(versionNote(7.5, false)).toBe(versionNote(0, false));
    // 比现在大的也一样,不叫人刷新
    expect(versionNote(GENERATOR_VERSION + 0.5, false)).toBe(versionNote(0, false));
  });
  it('版本不同、但世界应该一样时照样核对地形', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EMPTY_EDITS, 'aaaaaaaaaaaa');
    // 8 → 现在只改了编年史的字;7 → 现在,没改地形的世界也只是这样(第 8 版只动改过地形的)
    for (const generator of [8, 7]) {
      expect(checkWarning({ ...save, generator }, 'aaaaaaaaaaaa')).toBeNull();
      expect(checkWarning({ ...save, generator }, 'bbbbbbbbbbbb')).toBe(CHECK_WARNING);
    }
    // 世界本来就变了(已经说过变了什么):不重复
    expect(checkWarning({ ...save, generator: 6 }, 'bbbbbbbbbbbb')).toBeNull();
    const edited = { ...save, generator: 7, edits: { ...save.edits, terrain: [{ kind: 'lake' as const, pts: [300, 400], r: 16, s: 1 }] } };
    expect(checkWarning(edited, 'bbbbbbbbbbbb')).toBeNull();
  });
});

describe('读档提示的短说法', () => {
  it('地形对不上:缩成一行小字里的短句;版本提示本来就短,和认不出的一样原样', () => {
    expect(saveStore.briefWarning(versionNote(6, false)!)).toBe(versionNote(6, false));
    expect(saveStore.briefWarning(NEWER_NOTE)).toBe(NEWER_NOTE);
    expect(saveStore.briefWarning(CHECK_WARNING)).toBe('地形和存档时对不上');
    expect(saveStore.briefWarning('有 2 处改名格式不对,已跳过')).toBe('有 2 处改名格式不对,已跳过');
  });
  it('打不开的原因:别的 JSON、更新版本的存档、坏了的链接', () => {
    const other = parseSave(JSON.stringify({ hello: 1 }));
    const junk = parseSave('不是 JSON');
    const future = parseSave(JSON.stringify({ app: SAVE_APP, format: 99, seed: 7 }));
    expect(!other.ok && saveStore.briefError(other.error)).toBe('不是「文明与地图」的存档');
    expect(!junk.ok && saveStore.briefError(junk.error)).toBe('不是「文明与地图」的存档');
    expect(!future.ok && saveStore.briefError(future.error)).toBe('来自更新的版本,刷新页面后再打开');
    expect(saveStore.briefError('文件是空的')).toBe('文件是空的');
  });
});

describe('平面时代的存档(GENERATOR_VERSION 4 及以前)', () => {
  /** 平面世界时写的存档原文:参数里没有"形状",改名有旧的 r 格式和 c 格式,干预指向当时的国家,地形修改的坐标都在 [0, 2048] 里 */
  const OLD = JSON.stringify({
    app: '文明与地图',
    format: 1,
    generator: 4,
    seed: 7,
    params: { seed: 7, cells: 12000, landFraction: 0.33, plates: 30, mountains: 1, temperature: 0, rainfall: 1 },
    edits: {
      names: { 'settlement:r123#0': '饕餮城', 'polity:c4567#0': '秦', 'region:c890': '九嶷州', 'place:river@c11999#0': '弱水', 'culture:c3#0': '羌' },
      interventions: [
        { kind: 'protect', a: 'polity:c4567#0', from: 1200 },
        { kind: 'declare', a: 'polity:r45#0', b: 'polity:c100#0', from: 900 },
      ],
      terrain: [
        { kind: 'volcano', pts: [812, 403], r: 28, s: 1.05 },
        { kind: 'range', pts: [2000, 300, 2048, 340, 30, 380], r: 23, s: 1 },
      ],
    },
    check: '3f9a0c1d7b2e',
    title: '九州大陆',
    savedAt: '2026-09-20T08:00:00.000Z',
  });

  it('照常打开成球面世界:提示"来自旧版本";指不到的改名、干预不生效,不报错', () => {
    const r = parseSave(OLD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual(['来自旧版本：整颗星球重新生成了，地形和历史都和原来不同']);
    // 地形修改的坐标按经纬度读:x = 2048 就是 180° 经线,跨接缝的一笔展开成连着的
    expect(r.save.edits.terrain[1].pts).toEqual([2000, 300, 2048, 340, 2078, 380]);
    const w = generateWorld(r.save.params, undefined, r.save.edits.terrain);
    expect(w.mesh.xyz.length).toBe(3 * w.mesh.n);
    expect(w.volcanoes.length).toBe(1);
    // 地形校验对不上(地形全换了一遍),但版本不同时 parseSave 已经提示过,不重复
    expect(checkWarning(r.save, worldCheck(w))).toBeNull();
    const edits = upgradeLegacyKeys(r.save.edits, generateCiv(w).regions.seat);
    const civ = generateCiv(w, { interventions: edits.interventions });
    const named = applyNames(civ, edits.names);
    expect(named.polities.length).toBeGreaterThan(0);
    // 指得到的改名套上,指不到的先留着(界面上标"暂未生效");干预逐条能判断生效没有
    for (const k of Object.keys(edits.names)) expect(() => resolveKey(civ, k)).not.toThrow();
    for (let i = 0; i < (civ.interventions ?? []).length; i++) expect(() => interventionOutcome(civ, i)).not.toThrow();
    expect(() => buildChronicle(named)).not.toThrow();
  }, 60_000);

  it('分享链接同理:照常打开,提示"来自旧版本"', async () => {
    const r0 = parseSave(OLD);
    expect(r0.ok).toBe(true);
    if (!r0.ok) return;
    const r = await decodeShare(await encodeShare(JSON.parse(OLD)));
    expect(r.ok && r.warnings).toEqual([versionNote(4, true)]);
    expect(r.ok && r.save.edits).toEqual(r0.save.edits);
  });
});

describe('投影和中央经线跟着世界存(view)', () => {
  beforeEach(() => useStorage(new FakeStorage()));
  afterEach(() => {
    stopAuto?.();
    stopAuto = null;
    delete g.localStorage;
    saveStore._resetForTest();
    clearEdits();
    setProjection('equirect');
    publishMapCenter(0);
  });

  it('存档文件带上投影和中央经线;旧存档没有 = 等距圆柱、0°;格式不对的当没存', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', undefined, '2026-09-28T00:00:00.000Z', { projection: 'robinson', center: 485.123 });
    // 中央经线挪到 ±180° 以内、两位小数
    expect(save.view).toEqual({ projection: 'robinson', center: 125.12 });
    const r = parseSave(saveText(save));
    expect(r.ok && r.save.view).toEqual({ projection: 'robinson', center: 125.12 });
    expect(r.ok && r.warnings).toEqual([]);
    // 旧存档:没有 view
    const old = JSON.parse(saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c')));
    expect(old.view).toBeUndefined();
    const ro = parseSave(JSON.stringify(old));
    expect(ro.ok && ro.save.view).toBeUndefined();
    expect(DEFAULT_VIEW).toEqual({ projection: 'equirect', center: 0 });
    // 格式不对:照常打开,view 当没存
    for (const bad of [{ projection: 3, center: 0 }, { projection: 'robinson' }, { projection: '<script>', center: 1 }, 'robinson', { projection: 'mollweide', center: Infinity }]) {
      const rb = parseSave(JSON.stringify({ ...old, view: bad }));
      expect(rb.ok).toBe(true);
      expect(rb.ok && rb.save.view).toBeUndefined();
    }
    // 认不出的投影名原样留着(以后的版本加的投影),界面按等距圆柱看
    expect(cleanView({ projection: 'azimuthal', center: -30 })).toEqual({ projection: 'azimuthal', center: -30 });
  });

  it('分享链接带上投影和中央经线', async () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', '九州', undefined, { projection: 'mollweide', center: -60 });
    const r = await decodeShare(await encodeShare(save));
    expect(r.ok && r.save.view).toEqual({ projection: 'mollweide', center: -60 });
  });

  it('自动存按当时的投影和中心写;存着的世界换了投影 / 中心就重存,没存过的不为这个占列表', () => {
    setProjection('robinson');
    publishMapCenter(42.5);
    const id = openWorld(7, { kind: 'visit' });
    // 没存过的世界(打开的链接):换投影不存
    saveStore.viewChanged();
    expect(saveStore.loadWorld(id)).toBeNull();
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.save.view).toEqual({ projection: 'robinson', center: 42.5 });
    expect(saveStore.currentSave()?.view).toEqual({ projection: 'robinson', center: 42.5 });
    // 换成摩尔威德、中心 −100°:重存
    setProjection('mollweide');
    publishMapCenter(-100);
    saveStore.viewChanged();
    expect(saveStore.loadWorld(id)?.save.view).toEqual({ projection: 'mollweide', center: -100 });
    // 换个世界再回来:存着的存档带着它(App 按它换投影、转中心);存档这边不动投影
    openWorld(2024);
    setProjection('equirect');
    publishMapCenter(0);
    expect(saveStore.loadWorld(id)?.save.view).toEqual({ projection: 'mollweide', center: -100 });
    openWorld(7, { id });
    expect(getProjection()).toBe('equirect');
    expect(getMapCenter()).toBe(0);
    // 原样打开不重写(看法还是存着的那个)
    expect(saveStore.loadWorld(id)?.save.view).toEqual({ projection: 'mollweide', center: -100 });
  });
});

/** 打开别人分享短链接、另存时记下的底稿出处 */
const ORIGIN: SaveOrigin = { by: '明月', title: '苍澜界', url: 'https://atlas.example.com/s/k7Qm2xPa' };

describe('底稿出处(origin)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    tick();
    useStorage(new FakeStorage());
  });
  afterEach(() => {
    vi.useRealTimers();
    stopAuto?.();
    stopAuto = null;
    delete g.localStorage;
    saveStore._resetForTest();
    clearEdits();
    _resetToasts();
  });

  it('存档文件带着出处(往返不变);没有署名的不带 by;分享链接里也在', async () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', '苍澜界（二）', undefined, null, ORIGIN);
    const r = parseSave(saveText(save));
    expect(r.ok && r.save.origin).toEqual(ORIGIN);
    const anon = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', undefined, undefined, null, { title: '', url: ORIGIN.url });
    expect(anon.origin).toEqual({ title: '', url: ORIGIN.url });
    const d = await decodeShare(await encodeShare(save));
    expect(d.ok && d.save.origin).toEqual(ORIGIN);
    // 没有出处的存档不带这个字段
    expect('origin' in makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c')).toBe(false);
  });

  it('格式不对的出处当没有:链接不是 http(s) 的分享短链接、不是对象;署名、世界名去掉控制字符、超长截断', () => {
    for (const url of ['javascript:alert(1)//s/abcd', 'https://a.example/s/', 'https://a.example/x/abcd1234', 'ftp://a.example/s/abcd1234', 'https://a.example/s/abcd1234?x=1', 'https://a.ex ample/s/abcd1234', 'https://a.example/?next=/s/Ab12', 'https://a.example/#/s/Ab12', 'https://a.example/x?/s/Ab12', 'https://u:p@a.example/s/Ab12', 'https://a.example/x/../s/Ab12', 'https://A.example/s/Ab12', 'https://a.example:443/s/Ab12'])
      expect(cleanOrigin({ title: 't', url }), url).toBeNull();
    expect(cleanOrigin('https://a.example/s/abcd1234')).toBeNull();
    expect(cleanOrigin({ title: 't' })).toBeNull();
    expect(cleanOrigin({ by: '  明\u0007月  ', title: '苍澜界\n', url: 'http://localhost:5173/app/s/Ab12' })).toEqual({ by: '明月', title: '苍澜界', url: 'http://localhost:5173/app/s/Ab12' });
    expect(cleanOrigin({ by: '一二三四五六七八九十一二三四五六七八九十多出来', title: 1, url: ORIGIN.url })).toEqual({ by: '一二三四五六七八九十一二三四五六七八九十', title: '', url: ORIGIN.url });
    expect(cleanOrigin({ by: 7, title: 't', url: ORIGIN.url })).toEqual({ title: 't', url: ORIGIN.url });
    // 看不见的字符去掉(零宽空格、方向控制符、软连字符……),换行制表算空白;和服务器存署名时一样
    expect(cleanSignature('明\u200b\u202e月\u00ad\u0085')).toBe('明月');
    expect(cleanSignature('明\n\t月\u2028')).toBe('明 月');
    expect(cleanSignature('\u200b\u2060')).toBe('');
    // 组合表情要用的看不见的字符留着(👩‍💻 不拆成 👩💻、❤️ 不变成黑白的 ❤、旗帜里的标签);只有这些、没有看得见的字 = 没署名
    for (const e of ['👩\u200d💻', '\u2764\ufe0f', '🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', 'क्\u200dष', 'ᠠ\u180bᠢ\u180f', '葛\u{e0100}']) expect(cleanSignature(` ${e}\u200b `)).toBe(e);
    expect(cleanSignature('\u200d\ufe0f \u200c')).toBe('');
    expect(cleanSignature('\u200d'.repeat(25) + '明')).toBe('明');
    // 一个字后面挂上一长串看不见的字符:总长限住
    expect(cleanSignature('明月' + '\u200d'.repeat(400))).toBe('明');
    expect(cleanSignature('明'.repeat(1_000_000))).toBe('明'.repeat(20));
    expect(cleanSignature('一二三四五六七八九十一二三四五六七八九 十')).toBe('一二三四五六七八九十一二三四五六七八九');
    // 字数按看到的算:一个组合表情、一个 ❤️ 都是一个字
    for (const e of ['一二三四五六七八九十一二三四五六七八九\u2764\ufe0f', '\u2764\ufe0f'.repeat(20), '👩\u200d💻'.repeat(20)]) expect(cleanSignature(e)).toBe(e);
    expect(cleanSignature('👩\u200d💻'.repeat(21))).toBe('👩\u200d💻'.repeat(20));
    const text = JSON.stringify({ ...makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c'), origin: { by: 'x', title: 't', url: 'javascript:void(0)' } });
    const r = parseSave(text);
    expect(r.ok && r.save.origin).toBeUndefined();
  });

  it('打开别人的分享短链接:只是看看时不存;改了另存进我的世界,出处写进存档;存成文件、复制一份都带着', () => {
    const id = openWorld(7, { kind: 'visit', edits: EDITS, title: '苍澜界', origin: ORIGIN });
    expect(saveStore.loadWorld(id)).toBeNull();
    expect(saveStore.currentWorld()?.origin).toEqual(ORIGIN);
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.save.origin).toEqual(ORIGIN);
    expect(saveStore.currentSave()?.origin).toEqual(ORIGIN);
    // 改名也不丢
    saveStore.renameWorld(id, '我的苍澜界');
    expect(saveStore.loadWorld(id)?.save).toMatchObject({ title: '我的苍澜界', origin: ORIGIN });
    const copy = saveStore.duplicateWorld(id);
    expect(copy && saveStore.loadWorld(copy)?.save.origin).toEqual(ORIGIN);
    // 换个世界再回来:还带着
    openWorld(2024);
    openWorld(7, { id });
    expect(saveStore.currentWorld()?.origin).toEqual(ORIGIN);
  });

  it('长链接(没有出处)、新建中的世界不记出处', () => {
    const id = openWorld(7, { kind: 'visit', edits: EDITS });
    setName('settlement:r1#0', '饕餮城');
    expect(saveStore.loadWorld(id)?.save.origin).toBeUndefined();
    const d = openWorld(8, { kind: 'draft', title: '新世界', origin: ORIGIN });
    expect(saveStore.currentWorld()?.origin).toBeUndefined();
    expect(saveStore.loadWorld(d)?.save.origin).toBeUndefined();
  });
});

describe('全部存成文件(bundle)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    tick();
    useStorage(new FakeStorage());
    forgetNotes();
  });
  afterEach(() => {
    vi.useRealTimers();
    stopAuto?.();
    stopAuto = null;
    delete g.localStorage;
    saveStore._resetForTest();
    clearEdits();
    forgetNotes();
    _resetToasts();
  });

  /** 换一个空的浏览器(像清理了浏览器数据) */
  function freshBrowser(s = new FakeStorage()) {
    useStorage(s);
    forgetNotes();
  }

  const THUMB = 'data:image/jpeg;base64,/9j/AAAA';

  function threeWorlds() {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    putNote(a, NOTE);
    tick();
    const b = openWorld(2024, { kind: 'visit', edits: EDITS, title: '赤水纪', origin: ORIGIN });
    setName('settlement:r1#0', '饕餮城');
    saveStore.setWorldStats(16);
    tick();
    const c = openWorld(99, { kind: 'draft', title: '没建完' });
    saveStore.detachWorld();
    return { a, b, c };
  }

  it('文件名:文明与地图-全部世界-本地日期.json', () => {
    expect(bundleFileName(new Date(2026, 9, 5, 23, 59))).toBe('文明与地图-全部世界-2026-10-05.json');
  });

  it('全部存成一个文件:每个世界的存档、卡片上的几样、AI 写的东西都在;清理浏览器以后放回来,一个不少', () => {
    const { a, b, c } = threeWorlds();
    // 缩略图:网页自己截的 data URL
    const kv = globalThis.localStorage as unknown as FakeStorage;
    kv.setItem(`wenming-ditu:thumb:${a}`, THUMB);
    const before = saveStore.listWorlds();
    const out = bundleText(new Date('2026-10-05T09:00:00.000Z'))!;
    expect(out.count).toBe(3);
    const raw = JSON.parse(out.text);
    expect(raw).toMatchObject({ app: SAVE_APP, bundle: BUNDLE_FORMAT, savedAt: '2026-10-05T09:00:00.000Z' });
    expect(raw.worlds.map((w: { save: { title: string } }) => w.save.title).sort()).toEqual(['没建完', '苍澜界', '赤水纪']);

    freshBrowser();
    expect(saveStore.listWorlds()).toEqual([]);
    expect(openBundleText(out.text, 'x.json')).toBe(true);
    expect(getToast()).toMatchObject({ kind: 'ok', text: '已放回 3 个世界' });
    const after = saveStore.listWorlds();
    // 顺序、名字、修改、没建完、现存几国、出处都和原来一样(编号是新的)
    const pick = (l: saveStore.StoredWorld[]) => l.map((w) => ({ title: w.save.title, edits: w.save.edits, draft: w.draft, alive: w.alive, origin: w.save.origin, at: w.at }));
    expect(pick(after)).toEqual(pick(before));
    expect(after.map((w) => w.id).some((id) => [a, b, c].includes(id))).toBe(false);
    const na = after.find((w) => w.save.title === '苍澜界')!;
    expect(na.thumb).toBe(THUMB);
    expect(listNotes(na.id)).toEqual([NOTE]);
    expect(after.find((w) => w.save.title === '赤水纪')).toMatchObject({ alive: 16, save: { origin: ORIGIN } });
  });

  it('同一个文件再放一次:一模一样的不重复放;改过的那个两份都留', () => {
    const { a } = threeWorlds();
    const text = bundleText()!.text;
    expect(openBundleText(text)).toBe(true);
    expect(getToast()).toMatchObject({ text: '这些世界都已经在「我的世界」里了' });
    expect(saveStore.listWorlds()).toHaveLength(3);
    saveStore.renameWorld(a, '苍澜界改');
    openBundleText(text);
    expect(getToast()).toMatchObject({ kind: 'ok', text: '已放回 1 个世界', more: ['2 个原来就有，没重复放'] });
    expect(saveStore.listWorlds().map((w) => w.save.title).sort()).toEqual(['没建完', '苍澜界', '苍澜界改', '赤水纪']);
  });

  it('再放一次时,原来就有的那份缺了 AI 写的东西、缩略图、现存几国:用文件里的补上(这边另有的 AI 写的东西留着)', () => {
    const { a, b } = threeWorlds();
    const kv = globalThis.localStorage as unknown as FakeStorage;
    kv.setItem(`wenming-ditu:thumb:${a}`, THUMB);
    const text = bundleText()!.text;
    // 这边丢了:a 的 AI 写的东西和缩略图,b 的现存几国;a 另外又写了一条
    kv.removeItem(`civ-atlas:ai-notes:${a}`);
    kv.removeItem(`wenming-ditu:thumb:${a}`);
    kv.setItem(`wenming-ditu:meta:${b}`, '{}');
    forgetNotes();
    const other = { ...NOTE, key: '名字由来:饕餮城', kind: '名字由来', title: '饕餮城' };
    putNote(a, other);
    expect(openBundleText(text)).toBe(true);
    expect(getToast()).toMatchObject({ kind: 'ok', text: '这些世界都已经在「我的世界」里了', more: ['2 个原来就有的补上了缺的 AI 写的东西或缩略图'] });
    expect(saveStore.listWorlds()).toHaveLength(3);
    expect(listNotes(a).map((n) => n.key).sort()).toEqual([NOTE.key, other.key].sort());
    expect(saveStore.listWorlds().find((w) => w.id === a)?.thumb).toBe(THUMB);
    expect(saveStore.listWorlds().find((w) => w.id === b)?.alive).toBe(16);
    // 什么都不缺了:再放一次不说补上
    openBundleText(text);
    expect(getToast()?.more ?? []).toEqual([]);
  });

  it('没建完的世界以另一个世界为底稿:放回来以后记着的底稿换成新编号,还能回到那个世界', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    tick();
    saveStore.detachWorld();
    clearEdits();
    const d = saveStore.newWorldId();
    saveStore.attachWorld({
      id: d,
      params: { ...DEFAULT_PARAMS, seed: 8 },
      check: 'check8',
      kind: 'draft',
      title: '苍澜界续篇',
      saved: EMPTY_EDITS,
      pristine: false,
      base: { id: a, title: '苍澜界', names: 0, interventions: 0 },
    });
    saveStore.detachWorld();
    expect(saveStore.listWorlds().find((w) => w.id === d)?.base?.id).toBe(a);
    const text = bundleText()!.text;
    // 文件里没建完的那个排在前面(最近改的在前):放的时候也要先有底稿的新编号
    expect(JSON.parse(text).worlds.map((w: { meta: { draft?: boolean } }) => !!w.meta.draft)).toEqual([true, false]);
    freshBrowser();
    openBundleText(text);
    const after = saveStore.listWorlds();
    const na = after.find((w) => !w.draft)!;
    const nd = after.find((w) => w.draft)!;
    expect(na.id).not.toBe(a);
    expect(nd.base).toEqual({ id: na.id, title: '苍澜界', names: 0, interventions: 0 });
  });

  it('正在看的世界一次都没能存进浏览器(存储满了):也放进文件,放回来就有了', () => {
    const kv = globalThis.localStorage as unknown as FakeStorage;
    expect(saveStore.listWorlds()).toEqual([]);
    kv.cap = 0;
    const id = openWorld(7, { title: '只在页面里' });
    expect(saveStore.currentUnsaved()).toBe(true);
    expect(saveStore.listWorlds().some((w) => w.id === id)).toBe(false);
    const out = bundleText()!;
    expect(out.count).toBe(1);
    saveStore.detachWorld();
    freshBrowser();
    openBundleText(out.text);
    expect(saveStore.listWorlds().map((w) => w.save.title)).toEqual(['只在页面里']);
  });

  it('AI 写的东西各功能另记的(史书的书目、释名记的名字):跟着存进文件、跟着放回来,史书还认得出来', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    const book = { ...NOTE, book: { title: '世界通史', range: '第 0—3000 年', scope: { kind: 'world' }, style: 'classic', length: 'medium', fp: 'fp1', seed: 7, calls: 2 } };
    const name = { ...NOTE, key: '释名:settlement:c1#0', kind: '释名', title: '饕餮城', name: '饕餮城', shown: '饕餮城', stamp: 's1' };
    putNote(a, book);
    putNote(a, name);
    expect(asHistoryNote(getNote(a, book.key))).not.toBeNull();
    const text = bundleText()!.text;
    freshBrowser();
    openBundleText(text);
    const na = saveStore.listWorlds()[0];
    expect(listNotes(na.id)).toEqual([book, name]);
    expect(asHistoryNote(getNote(na.id, book.key))).not.toBeNull();
    // 另记的太大的不要(正文照样放回来)
    const huge = { ...NOTE, key: '史书:huge', book: { title: 'x'.repeat(30_000) } };
    const r = parseBundle(JSON.stringify({ app: SAVE_APP, bundle: 1, worlds: [{ save: makeSave({ ...DEFAULT_PARAMS, seed: 8 }, EDITS, 'c8', '大'), notes: [huge] }] }));
    expect(r && r.ok ? r.bundle.worlds[0].notes : null).toEqual([NOTE].map((n) => ({ ...n, key: '史书:huge' })));
  });

  it('参数、修改、名字都一样,底稿出处不一样:不算同一个,文件里的出处不丢', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 5 }, EDITS, 'c5', '同名');
    const a = saveStore.importSave(save)!;
    const withOrigin: SaveFile = { ...save, origin: ORIGIN };
    const b = saveStore.importSave(withOrigin)!;
    expect(b).not.toBe(a);
    expect(saveStore.loadWorld(b)?.save.origin).toEqual(ORIGIN);
    expect(saveStore.importSave({ ...withOrigin, origin: { ...ORIGIN } })).toBe(b);
    const r = importBundle({ worlds: [{ save: { ...save, origin: { ...ORIGIN, by: '别人' } }, meta: {}, thumb: null, notes: [] }, { save: withOrigin, meta: {}, thumb: null, notes: [] }], bad: 0 });
    expect(r).toMatchObject({ same: 1 });
    expect(r.added).toHaveLength(1);
    expect(saveStore.loadWorld(r.added[0])?.save.origin?.by).toBe('别人');
  });

  it('AI 写的东西上次没能写进浏览器(存储满了,只在页面里):腾出地方以后再放一次,这回写进去', () => {
    threeWorlds();
    const text = bundleText()!.text;
    const s = new FakeStorage();
    const put = s.setItem.bind(s);
    let full = true;
    s.setItem = (k: string, v: string) => {
      if (full && k.startsWith('civ-atlas:ai-notes:')) {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      put(k, v);
    };
    freshBrowser(s);
    openBundleText(text);
    expect(getToast()?.more?.some((m) => m.includes('AI 写的东西没能放回来'))).toBe(true);
    const na = saveStore.listWorlds().find((w) => w.save.title === '苍澜界')!;
    // 页面里有,浏览器里没有
    expect(listNotes(na.id)).toEqual([NOTE]);
    expect(s.getItem(`civ-atlas:ai-notes:${na.id}`)).toBeNull();
    full = false;
    openBundleText(text);
    expect(getToast()).toMatchObject({ text: '这些世界都已经在「我的世界」里了', more: ['1 个原来就有的补上了缺的 AI 写的东西或缩略图'] });
    expect(JSON.parse(s.getItem(`civ-atlas:ai-notes:${na.id}`)!)).toEqual([NOTE]);
  });

  it('没建完的世界:存档一样、底稿不一样的不算同一个;这边丢了底稿的,用文件里的补上', () => {
    const kv = globalThis.localStorage as unknown as FakeStorage;
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    const b = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 9 }, EDITS, 'c9', '赤水纪'))!;
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 8 }, EMPTY_EDITS, 'c8', '续篇');
    const baseA = { id: a, title: '苍澜界', names: 0, interventions: 0 };
    const baseB = { id: b, title: '赤水纪', names: 0, interventions: 0 };
    const draftOf = (base: typeof baseA) => ({ worlds: [{ save, meta: { draft: true, base }, thumb: null, notes: [] }], bad: 0 });
    const d = importBundle(draftOf(baseA)).added[0];
    expect(saveStore.listWorlds().find((w) => w.id === d)?.base).toEqual(baseA);
    expect(importBundle(draftOf(baseB)).added).toHaveLength(1);
    expect(importBundle(draftOf(baseA))).toMatchObject({ added: [], same: 1, filled: 0 });
    kv.setItem(`wenming-ditu:meta:${d}`, JSON.stringify({ draft: true }));
    expect(importBundle(draftOf(baseA))).toMatchObject({ added: [], same: 1, filled: 1 });
    expect(saveStore.listWorlds().find((w) => w.id === d)?.base).toEqual(baseA);
    expect(saveStore.listWorlds()).toHaveLength(4);
  });

  it('正在看的世界刚点了「创建世界」,存储满了没改写进浏览器:文件里按页面里的算(建好了,不再记底稿)', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    tick();
    const d = saveStore.newWorldId();
    saveStore.attachWorld({
      id: d,
      params: { ...DEFAULT_PARAMS, seed: 8 },
      check: 'check8',
      kind: 'draft',
      title: '续篇',
      saved: EMPTY_EDITS,
      pristine: false,
      base: { id: a, title: '苍澜界', names: 0, interventions: 0 },
    });
    expect(saveStore.listWorlds().find((w) => w.id === d)?.draft).toBe(true);
    (globalThis.localStorage as unknown as FakeStorage).cap = 0;
    expect(saveStore.markCreated()).toBe(false);
    expect(saveStore.currentUnsaved()).toBe(true);
    expect(saveStore.loadWorld(d)?.draft).toBe(true);
    const w = JSON.parse(bundleText()!.text).worlds.find((x: { id: string }) => x.id === d);
    expect(w.meta).toEqual({});
    expect(w.save.title).toBe('续篇');
  });

  it('再放一次时,原来那份没记投影(旧版存的):用文件里的;这边记着的不换', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界');
    const a = saveStore.importSave(save)!;
    expect(saveStore.loadWorld(a)?.save.view).toBeUndefined();
    const view = { projection: 'robinson', center: 30 };
    const one = (v: typeof view) => ({ worlds: [{ save: { ...save, view: v }, meta: {}, thumb: null, notes: [] }], bad: 0 });
    expect(importBundle(one(view))).toMatchObject({ added: [], same: 1, filled: 1 });
    expect(saveStore.loadWorld(a)?.save.view).toEqual(view);
    expect(importBundle(one({ ...view, center: 60 }))).toMatchObject({ added: [], same: 1, filled: 0 });
    expect(saveStore.loadWorld(a)?.save.view).toEqual(view);
  });

  it('正在看的世界是放回时原来就有的那个:补上的底稿下次自动存还在;投影按页面上的,不补', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    tick();
    const d = openWorld(8, { kind: 'draft', title: '续篇', pristine: false });
    const cur = saveStore.loadWorld(d)!;
    expect(cur.base).toBeUndefined();
    const base = { id: a, title: '苍澜界', names: 0, interventions: 0 };
    const r = importBundle({ worlds: [{ save: cur.save, meta: { draft: true, base, alive: 9 }, thumb: null, notes: [] }], bad: 0 });
    expect(r).toMatchObject({ added: [], same: 1, filled: 1 });
    expect(saveStore.loadWorld(d)).toMatchObject({ base, alive: 9 });
    // 接着改一处(自动存):补上的底稿、现存几国还在
    setName('settlement:r1#0', '新名字');
    expect(saveStore.loadWorld(d)).toMatchObject({ base, alive: 9, save: { edits: { names: { 'settlement:r1#0': '新名字' } } } });

    // 正在看的世界存档里没记投影(旧版存的、原样打开没重写):不补,页面上是什么样下次就存什么样
    const old = makeSave({ ...DEFAULT_PARAMS, seed: 9 }, EDITS, 'check9', '赤水纪');
    const b = saveStore.importSave(old)!;
    openWorld(9, { id: b });
    expect(saveStore.loadWorld(b)?.save.view).toBeUndefined();
    const view = { projection: 'robinson', center: 30 };
    expect(importBundle({ worlds: [{ save: { ...old, view }, meta: {}, thumb: null, notes: [] }], bad: 0 })).toMatchObject({ same: 1, filled: 0 });
    expect(saveStore.loadWorld(b)?.save.view).toBeUndefined();
  });

  it('AI 写的东西多(5000 条以上)、很长的:都存进文件,都放回来', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c7', '苍澜界'))!;
    const many = Array.from({ length: 5002 }, (_, i) => ({ ...NOTE, key: `释名:settlement:c${i}#0`, kind: '释名', text: `${i}` }));
    many.push({ ...NOTE, key: '史书:long', text: '长'.repeat(250_000) });
    replaceNotes(a, many);
    const text = bundleText()!.text;
    freshBrowser();
    openBundleText(text);
    expect(getToast()).toMatchObject({ kind: 'ok', text: '已放回 1 个世界' });
    const na = saveStore.listWorlds()[0];
    expect(listNotes(na.id)).toHaveLength(5003);
    expect(getNote(na.id, '史书:long')?.text).toHaveLength(250_000);
  });

  it('一个文件放不下:先不带 AI 写的东西,还放不下再不带缩略图,存出来的都能放回来;都不带也放不下就不存', () => {
    const { a } = threeWorlds();
    const kv = globalThis.localStorage as unknown as FakeStorage;
    kv.setItem(`wenming-ditu:thumb:${a}`, THUMB);
    const at = new Date('2026-10-05T09:00:00.000Z');
    const full = bundleText(at)!;
    expect(full.dropped).toBeUndefined();
    expect(full.text).toContain(NOTE.text);
    // 上限比全带上的短一点:不带 AI 写的东西
    const noNotes = bundleText(at, full.text.length - 1)!;
    expect(noNotes).toMatchObject({ count: 3, dropped: 'notes' });
    expect(noNotes.text.length).toBeLessThanOrEqual(full.text.length - 1);
    expect(noNotes.text).not.toContain(NOTE.text);
    expect(noNotes.text).toContain(THUMB);
    // 还放不下:缩略图也不带
    const bare = bundleText(at, noNotes.text.length - 1)!;
    expect(bare).toMatchObject({ count: 3, dropped: 'notes+thumbs' });
    expect(bare.text).not.toContain(THUMB);
    // 存出来的,同样的上限下都能读
    for (const [t, max] of [[noNotes.text, full.text.length - 1], [bare.text, noNotes.text.length - 1]] as const) {
      const r = parseBundle(t, max);
      expect(r?.ok && r.bundle.worlds).toHaveLength(3);
    }
    // 世界本身就放不下:不存
    expect(bundleText(at, 100)).toMatchObject({ text: '', count: 3, tooBig: true });
  });

  it('参数、名字、修改都一样,生成器版本或地形哈希不同:可能是两个不同的世界,都放回来', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 5 }, EDITS, 'c5', '同名');
    const r = importBundle({
      worlds: [
        { save, meta: {}, thumb: null, notes: [] },
        { save: { ...save, generator: save.generator - 1 }, meta: {}, thumb: null, notes: [] },
        { save: { ...save, check: 'other' }, meta: {}, thumb: null, notes: [] },
      ],
      bad: 0,
    });
    expect(r).toMatchObject({ same: 0, left: 0 });
    expect(r.added).toHaveLength(3);
    // 同一个文件再放一次:都不重复
    expect(importBundle({ worlds: [{ save, meta: {}, thumb: null, notes: [] }, { save: { ...save, check: 'other' }, meta: {}, thumb: null, notes: [] }], bad: 0 })).toMatchObject({ same: 2, added: [] });
  });

  it('最近打开过(比最后一次修改晚):放回来以后卡片上的时间和排序一样', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '苍澜界'))!;
    tick();
    saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 8 }, EDITS, 'check8', '赤水纪'));
    tick();
    // 苍澜界又打开了一次、没改:排到前面
    openWorld(7, { id: a });
    saveStore.detachWorld();
    const before = saveStore.listWorlds();
    expect(before[0].id).toBe(a);
    expect(before[0].at > before[0].save.savedAt).toBe(true);
    const text = bundleText()!.text;
    freshBrowser();
    openBundleText(text);
    const pick = (l: saveStore.StoredWorld[]) => l.map((w) => [w.save.title, w.at]);
    expect(pick(saveStore.listWorlds())).toEqual(pick(before));
  });

  it('原来就有的那份丢了"最近打开"(或比文件里的早):再放一次时用文件里的,卡片时间、排序回来,不算补上了', () => {
    const a = saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'check7', '苍澜界'))!;
    tick();
    saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 8 }, EDITS, 'check8', '赤水纪'));
    tick();
    openWorld(7, { id: a });
    saveStore.detachWorld();
    const before = saveStore.listWorlds();
    expect(before[0].id).toBe(a);
    const text = bundleText()!.text;
    const kv = globalThis.localStorage as unknown as FakeStorage;
    kv.setItem(`wenming-ditu:meta:${a}`, '{}');
    expect(saveStore.listWorlds()[0].id).not.toBe(a);
    expect(openBundleText(text)).toBe(true);
    expect(getToast()).toMatchObject({ kind: 'ok', text: '这些世界都已经在「我的世界」里了' });
    expect(getToast()?.more ?? []).toEqual([]);
    const pick = (l: saveStore.StoredWorld[]) => l.map((w) => [w.id, w.at]);
    expect(pick(saveStore.listWorlds())).toEqual(pick(before));
  });

  it('浏览器不让网页存数据(只在内存里):放回来了也说一声,文件先别删', () => {
    threeWorlds();
    const text = bundleText()!.text;
    freshBrowser(throwing as unknown as FakeStorage);
    expect(saveStore.persistent()).toBe(false);
    expect(openBundleText(text)).toBe(true);
    const t = getToast();
    expect(t).toMatchObject({ kind: 'warn', text: '已放回 3 个世界' });
    expect(t?.more?.[0]).toContain('只留在这个页面里');
  });

  it('没建完的和建好的分开算:同样的参数、名字,一个没建完一个建好的,不算同一个', () => {
    const save = makeSave({ ...DEFAULT_PARAMS, seed: 5 }, EMPTY_EDITS, 'c5', '同名');
    const r = importBundle({ worlds: [{ save, meta: { draft: true }, thumb: null, notes: [] }], bad: 0 });
    expect(r.added).toHaveLength(1);
    const r2 = importBundle({ worlds: [{ save, meta: {}, thumb: null, notes: [] }, { save, meta: { draft: true }, thumb: null, notes: [] }], bad: 0 });
    expect(r2).toMatchObject({ same: 1, left: 0 });
    expect(r2.added).toHaveLength(1);
    expect(saveStore.listWorlds().map((w) => w.draft).sort()).toEqual([false, true]);
  });

  it('放满了就停,不删别的世界;存不下也停;都说一声', () => {
    for (let i = 0; i < saveStore.MAX_WORLDS - 1; i++) saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 1000 + i }, EMPTY_EDITS, 'c', `旧${i}`));
    const worlds = [1, 2, 3].map((k) => ({ save: makeSave({ ...DEFAULT_PARAMS, seed: k }, EMPTY_EDITS, 'c', `新${k}`), meta: {}, thumb: null, notes: [] }));
    const r = importBundle({ worlds, bad: 0 });
    expect(r).toMatchObject({ left: 2, why: 'full' });
    expect(r.added).toHaveLength(1);
    expect(saveStore.listWorlds()).toHaveLength(saveStore.MAX_WORLDS);
    expect(saveStore.listWorlds().some((w) => w.save.title === '旧0')).toBe(true);

    // 浏览器存储满了:不为它删旧世界
    freshBrowser(new FakeStorage(2000));
    saveStore.importSave(makeSave({ ...DEFAULT_PARAMS, seed: 1 }, EMPTY_EDITS, 'c', '原来的'));
    const big = [1, 2, 3, 4, 5, 6].map((k) => ({ save: makeSave({ ...DEFAULT_PARAMS, seed: 10 + k }, EDITS, 'c', `大${k}`), meta: {}, thumb: null, notes: [] }));
    const text = JSON.stringify({ app: SAVE_APP, bundle: 1, worlds: big });
    expect(openBundleText(text)).toBe(true);
    const t = getToast()!;
    expect(t.kind).toBe('warn');
    expect(t.more?.some((m) => m.includes('浏览器存储已满'))).toBe(true);
    const left = saveStore.listWorlds();
    expect(left.length).toBeGreaterThan(1);
    expect(left.length).toBeLessThan(7);
    expect(left.some((w) => w.save.title === '原来的')).toBe(true);
  });

  it('读文件:不是这种文件交给单个存档;更新版本、没有世界、坏了的世界给中文说明', () => {
    const single = saveText(makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', '苍澜界'));
    expect(parseBundle(single)).toBeNull();
    expect(parseBundle('不是 JSON')).toBeNull();
    expect(openBundleText(single)).toBe(false);
    expect(parseBundle(JSON.stringify({ app: SAVE_APP, bundle: 2, worlds: [] }))).toMatchObject({ ok: false, error: expect.stringContaining('更新版本') });
    expect(parseBundle(JSON.stringify({ app: SAVE_APP, bundle: 1 }))).toMatchObject({ ok: false });
    const ok = makeSave({ ...DEFAULT_PARAMS, seed: 7 }, EDITS, 'c', '好的');
    const r = parseBundle(
      '\ufeff' +
        JSON.stringify({
          app: SAVE_APP,
          bundle: 1,
          worlds: [
            { save: { app: '别的' } },
            7,
            { save: ok, meta: { draft: 'yes', alive: -3, extra: 1 }, thumb: 'javascript:alert(1)', notes: [NOTE, { key: 1 }, { ...NOTE }] },
          ],
        }),
    );
    expect(r).toMatchObject({ ok: true, bundle: { bad: 2 } });
    const w = r && r.ok ? r.bundle.worlds[0] : null;
    expect(w).toMatchObject({ meta: {}, thumb: null, notes: [NOTE] });
    openBundleText(JSON.stringify({ app: SAVE_APP, bundle: 1, worlds: [{ save: { app: '别的' } }] }), '坏.json');
    expect(getToast()).toMatchObject({ kind: 'error', text: '打不开 坏.json', more: ['里面的 1 个世界都读不出来'] });
  });

  it('正在看的世界最新的改动没存进浏览器(存储满了):存成文件用页面里那份', () => {
    const id = openWorld(7, { title: '苍澜界' });
    const kv = globalThis.localStorage as unknown as FakeStorage;
    kv.cap = 0;
    setName('settlement:r1#0', '最新的名字');
    expect(saveStore.currentUnsaved()).toBe(true);
    const raw = JSON.parse(bundleText()!.text);
    expect(raw.worlds).toHaveLength(1);
    expect(raw.worlds[0].save.edits.names['settlement:r1#0']).toBe('最新的名字');
    expect(saveStore.loadWorld(id)?.save.edits.names['settlement:r1#0']).toBeUndefined();
  });

  it('一个世界都没有:没有可存的', () => {
    expect(bundleText()).toBeNull();
  });
});
