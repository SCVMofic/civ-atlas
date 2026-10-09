# 重构报告(TASK-001 ~ TASK-007D,以及 TASK-008A)

对应 RFC:Architecture Refactor / Agent Execution Specification、其后的源码审查意见,
以及 `docs/implementation-plan-phase3.md`。
**原则:Behavior Preservation First, Architecture Improvement Second.**

本文件记:做了什么、依赖关系怎么变了、哪些行为**逐字节**没变、哪些地方**故意**变了(以及为什么)、
性能与已知问题。三个阶段:

- **第一阶段(TASK-001 ~ 006)**:基线、确定性回归、存档往返、Worker 边界、WorldSession、网址/路由抽离。
- **第二阶段(TASK-007A ~ 007C)**:落实审查的 FINDING-001~005 与 P1 那条偶发断言
  (Worker 故障恢复、正式世界任务的单一状态来源、重新验收)。
- **第三阶段(TASK-007D 起)**:按 `implementation-plan-phase3.md` 走 ——
  007D 冒烟点击路径收口(已完成)、008A 调用图与边界清单(已完成,见 `docs/simulation-boundary.md`)、
  008B 最小 façade(已批准实施)、008C 单调用点迁移、009 全量回归与阶段冻结。

> 当前进度:007D 与 008A 已完成;**008B 已获有条件放行**,正在实现;008C 尚未开始
> (按审查要求,façade 独立通过测试之后才迁移调用点)。

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

1. **App.tsx 还远没到 800 行**(见 §10)。RFC §4 说"行数不是硬性指标,最终判断依据是职责是否清晰";
   第一、二阶段把"世界的真值""worker 边界""网址 / 路由""正式世界的任务生命周期"搬了出去,
   但**地图交互(指针 / 缩放 / 悬停 / 拾取)和面板装配**仍和根组件绑在一起 ——
   它们直接读写 DOM ref、canvas、store,要抽干净得先给它们定一套清楚的接缝。建议单独做,见 §10。

2. **两条既有性能债**(都会在机器有负载时偶发失败,**与本次改动无关**,建议独立处理):
   - 冒烟「东西相连:拖动每帧」(预算 16 ms):基线 16.2 ms、第一阶段末 16.7 ms —— 这台是软件渲染;
     还有一次机器被 Windows Defender 扫描拖慢到 2.5 倍(整轮冒烟从 ~19 分钟涨到 ~29 分钟)时冲到 41.8 ms。
   - `tests/names.test.ts`「生成 1000 个名字 < 100 毫秒(三次取最快)」:墙上时钟断言,
     同一份代码连跑 12 次里超了 1 次(124.6 ms)。详见 007C 那节。
   两条都建议改成与负载无关的判据(或按机器/CI 放宽),而不是调大超时。

3. **`bench/` 目录(RFC §28)没建**:基线报告里记了 `stress` / `fingerprint` 的逐组耗时当基准,
   但没有独立的 benchmark 目录与内存指标(`--expose-gc` + `process.memoryUsage()`)。

4. **第二阶段修掉的三条**(留档,免得以后又当新问题查一遍):
   - worker **线程级**异常没有回执、活一直挂着 → TASK-007A(现在按 `worker:crashed` 收尾,不自动重放);
   - `status` 与 `progress` / `resim` 双轨、失败后界面一直锁着 → TASK-007B(会话里的 `task` 是唯一来源);
   - 冒烟「城面板 → 迁都到这里」按瞬间采样 → TASK-007B(改成四段各等一个明确状态)。

5. **冒烟手机段挑国家的脆弱性**(007C 里加固):那一段挑"离屏幕中心最近的国家"来验干预,
   而那一国未必有可结盟的对象(干预页的"结盟"是灰的)。以前会静默跳过整段干预检查,
   并且让卡片停在拉满的状态 —— 右上那排按钮一直藏着,脚本在下一步"图层抽屉"半路崩掉(错误都来不及报)。
   现在改成**挨个试**能结盟的国家(最多 6 个,地图飞过去以后名牌位置会变,所以每次重新取),
   挑不到就**明确报错**(不静默跳过),并把详情卡片关掉让整段跑完 —— 既不掩盖问题,也不让它崩在半路。

---

## TASK-008B:最小 Simulation façade

按 `implementation-plan-phase3.md` 有条件放行实施。**只建立边界,不做 008C 的调用点迁移。**

- 新文件 `src/simulation/simulation.ts`:一行委托 ——
  `run({ world, params?, progress? })` → 原样调 `gen/civ/index.ts` 的 `generateCiv(...)` → 返回**同一个** `Civ`。
  放在 `src/simulation/`(不在 `src/gen/**` 里),所以"不改 `src/gen/civ/**`"这句话字面上也成立。
- 硬性约束逐条对上:不重写 `CivSim` / 事件调度 / 生成流程;不新建引擎实例、不复制文明状态、不加第二真值;
  不改 install 顺序与 `seq` 分配;不把引擎细节暴露给调用方;不吞异常、不自动重试;不包成 async;
  不依赖 React / DOM / Worker(只 import `src/gen/**`)。
- 为什么返回 `Civ` 而不是再造一个 `SimulationResult` 壳:今天调用方要的就是这份 `Civ`,壳里没有别的东西可放 ——
  等真有了再包(边界清单 §8 记了这条)。

测试 `tests/simulation-facade.test.ts`(13 个用例,覆盖审查点名的四件事):

| 要证明的 | 怎么证 |
| --- | --- |
| 参数与 progress 原样传递 | `params` 生效(`endYear` 1200);同一输入下 facade 与旧入口收到**同一串**阶段与百分比;不给参数也照跑 |
| 与旧入口逐字段一致 | 5 组输入(默认 / 截年 / 干预 / 地形大事 / 三者一起)各比一遍:`changedFields(fieldsOf('civ.', old), fieldsOf('civ.', via))` 为空,整体哈希也相同 |
| 异常继续上抛 | 传坏 world:`generateCiv` 与 façade 抛**同一个类、同一句话**,且 façade 不会"返回" |
| 不新增引擎 / 状态副本 / 异步包装 | `run` 同步返回且不是 thenable;façade 只有 `run` 一个成员;连着跑、中间插别的推演,结果都一样(无状态、无第二真值) |
| 只依赖纯计算(静态护栏) | 读源码:import 只许 `../gen/**`;去掉注释后不许出现 `new Worker` / `document.` / `window.` / `React` |

验收(本提交上实跑):

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ **85 文件 / 1274 个用例**(008B 新增 13) |
| `pnpm build` | ✅ 6.36 s;index 1420.63 kB(gzip 560.67)、worker 300.44 kB —— **和 008B 之前一模一样**(façade 还没被任何地方 import,不进包) |
| `scripts/fingerprint.ts --check` | ✅ **21 组全部一致** |
| 存档往返相关 | ✅ `regression-save-roundtrip` + `savefile` + `share` 共 **112 个用例**全过;`SAVE_FORMAT = 1`、`GENERATOR_VERSION = 9` 未动 |
| `src/gen` / `src/render` / `src/worker` / `src/ui` / `src/session` | **一行未动**(`git diff` 为空)⇒ 没有任何调用点被迁移 |

性能:façade 目前没有调用方,跑不到它 ⇒ 没有可比的运行时数据,也就没有回归可言(既有那两条性能债不变,见 §8)。
**008C 尚未开始** —— 按审查要求,façade 独立通过测试之后,再单独审查并逐个迁移调用点。

## 9. 每步的验收记录

> 第二、三阶段的验收记录在文末:「第二阶段:TASK-007A / 007B / 007C(审查意见的落实)」
> 与「TASK-007D」「TASK-008A」两节;下面这几条是第一阶段的。

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

> **更新(第二阶段末)**:本节原来列的"先做两件小事再进 Phase 3"**已经做完** ——
> `worldBusy` 已接到会话的 `task` 上(单一来源,失败也解锁),`worker.onerror` 已接,
> 那条偶发断言已改成按序列验证(见 007A / 007B)。**遗留事项**移到 §8「Known Issues」
> (App.tsx 仍是页面组合层、两条既有性能债、`bench/` 未建)。
>
> 下一步按新的实施计划走:`docs/implementation-plan-phase3.md`
> (TASK-007D 冒烟点击路径收口 → TASK-008A 调用图盘点 → 门 → TASK-008B 最小 façade →
> 008C 单点迁移 → TASK-009 全量回归与阶段冻结)。**不跳过 008A 的边界分析直接抽 façade。**

---

# 第二阶段:TASK-007A / 007B / 007C(审查意见的落实)

审查的结论是:第一阶段架构方向通过、Phase 3 有条件放行,但进 Simulation 之前要先补三处缺口 ——
Worker 的线程级异常、忙碌状态的单一来源、那条偶发的面板时序断言。以下按审查给的顺序做。

## TASK-007A Worker 故障恢复(`9473bcc`)

对应审查 FINDING-001 / 003 / 004。核心:**每个已提交的活都有确定的终态,不会挂着**。

| 故障 | 以前 | 现在 |
| --- | --- | --- |
| 线程里某条请求抛异常 | 回一条可序列化的 error 回执(第一阶段已做) | 那条活按 `worker:exception` 失败,`onError` 一并说一声 |
| 线程**整体**崩掉(`onerror`) | **没有回执**:等它的 promise 永远挂着、忙碌计数一直大于零、下一次 generate 还在用那个坏线程 | 线程作废,在跑的活全部按 `worker:crashed` 失败,记录与计数清干净;**不自动重放**(有副作用的活不重来),下一次请求另起一个线程 |
| 回执过不了 structured clone(`onmessageerror`) | 同上(悬挂) | 同上(按线程崩了处理) |
| `postMessage` 同步抛错 / 线程起不来 / 服务已销毁 | 请求记录已经建立却没人收尾 | `submit()` **不发异常**:给一件当场失败的活(`worker:unavailable`),调用方不必再包 try |
| 重复的终态回执 / 认不出的 requestId | 每来一条非 streaming 回执就扣一次忙碌计数 → 提前归零 → `restart()` 误判"线程不忙" | `busy` = 还没拿到终态回执的请求数(pending 表大小);重复 / 认不出的回执动不了任何一条活 |
| `dispose()` 之后 | 晚到的消息仍可能触发回调 | `disposed` 守卫:不再起线程、不再通知订阅者 |

另加 `isTaskCancellation()`:换线程 / 关服务 / 主动取消是**正常收尾**,界面不该当故障提示;
`dispose` 的失败码也从 `worker:replaced` 改成 `worker:disposed`(把"页面关了"说成"世界换了"是错的)。

测试:`tests/worker-client.test.ts` 14 → **24 个用例**(线程级 error / messageerror、崩溃后不自动重放、
postMessage 同步抛错、线程起不来、重复终态回执、认不出的 requestId、一条报错不影响另一条、
dispose 后无副作用、`isTaskCancellation` 的判定)。

过程里编译器逮住一处真 bug:`handle()` 把回执的**类型**当成了回执本身传给 `countsAsReply`
(运行结果恰好等价,语义是错的),已修正。

## TASK-007B 统一任务状态与界面恢复

对应审查 FINDING-002 / 005,外加 P1 那条偶发断言。要点:**"正式世界在算什么"只有一个来源**。

- 会话新增 `task`(`kind` / `requestId` / `year` / `since`):生成、改地形重新生成、干预与地形大事重推**登记**;
  助手试推演、地形大事预览、回放帧是**临时活,不登记** —— 它们不该把状态写成 resimulating,也不该锁住界面
- `status` 改成**推出来的**:`task` 在 → generating / resimulating;没有任务而有 error → error;
  有世界 → ready;什么都没有 → idle。写任何字段都重算一遍,所以不会有两份说法不一致
- `worldReady` / `simulationReady` 只认**当前这件活**的 requestId(过时的回执不落地、不覆盖新世界);
  `endWorldTask(requestId)` 只清自己的那一件 —— 被顶掉的活收尾不了接手的那件
- 界面:三处提交点登记任务并挂失败收尾;失败时 `endWorldTask` → `sessionFailed` →
  清 `progress` / `resim` / `terrainStatus.busy` / `regenRef`(界面解锁),**最后一份有效的世界和文明留着**
- `worldBusy` 从 `!!resim || terrainStatus.busy || !!progress` 换成 `session.task !== null`:
  算炸了 / 线程崩了任务会收尾,不会再像以前那样把助手面板一直锁着
- 冒烟里那条偶发断言改成按**四段各等一个明确状态**(不是"点击后 100 ms 采样"):
  ① 点击后面板藏起来(等 `.inspector.hidden`)② 重推期间"正在重新推演"的提示条确实出现过
  (页面内每 20 ms 看一次,不受来回通信采样影响)③ 推完面板回来(可操作)④ 结果与撤销都对。
  **没有放宽断言**:原来只验"某一刻藏着",现在验的是整条序列。

测试:`tests/world-session.test.ts` 15 → **24 个用例**(status 的派生、重推 vs 重新生成、
只有当前那件能收尾、被顶掉的不许覆盖新世界、失败的收尾与恢复、重复收尾不多做事、临时活不登记)。

## TASK-007C 重新验收第一阶段 + 第二阶段的护栏

按项目现有命令逐条跑(`scripts/fingerprint.ts` 的脚本名与参数按仓库当前定义:`--check docs/baseline-fingerprint.json`)。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ |
| `pnpm test` | ✅ **84 文件 / 1261 个用例**(第一阶段末 1242;007A +10、007B +9) |
| `pnpm build` | ✅ 6.15 s;index 1420.63 kB(gzip 560.67)、worker 300.44 kB |
| `pnpm stress` | ✅ 无 NaN,逐组无回归(见下表) |
| `pnpm smoke` | ✅ **功能全过**(只剩基线就有的那条拖动性能断言,见下) |
| `scripts/fingerprint.ts --check` | ✅ **21 组全部一致** |

### stress 首尾对照(第二阶段)

| 最慢的一组 | 基线 | 第一阶段末 | 第二阶段末 | 预算 |
| --- | --- | --- | --- | --- |
| 宜居度 + 划州(36k) | 108 ms | 101 ms | 104 ms | 60 ms |
| 道路(36k) | 183 ms | 175 ms | 169 ms | 150 ms |
| 生成 + 铺像素 + 文明(36k) | 2577 ms | 2469 ms | 2463 ms | 2000 ms |
| 推演 | 124.5 ms | 124.9 ms | 120.6 ms | 100 ms |
| 回放一帧(Node) | 121.4 ms | 112.8 ms | 146.3 ms | 30 ms |
| 国名、城名排版 | 36.1 ms | 37.6 ms | 35.5 ms | — |

「回放一帧」这一项在这三次数值里是 121 → 113 → 146,本机是软件渲染、这一项本身波动最大的
(数值和机器负载强相关),不作为回归判据;其余各项都在噪声范围里。

### 验收结论的三类(不许混着看)

| 类别 | 结论 | 依据 |
| --- | --- | --- |
| **功能断言** | ✅ 通过 | 最后一轮冒烟 `errors:` 里没有任何功能项;手机"结盟 + 撤销"3/3 次按元素命中并通过(见下) |
| **测试可靠性** | ✅ 通过(并修了两处) | 「迁都到这里」按四段序列验;手机点名牌真的按元素定位(3/3 命中);挑国家改成挨个试、挑不到就报错 |
| **性能预算** | ⚠️ **一条已知超标** | 拖动每帧 16.6 ms vs 预算 16 ms(基线 16.2 就超;软件渲染)—— **不算全绿**,登记为既有性能债(§8) |

**性能预算失败不算功能失败,也不算全绿** —— 上面这张表就是口径:功能与可靠性两类是绿的,
性能那一类明确标着一条已知超标。

### TASK-007D:点名牌的点击路径(可观测 + 连续 3 次)

审查指出:手机段那个名牌选择器是**拼接**出来的(`'...data-kind="' + '${tgt.kind}' + '"...'`),
`${tgt.kind}` 是字面文本、从未求值 —— 元素定位**永远落空**,每次都静默走坐标兜底,
于是"看起来稳定"其实是假的。已经改成真正插值的模板字符串,并把路径做成可观测:

- 先 `waitFor({ state: 'visible' })` 等名牌可点,再按元素 `click()`;
- 没命中才退回按坐标点,并把走的路记进 `tgtPath`(`element` / `fallback`);
- 日志里打出 `点名牌走的哪条路:…`;走兜底时**直接报错**(`手机:点名牌没有命中元素(走了…兜底;选择器 …)`)
  —— 兜底只是别让整段白跑,不许盖住"元素定位一直失败"。

连续 3 次的结果(临时探针,同一套交互:`选一个能结盟的国家 → 卡片拉满 → 干预 → 结盟 → 点名牌 → 撤销`):

```text
第 1 次:点名牌走 element | 通过 true | 兹拉季纳王国 → 「索拉尔汗国与兹拉季纳王国结盟,已从 2600 年起重新推演 撤销」/「已撤销,2600 年之后恢复原历史」
第 2 次:点名牌走 element | 通过 true | (同上)
第 3 次:点名牌走 element | 通过 true | (同上)
三轮里按元素命中:3/3;三轮都通过:true
```

完整冒烟跑也确认了同一件事:最后一轮的日志里是 `点名牌走的哪条路:element`,
`errors:` 里没有功能项(只剩拖动那条既有性能债,那一轮 26.4 ms —— 机器当时有别的负载)。

### 冒烟的分工:功能断言与性能断言

- **功能断言**:全部通过(最后一轮:整轮 ~20 分钟,`errors:` 里只有下面那一条性能断言)。第二阶段里:
  - 「迁都到这里」按**四段序列**验证(藏起来 → 重推中 → 推完回来 → 结果与撤销),不再依赖"点击后 100 ms"
    这个瞬间 —— 那条断言以前偶发失败(窗口 = 重推耗时 ≈ 300–400 ms,而采样要走两个来回),现在验的是整条序列;
  - 手机段的"结盟 + 撤销"整条流程通过(`点「兹拉季纳王国」→「…结盟,已从 2600 年起重新推演 撤销」`),
    点名牌改成按元素点以后不再偶发"点了没反应"。
- **性能断言**还剩一条在超:拖动每帧(预算 16 ms,本机 SW 渲染下 16.2 → 16.7 ms)。
  它在**基线**上就超(16.2 vs 16.0),属于**既有性能债**,与本次改动无关,建议独立处理
  (按机器区分预算,或改成测"文字层重排"这类与渲染后端无关的量)。本次**没有**动它。

### 手机段那两处偶发失败:查清了,是脚本的"点法",不是界面

第二轮验收时手机段连着两次报 `手机:点名牌后没有生效` / `手机:撤销后没有"已撤销"`。用页面内探针逐层查:

- **界面没坏**:干预页 6 条命令、"结盟"可点、提示条对、挑目标时卡片藏起来 —— 都正常;
  把"点那张名牌"从**按坐标点**换成**按元素点**(`.tp-layer .tp-plate[data-kind=…][data-id=…]`),
  重推立刻发生(`__wfResim.seq` = 2、线程里 244 ms),提示条「…结盟,已从 2600 年起重新推演 撤销」也对
  —— 手机结盟 + 撤销整条流程是通的。
- **问题在点法**:名牌是绝对定位 + 有进场动画,脚本原来用 `touchscreen.tap(x, y)`(合成触摸)按坐标点,
  详情卡片拉满时这一下会被别的手势吃掉,于是"点了没反应"。同一份探针在**改前的代码**上复现同样的失败
  —— 所以这不是本次改版带进来的,是那段脚本一直以来的脆弱点(以前靠运气过)。
- **处理**:那一步改成先按元素点(等名牌可见 / 稳定 / 可点),找不着才退回按坐标点。
  和审查 P1 的意见一致:等一个明确的状态或元素,而不是"按坐标 + 固定等待"。

### 一次被机器拖慢的冒烟(要和真回归分开看)

第二轮验收中间有一轮冒烟整轮从 ~19 分钟涨到 ~29 分钟,性能数字全变成 2–3 倍
(拖动每帧 41.8 ms、换投影重画 1297 ms),并多出两条"功能"失败。查下来当时
**Windows Defender 正在扫**(`MsMpEng` / `NisSrv` 占着 CPU),机器整体慢了 2.5 倍:

- `地球仪:拖时间轴时文明层没有跟着画` 判的是**帧数 ≥ 3**(脚本里本来就写着"慢的机器上一秒半拖不了几帧"),
  机器慢 → 固定窗口里凑不满 3 帧 → 误报;
- 手机那两条同样是慢机器下的观察超时。

同一份代码在机器空闲时重跑,这两类都不再出现(见下表)。**判断性能/超时类失败前,先看整轮耗时和机器负载。**

### 一个已定位的既有偶发失败(不是本次回归)

在第二阶段排查 `pnpm test` 偶发失败时,用 JSON 报告器抓到了一次具体结果:

```text
tests/names.test.ts › 地名生成器 生成 1000 个名字 < 100 毫秒(三次取最快)
  AssertionError: steppe 最快一次用了 124.6ms: expected 124.576 to be less than 100
```

- 这是**墙上时钟**断言:`const budget = process.env.CI ? 200 : 100`,三次取最快;
  机器有别的负载时(测试文件是并行跑的)就会超出。
- **与本次改动无关**:`git diff --stat 103afd3 HEAD -- tests/names.test.ts src/gen/names/` 是空的
  —— 这个测试文件和名字生成器,整个重构一行都没碰过。
- 复现率:同一份代码连跑 12 次,失败 1 次(那次超到 124.6 ms)。其余各次都过。
- 处理建议(留给你们定,本次**没有**改断言):按项目已有的做法给它也加一层 CI/负载放宽
  (它已经有 `CI ? 200 : 100`),或者把"快"这件事用与负载无关的量来验(迭代次数 / 分配次数),
  而不是墙上时钟。
