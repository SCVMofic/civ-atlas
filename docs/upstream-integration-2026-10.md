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
| 端到端冒烟(合并后) | `tsx scripts/replay-check.ts` | 全流程功能场景通过;唯一失败项 = 拖动每帧耗时预算(中位数 **17.5 ms** > 16 ms) |
| 端到端冒烟(基线 `0e3bda7`) | 同上 | 全流程功能场景通过;唯一失败项 = 同一条预算(中位数 **18.7 ms** > 16 ms) |
| 空白检查 | `git diff --check` | 干净 |

**结论**:上游 11 个提交的功能全部落地;默认(自动)路径下世界与文明输出与本地基线
逐字节一致(指纹 21 组);恢复推演的可观察结果(ChangeLog、annals、检查点、最终归属)
差异为 0,且与基线完全相同 —— 唯一的差异是"同刻事件 handler 调用顺序",这是本地在
TASK-011A 已探明、已记录、已接受的现象(`docs/simulation-event-audit.md`),本次合并没有
改变它。

端到端冒烟(`scripts/replay-check.ts`)的说明:合并后与基线各自都**只有一条**失败项,
且是同一条 —— 「东西相连:拖动每帧太慢」(预算 16 ms)。合并后中位数 17.5 ms,基线
18.7 ms(合并后反而更快)。这是本机负载敏感的性能预算(脚本注释也写明"CI 的虚拟机比
一般电脑慢两三倍"),不是本次集成引入的回归:同场景的功能断言(拖得动、拖一圈画面
变化 0.000%)两边都通过,且合并后的数字比基线更接近预算。新增功能的冒烟场景
(「看原样」第 8/9 版、新建确认框四样、版本号提示、地名风格)均已执行且无额外报错。

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
2. **端到端冒烟有一条性能预算失败(非本次引入)**:`scripts/replay-check.ts` 的
   「东西相连:拖动每帧太慢」在本机超预算;合并后 17.5 ms、基线 18.7 ms,两边同一条,
   且合并后更快 —— 属本机负载敏感的性能预算,不是集成回归。若要在 CI 稳定通过,需按
   脚本既有做法在 CI 上放宽(`CI=1` 时预算已是 40 ms),或在空闲机器上复跑确认。
3. **同刻事件顺序差异**(TASK-011A 已记录,非本次引入):恢复推演会改变同刻 handler
   调用顺序,但不影响任何可观察结果。本次合并前后完全一致,风险等级不变。
4. **旧存档兼容策略**:上游用 `original` 留底 + `versionNote` 提示;本地存档格式与恢复
   语义未改(见 `docs/simulation-resume-contract.md`)。不支持地名风格的旧存档按"自动"
   处理(`cleanMix` 返回 undefined)。
5. **指纹基线未更新**:本次默认路径指纹与基线一致,故 `docs/baseline-fingerprint.json`
   无需重存。若日后上游改动默认命名,应重新评审而非直接改基线。

## 8. 交付状态(2026-10-10 更新)

分支 `integration/upstream-2026-10` 已推送到 `origin`(SCVMofic/civ-atlas),并开了一个
以 `main` 为目标的 PR(https://github.com/SCVMofic/civ-atlas/pull/1)。**未合并进 `main`、
未部署**。PR 仅用于取得 GitHub CI 记录与审查。

## 9. 验收复跑(第二轮,2026-10-10)

环境:Windows + Git Bash,Node `v26.6.0`,pnpm `11.24.0`。

### 9.1 自动化验收(P0)

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 退出码 0 |
| 全量测试 | `pnpm test` | 退出码 0,89 文件 / 1320 用例全过 |
| 生产构建 | `pnpm build` | 退出码 0 |
| 指纹对账 | `pnpm exec tsx scripts/fingerprint.ts --check docs/baseline-fingerprint.json` | 退出码 0,21 组全部一致 |
| 恢复推演探针 | `pnpm exec tsx scripts/probe-resume-order.ts` | 退出码 0,24 组:轨迹 22、日志 0、史事 0、检查点 0、归属 0 |
| 端到端冒烟(CI 预算) | `CI=1 pnpm smoke` | **退出码 0,errors: []**(拖动每帧中位数 16.7 ms < CI 预算 40 ms) |

冒烟说明:此前在**未设 CI 变量**时本机冒烟会命中「拖动每帧太慢」(本地预算 16 ms);
合并后 17.5 ms、基线 18.7 ms,两边同一条,属本机负载敏感的性能预算。按 CI 口径
(`CI=1`,预算 40 ms)复跑**完整通过**,可记为"功能冒烟通过,常规本地性能预算仍有既有失败"。
未删除或放宽任何性能断言。

### 9.2 GitHub CI(P1)

PR #1 触发的 workflow run `38051179712`(commit `f1e2ae7`):

| 任务 | 结果 |
| --- | --- |
| 类型检查 / 单测 / 压力 / 构建 | ✅ success(9m14s) |
| 画面回归 | ✅ success(1m19s) |
| 冒烟 | ✅ success(约 28 分钟,CI 上属正常) |
| 最近一天有没有代码改动 | 跳过(仅 schedule 触发) |

四项全绿,无失败项。

### 9.3 浏览器功能验收(P1)

用 ZCode 内置浏览器对着本地 dev server(`vite`,端口 5199)做:

- **地名风格端到端**:新建世界 → 地名风格页(默认「自动」显示 中式 27% / 音译 73%)→
  「自己配」→「全中式」→ 比例变 中式 100% → 创建确认框列出「地名风格:全中式」→ 创建后
  地图标注全为中式(碧波洋、大霄、揽霞城、宁州、浮床之山……),无音译名。配置贯通成立。
- **旧存档首次重存留底**:注入 `generator=8` 的旧存档 → 打开后自动按新版重存,
  `wenming-ditu:orig:<id>` 出现且为 `generator=8`(原样)→ 再次改名保存后,`orig` 仍是
  `generator=8`、`savedAt` 不变,当前存档变 `generator=9`。**最早备份不被覆盖**。
- **看原样入口**:gen 8 的原始份**没有**「看原样」—— 正确,因为 `FIRST_OLD_SITE = 9`,
  `[9, GENERATOR_VERSION)` 在当前 `GENERATOR_VERSION = 9` 下为空;与冒烟脚本预期(0)一致。
- **非零中央经线草图(e0ae720)**:`lon=120` 的新建界面上用火山工具落一笔,
  `.terrain-marks` 组内出现 `tt-mark k-volcano`,`tt-line`/`tt-halo` 计算样式为
  `fill: none` + 可见描边;截图里是一圈可见的白色轮廓,**不是黑色实心块**。外层还有
  3 个 `<use>` 复制份。
- **时间轴缩略图(372f4e0)**:`shownRaw = civAtEra(rawCiv, eraK)`,并传给
  `useLayerThumbs({ data, civ: shownRaw, ... })`(App.tsx:1649)—— 代码级核对通过;
  未构造"地形大事 + 时间轴回退 + 图层缩略图对比"的完整可视化场景。

### 9.4 元数据(P2)

- `package.json` 的 `repository`、`src/ui/links.ts` 的 `SOURCE_URL`、README 的链接**都**指向
  `guaner-334/civ-atlas`,彼此一致(这是保留上游出处的写法)。是否改成
  `SCVMofic/civ-atlas` 是维护者的产品决定,不是本次合并的阻断项;若改,应四处一起改。
- `deploy.yml`(push main)与 `deploy-old-site.yml`(手动)**都**带
  `if: github.repository == 'guaner-334/civ-atlas'`,在 `SCVMofic/civ-atlas` 上会被跳过 ——
  合并进 `main` 也不会触发部署。

