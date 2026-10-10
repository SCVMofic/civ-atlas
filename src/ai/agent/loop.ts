/**
 * 助手的循环:问 AI → AI 要调用工具 → 网页执行、把结果交回 → 再问,直到 AI 只回话(或到了轮数上限、被停下)。
 * 每一轮都是一次 aiChat(各记一条调用记录);工具由调用方给(改世界的那一套见 ./assistant.ts)。
 * 纯逻辑,不碰 DOM。
 *
 * - 工具参数是模型写的 JSON 原文,可能不合法:解析不了 / 没有这个工具 / 执行时抛错,都把原因作为这一步的结果交回模型,
 *   让它自己改了再调,不中断整个循环
 * - 最后一轮 toolChoice = 'none':不许再调工具,只能回话(防止来回调个没完);之前调过工具的,先补一句 FINAL_NUDGE 让它直接下结论
 *   (光关掉工具,模型常常照样写一句"让我再查……:"就停了)
 * - 停下(signal)= 抛 AiError('aborted');已经做完的步骤在 onEvent 里已经报过了
 */
import { aiChat } from '../client';
import { AiError, type AiMessage, type AiTool, type AiUsage } from '../types';

/** 给模型用的一个工具,连同网页这边怎么执行 */
export interface AgentTool {
  def: AiTool;
  /** 这一步的说法(界面上一行):"查国家：特拉维亚共和国""试推演：保护特拉维亚共和国"。不给 = 工具名 */
  label?: (args: Record<string, unknown>) => string;
  /** 执行;返回交回模型的文字(或连同给作者看的一句话)。抛错 = 这一步没做成(错误的说明交回模型) */
  run: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string | AgentToolResult> | string | AgentToolResult;
}

/** 一步的结果:交回模型的文字 + 给作者看的一句话(界面上那一行下面的小字) */
export interface AgentToolResult {
  result: string;
  summary?: string;
}

/** 做过的一步 */
export interface AgentStep {
  /** 这次循环里的第几步(s1、s2……;模型给的调用编号可能重复,不用它) */
  id: string;
  tool: string;
  args: Record<string, unknown>;
  label: string;
  state: 'run' | 'ok' | 'error';
  /** 交回模型的结果(出错 = 错误的说明) */
  result?: string;
  /** 给作者看的一句话(工具给了才有) */
  summary?: string;
  ms?: number;
}

export type AgentEvent =
  /** 开始第几轮(从 0 数) */
  | { type: 'round'; round: number }
  /** 这一轮模型正在说的话(到目前为止的全文) */
  | { type: 'text'; text: string }
  /** 一步开始 / 做完(每次给一份新的拷贝) */
  | { type: 'step'; step: AgentStep }
  | { type: 'step-done'; step: AgentStep };

export interface AgentRequest {
  /** 调用记录里的功能名 */
  feature: string;
  /** 调用记录里的说明 */
  title?: string;
  /** system + 前情 + 这次的话 */
  messages: AiMessage[];
  tools: AgentTool[];
  /** 最多问几轮 AI(含最后只许回话的那一轮);默认 AGENT_MAX_ROUNDS */
  maxRounds?: number;
  temperature?: number;
  /** 每一轮的输出上限 */
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
}

export interface AgentOutcome {
  /** 最后回给作者的话 */
  text: string;
  steps: AgentStep[];
  /** 整段对话(含每一轮的工具调用和结果) */
  messages: AiMessage[];
  /** done = 模型自己说完了;rounds = 到了轮数上限,最后一轮被要求直接回话(只问一轮的不算) */
  end: 'done' | 'rounds';
  rounds: number;
  usage: AiUsage;
}

/** 默认最多几轮 */
export const AGENT_MAX_ROUNDS = 10;
/** 一步的结果交回模型时最长多少字(太长的截断,免得一轮把上下文吃光) */
export const TOOL_RESULT_MAX = 6000;
/** 最后一轮之前补的话:不能再调工具了,直接说结论 */
export const FINAL_NUDGE =
  '查询和试推演的次数用完了,这一轮不能再调工具。不要再说要查什么、试什么,直接告诉作者结论:' +
  '能做到就说怎么改(列了确认单的照确认单说),做不到就说做不到和原因。';

/** 收尾的话像没说完:最后一段以冒号结尾,或者是"让我再查……""我先看看……"这类还要接着做的话 */
export function looksUnfinished(text: string): boolean {
  const tail = text.trim().split(/\n+/).pop()?.trim() ?? '';
  if (!tail) return false;
  return /[:：]$/.test(tail) || /^(让我|我再|我先|我来|接下来我|下面我)(再|也|先|来)?(查|试|看|检查|确认|尝试|调)/.test(tail);
}

/** 参数原文 → 对象;空串 = {};不是 JSON 对象 = null */
export function parseToolArgs(raw: string): Record<string, unknown> | null {
  const t = raw.trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const clipResult = (s: string) => (s.length > TOOL_RESULT_MAX ? `${s.slice(0, TOOL_RESULT_MAX)}\n……(后面太长,没给)` : s);

const aborted = () => new AiError('aborted', '已停下');

export async function runAgent(req: AgentRequest): Promise<AgentOutcome> {
  const max = Math.max(1, Math.floor(req.maxRounds ?? AGENT_MAX_ROUNDS));
  const byName = new Map(req.tools.map((t) => [t.def.name, t]));
  const defs = req.tools.map((t) => t.def);
  const msgs: AiMessage[] = [...req.messages];
  const steps: AgentStep[] = [];
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0 };
  const emit = (e: AgentEvent) => req.onEvent?.(e);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  for (let round = 0; round < max; round++) {
    if (req.signal?.aborted) throw aborted();
    emit({ type: 'round', round });
    const last = round === max - 1;
    if (last && round > 0 && defs.length) msgs.push({ role: 'user', content: FINAL_NUDGE });
    const r = await aiChat(
      {
        feature: req.feature,
        title: req.title,
        messages: msgs,
        ...(defs.length ? { tools: defs, toolChoice: last ? ('none' as const) : ('auto' as const) } : {}),
        temperature: req.temperature,
        maxTokens: req.maxTokens,
      },
      { signal: req.signal, onDelta: (_, full) => emit({ type: 'text', text: full }) },
    );
    if (r.usage) {
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
    }
    const calls = r.toolCalls ?? [];
    // 不调工具了(或者最后一轮还想调:不理,拿它说的话收尾)
    if (!calls.length || last) {
      // 一步没做、一句没说:算空回复(做过步骤再收尾不说话可以,结果已经摆在面板上)
      if (!steps.length && !r.text.trim()) throw new AiError('bad-response', 'AI 返回了空回复,请再试一次');
      msgs.push({ role: 'assistant', content: r.text });
      return { text: r.text.trim(), steps, messages: msgs, end: calls.length || (last && round > 0) ? 'rounds' : 'done', rounds: round + 1, usage };
    }
    // 调用编号重复(或者空)就换成不重的:每条工具结果要对上各自那次调用
    const used = new Set(msgs.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []));
    const fixed = calls.map((c) => {
      let id = c.id;
      for (let k = 2; !id || used.has(id); k++) id = `${c.id || 'call'}_${k}`;
      used.add(id);
      return id === c.id ? c : { ...c, id };
    });
    msgs.push({ role: 'assistant', content: r.text, toolCalls: fixed });
    for (const c of fixed) {
      if (req.signal?.aborted) throw aborted();
      const tool = byName.get(c.name);
      const args = parseToolArgs(c.args);
      const step: AgentStep = {
        id: `s${steps.length + 1}`,
        tool: c.name,
        args: args ?? {},
        label: c.name,
        state: 'run',
      };
      if (tool?.label && args) {
        try {
          step.label = tool.label(args) || c.name;
        } catch {
          // 说法写不出来就用工具名
        }
      }
      steps.push(step);
      emit({ type: 'step', step: { ...step } });
      const t0 = now();
      let result: string;
      if (!tool) {
        step.state = 'error';
        result = `没有叫 ${c.name} 的工具,能用的有:${defs.map((d) => d.name).join('、')}`;
      } else if (!args) {
        step.state = 'error';
        result = '参数不是一个合法的 JSON 对象,请改好再调';
      } else {
        try {
          const r = await tool.run(args, req.signal);
          if (typeof r === 'string') result = r;
          else {
            result = r.result;
            if (r.summary) step.summary = r.summary;
          }
          step.state = 'ok';
        } catch (e) {
          if (req.signal?.aborted || (e instanceof AiError && e.code === 'aborted')) throw aborted();
          step.state = 'error';
          result = `出错了:${e instanceof Error ? e.message : String(e)}`;
        }
      }
      step.result = clipResult(result);
      step.ms = Math.round(now() - t0);
      emit({ type: 'step-done', step: { ...step } });
      msgs.push({ role: 'tool', toolCallId: c.id, content: step.result });
    }
  }
  // 走不到这里(最后一轮一定 return)
  throw new AiError('other', '助手没有说完');
}
