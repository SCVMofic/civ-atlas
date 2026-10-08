# 第一阶段重构报告(TASK-001 ~ TASK-006)

对应 RFC:Architecture Refactor / Agent Execution Specification。
**原则:Behavior Preservation First, Architecture Improvement Second.**

本文件是第一阶段的收口报告:做了什么、依赖关系怎么变了、哪些行为**逐字节**没变、
哪些地方**故意**变了(以及为什么)、性能与已知问题。按 RFC §53,做完这批**暂停**,
再决定是否进入 Simulation 重构(Phase 3)。

---

## 1. Summary

| 任务 | 内容 | 提交 |
| --- | --- | --- |
| TASK-001 | 基线:环境、五条命令的结果、性能基准、21 组确定性指纹、存档现状、结构盘点 | `72ed8a6` |
| TASK-005 | 确定性回归:同输入跑两遍完整流水线,逐字段比指纹(17 个用例) | `87ae4ee` |
| TASK-006 | 存档往返:生成 → 存 → 读 → 重新生成,逐字段一样(15 个用例) | `ba3223a` |
| TASK-004 | 世界计算服务:协议唯一一份 + `WorldComputeService` + 结构化错误(14 个用例) | `51cccb8` |
| TASK-002 | WorldSession:世界的运行时真值从 React 根组件里抽出来(15 个用例) | 见 §9 |
| TASK-003 | 抽离 URL / 路由 / 打开世界那一块(`ui/route.ts`) | 见 §9 |

第一轮**没有**碰 `src/gen/`、`src/render/` 里任何一行(只有 `src/worker.ts` 挪了位置):
世界的生成、气候、河流、生物群系、文明推演、铺像素、编年史——算法一个字没改,
这也是指纹能 21 组全部一致的根本原因。

---

## 2. 前后架构(Architecture Impact)

### 之前

```text
App.tsx(3596 行)
 ├─ 世界的运行时状态:baseData / rawCiv / eraMaps / params / reqId / resimSeq …
 │   (十几个 useState + useRef,另有 rawRef / baseRef / eraMapsRef 三个镜像 ref)
 ├─ worker 的生死:new Worker / terminate / onmessage 里一个大 switch
 │   (回音计数 busyRef、试推演等待表 trials、扩张节拍 tempoNote 也在这里)
 ├─ 生成 / 重推 / 改地形三条生命周期,各自 setProgress / 发请求 / 收拾状态
 └─ 画图、投影、交互、面板、AI、标记、人物 …(界面)
```

问题(和 RFC §2 一致):世界**数据**和界面状态混在一个 hook 里;
worker 协议靠"消息先后来猜归属";线程报错没有任何说法(异常只落在 error 事件上,界面停在进度条)。

### 之后

```text
UI(App.tsx)
 │  只负责:画、点、面板、时间轴 —— 和"拿到回执以后界面改成什么样"
 │
 ├── session/worldSession.ts     世界的真值:编号、参数、身体(world + raster + 各段世界 + civ)、
 │                              status、worldId / simulationVersion、error(useSyncExternalStore)
 │
 ├── worker/client.ts            WorldComputeService:发号(requestId)、按号兑现回执、取消、换线程、错误
 │      └── worker/protocol.ts   消息约定(唯一一份;每条请求与回执都带 requestId)
 │             └── worker/worker.ts   计算线程(原 src/worker.ts)
 │
 └── ui/route.ts                 网址 → 要打开的世界(Target):readUrl / firstRoute / writeWorldUrl …
```

依赖方向变清楚了:**界面 → 会话 → 计算服务 → 线程**;
`session/` 不依赖 `ui/`,也不依赖 `worker/` 的实现(只在类型上引用 `AppError`);
`worker/` 不认识界面。用户改的东西仍然在 `ui/editsStore.ts`(本来就是非 React 的 store),
会话不复制一份 —— RFC 里 `WorldSession.edits` 那一项由它承担。

### 前后行数

| 文件 | 之前 | 之后 |
| --- | --- | --- |
| `src/ui/App.tsx` | 3596 | **3388**(目标 < 800 未达成,原因见 §8) |
| `src/session/worldSession.ts` | — | 182 |
| `src/worker/protocol.ts` | — | 130 |
| `src/worker/client.ts` | — | 287 |
| `src/worker/worker.ts` | 345(`src/worker.ts`) | 293 |
| `src/ui/route.ts` | — | 215 |

---

## 3. Behavior Compatibility

**逐条回答 RFC §44 的五个问题。**

| 问题 | 回答 |
| --- | --- |
| 是否改变现有行为? | 功能的**输入输出**没有变:同种子、同参数、同修改、同干预 → 同一个世界、同一份历史、同一份编年史、同样的回放帧。**故意**变了两处,见下。 |
| 同 seed 是否仍然相同? | 是。21 组指纹全部一致(§5)。 |
| 旧 save 是否仍可读取? | 是。`SAVE_FORMAT`、`GENERATOR_VERSION`、`savefile.ts` 一行未动(§6)。 |
| 是否增加明显 runtime / memory? | 没有明显变化(§7);一处**时序**变化见下。 |
| 是否引入新的隐式耦合? | 没有;依赖方向是单向的(§2),协议只有一份。 |

### 故意改变的两处(都在 TASK-004 的范围内,是 RFC 要求的)

1. **线程里的异常现在有说法了。** 以前某条请求计算时抛异常 → 只落到线程的 error 事件上,
   界面既不知道原因、进度条也停在那里(`busyRef` 永远不归零,之后再也不换线程)。
   现在线程先回一条可序列化的 `{ type: 'error', requestId, error }`,
   主线程包成 `AppError` 交给界面(顶部提示条「计算线程出错」+ 原因),同时**保留**原来的重抛行为
   —— 也就是说,出错时不会静默,也不会因此改动正常路径。
2. **被换掉的线程上还挂着的活会明确失败。** 以前换线程(生成新世界时终止旧线程)只 reject 掉试推演,
   其它在跑的活(重推、回放帧)就那么挂着,永远不会回来。现在它们按 `worker:replaced`(「世界换了,试推演作废」)失败
   —— 界面上的表现不变(那些结果本来也不要了),但不再有"永远不兑现的 promise"。

### 一处时序变化(需要记着)

「城面板 → 迁都到这里」时,面板藏起来 → 重推完再露出来。**功能完全一样**,
但"藏起来的那一段"长度 = 重推耗时(本机约 300–400 ms)。冒烟检查在点击后 100 ms 采样,
而它的一次采样要走两个来回(取元素个数 + 判断可见),忙的时候可能落在 300 ms 之后 —— 于是偶发失败。
页面里的实测时间线(in-page MutationObserver,不受来回延迟影响):

```text
+23ms  按下"迁都到这里"
+30ms  面板加上 hidden            ← 藏起来
+42ms  提示条「正在重新推演 2600–3000 年」
+358ms 面板去掉 hidden            ← 重推落地,露回来
+358ms 提示条「萨尔斯坦帝国迁都萨拉尔,已从 2600 年起重新推演 撤销」
```

结论:藏与露的时机都是对的,是**这条断言本身窗口太窄**(见 §8)。

---

## 4. Determinism

- `tests/determinism.test.ts`(仓库原有,两个种子 × 12k 地块 × world + civ 全字段的**钉死**指纹):通过。
- `tests/regression-determinism.test.ts`(TASK-005 新增,17 个用例):**跑两遍互相比**。
  和上面那份分工互补 —— 钉死的期望值看不见"同一台机器上两次不一样"(Map 遍历顺序、
  模块级残留状态、隐藏的 `Math.random` / 时间戳)。覆盖:
  地形 / 气候 / 河流 / 生物群系(5 组参数 + 四种子的交叉生成)、
  文明 / 编年史(3 组参数 + 中间插别的世界)、
  改地形 / 草图(单测 + 整条流水线:世界 + 文明 + 编年史 + 铺像素 + 回放帧)、
  干预 / 地形大事(各段世界按 worker 的累积方式算)、铺像素 / 回放帧逐字节。
  另有一条**指纹本身有分辨力**的用例(换种子 / 换地形 / 换一帧 / `0.1+0.2 ≠ 0.3`),
  防止"恒等指纹"把回归测成绿的。
- `docs/baseline-fingerprint.json` + `scripts/fingerprint.ts --check`:21 组 × 54–57 个字段。
  每个阶段之后都跑一遍,**全部一致**(§7 有逐次记录)。
- 结论:**同种子 + 同参数 + 同修改 = 同一个世界**,这条不变量在第一阶段没有被破坏。

---

## 5. Persistence

- `SAVE_FORMAT = 1`、`GENERATOR_VERSION = 9`:没动。`src/gen/savefile.ts` 一行未改。
- `tests/regression-save-roundtrip.test.ts`(TASK-006 新增,15 个用例)补上了 RFC §21 要的那一整圈 ——
  之前**没有**任何用例走过 `生成 → 存 → 读 → 重新生成 → 比对`:
  - 默认参数 / 每个参数都非默认 / 3 处地形修改 / 草图 / 两者一起:重新生成的世界**逐字段一样**;
  - 干预:读档后按存档里的干预推演,文明逐字段一样(键、时序、人都没丢);
  - 地形大事:各段世界逐字段一样,之后的历史也一样;
  - 修改字段保真:改名 / AI 起名的记号 / 改的旗 / 标记 / 人物 / 干预 原样往返;没改东西时可选字段不写进文件;
  - 序列化幂等:读出来再写回去,文本一模一样;
  - 参数超范围:夹回并**明确提示**(不提示就等于静默换了世界),夹过以后是稳定的不动点;
  - 生成器版本不同:明确提示"来自旧版本";同版本地形对不上则 `checkWarning` 提示
    —— RFC §21 要求的"不得静默生成错误世界";
  - 格式与生成器版本钉在测试里(改它必须是有意识的)。
- 旧存档的兼容性由仓库原有的 `tests/savefile.test.ts`(89 个用例)守着,全过。

---

## 6. Tests

| 命令 | 基线(103afd3) | 第一阶段结束时 |
| --- | --- | --- |
| `pnpm typecheck` | ✅ | ✅ |
| `pnpm test` | ✅ 80 文件 / **1181** 用例 | ✅ 84 文件 / **1242** 用例(新增 61) |
| `pnpm build` | ✅ 6.59 s | ✅ 6.15 s |
| `pnpm stress` | ✅ 无 NaN | ✅ 无 NaN |
| `pnpm smoke` | 功能全过;1 条性能断言超(见 §7) | 功能全过;**同一条**性能断言超(另有一次时序偶发,见 §8) |
| `scripts/fingerprint.ts --check` | 21 组一致 | 21 组一致(每个阶段都跑过) |

新增的 61 个用例都是**回归测试**,不是凑数:
`regression-determinism`(17)+ `regression-save-roundtrip`(15)+ `worker-client`(14)+ `world-session`(15)。

---

## 7. Performance

本机:Windows 11、16 核、Playwright 无头 Chromium(**软件渲染 SwiftShader**)。数字只作相对比较。

### 打包体积

| | 基线 | 之后 |
| --- | --- | --- |
| `index-*.js` | 1415.39 kB(gzip 558.59) | 1419.21 kB(gzip 560.16) |
| `worker-*.js` | 300.05 kB | 300.44 kB(+0.39 kB:requestId 与错误回执) |

### `scripts/stress.ts`(首尾各跑一次,逐组对照)

| 最慢的一组 | 基线 | 第一阶段结束 | 预算 |
| --- | --- | --- | --- |
| 宜居度 + 划州(36k 默认) | 108 ms | **101 ms** | 60 ms |
| 道路(36k 默认) | 183 ms | **175 ms** | 150 ms |
| 生成 + 铺像素 + 文明(36k 默认) | 2577 ms | **2469 ms** | 2000 ms |
| 推演(民族 + 城镇 + 国家 + 战争 + 分合 + 王朝 + 同化迁徙 + 城市兴衰) | 124.5 ms | 124.9 ms | 100 ms |
| 回放一帧(Node 里) | 121.4 ms | **112.8 ms** | 30 ms |
| 国名、城名、城镇符号排版 + 避让 | 36.1 ms | 37.6 ms | — |

都在噪声范围里(几组还略快),**没有回归**。这些预算基线本身就超
(脚本只在 NaN / 非确定性时置退出码,见 `scripts/stress.ts`);
而且这次重构没有碰 `src/gen/`、`src/render/` 里任何一行,本来也不该有变化 —— 跑它是为了证明确实没有。

### 冒烟里的三条性能断言(基线就已经临界)

| 断言 | 基线 | 之后 |
| --- | --- | --- |
| 拖动每帧(预算 16 ms) | 16.2 ms ❌ | 16.7 ms ❌ |
| 国家视图首次绘制(预算 150 ms) | 通过 | 通过(曾出现一次 384 ms,当时有别的测试在抢 CPU;单独跑通过) |
| 回放每帧 / 改名 / 重推 / 改地形重新生成 | 通过 | 通过 |

拖动那一条在基线上就已经超(16.2 vs 16.0),**这台机器是软件渲染**;最后一次干净运行(不并跑任何别的东西)
是 16.7 ms —— 比基线的 16.2 ms 高 0.5 ms,在噪声范围里,但不能说"零影响"。下一阶段开始前建议把这条预算按机器区分
(基线报告 §4 已记)。**除此之外,最后一次冒烟只有这一条错误,功能项全过。**

---

## 8. Known Issues

1. **App.tsx 还远没到 800 行**(见 §9)。RFC §4 说"行数不是硬性指标,最终判断依据是职责是否清晰":
   本次把"世界的真值""worker 边界""网址 / 路由"三块职责搬出去了,
   但**地图交互(指针 / 缩放 / 悬停 / 拾取)和面板装配**仍和根组件绑在一起 ——
   它们直接读写 DOM ref、canvas、store,要抽干净得先给它们定一套清楚的接缝。
   建议作为下一步单独做,详见 §10。
2. **冒烟里「城面板 → 迁都到这里」偶发失败**(三次运行里出现一次;最后一次通过):功能正确(§3 有时间线),
   是那条断言窗口太窄(点击后 100 ms 采样,而"藏起来"的窗口 = 重推耗时 ≈ 300–400 ms,采样又要走两个来回)。
   三个候选处理(留给项目决定,本阶段**没有**动测试,以免把断言改松):
   - 采样改成 `waitForFunction(面板藏起来了, timeout: 2000)` —— 断言"藏过"而不是"此刻藏着";
   - 或者把重推的忙碌窗口做长一点(重推落地前不露出面板);
   - 或者按 RFC §45 的"visual regression"单独立一条,不和功能断言混在一起。
3. **`status` 目前只有写入方,还没有界面读它**:会话里的 `status`(idle / generating / resimulating / ready / error)
   在生成、重推、就绪、报错各点都写了,但界面上还照旧用 `progress` / `resim` / `terrainStatus.busy` 自己拼
   (`worldBusy`)。**没有**强行改读它,因为那会改掉面板的显隐时机(正是 §3 那条时序)。
   下一步:把 `worldBusy` 换成 `session.status === 'generating' || 'resimulating'`,并给这条迁移补测试。
4. **`worker.onerror` 没接**:线程级别的崩溃(不是某条请求抛异常)仍然只有 error 事件。
   现在的 `onError` 只覆盖"线程回了 error 回执"和"造线程失败"。下一阶段补。
5. **`bench/` 目录(RFC §28)没建**:基线报告里记了 `stress` / `fingerprint` 的逐组耗时当基准,
   但没有独立的 benchmark 目录与内存指标(`--expose-gc` + `process.memoryUsage()`)。
6. **`scripts/tmp-move-probe.ts`**:本次排查时序用的临时脚本,**没有**提交(工作区里删掉即可)。

---

## 9. 每步的验收记录

### TASK-001 基线(`72ed8a6`)

typecheck ✅ · 80 文件 1181 用例 ✅ · build 6.59 s ✅ · stress 无 NaN ✅ ·
smoke 功能全过(仅拖动性能断言超)· 指纹 21 组已存并复验一致。
交付:`docs/baseline-report.md`、`docs/baseline-fingerprint.json`、`.node-version`。

### TASK-005 确定性回归(`87ae4ee`)

只新增测试与测试辅助(`tests/lib/fingerprint.ts`、`tests/regression-determinism.test.ts`),
`src/` 一行未动。17 个用例,15.6 s。

### TASK-006 存档往返(`ba3223a`)

只新增测试(`tests/regression-save-roundtrip.test.ts`),`src/` 一行未动。15 个用例,8.1 s。

### TASK-004 世界计算服务(`51cccb8`)

- 新增 `src/worker/protocol.ts`(130)、`src/worker/client.ts`(287);`src/worker.ts` → `src/worker/worker.ts`(293)。
- `App.tsx`:删掉 worker 的生死管理、回音计数、试推演等待表、节拍注入;改成
  `onReply` 一个处理 + `compute.generate / resimulate / trial / history / previewUpheaval`。
- 验收:typecheck ✅ · **1227** 个用例 ✅(1181 + 新增 46)· build ✅(worker chunk +0.39 kB)·
  指纹 21 组一致 ✅ · smoke 功能全过 ✅(两条性能断言超,见 §7)。

### TASK-002 WorldSession + TASK-003 URL / 路由抽离

> **为什么这两步在同一个提交里**:抽 `route.ts` 的准备是在第二条冒烟跑着的时候做的(不影响运行中的服务),
> 等结果出来两处改动已经在同一份工作区里了。为了不把一个已经验证过的状态拆开重做,
> 就合成一个提交,提交信息里把两步分开写清楚 —— 加起来的验收见本节末尾。

- 新增 `src/session/worldSession.ts`(182):世界编号 / 版本、参数、身体(world + raster + 各段世界 + civ)、
  地图上这份世界带着的修改、`status`、`error`;`useSyncExternalStore` 订阅,`getWorldSession()` 给非界面代码读。
- `App.tsx`:删掉 `baseData` / `rawCiv` / `eraMaps` / `params` / `shownTerrain` / `shownSketch` 六个 useState、
  `reqId` / `resimSeq` 两个计数器,以及 `rawRef` / `baseRef` / `eraMapsRef` **三个镜像 ref**
  (会话本身就是真值,不必再镜像);生命周期各点改调 `newGeneration / worldReady / simulationStarted /
  invalidateSimulation / simulationReady / setShownEdits / sessionFailed`。
- 验收:typecheck ✅ · **1242** 个用例 ✅(新增 15)· build ✅ · 指纹 21 组一致 ✅。

### TASK-003 抽离 URL / 路由

- 新增 `src/ui/route.ts`:原来散在 `App.tsx` 顶上的那一整块模块级代码 ——
  `readUrl` / `writeLayerUrl` / `Target`(要打开的世界)/ `randomSeedValue` / `draftSig` / `draftTarget` /
  `storedTarget` / `visitTarget` / `firstRoute`(打开网页时去哪)/ `STUDIO_LAYERS` / `HISTORY_LAYERS` /
  `writeWorldUrl` / `writeHomeUrl` / `storyOk`,以及 `wrapClip` / `screenClip` 两个裁剪工具。
- 这些本来就是纯函数(只依赖 imports + `location` / `history`),搬出去是机械替换;
  `App.tsx` 只留一行 import。
- `App.tsx`:**3596 → 3388 行**(−208)。职责上"网址 / 路由 / 要打开哪个世界"不再归根组件。
- 验收:typecheck ✅ · 1242 个用例 ✅ · build ✅(6.15 s;index 1419.21 kB / gzip 560.16)·
  指纹 21 组一致 ✅ · **smoke 功能全过**(只余基线就有的那条拖动性能断言:16.7 ms vs 预算 16 ms)。

---

## 10. Next Recommended Task

按 RFC §52 的顺序,下一阶段是 **Phase 3 — Simulation Boundary**(`CivSim` → `Simulation` façade),
但基于本阶段的实际情况,建议先插两件小事(各半天):

1. **把 `worldBusy` 接到会话的 `status` 上**(§8 第 3 条),顺带把"面板藏 / 露"的时机写进测试 ——
   这样 §8 第 2 条那个偶发断言就有了正经的替代,而不是放宽预算。
2. **接 `worker.onerror`**(§8 第 4 条):线程整体崩掉时也要有说法。

然后进入 Phase 3 时**先只立 façade**(RFC §37 明确"第一阶段只建立 facade,不要立即重写所有 civilization 模块"):
`Simulation` 持有 `CivSim` 的实例、`EventScheduler` / `EventStore` 包一层,
`generateCiv` 的行为逐字节不变(tests/regression-determinism 与 21 组指纹就是它的护栏)。

再往后(Phase 4+)才动事件抽象与 mutation 边界 —— 那会真正碰到
`gen/civ/*.ts` 里各系统的写法,必须一个系统一个系统迁移、每步都对一次指纹。
