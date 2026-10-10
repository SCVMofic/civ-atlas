# 上游功能集成报告(2026-10)

把上游仓库 `guaner-334/civ-atlas` 的最新功能与修复,以**本地架构为基础**移植进
`SCVMofic/civ-atlas`。这不是一次普通 Git 合并:上游把路由、worker 调用等写在内联函数里,
本地已经把这些抽成模块(Simulation façade、worker 协议、WorkerClient、WorldSession、
route.ts),因此每个上游改动都要判断"落在哪个本地模块上"。

## 1. 范围与提交

| 项 | 值 |
| --- | --- |
| 本地分支 | `integration/upstream-2026-10` |
| 共同祖先 | `103afd3d998eac6750692a6813bf5aea03521448` |
| 上游端点 | `91009b9b35880b6e3ee9f370bc39c7d3cacf257b` |
| 合并提交 | `4aceabcec25d0fddbc8cc8d7b099fee29a024287`(第一父 = 本地 `0e3bda7`,第二父 = 上游 `91009b9`) |

上游独有 11 个提交,按功能组:

| 组 | 提交 | 内容 |
| --- | --- | --- |
| A | `91009b9` | AI 助手:立国那年命令挪次年生效、轮数用完直接给结论、收尾没说完补一句、连 3 次试推演不变时提示 |
| B | `7551366` | 地名风格配置(12 种语感配份数),跨 UI/生成/存档 |
| C | `6bccd74` / `37d0044` / `945700b` | 旧版网站兼容、旧存档首次重存留底、`/v9` 无斜杠 |
| D | `372f4e0` / `e0ae720` | 时间轴缩略图取那一段的州、非零中央经线草图黑屏 |
| E | `1f2990a` / `b286bdf` / `9dee309` | logo/favicon、README 改版、QQ 群 |
| F | `cadba38` | 旧版网站部署 workflow |

## 2. 本地架构保留清单(未因合并改动)

- `src/simulation/simulation.ts`(Simulation façade,只做委托)
- `src/worker/protocol.ts`(统一请求/回执 + `requestId`)
- `src/worker/client.ts`(`WorldComputeService` 生命周期、取消、换线程、错误终态)
- `src/session/worldSession.ts`(世界会话、任务登记)
- `src/ui/route.ts`(网址/路由抽离)
- `src/ui/assistantStore.ts`(助手状态流转)
- 调度器、存档恢复、事件处理、年份推进、历史记录语义(见 §5 证据)

## 3. 冲突解决(手工整合,未整文件选边)

`git merge` 只在两个文件冲突:`src/ui/App.tsx`、`src/worker/worker.ts`。

### 3.1 `src/worker/worker.ts`

以上游 `src/worker.ts` 相对祖先的 diff 为准:上游对该文件**只有**「地名风格」这一处改动
(5 处:import、`CivInput.names`、`namesOpt`、两处推演调用)。本地已把 worker 重命名到
`src/worker/worker.ts` 并换成 `simulation.run(...)` + `requestId` 协议。做法:

1. 取本地版本(保留 imports、`simulation.run`、`requestId` 回执);
2. 补 `import type { NameMix }`、`namesOpt` 辅助函数;
3. 两处 `simulation.run({ params: { ... } })` 加上 `...namesOpt(m.names)`。

### 3.2 `src/worker/protocol.ts`(本地独有)

上游把 `names?: NameMix` 放在 worker.ts 内的 `CivInput`;本地 `CivInput` 在协议层,
因此 `names` 加到 `protocol.ts` 的 `CivInput`。`client.ts` 用 `{ ...input }` 泛型透传,
`RequestInput<T>` 自动带上 `names`,无需改动。

### 3.3 `src/ui/App.tsx`

8 个冲突块逐个判断,保留本地架构、移植上游功能:

| 块 | 本地(保留) | 上游(移植进来的部分) |
| --- | --- | --- |
| 1 | `import ... from './route'` | `versionAction` / `openFailed` 两个模块级函数(上游加在 App.tsx 内,本地补进来) |
| 2 | `type Replay` | 丢弃上游内联的 `writeWorldUrl/writeHomeUrl/storyOk`(本地在 route.ts) |
| 3 | `compute.trial(...)` 试推演 | `...namesOpt(civNames.current)` |
| 4 | `compute.generate` + `beginWorldTask` | `civNames.current = t.edits.nameMix` + `...namesOpt(t.edits.nameMix)` |
| 5 | `invalidateSimulation()` | `civNames.current = getEdits().nameMix` |
| 6 | `compute.generate` + `beginWorldTask` | `...namesOpt(civNames.current)` |
| 7 | `nextSimulationVersion()` | `if (!fresh.current) civNames.current = names` |
| 8 | `beginWorldTask('resimulate', ...)` | 依赖数组补 `edits.nameMix` |

另补 `type SaveFile`、`type WorldEdits` 两个 import(上游内联代码用到,本地原本只在
route.ts 里用)。自动合并已落地的上游公共区改动(未冲突,核对通过):`own` 分享标记、
`OldSiteBadge`、`shownRaw` 缩略图、`reuseRegions(..., true)`、`attachWorld({ original })`、
`namesOpt` 定义、新建「换一颗」保留 nameMix。

### 3.4 `src/ui/route.ts`(本地独有)

上游 `writeWorldUrl` 相对祖先只加了一行 `q.delete(OWN_KEY)`(内联版里);本地搬到
route.ts,故补这一行 + `import { OWN_KEY } from './oldSite'`。

### 3.5 两侧都改、自动合并的文件

- `scripts/replay-check.ts`:上游加了「看原样」冒烟段 + 「地名风格」确认框断言,本地加了
  façade 迁移与冒烟调整。核对两者都在,typecheck 通过。
- `tests/savefile.test.ts`:上游加旧存档留底用例,本地加往返用例,均在,全过。

## 4. 逐功能组移植结果

- **A AI 助手**:`src/ai/agent/{assistant,loop,trial}.ts`、`src/ai/prompts/{rewrite,names}.ts`
  自动合并落地。改动都在 `runAssistant` / `runAgent` / `Checker` 内部,API 形状不变,
  本地 assistant Store 无需适配。`tests/ai-agent.test.ts`(23)、`tests/ai-rewrite.test.ts` 全过。
- **B 地名风格**:纵向贯通完成。链路
  `Studio/NameMixPage → edits.nameMix → savefile → compute.generate/resimulate/trial →
  protocol.CivInput.names → worker → simulation.run(params.names) → generateCiv(cleanMix)
  → naming/places/cultures`。默认(自动)与旧行为逐字节相同(见 §5 指纹)。20 个
  `name-mix` 用例 + 存档往返用例全过。
- **C 旧版网站兼容**:`src/ui/oldSite.ts`、`saveStore` 的 `original/currentOriginal`、
  `Corners.OldSiteBadge`、`AccountDialogs.SharedHint(own)`、`SaveMenu`/`MyWorlds` 入口、
  `route.ts` 的 `OWN_KEY` 清理、`savefile` 留底逻辑,均落地。`tests/old-site.test.ts`、
  `savefile` 的旧版本用例全过。
- **D 地图/历史 UI**:`TerrainTools.tsx` 的 `className="terrain-marks"` + `app.css`
  从 `.terrain-marks` 往下写样式(修非零中央经线黑屏);`App.tsx` 缩略图改传 `shownRaw`
  (时间轴那一段的州)。本地未改这些文件,干净落地。
- **E logo/README**:`index.html`/`public/*`/`privacy.html`/`terms.html` 图标、
  `README.md` 改版 + QQ 群、`.github/readme/*` 配图、`docs/development.md`,均落地。
  本地自祖先以来未改 README,无本地特有说明被覆盖。
- **F 部署 workflow**:见 §6,保留未启用。

## 5. 验证证据(实际执行的命令与结果)

环境:Windows + Git Bash,Node `v26.6.0`(`E:\cache\fnm\node-versions\v26.6.0`)。

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 基线(合并前 `HEAD`) | `vitest run` | 87 文件 / 1288 用例全过(86s) |
| 基线 typecheck | `tsc --noEmit` | 0 错 |
| 合并后 typecheck | `tsc --noEmit` | 0 错 |
| 合并后全量测试 | `vitest run` | **89 文件 / 1320 用例全过**(84s) |
| 生产构建 | `vite build` | 成功(`dist/assets/index-*.js` 1.44MB) |
| 指纹对账 | `tsx scripts/fingerprint.ts --check docs/baseline-fingerprint.json` | **21 组、44s、全部一致**(每组 54–57 字段) |
| 恢复推演探针 | `tsx scripts/probe-resume-order.ts` | **24 组:轨迹不同 22、日志 0、史事 0、检查点 0、归属 0** |
| 同一探针(基线 `0e3bda7`) | 同上 | 24 组:轨迹 22、日志 0、史事 0、检查点 0、归属 0(**与合并后逐项相同**) |
| 定向用例 | `vitest run ai-agent ai-rewrite name-mix old-site savefile worker-client world-session simulation-facade` | 8 文件 / 217 用例全过 |
| 空白检查 | `git diff --check` | 干净 |

**结论**:上游 11 个提交的功能全部落地;默认(自动)路径下世界与文明输出与本地基线
逐字节一致(指纹 21 组);恢复推演的可观察结果(ChangeLog、annals、检查点、最终归属)
差异为 0,且与基线完全相同 —— 唯一的差异是"同刻事件 handler 调用顺序",这是本地在
TASK-011A 已探明、已记录、已接受的现象(`docs/simulation-event-audit.md`),本次合并没有
改变它。

## 6. 旧版网站部署 workflow(保留,未启用)

`.github/workflows/deploy-old-site.yml` 按上游原样保留,理由与现状:

- 触发条件是 `workflow_dispatch`(**只手动跑**),不会随 push/PR 自动执行;
- `jobs.deploy.if: github.repository == 'guaner-334/civ-atlas'` 把它钉在上游仓库,
  在 `SCVMofic/civ-atlas` 上该 job 会被跳过;
- 发布依赖 `secrets.DEPLOY_SSH_KEY / DEPLOY_KNOWN_HOSTS / DEPLOY_DEST / DEPLOY_PORT`
  与主机 `atlas.gerdor.top`,本仓库没有对应配置。

**未解决**:若本仓库要用这个流程,需由维护者决定发布目标、SSH 密钥与 Secrets,并把
`if` 改成当前仓库 —— 在此之前不要启用,也不要把它与应用代码一起验收。

## 7. 遗留问题与风险

1. **部署 workflow 未适配**(§6):需维护者提供发布目标与密钥后再启用。
2. **`scripts/replay-check.ts` 冒烟未在本机执行**:该脚本要 Playwright 浏览器 + dev
   server,本次只做了 typecheck 与静态核对,未跑端到端冒烟。CI 或本地有浏览器环境时应补跑。
3. **同刻事件顺序差异**(TASK-011A 已记录,非本次引入):恢复推演会改变同刻 handler
   调用顺序,但不影响任何可观察结果。本次合并前后完全一致,风险等级不变。
4. **旧存档兼容策略**:上游用 `original` 留底 + `versionNote` 提示;本地存档格式与恢复
   语义未改(见 `docs/simulation-resume-contract.md`)。不支持地名风格的旧存档按"自动"
   处理(`cleanMix` 返回 undefined)。
5. **指纹基线未更新**:本次默认路径指纹与基线一致,故 `docs/baseline-fingerprint.json`
   无需重存。若日后上游改动默认命名,应重新评审而非直接改基线。

## 8. 未推送、未合并

分支停在 `integration/upstream-2026-10`,**未 push、未合并进 `main`、未部署**。待维护者
审阅本报告与 §7 的遗留项后再决定。
