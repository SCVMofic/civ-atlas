/**
 * AI 改写(阶段 5「对话式编辑」):材料、提示词、AI 回复的核对、合进 / 撤销修改、测试用假 AI 的固定提议
 * (在助手里执行 / 撤销的完整流程见 ai-assistant.test.ts)。
 * 全程用测试用假 AI,不联网。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import { Biome } from '../src/gen/biomes';
import { AdjKind, type Civ } from '../src/gen/civ/types';
import { capitalAt, polityAlive, polityTitleChain } from '../src/gen/civ/growth';
import { regionLabel, regionNamed } from '../src/gen/civ/display';
import { ownersAt } from '../src/gen/civ/timeline';
import { TERRAIN_MAX_OPS, TERRAIN_PRESETS } from '../src/gen/terrainEdits';
import {
  cultureKey,
  dynastyKey,
  placeKeyOf,
  polityKey,
  regionKey,
  settlementKey,
  type Intervention,
  type TerrainOp,
  type WorldEdits,
} from '../src/gen/edits';
import { setActiveProvider, setMockResponder } from '../src/ai/client';
import {
  REWRITE_FEATURE,
  REWRITE_MAX_ITEMS,
  REWRITE_SYSTEM,
  WISH_MAX,
  cleanWish,
  mergeRewrite,
  mockRewrite,
  nameAt,
  parseRewrite,
  rewriteMaterial,
  rewriteRequest,
  toLonLat,
  toWorld,
  unmergeRewrite,
  type RewriteChange,
  type RewriteContext,
} from '../src/ai/prompts/rewrite';
import { clearEdits } from '../src/ui/editsStore';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
const civ = generateCiv(world);
const EMPTY: WorldEdits = { names: {}, interventions: [], terrain: [] };
const Y = 2000;
const ctx = (edits: WorldEdits = EMPTY, year = Y, c: Civ = civ, w: World = world): RewriteContext => ({ world: w, civ: c, year, edits });
const json = (edits: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ reply: '好的', edits, ...extra });
/** 只有一条修改的回复 → 那一条 */
const one = (edit: Record<string, unknown>, c: RewriteContext = ctx()) => {
  const p = parseRewrite(json([edit]), c);
  if (!p.ok) throw new Error(p.message);
  return p.items[0];
};

// ---- 这份历史里第 Y 年的几个角色 ----
const own = ownersAt(civ, Y);
const reg = civ.regions;
const size = new Map<number, number>();
for (let r = 0; r < reg.count; r++) if (own.polity[r] >= 0) size.set(own.polity[r], (size.get(own.polity[r]) ?? 0) + 1);
/** y 年和 id 相邻的国家:[陆上接壤的, 以任何方式相邻的(隔海峡、航线也算)] */
function nearOf(id: number): [Set<number>, Set<number>] {
  const land = new Set<number>();
  const any = new Set<number>();
  for (let r = 0; r < reg.count; r++) {
    if (own.polity[r] !== id) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const q = own.polity[reg.adj[k]];
      if (q < 0 || q === id) continue;
      any.add(q);
      if (reg.adjKind[k] !== AdjKind.Strait && reg.adjKind[k] !== AdjKind.SeaRoute) land.add(q);
    }
  }
  return [land, any];
}
/** 第 Y 年最大的国家(测试用假 AI 挑它) */
const largest = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
/** 第 Y 年有陆上邻国的国家里最大的那个 */
const big = [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).find(([id]) => nearOf(id)[0].size > 0)![0];
const stands = (sid: number, y: number) => {
  const s = civ.settlements[sid];
  return s.founded <= y && (s.ended === undefined || s.ended > y);
};
const [landNear, anyNear] = nearOf(big);
const neighbor = [...landNear][0];
const far = [...size.keys()].find((q) => q !== big && !anyNear.has(q))!;
/** 亡了的国家(亡国后一年用)、后来才立的国家(立国前一年用) */
const dead = civ.polities.find((p) => p.ended !== undefined && p.ended < civ.endYear - 10)!;
const deadYear = Math.floor(dead.ended!) + 1;
const unborn = civ.polities.find((p) => p.founded > 10)!;
const unbornYear = Math.floor(unborn.founded) - 1;
const capital = capitalAt(civ.polities[big], Y);
const ownCity = civ.settlements.find((s) => s.id !== capital && own.polity[s.region] === big && stands(s.id, Y))!;
const foreignCity = civ.settlements.find((s) => own.polity[s.region] >= 0 && own.polity[s.region] !== big && stands(s.id, Y))!;
const empty = (() => {
  for (let r = 0; r < reg.count; r++) if (own.culture[r] < 0) return r;
  return -1;
})();
const ownRegion = civ.settlements[capital].region;
const otherRegion = foreignCity.region;

afterEach(() => {
  setMockResponder(null);
  setActiveProvider(null);
  clearEdits();
});

describe('改写 · 坐标', () => {
  it('世界坐标和经纬度互换:左上角 = 西经 180°、北纬 90°;中心 = (0, 0);来回换回原处;经度取模到 −180…180', () => {
    expect(toLonLat(0, 0)).toEqual([-180, 90]);
    expect(toLonLat(1024, 512)).toEqual([0, 0]);
    expect(toWorld(0, 0)).toEqual([1024, 512]);
    for (const [x, y] of [
      [100, 200],
      [1999, 1000],
      [1024, 1],
    ]) {
      const [lon, lat] = toLonLat(x, y);
      const [x2, y2] = toWorld(lon, lat);
      expect(x2).toBeCloseTo(x, 6);
      expect(y2).toBeCloseTo(y, 6);
    }
    expect(toLonLat(2048 + 512, 512)[0]).toBeCloseTo(-90, 6);
  });
});

describe('改写 · 材料与提示词(seed 7)', () => {
  it('seed 7 里有需要的角色:最大的国家和它的邻国、远处的国家、已亡和还没立的国家、本国和外国的城、没人住的州', () => {
    expect(polityAlive(civ.polities[big], Y)).toBe(true);
    expect(neighbor).toBeDefined();
    expect(far).toBeDefined();
    expect(dead).toBeDefined();
    expect(unborn).toBeDefined();
    expect(ownCity).toBeDefined();
    expect(foreignCity).toBeDefined();
    expect(empty).toBeGreaterThanOrEqual(0);
  });

  it('材料:年份、经纬度约定、陆块、国家(在世的写国都和邻国,已亡的写怎么亡的)、民族、山河;实体用短编号', () => {
    const m = rewriteMaterial(world, civ, Y, EMPTY, ['随便说一句']);
    expect(m.year).toBe(Y);
    const t = m.text;
    expect(t).toContain(`时间轴现在在第 ${Y} 年`);
    expect(t).toContain('(经度, 纬度)');
    for (const h of ['## 陆块', '## 国家', '## 城', '## 民族', '## 山河湖海']) expect(t).toContain(h);
    expect(t).toMatch(/^L0 /m);
    expect(t).toMatch(new RegExp(`^P${big} .+\\n  第 ${Y} 年:在世,${size.get(big)} 州,国都 C${capital} `, 'm'));
    expect(t).toMatch(new RegExp(`^  第 ${Y} 年:在世,.*邻国 .*P${neighbor}(、|$)`, 'm'));
    expect(t).toMatch(new RegExp(`^C${capital} ${civ.settlements[capital].name} · `, 'm'));
    expect(t).toMatch(/^E0 .+族 · /m);
    expect(t).toMatch(/^M\d+ .+\(.+\)· /m);
    // 亡了的国家写怎么亡的、最后的国都
    expect(rewriteMaterial(world, civ, deadYear, EMPTY, ['x']).text).toMatch(
      new RegExp(`^P${dead.id} .+\\n  第 ${deadYear} 年:已亡\\(第 ${Math.floor(dead.ended!)} 年(并入|被|瓦解).*\\);最后的国都 C\\d+ `, 'm'),
    );
    // 没做过修改:不列"已经做过的修改";一个世界的材料不太长
    expect(t).not.toContain('## 已经做过的修改');
    expect(t.length).toBeLessThan(20000);
    // 同样的输入同样的材料
    expect(rewriteMaterial(world, civ, Y, EMPTY, ['随便说一句']).text).toBe(t);
  });

  it('作者点了名的城、州才列进材料;年份超出范围夹到 0…最后一年', () => {
    const m0 = rewriteMaterial(world, civ, Y, EMPTY, ['随便说一句']).text;
    // 一座不在材料里的小城
    const small = civ.settlements.find((s) => [...s.name].length >= 2 && !m0.includes(`C${s.id} `))!;
    expect(small).toBeDefined();
    const named = rewriteMaterial(world, civ, Y, EMPTY, [`让${small.name}变成国都`]).text;
    expect(named).toContain(`C${small.id} ${small.name} · `);
    const r = [...Array(reg.count).keys()].find((i) => regionNamed(civ, i) && [...regionLabel(civ, i)].length >= 2)!;
    expect(m0).not.toContain('## 州(作者点了名的)');
    expect(rewriteMaterial(world, civ, Y, EMPTY, [`把${regionLabel(civ, r)}划出去`]).text).toContain(`R${r} ${regionLabel(civ, r)} · `);
    expect(rewriteMaterial(world, civ, 99999, EMPTY, ['x']).year).toBe(civ.endYear);
    expect(rewriteMaterial(world, civ, -5, EMPTY, ['x']).year).toBe(0);
    expect(rewriteMaterial(world, civ, Number.NaN, EMPTY, ['x']).year).toBe(civ.endYear);
  });

  it('国家太多只列前 80 个;排在后面、但作者点了名的也列上(说国号、词根都算)', () => {
    const extra = Array.from({ length: 100 }, (_, i) => ({ ...dead, id: civ.polities.length + i, name: `测${i}乌`, eastern: false, dynasties: undefined }));
    const many: Civ = { ...civ, polities: [...civ.polities, ...extra] };
    const last = extra[extra.length - 1];
    const m0 = rewriteMaterial(world, many, Y, EMPTY, ['随便说一句']).text;
    expect(m0).not.toMatch(new RegExp(`^P${last.id} `, 'm'));
    expect(m0.match(/^P\d+ /gm)?.length).toBe(80);
    for (const wish of [`让${last.name}复国`, `让${polityTitleChain(last).split(' → ').pop()}复国`]) {
      const t = rewriteMaterial(world, many, Y, EMPTY, [wish]).text;
      expect(t, wish).toMatch(new RegExp(`^P${last.id} `, 'm'));
      expect(t.match(/^P\d+ /gm)?.length).toBe(81);
    }
  });

  it('已经做过的修改列在最后(干预用编号、改名只说几处、改地形写经纬度)', () => {
    const edits: WorldEdits = {
      names: { [settlementKey(civ, capital)]: '测试城' },
      interventions: [
        { kind: 'protect', a: polityKey(civ, big), from: 1500, until: 1800 },
        { kind: 'ally', a: polityKey(civ, big), b: polityKey(civ, neighbor), from: 1600 },
      ],
      terrain: [{ kind: 'volcano', pts: [1024, 512], r: 20, s: 1 }],
    };
    const t = rewriteMaterial(world, civ, Y, edits, ['x']).text;
    const tail = t.slice(t.indexOf('## 已经做过的修改'));
    expect(tail).toContain(`- 第 1500 年起:P${big} 保护,至第 1800 年`);
    expect(tail).toContain(`- 第 1600 年起:P${big} 与 P${neighbor} 结盟`);
    expect(tail).toContain('- 改过 1 处名字');
    expect(tail).toContain('- 改地形:火山 (0, 0)');
  });

  it('请求:系统提示词 + 材料 + 前几轮(最多 4 轮)+ 这次的话;要 JSON;标题是这句话(长的截断)', () => {
    const mat = rewriteMaterial(world, civ, Y, EMPTY, ['x']);
    const hist = Array.from({ length: 6 }, (_, i) => ({ wish: `第${i}句`, reply: `回${i}`, items: [`修改${i}`], applied: i % 2 === 0 }));
    const req = rewriteRequest(mat, hist, '让最大的国家多撑三百年,顺便在北边放一座火山,再给它的国都起个好听的名字吧');
    expect(req.feature).toBe(REWRITE_FEATURE);
    expect(req.json).toBe(true);
    expect(req.messages[0]).toEqual({ role: 'system', content: REWRITE_SYSTEM });
    const u = req.messages[1].content;
    expect(u.startsWith(mat.text)).toBe(true);
    expect(u).not.toContain('第1句');
    expect(u).toContain('作者:第2句');
    expect(u).toContain('你:回2(列的修改:修改2)—— 作者执行了');
    expect(u).toContain('你:回3(列的修改:修改3)—— 作者没有执行');
    expect(u.endsWith('# 作者这次说\n让最大的国家多撑三百年,顺便在北边放一座火山,再给它的国都起个好听的名字吧')).toBe(true);
    expect(req.title).toBe('让最大的国家多撑三百年,顺便在北边放一座火山,再…');
    expect(rewriteRequest(mat, [], '结盟').messages[1].content).not.toContain('# 之前的对话');
    // 提示词说清楚各种修改和规矩
    for (const op of ['protect', 'unity', 'halt', 'ally', 'declare', 'move', 'cede', 'found', 'rename', 'volcano', 'lake', 'range', 'raise', 'sink'])
      expect(REWRITE_SYSTEM).toContain(`- ${op} `);
    expect(REWRITE_SYSTEM).toContain('雨影');
    expect(REWRITE_SYSTEM).toContain('同一次不要既改地形又下历史命令');
  });

  it('作者的话:去掉控制字符、首尾空白,超长截断', () => {
    expect(cleanWish('  让\u0000它\u0007结盟\n ')).toBe('让它结盟');
    expect(cleanWish('第一行\n第二行')).toBe('第一行\n第二行');
    expect([...cleanWish('长'.repeat(WISH_MAX + 50))].length).toBe(WISH_MAX);
    expect(cleanWish('   ')).toBe('');
  });
});

describe('改写 · 核对 AI 的回复', () => {
  it('整段看不懂 / 什么都没给 = 出错;只回答了问题(没有修改)也行', () => {
    expect(parseRewrite('不是 JSON', ctx())).toMatchObject({ ok: false });
    expect(parseRewrite('[1, 2]', ctx())).toMatchObject({ ok: false });
    expect(parseRewrite('{}', ctx())).toMatchObject({ ok: false, message: expect.stringMatching(/没给出修改/) });
    expect(parseRewrite('{"reply":"这个国家亡于第 2400 年。","edits":[]}', ctx())).toEqual({ ok: true, reply: '这个国家亡于第 2400 年。', items: [], cannot: [] });
    // 包在代码块里、键名用中文也认
    const p = parseRewrite('```json\n{"回复":"好","修改":[{"op":"保护","country":"P' + big + '"}],"做不到":"天气改不了"}\n```', ctx());
    expect(p).toMatchObject({ ok: true, reply: '好', cannot: ['天气改不了'] });
    if (p.ok) expect(p.items[0]).toMatchObject({ op: 'protect', year: Y, change: { kind: 'intervention' } });
  });

  it('保护 / 禁止扩张 / 禁止分裂:编号换成稳定键;until 在 from 之后才收;没写年份用时间轴的年份', () => {
    const a = polityKey(civ, big);
    expect(one({ op: 'protect', country: `P${big}`, from: 1500, until: 1800, why: '多撑一阵' })).toMatchObject({
      op: 'protect',
      change: { kind: 'intervention', v: { kind: 'protect', a, from: 1500, until: 1800 } },
      year: 1500,
      why: '多撑一阵',
      text: expect.stringMatching(/:保护\(至第 1800 年\)$/),
    });
    expect(one({ op: 'protect', country: `P${big}`, from: '第 1500 年', until: 1400 }).change).toEqual({ kind: 'intervention', v: { kind: 'protect', a, from: 1500 } });
    expect(one({ op: 'halt', country: `P${big} 某国`, until: Y + 100 }).change).toEqual({ kind: 'intervention', v: { kind: 'halt', a, from: Y, until: Y + 100 } });
    expect(one({ op: 'unity', country: big, from: 1999.7 }).change).toEqual({ kind: 'intervention', v: { kind: 'unity', a, from: 1999 } });
    // 时间轴在最后一年(刚打开时就是):没写年份、或写的就是最后一年 = 前一年起
    const end = ctx(EMPTY, civ.endYear);
    const last = civ.polities.find((p) => p.ended === undefined)!;
    for (const from of [undefined, civ.endYear])
      expect(one({ op: 'protect', country: `P${last.id}`, from }, end)).toMatchObject({
        year: civ.endYear - 1,
        change: { kind: 'intervention', v: { kind: 'protect', from: civ.endYear - 1 } },
      });
    expect(rewriteMaterial(world, civ, civ.endYear, EMPTY, ['x']).text).toContain(`作者没说年份的命令从第 ${civ.endYear - 1} 年起`);
  });

  it('国家对不上、那一年还没立 / 已亡、年份超出范围:列出来、写明原因、不能执行', () => {
    const bad = (e: Record<string, unknown>, re: RegExp) => {
      const x = one(e);
      expect(x.change, JSON.stringify(e)).toBeNull();
      expect(x.problem, JSON.stringify(e)).toMatch(re);
    };
    bad({ op: 'protect', country: 'P99999' }, /材料里没有 P99999/);
    bad({ op: 'protect', country: '大昌' }, /没说是哪个国家/);
    bad({ op: 'protect', country: `P${dead.id}`, from: deadYear }, /已亡/);
    bad({ op: 'protect', country: `P${unborn.id}`, from: unbornYear }, /还没立国/);
    bad({ op: 'protect', country: `P${big}`, from: civ.endYear + 1 }, /年份要在/);
    bad({ op: 'protect', country: `P${big}`, from: -3 }, /年份要在/);
    bad({ op: 'ally', country: `P${big}`, other: `P${big}` }, /两个不同的国家/);
    bad({ op: 'ally', country: `P${big}` }, /没说是哪个对方国家/);
    bad({ op: 'nuke', country: `P${big}` }, /没有这种修改/);
    expect(one({ op: 'nuke' }).text).toBe('「nuke」');
  });

  it('立国那年下的命令:挪到次年起(那年年初还没立国,命令会落空),写明原因,推演里真的生效;更早的照样不合格', () => {
    // 年中立国、立国前后还有别的国家在(拿来结盟)
    const before = (q: Civ['polities'][number], y: number) => q.founded < y - 1 && (q.ended === undefined || q.ended > y + 2);
    const p = civ.polities.find(
      (q) => !Number.isInteger(q.founded) && (q.ended === undefined || q.ended > q.founded + 5) && civ.polities.some((o) => before(o, Math.floor(q.founded))),
    )!;
    const y = Math.floor(p.founded);
    const a = polityKey(civ, p.id);
    const x = one({ op: 'protect', country: `P${p.id}`, from: y });
    expect(x.problem).toBeUndefined();
    expect(x.year).toBe(y + 1);
    expect(x.change).toEqual({ kind: 'intervention', v: { kind: 'protect', a, from: y + 1 } });
    expect(x.where).toBe(`${nameAt(p, p.founded)}第 ${y} 年才立国,那年年初还不在,命令改从第 ${y + 1} 年起`);
    // 推演里生效了:记了一条干预(立国那年的年初下,一条都不记)
    const fired = (v: Intervention) => generateCiv(world, { interventions: [v] }).annals.some((e) => e.kind === 'intervene' && e.war === 0);
    expect(fired({ kind: 'protect', a, from: y + 1 })).toBe(true);
    expect(fired({ kind: 'protect', a, from: y })).toBe(false);
    // 不在立国那年:年份不动,也不写原因
    const later = one({ op: 'protect', country: `P${p.id}`, from: y + 2 });
    expect([later.year, later.where]).toEqual([y + 2, undefined]);
    // 更早:还没立国;说的立国年份比给的晚,不再自相矛盾
    const early = one({ op: 'protect', country: `P${p.id}`, from: y - 1 });
    expect(early.change).toBeNull();
    expect(early.problem).toBe(`第 ${y - 1} 年${nameAt(p, y - 1)}还没立国(第 ${y} 年立国)`);
    // 结盟的对方在那年立国:也挪
    const old = civ.polities.find((q) => before(q, y))!;
    expect(one({ op: 'ally', country: `P${old.id}`, other: `P${p.id}`, from: y }).change).toEqual({
      kind: 'intervention',
      v: { kind: 'ally', a: polityKey(civ, old.id), b: a, from: y + 1 },
    });
    // 原本是一年期的(截止 = 立国次年):挪过以后管不到一年,不合格,不能变成一直有效
    const short = one({ op: 'protect', country: `P${p.id}`, from: y, until: y + 1 });
    expect(short.change).toBeNull();
    expect(short.problem).toBe(`命令最早从第 ${y + 1} 年起,到第 ${y + 1} 年为止一年也管不到`);
    expect(one({ op: 'protect', country: `P${p.id}`, from: y, until: y + 2 }).change).toEqual({ kind: 'intervention', v: { kind: 'protect', a, from: y + 1, until: y + 2 } });
    // 正好在年初立国(年份是整数):那一刻命令也比立国早,同样挪到次年
    const whole = { ...civ, polities: civ.polities.map((q) => (q.id === p.id ? { ...q, founded: y } : q)) };
    expect(one({ op: 'protect', country: `P${p.id}`, from: y }, ctx(EMPTY, Y, whole)).year).toBe(y + 1);
  });

  it('结盟、宣战:宣战要那一年接壤', () => {
    const [a, b] = [polityKey(civ, big), polityKey(civ, neighbor)];
    expect(one({ op: 'ally', country: `P${big}`, other: `P${neighbor}`, until: 2300 }).change).toEqual({ kind: 'intervention', v: { kind: 'ally', a, b, from: Y, until: 2300 } });
    expect(one({ op: 'declare', country: `P${big}`, other: `P${neighbor}` }).change).toEqual({ kind: 'intervention', v: { kind: 'declare', a, b, from: Y } });
    const x = one({ op: 'declare', country: `P${big}`, other: `P${far}` });
    expect(x.change).toBeNull();
    expect(x.problem).toMatch(/两国不接壤/);
  });

  it('迁都:城要在本国国土里、那一年还在、不是现在的国都', () => {
    const a = polityKey(civ, big);
    expect(one({ op: 'move', country: `P${big}`, city: `C${ownCity.id}` })).toMatchObject({
      change: { kind: 'intervention', v: { kind: 'move', a, city: settlementKey(civ, ownCity.id), from: Y } },
      text: expect.stringContaining(`迁都${ownCity.name}`),
    });
    expect(one({ op: 'move', country: `P${big}`, city: `C${foreignCity.id}` }).problem).toMatch(/不在.+的国土里/);
    expect(one({ op: 'move', country: `P${big}`, city: `C${capital}` }).problem).toMatch(/本来就是国都/);
    expect(one({ op: 'move', country: `P${big}`, city: 'C99999' }).problem).toMatch(/材料里没有 C99999/);
    expect(one({ op: 'move', country: `P${big}` }).problem).toMatch(/没说迁到哪座城/);
  });

  it('划州、立国:可用州或城指定;没人住的划不成、立不成;本来就是它的不用划;国名去掉"国"', () => {
    const a = polityKey(civ, big);
    expect(one({ op: 'cede', country: `P${big}`, region: `R${otherRegion}`, permanent: true }).change).toEqual({
      kind: 'intervention',
      v: { kind: 'cede', a, region: regionKey(civ, otherRegion), from: Y, permanent: true },
    });
    expect(one({ op: 'cede', country: `P${big}`, city: `C${foreignCity.id}` }).change).toEqual({
      kind: 'intervention',
      v: { kind: 'cede', a, region: regionKey(civ, foreignCity.region), from: Y },
    });
    expect(one({ op: 'cede', country: `P${big}`, region: `R${ownRegion}` }).problem).toMatch(/本来就是/);
    expect(one({ op: 'cede', country: `P${big}`, region: `R${empty}` }).problem).toMatch(/没人住,划不成/);
    expect(one({ op: 'found', region: `R${otherRegion}`, name: ' 秦国 ' })).toMatchObject({
      change: { kind: 'intervention', v: { kind: 'found', region: regionKey(civ, otherRegion), from: Y, name: '秦' } },
      text: expect.stringMatching(/立国,国名「秦」$/),
    });
    expect(one({ op: 'found', region: `R${empty}` }).problem).toMatch(/没人住,立不成/);
    expect(one({ op: 'found', region: 'R999999' }).problem).toMatch(/没有这一州/);
    expect(one({ op: 'found' }).problem).toMatch(/没说是哪一州/);
  });

  it('查重:和已经下过的、同一批里前面的一样 = 不能执行', () => {
    const v: Intervention = { kind: 'protect', a: polityKey(civ, big), from: Y };
    expect(one({ op: 'protect', country: `P${big}` }, ctx({ ...EMPTY, interventions: [v] })).problem).toMatch(/已经下过/);
    const p = parseRewrite(json([{ op: 'protect', country: `P${big}` }, { op: 'protect', country: `P${big}`, from: Y }]), ctx());
    expect(p.ok && p.items.map((x) => !!x.change)).toEqual([true, false]);
  });

  it('改名:国家(东方国家后来的朝代改朝代名)、城、州、民族、山河;和原名一样 / 空名 / 同一处改两次不行', () => {
    const p = civ.polities[big];
    const r = one({ op: 'rename', target: `C${capital}`, name: '测试城', why: '好听' });
    expect(r).toMatchObject({ op: 'rename', change: { kind: 'name', key: settlementKey(civ, capital), name: '测试城' }, why: '好听' });
    expect(r.text).toBe(`${civ.settlements[capital].name}改名为「测试城」`);
    expect(r.year).toBeUndefined();
    expect(one({ op: 'rename', target: `R${otherRegion}`, name: '九嶷州' }).change).toEqual({ kind: 'name', key: regionKey(civ, otherRegion), name: '九嶷州' });
    expect(one({ op: 'rename', target: 'E0', name: '测试' }).change).toEqual({ kind: 'name', key: cultureKey(civ, 0), name: '测试' });
    expect(one({ op: 'rename', target: 'M0', name: '测试河' }).change).toMatchObject({ kind: 'name', key: placeKeyOf(civ, 0) });
    // 国家:改的是这一年那一朝的名字
    const east = civ.polities.find((q) => q.eastern && (q.dynasties?.length ?? 0) >= 2 && q.founded < q.dynasties![1].year)!;
    expect(east).toBeDefined();
    const later = Math.floor(east.dynasties![1].year) + 1;
    expect(one({ op: 'rename', target: `P${east.id}`, name: '澜' }, ctx(EMPTY, later)).change).toEqual({ kind: 'name', key: dynastyKey(civ, east.id, 1), name: '澜' });
    expect(one({ op: 'rename', target: `P${east.id}`, name: '澜' }, ctx(EMPTY, Math.ceil(east.founded))).change).toEqual({
      kind: 'name',
      key: polityKey(civ, east.id),
      name: '澜',
    });
    // 不行的
    expect(one({ op: 'rename', target: `C${capital}`, name: civ.settlements[capital].name }).problem).toMatch(/一样/);
    expect(one({ op: 'rename', target: `E0`, name: civ.cultures[0].name }).problem).toMatch(/一样/);
    expect(one({ op: 'rename', target: `C${capital}`, name: '  ' }).problem).toMatch(/空的/);
    expect(one({ op: 'rename', target: 'C99999', name: '某城' }).problem).toMatch(/材料里没有 C99999/);
    expect(one({ op: 'rename', name: '某城' }).problem).toMatch(/没说改哪个/);
    const twice = parseRewrite(json([{ op: 'rename', target: `P${p.id}`, name: '甲' }, { op: 'rename', target: `P${p.id}`, name: '乙' }]), ctx());
    expect(twice.ok && twice.items[1].problem).toMatch(/改了两次/);
  });

  it('改地形:经纬度换成世界坐标,大小按改地形工具条的三档;湖不能挖在海里;山脉要两个点;满了不收', () => {
    const v = one({ op: 'volcano', at: [0, 0], size: '大', why: '造个岛' });
    expect(v.change).toEqual({ kind: 'terrain', op: { kind: 'volcano', pts: [1024, 512], r: TERRAIN_PRESETS.volcano[2][0], s: TERRAIN_PRESETS.volcano[2][1] } });
    expect(v.text).toMatch(/放一座火山\(大\)$/);
    // 位置的几种写法都认;没写大小 = 中
    for (const at of ['0, 0', { lon: 0, lat: 0 }, [[0, 0]]]) {
      const x = one({ op: 'volcano', ...(Array.isArray(at) ? { path: at } : { at }) });
      expect((x.change as Extract<RewriteChange, { kind: 'terrain' }>).op, JSON.stringify(at)).toMatchObject({ pts: [1024, 512], r: TERRAIN_PRESETS.volcano[1][0] });
    }
    const range = one({ op: 'range', path: [10, 40, 14, 46, 16, 52], size: '低' });
    const op = (range.change as Extract<RewriteChange, { kind: 'terrain' }>).op;
    expect(op.kind).toBe('range');
    expect(op.pts.length).toBe(6);
    expect(op.pts[0]).toBeCloseTo(toWorld(10, 40)[0], 0);
    expect(op.pts[1]).toBeCloseTo(toWorld(10, 40)[1], 0);
    expect([op.r, op.s]).toEqual([...TERRAIN_PRESETS.range[0]]);
    expect(range.text).toMatch(/^从.+到.+抬起一道山脉\(低\)$/);
    expect(one({ op: 'range', path: [[10, 40]] }).problem).toMatch(/至少两个点/);
    expect(one({ op: 'sink' }).problem).toMatch(/没给路线/);
    expect(one({ op: 'volcano', at: [0, 95] }).problem).toMatch(/没给位置/);
    // 湖:海上不行,陆上可以
    const sea = [...Array(world.mesh.n).keys()].find((i) => world.water[i] === 1 && world.mesh.y[i] > 300 && world.mesh.y[i] < 700)!;
    const land = civ.settlements[capital].cell;
    expect(one({ op: 'lake', at: toLonLat(world.mesh.x[sea], world.mesh.y[sea]) }).problem).toMatch(/这里是海/);
    expect(one({ op: 'lake', at: toLonLat(world.mesh.x[land], world.mesh.y[land]) }).change).toMatchObject({ kind: 'terrain', op: { kind: 'lake' } });
    // 同一批前面在那片海上抬起陆地 / 放火山 / 拉山脉:湖先收下(生成时湖心还在海里就不挖);沉成海、离得远的不算;
    // 前面把陆地沉成海的,湖不收
    const seaLL = toLonLat(world.mesh.x[sea], world.mesh.y[sea]);
    const lakeAfter = (first: Record<string, unknown>, at = seaLL) => {
      const p = parseRewrite(json([first, { op: 'lake', at }]), ctx());
      if (!p.ok) throw new Error(p.message);
      expect(p.items[0].change).toBeTruthy();
      return p.items[1];
    };
    const LAKE = { kind: 'terrain', op: { kind: 'lake' } };
    expect(lakeAfter({ op: 'raise', path: [seaLL], size: '大' }).change).toMatchObject(LAKE);
    expect(lakeAfter({ op: 'volcano', at: seaLL }).change).toMatchObject(LAKE);
    expect(lakeAfter({ op: 'range', path: [[seaLL[0] - 3, seaLL[1]], [seaLL[0] + 3, seaLL[1]]] }).change).toMatchObject(LAKE);
    expect(lakeAfter({ op: 'sink', path: [seaLL] }).problem).toMatch(/海,湖要挖在陆地上/);
    const landLL = toLonLat(world.mesh.x[land], world.mesh.y[land]);
    expect(lakeAfter({ op: 'sink', path: [landLL] }, landLL).problem).toMatch(/同一批前面把这里沉成了海/);
    expect(lakeAfter({ op: 'volcano', at: [landLL[0] > 0 ? landLL[0] - 90 : landLL[0] + 90, landLL[1]] }, landLL).change).toMatchObject(LAKE);
    expect(lakeAfter({ op: 'raise', path: [[seaLL[0] > 0 ? seaLL[0] - 90 : seaLL[0] + 90, seaLL[1]]] }).problem).toMatch(/这里是海/);
    // 跨 180° 经线也算近
    const edge = [...Array(world.mesh.n).keys()].find((i) => world.water[i] === 1 && world.mesh.x[i] < 2 && world.mesh.y[i] > 300 && world.mesh.y[i] < 700)!;
    const edgeLL = toLonLat(world.mesh.x[edge], world.mesh.y[edge]);
    expect(one({ op: 'lake', at: edgeLL }).problem).toMatch(/这里是海/);
    expect(lakeAfter({ op: 'raise', path: [[179.9, edgeLL[1]]] }, edgeLL).change).toMatchObject(LAKE);
    // 地形处数满了
    const full: TerrainOp[] = Array.from({ length: TERRAIN_MAX_OPS }, (_, i) => ({ kind: 'volcano', pts: [i * 10, 500], r: 20, s: 1 }));
    expect(one({ op: 'volcano', at: [0, 0] }, ctx({ ...EMPTY, terrain: full })).problem).toMatch(/已经满了/);
    const almost = parseRewrite(json([{ op: 'volcano', at: [0, 0] }, { op: 'volcano', at: [5, 0] }]), ctx({ ...EMPTY, terrain: full.slice(1) }));
    expect(almost.ok && almost.items.map((x) => !!x.change)).toEqual([true, false]);
  });

  it('一次最多 12 条,多的不收并写进"做不到";没有文明的世界只能改地形', () => {
    const many = Array.from({ length: REWRITE_MAX_ITEMS + 3 }, (_, i) => ({ op: 'volcano', at: [i * 5, 0] }));
    const p = parseRewrite(json(many), ctx());
    expect(p.ok && p.items.length).toBe(REWRITE_MAX_ITEMS);
    expect(p.ok && p.cannot.at(-1)).toMatch(/一次最多 12 条/);
    const frozen: World = { ...world, biome: world.biome.map((b, i) => (world.water[i] === 0 ? Biome.Ice : b)) };
    const none = generateCiv(frozen);
    expect(none.viable).toBe(false);
    const c = ctx(EMPTY, Y, none, frozen);
    expect(one({ op: 'protect', country: 'P0' }, c).problem).toMatch(/没有文明/);
    expect(one({ op: 'volcano', at: [30, 10] }, c).change).toMatchObject({ kind: 'terrain' });
    expect(rewriteMaterial(frozen, none, Y, EMPTY, ['x']).text).toContain('没有长出文明');
  });
});

describe('改写 · 合进修改 / 撤销', () => {
  const a = polityKey(civ, big);
  const v1: Intervention = { kind: 'protect', a, from: 1500 };
  const v2: Intervention = { kind: 'halt', a, from: 1600 };
  const t1: TerrainOp = { kind: 'volcano', pts: [1024, 512], r: 20, s: 1 };
  const k = settlementKey(civ, capital);

  it('合进:一次加上几条;已有的跳过;什么都没变 = 原对象', () => {
    const base: WorldEdits = { names: { x: '旧' }, interventions: [v1], terrain: [] };
    const out = mergeRewrite(base, [
      { kind: 'intervention', v: v1 },
      { kind: 'intervention', v: v2 },
      { kind: 'name', key: k, name: '新城' },
      { kind: 'terrain', op: t1 },
    ]);
    expect(out).toEqual({ names: { x: '旧', [k]: '新城' }, interventions: [v1, v2], terrain: [t1] });
    expect(base).toEqual({ names: { x: '旧' }, interventions: [v1], terrain: [] });
    expect(mergeRewrite(base, [{ kind: 'intervention', v: v1 }])).toBe(base);
    expect(mergeRewrite(base, [])).toBe(base);
    const nameOnly = mergeRewrite(base, [{ kind: 'name', key: 'x', name: '新' }]);
    expect(nameOnly.interventions).toBe(base.interventions);
    expect(nameOnly.terrain).toBe(base.terrain);
  });

  it('撤销:之后没改过 = 回到执行前;改过别的 = 只拿掉这一批加的,改过的名字恢复,之后又改的名字不动', () => {
    const before: WorldEdits = { names: { [k]: '旧城', y: '乙' }, interventions: [v1], terrain: [] };
    const after = mergeRewrite(before, [
      { kind: 'intervention', v: v2 },
      { kind: 'name', key: k, name: '新城' },
      { kind: 'name', key: 'z', name: '丙' },
      { kind: 'terrain', op: t1 },
    ]);
    expect(unmergeRewrite(after, before, after)).toBe(before);
    // 之后又下了一条命令、又改了 z 的名字
    const v3: Intervention = { kind: 'unity', a, from: 1700 };
    const now: WorldEdits = { names: { ...after.names, z: '丁', w: '戊' }, interventions: [...after.interventions, v3], terrain: after.terrain };
    expect(unmergeRewrite(now, before, after)).toEqual({ names: { [k]: '旧城', y: '乙', z: '丁', w: '戊' }, interventions: [v1, v3], terrain: [] });
    // 这一批加的都已经被拿掉了 = 原对象
    const gone: WorldEdits = { names: before.names, interventions: [v1, v3], terrain: [] };
    expect(unmergeRewrite(gone, before, after)).toBe(gone);
  });
});

describe('改写 · 测试用假 AI', () => {
  it('固定提议:话里没有地形字眼 = 最大的国家保护 300 年;有 = 在它国都以东放一座火山;都能通过核对', () => {
    const c = ctx();
    const p = parseRewrite(mockRewrite(c, '让它多撑三百年'), c);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.reply).toMatch(/^【测试用假 AI】/);
    expect(p.cannot.length).toBe(1);
    expect(p.items.map((x) => x.change)).toEqual([{ kind: 'intervention', v: { kind: 'protect', a: polityKey(civ, largest), from: Y, until: Y + 300 } }]);
    const q = parseRewrite(mockRewrite(c, '在海上放一座火山'), c);
    expect(q.ok && q.items.map((x) => x.change?.kind)).toEqual(['terrain']);
    if (q.ok) expect(q.items[0].text).toMatch(/^在.+放一座火山\(中\)$/);
    // 最后几年:保护到最后(不给 until);没有文明 = 火山
    const end = parseRewrite(mockRewrite(ctx(EMPTY, civ.endYear - 10), ''), ctx(EMPTY, civ.endYear - 10));
    expect(end.ok && end.items[0].change).toMatchObject({ kind: 'intervention', v: { kind: 'protect' } });
    expect(end.ok && (end.items[0].change as Extract<RewriteChange, { kind: 'intervention' }>).v).not.toHaveProperty('until');
  });
});
