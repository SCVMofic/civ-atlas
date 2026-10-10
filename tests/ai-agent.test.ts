/**
 * 助手:工具调用的循环、试推演的对照、查资料 / 试推演 / 列确认单这几个工具,和一次完整的对话。
 * 全程用测试用假 AI(按剧本一轮一轮回),不联网;试推演在 Node 里真的重推历史(种子 7)。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { generateCiv } from '../src/gen/civ';
import type { Civ } from '../src/gen/civ/types';
import { ownersAt } from '../src/gen/civ/timeline';
import { applyNames, polityKey, regionKey, type WorldEdits } from '../src/gen/edits';
import { setActiveProvider, setMockResponder } from '../src/ai/client';
import { AiError, type AiRequest } from '../src/ai/types';
import { AGENT_MAX_ROUNDS, FINAL_NUDGE, TOOL_RESULT_MAX, looksUnfinished, parseToolArgs, runAgent, type AgentEvent, type AgentTool, type AgentToolResult } from '../src/ai/agent/loop';
import { compareTrial, fateText, matchPolities, trialText } from '../src/ai/agent/trial';
import {
  ASSISTANT_FEATURE,
  ASSISTANT_SYSTEM,
  TRIAL_MAX,
  TRIAL_SAME_MAX,
  UNFINISHED_NOTE,
  assistantMessages,
  assistantTools,
  polityOf,
  runAssistant,
  type AssistantContext,
  type AssistantProposal,
  type AssistantTrial,
} from '../src/ai/agent/assistant';
import { REWRITE_OPS, REWRITE_SYSTEM, bordersAt, nameAt, parseRewrite, plainIds } from '../src/ai/prompts/rewrite';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7 });
const civ = generateCiv(world);
const EMPTY: WorldEdits = { names: {}, interventions: [], terrain: [] };
/** 真的重推一遍(和界面里交给 worker 的一样:干预重推,再套上改名) */
const simulate = async (e: WorldEdits): Promise<Civ> => applyNames(generateCiv(world, e.interventions.length ? { interventions: e.interventions } : undefined), e.names);
const ctx = (over: Partial<AssistantContext> = {}): AssistantContext => ({ world, civ, year: 2000, edits: EMPTY, simulate, ...over });

// ---- 这份历史里的角色:最晚一个被灭的国家(亡国前 30 年起保护它),和它那时的一个邻国(拉来结盟) ----
const fall = [...civ.annals].reverse().find((e) => e.kind === 'fall' && e.b >= 0 && e.a >= 0 && civ.polities[e.a].founded < Math.floor(e.year) - 40)!;
const victim = fall.a;
const conqueror = fall.b;
const from = Math.floor(fall.year) - 30;
const vName = nameAt(civ.polities[victim], from);
const ownFrom = ownersAt(civ, from).polity;
const friend =
  [...bordersAt(civ, ownFrom, victim)].find((q) => q !== conqueror) ??
  civ.polities.find((p) => p.id !== victim && p.id !== conqueror && p.founded <= from && (p.ended === undefined || p.ended > from))!.id;
const PROTECT = { op: 'protect', country: `P${victim}`, from, why: '国都攻不下' };
const ALLY = { op: 'ally', country: `P${victim}`, other: `P${friend}`, from, why: '找个帮手' };

/** 工具交回模型的那段文字 */
const said = async (r: Promise<string | AgentToolResult> | string | AgentToolResult): Promise<string> => {
  const v = await r;
  return typeof v === 'string' ? v : v.result;
};

/** 假 AI 按剧本一轮一轮回(字符串 = 只回话;calls = 要调用的工具 [名字, 参数]);记下每一轮收到的请求 */
type Round = string | { text?: string; calls: [string, unknown][] };
function script(...rounds: Round[]): AiRequest[] {
  const seen: AiRequest[] = [];
  let i = 0;
  setMockResponder((req) => {
    seen.push(structuredClone(req));
    const n = i++;
    const r = rounds[Math.min(n, rounds.length - 1)];
    if (typeof r === 'string') return r;
    return { text: r.text, toolCalls: r.calls.map(([name, args], k) => ({ id: `call_${n}_${k}`, name, args: typeof args === 'string' ? args : JSON.stringify(args) })) };
  });
  return seen;
}

beforeAll(() => {
  setActiveProvider('mock');
});

afterEach(() => {
  setMockResponder(null);
});

describe('助手的循环', () => {
  const echo: AgentTool = {
    def: { name: 'echo', description: '原样说回来', parameters: { type: 'object', properties: { x: { type: 'number' } } } },
    label: (a) => `回声 ${a.x}`,
    run: (a) => `收到 ${a.x}`,
  };
  const boom: AgentTool = {
    def: { name: 'boom', description: '一定出错', parameters: { type: 'object', properties: {} } },
    run: () => {
      throw new Error('坏了');
    },
  };
  const long: AgentTool = {
    def: { name: 'long', description: '回一大段', parameters: { type: 'object', properties: {} } },
    run: () => 'x'.repeat(TOOL_RESULT_MAX + 500),
  };

  it('模型调工具 → 网页执行 → 结果按调用编号交回 → 模型回话;参数不合法、没有这个工具、执行出错都把原因交回,不中断', async () => {
    const seen = script({ text: '我先查一下。', calls: [['echo', { x: 1 }], ['nope', {}], ['echo', '{bad'], ['boom', {}], ['long', {}]] }, '查好了。');
    const events: AgentEvent[] = [];
    const out = await runAgent({
      feature: '测试',
      messages: [{ role: 'user', content: '帮我查查' }],
      tools: [echo, boom, long],
      onEvent: (e) => events.push(e),
    });
    expect(out.text).toBe('查好了。');
    expect(out.end).toBe('done');
    expect(out.rounds).toBe(2);
    expect(out.steps.map((s) => [s.tool, s.state])).toEqual([
      ['echo', 'ok'],
      ['nope', 'error'],
      ['echo', 'error'],
      ['boom', 'error'],
      ['long', 'ok'],
    ]);
    expect(out.steps[0]).toMatchObject({ id: 's1', label: '回声 1', result: '收到 1', args: { x: 1 } });
    expect(out.steps[1].result).toContain('echo、boom、long');
    expect(out.steps[2].result).toContain('JSON');
    expect(out.steps[3].result).toBe('出错了:坏了');
    expect(out.steps[4].result!.length).toBeLessThan(TOOL_RESULT_MAX + 50);
    // 第一轮:带上工具,模型自己决定调不调
    expect(seen[0].tools!.map((t) => t.name)).toEqual(['echo', 'boom', 'long']);
    expect(seen[0].toolChoice).toBe('auto');
    expect(seen[0].feature).toBe('测试');
    // 第二轮:模型上一轮的话和调用原样放回,后面每个调用一条结果(对得上调用编号)
    const m = seen[1].messages;
    expect(m[1]).toMatchObject({ role: 'assistant', content: '我先查一下。' });
    expect(m[1].toolCalls!.map((c) => c.id)).toEqual(['call_0_0', 'call_0_1', 'call_0_2', 'call_0_3', 'call_0_4']);
    expect(m.slice(2).map((x) => [x.role, x.toolCallId])).toEqual([
      ['tool', 'call_0_0'],
      ['tool', 'call_0_1'],
      ['tool', 'call_0_2'],
      ['tool', 'call_0_3'],
      ['tool', 'call_0_4'],
    ]);
    expect(m[2].content).toBe('收到 1');
    // 整段对话最后是模型的回话
    expect(out.messages[out.messages.length - 1]).toEqual({ role: 'assistant', content: '查好了。' });
    // 事件:每一轮开头、每一步开始和做完、模型正在说的话
    expect(events.filter((e) => e.type === 'round').map((e) => (e as { round: number }).round)).toEqual([0, 1]);
    expect(events.filter((e) => e.type === 'step')).toHaveLength(5);
    const done = events.filter((e): e is Extract<AgentEvent, { type: 'step-done' }> => e.type === 'step-done');
    expect(done.map((e) => e.step.state)).toEqual(['ok', 'error', 'error', 'error', 'ok']);
    expect(events.filter((e) => e.type === 'text').pop()).toEqual({ type: 'text', text: '查好了。' });
    expect(out.usage.inputTokens).toBeGreaterThan(0);
  });

  it('模型给的调用编号重复或是空的:换成不重的,每条结果对得上各自那次调用', async () => {
    const seen: AiRequest[] = [];
    let n = 0;
    setMockResponder((req) => {
      seen.push(structuredClone(req));
      if (n++ > 0) return '好了。';
      return {
        toolCalls: [
          { id: 'c', name: 'echo', args: '{"x":1}' },
          { id: 'c', name: 'echo', args: '{"x":2}' },
          { id: '', name: 'echo', args: '{"x":3}' },
        ],
      };
    });
    const out = await runAgent({ feature: '测试', messages: [{ role: 'user', content: '查' }], tools: [echo] });
    expect(out.text).toBe('好了。');
    const m = seen[1].messages;
    const ids = m[1].toolCalls!.map((c) => c.id);
    expect(ids[0]).toBe('c');
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(m.slice(2).map((x) => [x.toolCallId, x.content])).toEqual(ids.map((id, i) => [id, `收到 ${i + 1}`]));
  });

  it('到了轮数上限:最后一轮不许再调工具,拿它说的话收尾', async () => {
    const seen = script({ text: '再查查。', calls: [['echo', { x: 2 }]] });
    const out = await runAgent({ feature: '测试', messages: [{ role: 'user', content: '查个没完' }], tools: [echo], maxRounds: 3 });
    expect(seen.map((r) => r.toolChoice)).toEqual(['auto', 'auto', 'none']);
    expect(out.end).toBe('rounds');
    expect(out.rounds).toBe(3);
    expect(out.steps).toHaveLength(2);
    expect(out.text).toBe('再查查。');
    expect(AGENT_MAX_ROUNDS).toBeGreaterThanOrEqual(6);
    // 最后一轮之前补一句"直接说结论";前几轮没有
    const lastMsg = (r: AiRequest) => r.messages[r.messages.length - 1];
    expect(lastMsg(seen[2])).toEqual({ role: 'user', content: FINAL_NUDGE });
    expect(seen.slice(0, 2).some((r) => r.messages.some((m) => m.content === FINAL_NUDGE))).toBe(false);
    expect(FINAL_NUDGE).toMatch(/直接告诉作者结论/);
  });

  it('到了轮数上限、最后一轮老实收尾(不再要调工具):也算 rounds;只问一轮的不补那句话、算 done', async () => {
    let seen = script({ calls: [['echo', { x: 1 }]] }, { calls: [['echo', { x: 2 }]] }, '做不到:命令只能定条件。');
    let out = await runAgent({ feature: '测试', messages: [{ role: 'user', content: '…' }], tools: [echo], maxRounds: 3 });
    expect(out.text).toBe('做不到:命令只能定条件。');
    expect(out.end).toBe('rounds');
    expect(seen[2].messages.filter((m) => m.content === FINAL_NUDGE)).toHaveLength(1);
    seen = script('直接回答。');
    out = await runAgent({ feature: '测试', messages: [{ role: 'user', content: '…' }], tools: [echo], maxRounds: 1 });
    expect(out.end).toBe('done');
    expect(seen[0].toolChoice).toBe('none');
    expect(seen[0].messages.some((m) => m.content === FINAL_NUDGE)).toBe(false);
  });

  it('收尾的话像没说完:以冒号结尾,或者最后一段是"让我再查……"这类', () => {
    for (const t of ['让我也查询赤牙王朝在同一时期的详细编年史：', '先看结果。\n\n接着查一下:', '试了四次都不行。\n\n让我再试一次，这次试试组合效果。', '我先看看那一年的格局'])
      expect(looksUnfinished(t), t).toBe(true);
    for (const t of ['', '做不到：命令只能定条件，不能规定谁打赢。', '让我总结一下：保护以后它撑到了最后。', '我再说一句，这是试推演的结果。'])
      expect(looksUnfinished(t), t).toBe(false);
  });

  it('做过步骤再收尾不说话可以(结果已经在面板上);一步没做、一句没说算空回复', async () => {
    script({ calls: [['echo', { x: 4 }]] }, '');
    const out = await runAgent({ feature: '测试', messages: [{ role: 'user', content: '…' }], tools: [echo] });
    expect(out.text).toBe('');
    expect(out.steps).toHaveLength(1);
    script('  ');
    const e = (await runAgent({ feature: '测试', messages: [{ role: 'user', content: '…' }], tools: [echo] }).catch((x) => x)) as AiError;
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe('bad-response');
  });

  it('停下:工具执行时停下 → aborted,不再问 AI', async () => {
    const ac = new AbortController();
    const seen = script({ calls: [['stop', {}], ['echo', { x: 3 }]] }, '不该到这里');
    const stop: AgentTool = {
      def: { name: 'stop', description: '', parameters: { type: 'object', properties: {} } },
      run: () => {
        ac.abort();
        return '停';
      },
    };
    const e = (await runAgent({ feature: '测试', messages: [{ role: 'user', content: '…' }], tools: [stop, echo], signal: ac.signal }).catch((x) => x)) as AiError;
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe('aborted');
    expect(seen).toHaveLength(1);
  });

  it('参数原文:空 = {};不是 JSON 对象 = null', () => {
    expect(parseToolArgs('')).toEqual({});
    expect(parseToolArgs(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseToolArgs('[1]')).toBeNull();
    expect(parseToolArgs('{"a":')).toBeNull();
  });
});

describe('试推演的对照', () => {
  it('同一份历史:什么都没变', () => {
    const d = compareTrial(civ, civ, [victim], from);
    expect(d.focus).toHaveLength(1);
    expect(d.focus[0].who).toEqual({ id: victim, name: vName });
    expect(d.focus[0].after).toEqual(d.focus[0].before);
    expect(d.focus[0].before).toMatchObject({ end: Math.floor(civ.polities[victim].ended!), way: 'fall', by: { id: conqueror } });
    expect(d.others).toEqual([]);
    expect(d.addedCount + d.removedCount).toBe(0);
    expect(d.alive[0]).toBe(d.alive[1]);
    expect(trialText(d)).toContain('大事没有变化');
  });

  it('结局对照里的国家按最后的国号叫(和左边卡片一样);那时叫法不一样的,给 AI 的文字里补一句', () => {
    const p = civ.polities.find((q) => q.ended === undefined && q.founded < 2500 && nameAt(q, 2500) !== nameAt(q, civ.endYear))!;
    expect(p).toBeDefined();
    const d = compareTrial(civ, civ, [p.id], 2500);
    expect(d.focus[0].who).toEqual({ id: p.id, name: nameAt(p, civ.endYear), then: nameAt(p, 2500) });
    expect(trialText(d)).toContain(`P${p.id} ${nameAt(p, civ.endYear)}(第 2500 年时叫${nameAt(p, 2500)})`);
  });

  it('试推演里新立的国家:不会占掉同一州里原有国家的序号、被认成那个国家;两边同一条立国修改立的对得上', () => {
    // 一个后来才立的国家,在它国都那州早 30 年让人立国
    const S = civ.settlements;
    const q = civ.polities.find((p) => p.founded >= 1200)!;
    const y = Math.floor(q.founded) - 30;
    const after = generateCiv(world, { interventions: [{ kind: 'found', region: regionKey(civ, S[q.capital].region), from: y }] });
    const made = after.annals.find((e) => e.kind === 'intervene' && e.war === 0)!.a;
    expect(made).toBeGreaterThanOrEqual(0);
    // 按稳定键,新立的国家正好落在原来那国的键上
    expect(polityKey(after, made)).toBe(polityKey(civ, q.id));
    const m = matchPolities(civ, after, y);
    expect(m.has(made)).toBe(false);
    for (const [a, b] of m) if (b === q.id) expect(Math.abs(after.polities[a].founded - q.founded)).toBeLessThanOrEqual(60);
    // 这一州被抢先立了国,原来那国在试推演里没立起来:它的结局是"没有这个国家",不是新立那国的结局
    expect(compareTrial(civ, after, [q.id], y).focus[0].after).toBeNull();
    // 两边都有这条立国修改:立出来的国家对上
    const same = matchPolities(after, after, y);
    for (const p of after.polities) expect(same.get(p.id)).toBe(p.id);
  });

  it('保护一个原本被灭的国家:试推演里它活到最后,它被灭的那条大事不再发生', async () => {
    const after = generateCiv(world, { interventions: [{ kind: 'protect', a: polityKey(civ, victim), from }] });
    const d = compareTrial(civ, after, [victim], from);
    const f = d.focus[0];
    expect(f.before!.end).toBe(Math.floor(civ.polities[victim].ended!));
    expect(f.after).not.toBeNull();
    expect(f.after!.end).toBeUndefined();
    expect(f.after!.size).toBeGreaterThan(0);
    expect(d.removedCount).toBeGreaterThan(0);
    expect(d.removed.length).toBeLessThanOrEqual(10);
    // 从 from 年起才不一样:别的国家里变化大的都是 from 年时还在、或之后才立的
    for (const c of d.others) if (c.who.id >= 0) expect(civ.polities[c.who.id].ended === undefined || civ.polities[c.who.id].ended! > from).toBe(true);
    const t = trialText(d);
    expect(t).toContain(`P${victim} ${vName}`);
    expect(t).toContain(`到第 ${civ.endYear} 年仍在`);
    expect(fateText(f.before, civ.endYear)).toMatch(/^第 \d+ 年被 P\d+ .+ 所灭\(亡国前 \d+ 州\)$/);
  });
});

describe('助手', () => {
  it('查 → 试推演两次 → 列确认单 → 回话:确认单附上同一批的试推演结果;每一步一句话', async () => {
    const seen = script(
      { calls: [['country', { country: `P${victim}` }]] },
      { text: '先试试只保护。', calls: [['try_edits', { edits: [PROTECT] }]] },
      { calls: [['try_edits', { edits: [PROTECT, ALLY] }]] },
      { calls: [['propose_edits', { edits: [PROTECT, ALLY], cannot: ['规定谁打赢做不到'] }]] },
      '试推演里它撑到了最后。',
    );
    const steps: string[] = [];
    const r = await runAssistant(ctx(), [], `让${vName}撑到最后`, { onEvent: (e) => e.type === 'step-done' && steps.push(e.step.label) });
    expect(r.text).toBe('试推演里它撑到了最后。');
    expect(r.end).toBe('done');
    // 刚查过的国家不再重复国名
    expect(steps).toEqual([`查国家：${nameAt(civ.polities[victim], 2000)}`, `试推演：第 ${from} 年起保护`, expect.stringMatching(/^试推演：保护，再和.+结盟$/), '列出要改的 2 条']);
    expect(r.steps.every((s) => s.state === 'ok')).toBe(true);
    // 每一步下面一句给作者看的结果
    // (分出来的国家说"自立";试推演那一行说的就是刚查过的国家,不写国名)
    expect(r.steps[0].summary).toMatch(new RegExp(`^第 \\d+ 年${civ.polities[victim].parent !== undefined ? '自立' : '立国'}；`));
    expect(r.steps[1].summary).toBe(`撑到了第 ${civ.endYear} 年，最后 ${r.trials[0].diff.focus[0].after!.size} 州`);

    // 第一轮:提示词、材料、作者的话、五个工具
    expect(seen[0].feature).toBe(ASSISTANT_FEATURE);
    expect(seen[0].messages[0]).toEqual({ role: 'system', content: ASSISTANT_SYSTEM });
    expect(seen[0].messages[1].content).toContain('# 这个世界');
    expect(seen[0].messages[1].content).toMatch(new RegExp(`# 作者这次说\\n让${vName}撑到最后$`));
    expect(seen[0].tools!.map((t) => t.name)).toEqual(['country', 'chronicle', 'situation', 'try_edits', 'propose_edits']);
    // 查国家的结果交回去了
    expect(seen[1].messages[seen[1].messages.length - 1]).toMatchObject({ role: 'tool', toolCallId: 'call_0_0' });
    expect(seen[1].messages[seen[1].messages.length - 1].content).toContain(`P${victim} `);
    // 试推演的结果交回去了
    const t1 = seen[2].messages[seen[2].messages.length - 1].content;
    expect(t1).toContain('第 1 次试推演(没有执行)');
    expect(t1).toContain(`P${victim} ${vName}:现在 第 `);

    // 两次试推演都记下了:保护以后它活到最后
    expect(r.trials.map((t) => t.n)).toEqual([1, 2]);
    expect(r.trials[0].diff.focus[0].after!.end).toBeUndefined();
    expect(r.trials[1].diff.focus.map((f) => f.who.id).sort((a, b) => a - b)).toEqual([victim, friend].sort((a, b) => a - b));
    expect(r.trials[1].edits.interventions).toHaveLength(2);
    // 确认单:两条都能执行,附上第 2 次试推演(同一批修改),做不到的照抄
    const p = r.proposal!;
    expect(p.items.map((it) => it.change?.kind)).toEqual(['intervention', 'intervention']);
    expect(p.cannot).toEqual(['规定谁打赢做不到']);
    expect(p.trial).toBe(r.trials[1]);
    // 作者的世界没动
    expect(ctx().edits).toBe(EMPTY);
  });

  it('列确认单:没试过的顺带试推演一次;有地形修改的不附结果;再列一次换掉上一张;试推演次数有上限', async () => {
    let runs = 0;
    const fast = async () => {
      runs++;
      return civ;
    };
    const state: { trials: AssistantTrial[]; proposal: AssistantProposal | null } = { trials: [], proposal: null };
    const tools = Object.fromEntries(assistantTools(ctx({ simulate: fast }), state).map((t) => [t.def.name, t]));
    const r1 = await said(tools.propose_edits.run({ edits: [PROTECT] }));
    expect(runs).toBe(1);
    expect(state.proposal!.trial!.n).toBe(0);
    expect(r1).toContain('顺带试推演了一次');
    expect(state.trials).toHaveLength(0);

    const r2 = await said(tools.propose_edits.run({ edits: [{ op: 'volcano', at: [10, 10], size: '中', why: '…' }] }));
    expect(runs).toBe(1);
    expect(state.proposal!.trial).toBeUndefined();
    expect(r2).toContain('已换掉上一张');

    // 只有改名:不用试推演
    const rn = await said(tools.try_edits.run({ edits: [{ op: 'rename', target: `P${victim}`, name: '阿尔瑟', why: '…' }] }));
    expect(rn).toContain('不用试推演');
    // 不合格的修改:原因交回去
    const bad = await said(tools.try_edits.run({ edits: [{ op: 'protect', country: 'P99999', from, why: '…' }] }));
    expect(bad).toContain('不合格');
    expect(runs).toBe(1);

    for (let i = 0; i < TRIAL_MAX; i++) await tools.try_edits.run({ edits: [PROTECT] });
    expect(state.trials.map((t) => t.n)).toEqual(Array.from({ length: TRIAL_MAX }, (_, i) => i + 1));
    await expect(Promise.resolve().then(() => tools.try_edits.run({ edits: [PROTECT] }))).rejects.toThrow(`用了 ${TRIAL_MAX} 次`);
    // 不能试推演的地方(没给 simulate)
    const noSim = Object.fromEntries(assistantTools(ctx({ simulate: undefined }), { trials: [], proposal: null }).map((t) => [t.def.name, t]));
    await expect(Promise.resolve().then(() => noSim.try_edits.run({ edits: [PROTECT] }))).rejects.toThrow('不能试推演');
    const r3 = await said(noSim.propose_edits.run({ edits: [PROTECT] }));
    expect(r3).not.toContain('试推演');
  });

  it('试推演连着几次都和现在一样:提醒 AI 多半做不到、直接说;中间有一次变了就重新数', async () => {
    const state: { trials: AssistantTrial[]; proposal: AssistantProposal | null } = { trials: [], proposal: null };
    let same = true;
    const sim = async (e: WorldEdits) => (same ? civ : simulate(e));
    const tools = Object.fromEntries(assistantTools(ctx({ simulate: sim }), state).map((t) => [t.def.name, t]));
    const hint = /连着 \d+ 次试推演,历史都和现在一样.*多半用命令做不到/;
    for (let i = 1; i < TRIAL_SAME_MAX; i++) expect(await said(tools.try_edits.run({ edits: [PROTECT] }))).not.toMatch(hint);
    const r = await said(tools.try_edits.run({ edits: [PROTECT] }));
    expect(r).toMatch(hint);
    expect(r).toContain(`连着 ${TRIAL_SAME_MAX} 次`);
    // 提醒放在最后(试推演结果之后)
    expect(r.indexOf('大事没有变化')).toBeLessThan(r.search(hint));
    // 真的变了一次:重新数
    same = false;
    expect(await said(tools.try_edits.run({ edits: [PROTECT] }))).not.toMatch(hint);
    same = true;
    expect(await said(tools.try_edits.run({ edits: [PROTECT] }))).not.toMatch(hint);
  });

  it('收尾的话像没说完:后面补一句,作者知道可以说「继续」', async () => {
    script({ calls: [['country', { country: `P${victim}` }]] }, '让我也查询它的邻国在同一时期的详细编年史：');
    const r = await runAssistant(ctx(), [], `让${vName}打赢那一仗`);
    expect(r.text).toBe(`让我也查询它的邻国在同一时期的详细编年史：\n\n${UNFINISHED_NOTE}`);
    script({ calls: [['country', { country: `P${victim}` }]] }, '做不到：命令只能定条件，不能规定谁打赢。');
    expect((await runAssistant(ctx(), [], `让${vName}打赢那一仗`)).text).toBe('做不到：命令只能定条件，不能规定谁打赢。');
  });

  it('列确认单:同一批修改换了顺序不算试过(同一年的修改按先后执行,结果可能不同),顺带重新试推演', async () => {
    let runs = 0;
    const fast = async () => {
      runs++;
      return civ;
    };
    const state: { trials: AssistantTrial[]; proposal: AssistantProposal | null } = { trials: [], proposal: null };
    const tools = Object.fromEntries(assistantTools(ctx({ simulate: fast }), state).map((t) => [t.def.name, t]));
    await tools.try_edits.run({ edits: [PROTECT, ALLY] });
    await tools.propose_edits.run({ edits: [PROTECT, ALLY] });
    expect(runs).toBe(1);
    expect(state.proposal!.trial).toBe(state.trials[0]);
    const r = await said(tools.propose_edits.run({ edits: [ALLY, PROTECT] }));
    expect(runs).toBe(2);
    expect(state.proposal!.trial!.n).toBe(0);
    expect(r).toContain('顺带试推演了一次');
  });

  it('试推演里同时改名:两边都套上新名字再比,没变的大事不会算成少一件、多一件', async () => {
    // 改名的对象:生效年份以后编年史里出现最多的国家(不是被保护的那个)
    const count = new Map<number, number>();
    for (const e of civ.annals) if (e.year >= from && e.a >= 0 && e.a !== victim) count.set(e.a, (count.get(e.a) ?? 0) + 1);
    const busy = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const state: { trials: AssistantTrial[]; proposal: AssistantProposal | null } = { trials: [], proposal: null };
    const tools = Object.fromEntries(assistantTools(ctx(), state).map((t) => [t.def.name, t]));
    await tools.try_edits.run({ edits: [PROTECT] });
    await tools.try_edits.run({ edits: [PROTECT, { op: 'rename', target: `P${busy}`, name: '阿尔瑟', why: '…' }] });
    const [a, b] = state.trials.map((t) => t.diff);
    expect(b.addedCount).toBe(a.addedCount);
    expect(b.removedCount).toBe(a.removedCount);
  });

  it('立国:能用经纬度指地方(挑离它最近、有人住的一州);结果里写明那一州在哪、多大、什么地貌', () => {
    const rctx = { world, civ, year: 2000, edits: EMPTY };
    const R = civ.regions;
    // 种子 7 的 R702:大洋中间两块地的小岛(北纬 32° 一带)
    const seat = R.seat[702];
    const lon = (world.mesh.x[seat] / world.width) * 360 - 180;
    const lat = 90 - (world.mesh.y[seat] / world.height) * 180;
    const p = parseRewrite(JSON.stringify({ edits: [{ op: 'found', at: [lon + 0.1, lat - 0.1], from: 2500, why: '…' }] }), rctx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const it = p.items[0];
    expect(it.change).toMatchObject({ kind: 'intervention', v: { kind: 'found', region: regionKey(civ, 702), from: 2500 } });
    expect(it.where).toMatch(/^R702 在 \(-43\.\d, 31\.\d\),小岛\(这块陆地 1 州\)上/);
    // 北极点附近:一千五百公里内没人住,说明原因和最近有人住的州
    const pole = parseRewrite(JSON.stringify({ edits: [{ op: 'found', at: [0, 89.9], from: 2500, why: '…' }] }), rctx);
    if (!pole.ok) throw new Error('看不懂');
    expect(pole.items[0].change).toBeNull();
    expect(pole.items[0].problem).toMatch(/^\(0, 89\.9\) 一带没人住;最近有人住的州是 R\d+ /);
  });

  it('回给作者的话:编号换成名字,紧挨着写了名字的只去掉编号;英文种类名换成中文;认不出的编号留着', () => {
    const rctx = { world, civ, year: from };
    const v = nameAt(civ.polities[victim], from);
    const city = civ.settlements[civ.polities[victim].capital].name;
    expect(plainIds(`给 P${victim} 下一道 protect,国都 C${civ.polities[victim].capital} 就攻不下`, rctx)).toBe(`给${v}下一道保护,国都${city}就攻不下`);
    expect(plainIds(`${v}(P${victim})撑到了最后;P${victim} ${v}也没分裂`, rctx)).toBe(`${v}撑到了最后;${v}也没分裂`);
    expect(plainIds(`${v}（P${victim}、P${friend}）`, rctx)).toBe(v);
    expect(plainIds('P99999 不在', rctx)).toBe('P99999 不在');
    expect(plainIds('第 2400 年起', rctx)).toBe('第 2400 年起');
    // 确认单上 AI 写的理由、做不到的话也换
    const p = parseRewrite(JSON.stringify({ reply: `保护 P${victim}`, edits: [{ ...PROTECT, why: `让 P${victim} 撑住` }], cannot: [`没法让 P${victim} 打赢`] }), { ...rctx, edits: EMPTY });
    if (!p.ok) throw new Error('看不懂');
    expect(p.reply).toBe(`保护${v}`);
    expect(p.items[0].why).toBe(`让${v}撑住`);
    expect(p.cannot).toEqual([`没法让${v}打赢`]);
  });

  it('查资料:国家用编号或国名都能查,找不到的说找不到;编年史按年份和国家筛;某一年的格局', async () => {
    const tools = Object.fromEntries(assistantTools(ctx(), { trials: [], proposal: null }).map((t) => [t.def.name, t]));
    const c = await said(tools.country.run({ country: `P${victim}` }));
    expect(c.split('\n')[0]).toMatch(new RegExp(`^P${victim} `));
    expect(c).toContain('国都:');
    expect(c).toMatch(/国土:.*最盛约第 \d+ 年 \d+ 州/);
    expect(c).toMatch(new RegExp(`结局:第 \\d+ 年被 P${conqueror} .+ 所灭`));
    expect(await said(tools.country.run({ country: vName }))).toBe(c);
    expect(await said(tools.country.run({ country: '不存在的国' }))).toContain('找不到');

    const ch = await said(tools.chronicle.run({ country: `P${victim}`, from, to: civ.endYear, all: true }));
    expect(ch.split('\n')[0]).toContain(`和 P${victim} `);
    expect(ch).toContain(`〔`);
    for (const line of ch.split('\n').slice(1)) {
      const y = Number(/第 (\d+)/.exec(line)![1]);
      const end = Number(/第 \d+(?:—(\d+))? 年/.exec(line)![1] ?? y);
      expect(end).toBeGreaterThanOrEqual(from);
    }
    expect(tools.chronicle.label!({ country: `P${victim}`, from: 100, to: 200 })).toBe(`查编年史：${nameAt(civ.polities[victim], 2000)}，第 100—200 年`);

    const sr = await tools.situation.run({ year: from });
    const s = await said(sr);
    expect(s.split('\n')[0]).toMatch(new RegExp(`^第 ${from} 年在世的国家 \\d+ 个`));
    expect(s).toContain(`P${victim} ${vName}`);
    // 刚查过这个国家:小字说它那年的州数和邻国;邻国那年的国号和现在不一样的,补一句后来叫什么
    const sum = (sr as AgentToolResult).summary!;
    expect(sum).toMatch(/^剩 \d+ 州/);
    for (const q of civ.polities) {
      const then = nameAt(q, from);
      const now = nameAt(q, civ.endYear);
      if (q.ended === undefined && now !== then && sum.includes(then)) expect(sum).toContain(`${then}（后来的${now}）`);
    }
  });

  it('提示词:改写的提示词带的修改写法和助手的是同一份;前几轮带上执行没执行', () => {
    expect(REWRITE_SYSTEM).toContain(REWRITE_OPS);
    expect(ASSISTANT_SYSTEM).toContain(REWRITE_OPS);
    const m = assistantMessages(ctx(), [{ ask: '让它多撑三百年', reply: '好的', items: ['某国:保护'], applied: true }, { ask: '大昌在哪' }], '再让它结个盟');
    expect(m).toHaveLength(2);
    const u = m[1].content;
    expect(u).toContain('# 之前的对话');
    expect(u).toContain('作者:让它多撑三百年\n你:好的(列的修改:某国:保护—— 作者执行了)');
    expect(u).toContain('作者:大昌在哪');
    expect(u.endsWith('# 作者这次说\n再让它结个盟')).toBe(true);
  });

  it('国家的叫法:编号、数字、国名都认', () => {
    expect(polityOf(civ, `P${victim}`)).toBe(victim);
    expect(polityOf(civ, `p${victim}`)).toBe(victim);
    expect(polityOf(civ, String(victim))).toBe(victim);
    expect(polityOf(civ, victim)).toBe(victim);
    expect(polityOf(civ, vName)).toBe(victim);
    expect(polityOf(civ, 'P99999')).toBe(-1);
    expect(polityOf(civ, '')).toBe(-1);
    expect(polityOf(civ, null)).toBe(-1);
  });
});
