/**
 * 阶段 2 浏览器验收:应用内视图 ↔ 浏览器后退 / 前进。
 *   npx tsx scripts/nav-check.ts
 *
 * 覆盖设计文档 §5 的 T1–T8:
 *   T1 直接打开 / 刷新 → base;T2 详情 → Back 回 base 且仍在应用内;T3 连续 A→B→C 的 Back/Forward 顺序与 +3;
 *   T4 重复打开同一实体不新增记录;T5 Esc 回上一视图且不增长历史、base 再按 Esc 不离开站点;
 *   T6 刷新后旧 state 被安全降级(世界标识变);T7 别的世界的历史记录不恢复实体;
 *   T8 全程不离开站点、无 console / pageerror、无导航循环。
 */
import { chromium, type Browser, type Page } from 'playwright';
import { startDevServer } from './lib/devserver';

const dev = await startDevServer();
const browser: Browser = await chromium.launch();
const errs: string[] = [];
const check = (ok: boolean, msg: string) => {
  if (!ok) errs.push(msg);
};

const URL = `${dev.url}/?seed=7`;

/** 当前导航状态(读 history.state + 界面) */
const nav = (p: Page) =>
  p.evaluate(() => {
    const s = (history as unknown as { state: { v?: string; world?: string } | null }).state;
    return {
      v: s?.v ?? null,
      world: s?.world ?? null,
      len: history.length,
      href: location.href,
      host: location.host,
      panel: !!document.querySelector('section.inspector:not(.hidden)'),
      overview: !!document.querySelector('.ov-root:not([hidden])'),
      app: !!(window as unknown as { __wfCiv?: unknown }).__wfCiv,
    };
  });

const ready = async (p: Page) => {
  await p.waitForFunction(() => (window as unknown as { __wfCiv?: { ready?: boolean } }).__wfCiv?.ready, null, { timeout: 60000 });
  await p.waitForTimeout(400);
};

/** 新开一页(隔离历史),打开 seed 7 的世界,等就绪 */
const fresh = async () => {
  const p = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errs.push(`console: ${m.text()}`));
  await p.goto(URL);
  await ready(p);
  return p;
};

/** 打开第 id 号国家详情(用应用自己的 __wfSelect 钩子:点侧栏第二个国家时列表已经被面板换掉了) */
const openDetail = async (p: Page, id: number) => {
  await p.evaluate((i) => (window as unknown as { __wfSelect: (k: string, id: number) => void }).__wfSelect('polity', i), id);
  await p.waitForTimeout(450);
};
/** 真实用户路径:点侧栏第一个国家(证明"点行 → push"确实成立) */
const clickFirstCountry = async (p: Page) => {
  await p.locator('.sb-row[data-polity]').first().click();
  await p.waitForTimeout(450);
};
/** 打开概览的编年史页(应 push) */
const openOverviewTab = async (p: Page) => {
  await p.locator('[data-act=chronicle]').first().click();
  await p.waitForTimeout(450);
};

// ---- T1:直接打开 / 刷新 → base ----
{
  const p = await fresh();
  let s = await nav(p);
  check(s.v === 'base' && !s.panel && s.app, `T1 直接打开应是 base 且没有详情面板(${JSON.stringify(s)})`);
  await p.reload();
  await ready(p);
  s = await nav(p);
  check(s.v === 'base' && !s.panel && s.app, `T1 刷新后应仍是 base 且不崩(${JSON.stringify(s)})`);
  console.log(`T1 直接打开 / 刷新:${JSON.stringify(s)}`);
  await p.close();
}

// ---- T2:详情 → Back 回 base,仍在应用内 ----
{
  const p = await fresh();
  const l0 = (await nav(p)).len;
  await clickFirstCountry(p);
  let s = await nav(p);
  check(s.v === 'detail' && s.panel, `T2 打开详情应 push 出 detail 视图(${JSON.stringify(s)})`);
  check(s.len === l0 + 1, `T2 打开详情应新增 1 条历史(${l0} → ${s.len})`);
  const host = s.host;
  await p.goBack();
  await p.waitForTimeout(450);
  s = await nav(p);
  check(s.app && s.v === 'base' && !s.panel, `T2 Back 应回到 base 且仍在应用内(${JSON.stringify(s)})`);
  check(s.host === host, `T2 Back 不该离开站点(${host} → ${s.host})`);
  console.log(`T2 详情 → Back:len ${l0} → ${s.len},v=${s.v},panel=${s.panel}`);
  await p.close();
}

// ---- T3:A → B → C 的 Back/Forward 顺序与 +3 ----
{
  const p = await fresh();
  const l0 = (await nav(p)).len;
  const host = (await nav(p)).host;
  await openDetail(p, 0);
  await openDetail(p, 1);
  await openOverviewTab(p);
  let s = await nav(p);
  check(s.len === l0 + 3, `T3 三次打开应 +3(${l0} → ${s.len})`);
  check(s.overview, `T3 第三次应是概览(${JSON.stringify(s)})`);
  const back: (string | null)[] = [];
  for (let i = 0; i < 3; i++) {
    await p.goBack();
    await p.waitForTimeout(400);
    back.push((await nav(p)).v);
  }
  check(back.join() === 'detail,detail,base', `T3 Back×3 应依次到 detail,detail,base(${back.join()})`);
  const fwd: (string | null)[] = [];
  for (let i = 0; i < 3; i++) {
    await p.goForward();
    await p.waitForTimeout(400);
    fwd.push((await nav(p)).v);
  }
  check(fwd.join() === 'detail,detail,overview', `T3 Forward×3 应依次到 detail,detail,overview(${fwd.join()})`);
  check((await nav(p)).host === host, `T3 全程不该离开站点`);
  console.log(`T3 A→B→C:len ${l0} → ${l0 + 3};Back ${back.join(' → ')};Forward ${fwd.join(' → ')}`);
  await p.close();
}

// ---- T4:重复打开同一实体不新增记录 ----
{
  const p = await fresh();
  const l0 = (await nav(p)).len;
  await openDetail(p, 0);
  const l1 = (await nav(p)).len;
  check(l1 === l0 + 1, `T4 首次打开应 +1(${l0} → ${l1})`);
  await openDetail(p, 0);
  const l2 = (await nav(p)).len;
  check(l2 === l1, `T4 重复打开同一实体不该新增记录(${l1} → ${l2})`);
  console.log(`T4 重复打开:len ${l0} → ${l1} → ${l2}`);
  await p.close();
}

// ---- T5:Esc 回上一视图、历史不增长;base 再按 Esc 不离开站点 ----
{
  const p = await fresh();
  await openDetail(p, 0);
  const l1 = (await nav(p)).len;
  await p.keyboard.press('Escape');
  await p.waitForTimeout(450);
  let s = await nav(p);
  check(s.v === 'base' && !s.panel, `T5 Esc 应回到上一视图 base(${JSON.stringify(s)})`);
  check(s.len <= l1, `T5 Esc 后历史长度不该增长(${l1} → ${s.len})`);
  // base 再按 Esc 不能离开站点(网址可能因地图中心 lon 变化,只比 host 和"还在应用里")
  const host = s.host;
  await p.keyboard.press('Escape');
  await p.waitForTimeout(350);
  s = await nav(p);
  check(s.app && s.host === host && s.len <= l1, `T5 base 再按 Esc 不该离开站点(${JSON.stringify(s)})`);
  console.log(`T5 Esc:len ${l1} → ${s.len},v=${s.v},仍在应用=${s.app}`);
  await p.close();
}

// ---- T6:刷新后旧 state 被安全降级 ----
{
  const p = await fresh();
  await openDetail(p, 0);
  const before = await nav(p);
  check(before.v === 'detail', `T6 刷新前应是 detail(${JSON.stringify(before)})`);
  await p.reload();
  await ready(p);
  const after = await nav(p);
  check(after.v === 'base' && !after.panel, `T6 刷新后应回 base 且没有面板(${JSON.stringify(after)})`);
  check(after.world !== before.world, `T6 刷新后 world 标识应变(旧 nonce 失效)(${before.world} → ${after.world})`);
  console.log(`T6 刷新:world ${before.world} → ${after.world};v=${after.v}`);
  await p.close();
}

// ---- T7:别的世界的历史记录不恢复实体 ----
{
  const p = await fresh();
  await p.evaluate(() => {
    history.pushState({ v: 'detail', kind: 'polity', id: 'polity:nope#0', world: 'staleNonce:99' }, '');
  });
  await p.goBack();
  await p.waitForTimeout(250);
  await p.goForward(); // 前进到"别的世界"那条 → popstate
  await p.waitForTimeout(450);
  const s = await nav(p);
  check(s.app, `T7 仍在应用内(${JSON.stringify(s)})`);
  check(!s.panel, `T7 别的世界的历史记录不该恢复实体(不该有面板)(${JSON.stringify(s)})`);
  console.log(`T7 别的世界的记录:panel=${s.panel},v=${s.v},仍在应用=${s.app}`);
  await p.close();
}

// ---- T8:全程无 console / pageerror(在 errs 里累积) ----
check(errs.length === 0, `T8 全程不该有 console / pageerror(已有 ${errs.length} 条)`);

console.log('errors:', errs);
await browser.close();
await dev.close();
if (errs.length) process.exit(1);
