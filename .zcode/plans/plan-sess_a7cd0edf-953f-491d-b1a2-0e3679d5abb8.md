# PR #4 最新审评 → 只读审计操作计划

## 最新审评是什么
PR #4（`feat/agent-phase2-nav`，SCVMofic/civ-atlas，OPEN）最新一条审评是 **Saltinsol 2026-10-12 16:24**：《暂停 PR #4 实现：先审计上游领先的 18 个 commits，再决定去留》。它要求**只读审计 + 在本评论回复报告**，明确禁止：继续叠加实现、回滚/`reset --hard`/强推、用上游 main 覆盖本仓库、关闭或合并 PR、改写共享历史。本阶段交付物 = **一份审计报告**（不改代码）。

（上一条 16:13 的 selection 边界项按你的选择**本轮不做**，留到方案确定后。）

## 已核实的事实基线（读命令结果）
| 项 | 值 |
|---|---|
| PR #4 base (`origin/main`) | `3f39a5b` |
| PR #4 head（已推送，= 本地 HEAD） | `e68770a` |
| 上游 `guaner-334/civ-atlas:main` | `139f8bee`（#93，2026-10-12） |
| merge-base(origin/main, upstream/main) | `91009b9`（上游 #73，2026-10-10） |
| 上游侧领先 | `91009b9..main` = **18 commits**（ahead 18 / behind 0）——与审评"18 commits"吻合 |
| 本仓库侧领先 | `91009b9..origin/main` = **42 commits** |
| mergeable | MERGEABLE / UNSTABLE |
| 上游同能力 PR | **#75「浏览器的后退、前进回到上一个画面」已于 2026-10-11 合并**（merge commit `76984b21`） |

关键点：两侧在 **#73** 处分叉——本仓库是独立维护分支（已通过 PR #1 用"移植"方式吸收过上游 2026-10 功能），不是线性落后 18。本地 `upstream/main` 引用停在 #73，已过期，需刷新才能取准确差异。

## 执行步骤（只读审计 + 回帖）

**Step 1 — 记录权威 SHA 与分叉方向**
用 `gh pr view` / GitHub API 固化上表 SHA，并明确"18 commits"的准确含义（上游相对 merge-base #73 领先 18，本仓库相对 #73 领先 42），供报告引用。

**Step 2 — 刷新并读取上游 18 个提交**
`git fetch upstream` 刷新 remote-tracking 引用（只写本地 remote-tracking ref，不动共享历史、不推任何东西），或经 GitHub API 读取。产出：18 个提交的标题、日期、**涉及文件、增删行数**、对应上游 PR 号（#79/#80/#59/#85/#65/#68/#86/#71/#74/#75/#76/#87/#88/#89/#90/#92/#91/#93），以及差异文件全集。

**Step 3 — 逐提交归类**
对 18 个提交逐个给出：功能/修复摘要、涉及文件、**是否与本仓库已有改动重叠**（重点 `App.tsx`、`studio/scene.ts`、`route.ts`、`replay-check.ts`、`account/session.ts`）、是否值得吸收。标注哪些本仓库已通过 PR #1 移植过（如地名风格 #69、旧版网站 #67、助手修复 #74），区分"已移植 / 需吸收 / 可忽略 / 与本仓库冲突"。

**Step 4 — PR #4 vs 上游 #75 逐项对照（核心）**
上游 #75 变更集：`src/ui/nav.ts`(+354)、`src/ui/navView.ts`(+71)、`App.tsx`(+239/-23)、`bookStore.ts`(+13)、`account/session.ts`(+2/-1)、`replay-check.ts`(+115)、`tests/nav.test.ts`(+400)、README(-1)。
本仓库 PR #4 变更集：`src/ui/nav.ts`(+130)、`navSelection.ts`(+45)、`App.tsx`、`route.ts`、`civView.ts`、`overviewStore.ts`、`tests/nav.test.ts`、`tests/nav-selection.test.ts`、`scripts/nav-check.ts`。
按能力维度逐项判定"已完整实现 / 部分实现 / 未实现 / 设计不适配"，至少覆盖：
- a) 世界内卡片 + 概览进历史；b) 稳定键 codec（重推历史后仍可识别）；c) **我的世界/新建世界/世界之间的页面级导航**（上游 #75 明说有，本仓库 PR #4 只做世界内 detail/overview）；d) 后退到已删除世界的降级提示；e) 弹窗 / 换一颗 / 未改动底稿的后退语义；f) Esc 契约（关面板并规范化为 base，历史交给 Back/Forward）；g) popstate 只读不写历史；h) 刷新后旧 state 降级（nonce）；i) 7 处 `replaceState`→`replaceUrl` 迁移。
结论必须给"上游是否已实现同一能力"的明确判定 + 上游 commit/文件/测试行证据，不能只凭提交标题。

**Step 5 — 方案对比与推荐**
- **A) 保留 PR #4 + 选择性吸收上游**：风险最低（已有测试 + nav-check T1–T15）；需评估是否补页面级/新建/世界间导航。
- **B) 先同步上游再把导航移植到新分支**：契合仓库既有"移植"习惯，但改动大、需重放并重跑全套验证。
- **C) 上游 #75 已等价 → 关闭/废弃 PR #4 改为移植 #75**：最省维护，但会丢失本仓库的 Esc 契约、稳定键边界测试、nav-check 等硬化。
报告里明确推荐其中一个，附证据与回滚方案（备份 ref 名）。

**Step 6 — 交付**
把审计报告**回帖到 PR #4 评论**（中文，含：base/head SHA 与同步方式、重叠/冲突结论、逐项对照证据、方案推荐与回滚），并在本地留档一份。回帖是唯一写动作（你已确认）。

## 边界与不做
- 本阶段**不改任何源码/测试/断言**，**不运行** typecheck/test/build/smoke（无代码改动，留到选定方案执行时）。
- 不 `reset --hard`、不强推、不用上游覆盖本仓库、不关闭、不合并 PR、不改写共享历史。
- 唯一本地写：`git fetch upstream` 刷新 remote-tracking ref（可恢复）；若你希望连 fetch 都避免，则改用 GitHub API 只读读取差异。
- 回滚：报告前先打本地备份 tag（如 `backup/pr4-audit-<date>` → `e68770a`、`backup/main-audit-<date>` → `3f39a5b`），仅本地、不推送。