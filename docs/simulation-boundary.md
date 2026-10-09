# Simulation 边界清单(TASK-008A)

- 目的:在动代码之前,把现有文明推演的生命周期、调用点、所有权与不变量写成一份可审查的清单。
- 本步**只产出文档,不改任何源码**(`src/gen/civ/**` 一行未动)。
- 结论口径:下面的每条都标了 `file:line`,以源码实际结构为准。

---

## 1. 一句话现状

推演只有**一个主入口** `generateCiv(world, params?, progress?)`,它是**一个同步函数**:
在里面自己建 `CivSim`、按固定顺序装上各系统、`sim.run(...)` 推到 `endYear`、再把
`SimResult`(log / checkpoints / annals / 主人数组)和各模型的成品拼成 `Civ` 返回。
`CivSim` 是事件驱动的小引擎(二叉堆 + 结构数组的事件池),**不持有**各系统的模型 ——
模型放在各模块的模块级 `WeakMap<CivSim, Model>` 里。

所以"最小 façade"要包的,就是**这一个同步生命周期**,而不是重写里面的东西。

---

## 2. 调用关系(简图)

```text
generateCiv(world, params, progress)            src/gen/civ/index.ts:89
 │
 ├─ computeHabitat(world)                        habitat.ts:85
 ├─ viability(world, habitat)                    index.ts:59(本地)
 ├─ buildRegions(world, habitat, {regionArea})   regions.ts:70      (land===0 时走 emptyRegions)
 │
 ├─ new CivSim(R)                                sim.ts:266   ← 引擎在这里建
 ├─ planCultures(...)                            cultures.ts:389   (viable 才走)
 ├─ planPolities(...)                            polities.ts:541   (有 model 才走)
 ├─ scheduleInterventions(sim, seed, iv)         interventions.ts:243   ← 最先安排(同刻的干预事件排在前面)
 │
 ├─ install 顺序(固定,顺序可观察):              index.ts:114-121
 │    1 installCultures      cultures.ts:610
 │    2 installPolities      polities.ts:557
 │    3 installWars          wars.ts:240
 │    4 installPolitics      politics.ts:227
 │    5 installDynasty       dynasty.ts:138
 │    6 installAssimilation  assimilation.ts:182
 │    7 installCities        cities.ts:141
 │    8 installInterventions interventions.ts:262
 │
 ├─ sim.run(第一件地形大事之前 | endYear)        sim.ts:416   ← 唯一的时间推进方式
 │
 ├─ 地形大事循环(没有大事就整段跳过)           index.ts:130-162
 │    partialCiv → CivSim.fromCiv(分支) → branch.run(endYear) → pinNames
 │    → 每一件大事:reshapeRegions / upheavalImpact / CivSim.fromCiv(接着推) / s1.run(...)
 │
 ├─ sim.result()                                 sim.ts:439   → log / checkpoints / annals / culture / polity
 ├─ finishCultures / finishPolities              cultures.ts:812 / polities.ts:1028   ← 起名、配色
 ├─ buildRoutes / findPlaces / buildPeople       routes.ts:298 / places.ts:96 / people.ts:186
 ├─ buildReligion(world, civ)                    religion.ts:101   ← 最后一步,要用整个 civ
 └─ return Civ                                   index.ts:203
```

`CivSim` 自己(引擎,`src/gen/civ/sim.ts:266`):

```text
new CivSim(regionCount)       :266   建引擎:owners(两层)/ version / 事件池 / 堆
  .on(kind, handler, opts?)   :348   每种事件**只有一个** handler(后注册的覆盖先前的)
  .onChange(layer, fn)        :354   主人变化时的同步监听(按注册顺序触发)
  .schedule(t, kind, a, b)    :362   入堆;优先级 = tick*SEQ_SPAN + seq(先按时间,同刻按安排先后)
  .setOwner(layer, region, v, cause) :387   唯一的改主人入口:写 log、bump version、通知监听
  .record(kind, fields?)      :401   写一条编年史素材
  .run(untilYear)             :416   把堆里 ≤ untilYear 的事件一件件弹出处理(唯一推进方式)
  .result()                   :439   交回 log / checkpoints / annals / 主人数组(**都是拷贝**)
CivSim.fromCiv(world, civ, iv, first?) :317  从成品 Civ 重建引擎(恢复推演用;堆不序列化)
```

---

## 3. 生命周期(现有,façade 不许改)

| 阶段 | 在哪 | 说明 |
| --- | --- | --- |
| 创建 | `index.ts:106` `new CivSim(R)` | 生产路径上唯一的创建点;另有 `index.ts:135` / `:152` 用 `fromCiv` 建"分支推演"和"大事之后接着推" |
| 初始化 | `index.ts:113-121` | 先 `scheduleInterventions`,再按第 2 节的固定顺序 `install*` |
| 按年推进 | `index.ts:125` / `:136` / `:157` | 只经 `sim.run(untilYear)`;地形大事时先推到"大事前 1/256 年" |
| 应用干预 | 不在 run 之后单独做 | 干预在**开跑前**就 `schedule` 进堆(`interventions.ts:243`),由事件驱动生效 |
| 生成结果 | `sim.result()` `:439` + `finish*` | 结果拼进 `Civ`(见 §5) |
| 结束/丢弃 | 无 dispose | `CivSim` 是局部 `const`,靠 GC;模型留在 `WeakMap` 里随实例回收 |

**同一个 `CivSim` 实例的身份是有意义的**:各系统的模型挂在模块级
`WeakMap<CivSim, Model>` 上(`cultures.ts:599`、`polities.ts:549`、`wars.ts:229`、`politics.ts:216`、
`dynasty.ts:106`、`assimilation.ts:171`、`cities.ts:110`、`interventions.ts:231`)。
façade **不能**包一层新的引擎对象再转手 —— 那样 `install*` 写进 `WeakMap` 的键就变了,`resume*` 也找不到。

---

## 4. 事件与确定性(不许动的部分)

- **事件**:结构数组(`evT/evKind/evA/evB/evVer`)+ 二叉最小堆(`sim.ts:286-295`);
  优先级 `tick*SEQ_SPAN + seq`,`tick = round(t*256)`(1/256 年精度),`SEQ_SPAN = 2**28`。
  **同刻按"安排先后"**(全局递增 `seq`),而 `seq` 是在 install 与 handler 里分配的 ⇒ **install 顺序是承重的**。
- **过期事件**:`evVer >= 0 && version[a] !== evVer` 就丢弃(`sim.ts:431`)—— 用"改动计数"作废旧事件。
- **每类事件只有一个 handler**:`sim.on` 是覆盖式(`sim.ts:348`)。
- **随机数**:全部由种子派生,**没有 `Math.random`**(`src/gen/civ/**` grep 为空);
  主流是**无状态、按位置锚定**的 `keyed/keyed4`(`util.ts:44/53`),只有起名 / 旗 / 地名用
  有状态的 `mulberry32` 顺序流。流按标签切开:`subSeed(seed, 'civ-culture')`、`'civ-polity'`、
  `'civ-war'`、`'civ-names*'`、`'civ-places*'`、`'flag:*'` 等(清单见 `rand.ts` 与各模块)。
- **没有墙上时钟**:`src/gen/civ/**` 里没有 `Date.now` / `performance.now` / `new Date`;
  模块级也没有可变 `let`(只有 `const` 的 `WeakMap`/`Map`/`Set` 缓存,按实例/键记忆,不改结果)。

⇒ façade 只要**不改调用顺序、不改 `seq` 的分配次序、不新建引擎实例**,结果就逐字节不变。
这三条就是它的红线。

---

## 5. 输入 / 输出 / 错误 / 所有权

**输入**(`generateCiv` 的参数,`src/gen/civ/types.ts:573`):
`world`(只读)、`params: Partial<CivParams>`(九个字段都会被读到:`endYear` / `cultures` / `polities` /
`regionArea` / `pace` / `birthSpan` / `interventions` / `tempo` / `upheavals`)、
`progress?: (stage, pct) => void`。

**输出**:`Civ`(`types.ts:333`)。里面**大块数据**是类型化数组:
`habitat.*`、`regions.*`、`culture`/`polity`(Int16Array)、`log`、`checkpoints[].*`、
`routes[].cells`、`places[].path`、`religion.log/checkpoints`、`eras[].*`;
`civTransferables`(`index.ts:287`)会遍历深度 ≤ 4 收集 `ArrayBuffer`(worker 用它零拷贝回传)。

**错误行为**:`generateCiv` 与 `CivSim` **没有 try/catch、没有静默恢复、没有重试** ——
异常直接往上抛。今天唯一接住它的是 worker:`src/worker/worker.ts` 的 `pump()` 把异常变成一条
`{ type: 'error', requestId, error }` 回执(TASK-007A)。**façade 不改这个行为**:不吞异常、不自动重试。

**所有权 / 可变性**:
- `CivSim.owners[0]`、`owners[1]`、`version` 是**公开的类型化数组**,`readonly` 只锁绑定、不锁内容;
  `now` / `floor` / `processed` 是公开可变标量。只有 `setOwner` 应该改主人(它会同步写 log、bump version)。
- `result()` 交回的都是**拷贝**(`sim.ts:442-448`),所以成品 `Civ` 与引擎之后的状态无关。
- 系统模型不在 `CivSim` 里,而在模块级 `WeakMap`(见 §3)。

**调用顺序(承重,façade 只许照搬)**:
1. `scheduleInterventions` 必须在所有 `install*` **之前**(同刻的干预事件排在前面);
2. `install*` 顺序固定(§2);
3. `sim.run` 分几段:大事前 → 每件大事之后接着推(经 `fromCiv` + `floor` + `scheduleUpheaval`);
4. `result()` → `finishCultures`/`finishPolities`(起名、配色)→ 道路 / 地名 / 人物 → **最后** `buildReligion`。

---

## 6. 现有调用点(每个都列出 + 计划迁移到哪个 TASK)

**生产代码(只有两处,都在 worker)**

| 调用点 | 传什么 | 拿结果做什么 | 计划 |
| --- | --- | --- | --- |
| `src/worker/worker.ts:257`(`generate`) | `world` + `{ interventions?, tempo, upheavals? }` | 随 `done` 回执发回(带 `civTransferables`),再排队铺各段主图 | TASK-008C(第二步) |
| `src/worker/worker.ts:277`(`resim` / `trial`) | 同上 | `resim` 发 `civ` 回执、`trial` 发 `trial` 回执 | TASK-008C(第一步) |

**脚本(开发/验收工具)**

| 调用点 | 传什么 | 计划 |
| --- | --- | --- |
| `scripts/fingerprint.ts:143` | `generateCiv(w)` | **TASK-008C 的第一步候选**:它是 21 组指纹门自己,迁过去等于让门走 façade |
| `scripts/fingerprint.ts:148` | `generateCiv(w, { interventions })` | 同上 |
| `scripts/stress.ts:113` | `{ tempo }` + progress 回调 | TASK-008C(候选;简单,且压力测试会跑到) |
| `scripts/stress.ts:349` | `{ upheavals: steps }` | TASK-008C(候选) |
| `scripts/gen-stats.ts:122` | `generateCiv(w)` | TASK-008C(候选,最简) |
| `scripts/ai-names-demo.ts:13` | `generateCiv(w)` | 不急(演示脚本) |
| `scripts/replay-check.ts:1421`、`:2272` | `generateCiv(w)`(动态 import,拿州/编年史锚点) | 不急(冒烟自己) |

**测试(很多,`generateCiv(world)` 为主)**

`tests/` 下的调用点集中在这些文件(全部是"跑一遍拿结果来断言"):`determinism`、`regression-determinism`、
`regression-save-roundtrip`、`civ-sim`、`civ-cultures`(经 `civ-*` 系列)、`civ-upheaval`、`civ-tempo`、
`civ-interventions`、`civ-polities`、`civ-wars`、`civ-cities`、`civ-politics`、`civ-dynasty`、`civ-assimilation`、
`civ-people*`、`civ-religion`、`civ-regions`、`civ-routes`、`civ-chronicle`、`civ-detail`、`civ-labels`、
`names-stable`、`sketch`、`edits`、`marks`、`flags`、`export`、`timeline-layout`、`projection-labels`、
`sphere-labels`、`globe-labels`、`places-labels`、`ui-panels`、`ui-book-search`、`selection-outline`、
`labels-charset`、`characters`、`ai-*` 系列。
**计划:这一阶段不动**(它们是"旧入口"的对照基准,façade 要靠它们证明等价);等 008C 迁完生产调用点、
并且 façade 与旧入口逐字段一致之后,再决定要不要统一。

---

## 7. 其他入口,以及它们之间的**不一致**(先记录,不顺手统一)

今天跑推演的路不止一条,行为并不完全一致 —— 这是事实,façade 第一版**不**去统一它们:

1. **`generateCiv`(完整跑)**:从零建引擎,一路推到 `endYear`,产出成品 `Civ`。
2. **`CivSim.fromCiv` + `run`(接着跑)**:从成品 `Civ` 重建引擎再推进。**引擎内部状态(事件堆、
   事件池、`seq`、各系统模型)不序列化**,靠各模块的 `resume*` 重新登记 handler 并把将来的事件重新安排。
   `generateCiv` 自己也用它做"地形大事分支推演"和"大事之后接着推"(`index.ts:135`、`:152`)。
   ⇒ 与 1 的差别:重建后的 `seq` 从 0 开始,同刻事件的先后可能与一口气跑到底**不同**;
   今天靠 `civ-interventions` 里"切开推 = 一口气推"的测试守着。
3. **`planetTempo`(只标定)**:`index.ts:79`,跑到 `planCultures` 为止,`sim.run` 都不调,只为拿扩张节拍。
4. **地形大事里的多次 `fromCiv` + `run`**:每件大事后重推一次,`floor` 用来把新事件钉在"大事那一年之后"。

façade 第一版**只包 1**(完整跑),并把 2 留成独立入口(它需要 `fromCiv` 的语义,不能塞进同一个签名)。
3 与 4 保持原样。

---

## 8. façade 第一版的边界(依据以上盘点)

**包**:`generateCiv(world, params, progress)` 这一个同步生命周期 → 一个 `run(input)` 形态的入口,
内部**原样**调 `generateCiv` 并原样返回结果。

**不包 / 不做**:
- 不新建引擎对象、不复制 `Civ`、不引入第二份文明状态;
- 不动 `install*` 顺序、`scheduleInterventions` 的先后、`run` 的分段、`seq` 的分配;
- 不把 `CivSim` / `EventScheduler` / `EventStore` 的细节暴露给 UI;
- 不接 React / DOM / worker;
- 不加 try/catch、不加自动重试;
- 不在这一步把 §7 的四个入口统一。

**依赖方向**:`Simulation` 只依赖 `src/gen/**`(纯计算),不依赖 `src/ui`、`src/render`、`src/worker`。
`src/gen/civ/**` 今天也**确实**没有这些依赖(已核对:无 `src/ui` / `src/render` / `src/worker` / DOM / React 引用)。

---

## 9. 验收(本步)

- 本文件即"调用关系图 + 调用点清单 + 边界/所有权/顺序/错误说明"。
- **未修改** `src/gen/civ/**`、`SAVE_FORMAT`、`GENERATOR_VERSION`、任何算法;本步只加文档。
- 下一个门:审查这份边界清单 → 批准后再做 **TASK-008B(最小 façade)**。
"""
