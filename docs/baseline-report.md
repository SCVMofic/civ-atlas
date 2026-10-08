# 重构基线报告(baseline-report.md)

本文件是架构重构 RFC 的 **Phase 0 / TASK-001** 交付物:在动任何结构之前,把「现在的行为」钉下来。
之后每个重构 PR 都用这里的指纹和命令对账,证明「同种子还是同一个世界」「旧存档照样能读」。

> 原则:**Behavior Preservation First, Architecture Improvement Second.**

---

## 1. 环境(Environment)

| 项 | 值 |
| --- | --- |
| commit | `103afd3d998eac6750692a6813bf5aea03521448`(main,PR #55 之后) |
| 工作区 | 干净(仅 `.node-version`、`docs/` 未跟踪) |
| Node | v26.6.0(经 fnm;仓库根 `.node-version` = 26.6.0) |
| pnpm | 11.24.0 |
| 操作系统 | Windows 11(10.0.22631),x86_64,16 核 |
| 浏览器 | Playwright Chromium 1243(headless shell) |
| GPU | SwiftShader(软件渲染:`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`) |
| 时区/语言 | 本机默认;测试均为纯计算,不依赖时区 |

浏览器是**软件渲染**,所以本机的画面耗时(冒烟里的每帧预算)比有 GPU 的机器慢,也比 CI 的虚拟机更不稳定 —— 判读性能数字时以这一点为前提。

---

## 2. 命令与结果(Test Result)

| 命令 | 结果 | 耗时 | 备注 |
| --- | --- | --- | --- |
| `pnpm typecheck` | ✅ 通过 | ~10 s | `tsc --noEmit`,无输出 |
| `pnpm test` | ✅ **80 个文件 / 1181 个用例全过** | 92.5 s | `vitest run` |
| `pnpm build` | ✅ 通过 | 6.59 s | `tsc --noEmit && vite build` |
| `pnpm stress` | ✅ 通过(无 NaN) | ~3 min | 极端参数 + 改地形 + 草图 + 地形大事 |
| `pnpm smoke` | ⚠️ **功能全过,1 条性能断言临界** | ~13 min | 见 §4 |
| `npx tsx scripts/fingerprint.ts --save docs/baseline-fingerprint.json` | ✅ 21 组已存 | 43 s | 见 §5 |

### 产物体积(build)

```text
dist/index.html                    0.69 kB │ gzip:   0.48 kB
dist/assets/gullyWorker-*.js       3.11 kB
dist/assets/tileWorker-*.js       62.06 kB
dist/assets/globeWorker-*.js      95.20 kB
dist/assets/exportWorker-*.js    203.48 kB
dist/assets/worker-*.js          300.05 kB
dist/assets/index-*.css          171.12 kB │ gzip:  31.77 kB
dist/assets/index-*.js         1,415.39 kB │ gzip: 558.59 kB
```

`index-*.js` 超过 vite 默认 500 kB 警告线 —— 基线如此,重构不应把它顶上去;若拆分 App.tsx 后反而变小,记在 PR 里。

---

## 3. 性能基准(Benchmark)

### 3.1 `scripts/stress.ts` 汇总(本机,Node)

**默认精细度(36k 地块):**

| 量 | 本机最慢 | 脚本内预算 | 判定 |
| --- | --- | --- | --- |
| 宜居度 + 划州 | 108 ms | 60 ms | ⚠️ 超 |
| 道路 | 183 ms | 150 ms | ⚠️ 超 |
| 生成 + 铺像素 + 文明 | 2577 ms | 2000 ms | ⚠️ 超 |

**全部参数组:**

| 量 | 本机最慢 | 预算 | 判定 |
| --- | --- | --- | --- |
| 推演(民族 + 城镇 + 国家 + 战争 + 分合 + 王朝 + 同化迁徙 + 城市兴衰) | 124.5 ms | 100 ms | ⚠️ 超 |
| 回放一帧(归属 + 国界 + 半分辨率色块,Node 里) | 121.4 ms | 30 ms | ⚠️ 超 |
| 国名、城名、城镇符号排版 + 避让(缩放 1 倍) | 36.1 ms | — | 记录 |

这些预算是**提示性**的:`scripts/stress.ts` 只在出现 NaN / 非确定性时置 `process.exitCode = 1`(见其 :299、:385)。
也就是**基线本身就已经超出脚本预算**,与本次重构无关;重构时只要求「不显著变慢」,不要求达标。

分组耗时明细(便于以后逐阶段比较):

| 组 | 生成 | 铺像素 | 文明 |
| --- | --- | --- | --- |
| 默认 36k(seed 3) | 718 ms | 1201 ms | 348 ms |
| 陆地 12% | 635 ms | 700 ms | 173 ms |
| 陆地 60% | 754 ms | 1441 ms | 382 ms |
| 200k 地块 | 3693 ms | 1147 ms | 718 ms |
| 12k 地块 | 210 ms | 1075 ms | 122 ms |
| 改地形大杂烩 19 处 | 1015 ms | 1426 ms | 327 ms |
| 地形大事(五件火山,5 段) | 2997 ms(各段地形合计) | — | 739 ms |

### 3.2 内存(peak memory)

未单独测量。Node 里的 `stress` / `fingerprint` 逐组串行、每组算完即弃,进程峰值不作为长期指标;
200k 地块是当前上限(RFC §27),后续 benchmark 目录(`bench/`)建立时再补 `--expose-gc` + `process.memoryUsage()` 采样。

---

## 4. 冒烟检查(smoke)

`npx tsx scripts/replay-check.ts` 用 Playwright 打开真实 dev server,逐项点过界面骨架、回放、悬停、点选改名、
存档读档分享、导出、干预、改地形、AI、快捷键、人物、标记、信仰、投影、地球仪、手机布局等。

**结论:功能项全部通过。** 唯一一条失败是性能断言:

```text
errors: [ '东西相连:拖动每帧太慢(中位数 16.2 ms,预算 16 ms)' ]
```

- 位置:`scripts/replay-check.ts:3622`(`PAN_BUDGET = process.env.CI ? 40 : 16`),阈值就是 60 帧/秒的一帧;
- 本机实测 16.2 ms —— 超 0.2 ms,属临界噪声(SwiftShader 软件渲染);
- 用 `CI=1 pnpm smoke`(预算放宽到 40 ms)可复现「零错误」,后续判定以「错误集合与基线相同」为准。

**另注(非功能问题):** 脚本跑完 `process.exit(1)` 时,Node 26 在 Windows 上会打印
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` 并以 `3221226505` 结束。
这是退出期的 libuv 断言,发生在所有检查之后,与应用行为无关;判读时看 `errors:` 那一行。

---

## 5. 确定性指纹(Determinism)

### 5.1 仓库既有的确定性测试

- `tests/determinism.test.ts`:`seed 2024` / `seed 7`(12k 地块)的**地形 + 文明全部数据**逐字段指纹,钉在代码里。
  测试文件头写明:CI(x64 Linux)和本地(Apple 芯片 macOS)都要过 —— 超越函数一律舍入到 24 位(`gen/civ/rand.ts` 的 `round24`)。
  期望值按 `GENERATOR_VERSION = 9` 算。**基线:通过。**
- 各子系统另有各自的确定性用例,如 `tests/terrain-edits.test.ts:99`(改地形两次生成逐字节相同)、
  `tests/civ-interventions.test.ts`(同样干预两次推演逐字节相同)、`tests/civ-labels.test.ts`(同样视口排版一样)。

### 5.2 本次新增的全量指纹快照

`docs/baseline-fingerprint.json` —— **21 组**用例 × 每组 54–57 个字段(16 位十六进制 SHA-1)。

覆盖维度:

| 维度 | 组 |
| --- | --- |
| 种子 | 1 / 7 / 42 / 2024 |
| 精细度 | 12k / 20k / 36k(默认)/ 50k / 80k |
| 陆地比例 | 12% / 33%(默认)/ 45% / 60% |
| 板块数 | 5 / 30(默认)/ 60 |
| 气候 | 冷 −12 / 热 +12 / 少雨 0.4 / 山 ×2 / 山 ×0.2 |
| 地形修改 | 大杂烩 19 处 / 整片沉成海 6 处 / 整片抬成陆地 6 处 / 普通 5 处 |
| 干预 | 宣战 + 保护 + 迁都 + 立国 + 停战(按稳定键挑,确定性) |
| 回放帧 | seed 7、seed 2024、seed 17、seed 43(4 组另算 `buildHistoryFrames`) |

每个用例的字段构成:`world.*`(地形、气候、河流、生物群系、网格、板块、火山……)、
`civ.*`(州、民族、国家、城镇、人物、信仰、道路、编年史素材、检查点……)、`chronicle`(编年史成品)、
`raster.*`(铺好的像素)、`interventions`(挑出来的干预列表)、`frames`(回放帧)。

### 5.3 怎么用它守行为

```bash
# 基线(已存于本仓库)
npx tsx scripts/fingerprint.ts --save docs/baseline-fingerprint.json

# 重构后逐字段对账,有差异退出码 1
npx tsx scripts/fingerprint.ts --check docs/baseline-fingerprint.json
```

**判据:纯重构必须 `全部一致`。** 任何一格不一致,都说明这次改动动了世界生成或推演的数值路径,
要么改回来,要么按 RFC §33 第 3 条 bump `GENERATOR_VERSION` 并说明理由。

> 基线自检:存完之后立刻对账过一遍,`共 21 组,44 秒,全部一致`(退出码 0)—— 这份快照可用作门禁。

---

## 6. 存档兼容(Save Compatibility)

- `SAVE_FORMAT = 1`、`GENERATOR_VERSION = 9`(基线值)。
- 现有覆盖:`tests/savefile.test.ts`(89 个用例)含 `makeSave → JSON → parseSave 不变`、
  坏文件/别的版本/超范围参数的降级与提示、`worldCheck` 确定性、稳定键(州/城/信仰)往返、
  浏览器存储(saveStore)的增删改查与撤销、以及从 v4 老存档重新生成的用例(`tests/savefile.test.ts:996`)。
- **已知缺口(本次要补,见 TASK-006):** 没有任何一个用例走完**完整一圈**
  —— `generateWorld(带地形 + 草图)` → `makeSave` → `saveText` → `parseSave` → 按存档参数**重新生成** → 比对世界指纹。
  最接近的是 `tests/savefile.test.ts:996`,但它用 v4 手写存档、不带草图、且因为生成器版本不同而比对不出哈希(`checkWarning` 返回 null)。
- 基线判定:**现有存档格式不动**;重构不得改变 `SAVE_FORMAT` 的含义,需要改字段时必须加 version + migration + 测试(RFC §33 第 4 条)。

---

## 7. 结构基线(重构对象)

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `src/ui/App.tsx` | **3596** | 世界生命周期、生成、worker 编排、存档、URL/分享、时间轴、地图交互、编辑、AI、投影、选中、地形大事、人物、标记、UI 状态 |
| `src/worker.ts` | 345 | worker 协议 + 生成/推演编排(消息按 `type` + `id` 隐式关联) |
| `src/render/fantasy.ts` | 3960 | 幻想风渲染 |
| `src/gen/civ/chronicle.ts` | 1941 | 编年史 |
| `src/gen/geometry.ts` | 1578 | 球面几何 |
| `src/ui/Globe.tsx` | 1778 | 地球仪 |

`src/` 共 **245** 个 ts/tsx 文件、5.0 MB。

**worker 协议现状(基线):** `WorkerRequest` / `WorkerResponse` 是 `type` 判别联合,
请求用 **`id: number`(每换一个世界加一)** 关联回包,另有 `seq`(重推第几次)、`tid`(试推演)、
`pid`(地形大事预览)三个额外序号。**没有 requestId 字符串、没有统一的取消语义**;
取消靠「主线程 `terminate()` 再开一个新线程」,而 `progress` / `eraPatch` 不计数(`busyRef` 只在别的回包上减)。
→ 这正是 RFC §5/§6 要改的地方(TASK-004)。

---

## 8. 后续每个 PR 的对账清单(RFC §44 落地)

对每个重构 PR 逐项回答:

- **Behavior** 是否改变现有行为?→ 用 `pnpm smoke`(错误集合与基线一致)+ `pnpm test` 判定
- **Determinism** 同 seed 是否仍然相同?→ `npx tsx scripts/fingerprint.ts --check docs/baseline-fingerprint.json` 必须 `全部一致`
- **Persistence** 旧 save 是否仍可读取?→ `pnpm test -- tests/savefile.test.ts tests/share.test.ts` + 新增的完整往返用例
- **Performance** 是否增加明显 runtime/memory?→ 对着 §3 的表格逐组比,不要求达标、要求不显著变慢
- **API** 是否引入新的隐式耦合?→ PR 里写清楚新模块的依赖方向
- **Tests** 是否添加了对应 regression test?→ 每个阶段至少一条

**Definition of Done 的完整清单见 RFC §45。**
