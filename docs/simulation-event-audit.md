# 事件语义与状态写入审计(TASK-010A)

- 施工基点:`023d3cb`(开工前已确认 `HEAD == 023d3cb`,分支没有新提交)。
- 本步**只读审计,未改任何源码**。
- 口径:每条结论都标 `file:line` + 所在函数;**不按函数名推断语义**,下面引的都是实际代码;
  凡未证实的都写了"未证实"。

---

## 1. 一句话结论

`CivSim` 是一个**单线程、同步、事件驱动**的小引擎:事件堆按「量化时刻 + 预约序号」排序,
同一刻严格按**预约先后**(`seq`)处理;每类事件**只有一个** handler(`on` 覆盖式);
归属只有**一个**写入入口 `setOwner`(写日志、版本 +1、同步通知监听者);
`run(untilYear)` 是**唯一**的时间推进方式。系统模型不在引擎里,而在各模块的
`WeakMap<CivSim, Model>` 上 —— **实例身份是有意义的**。

---

## 2. 引擎的状态与写入点

`src/gen/civ/sim.ts:266` `class CivSim`。

| 字段 | 声明 | 合法写入点 | 读取(影响行为) | 旁路 |
| --- | --- | --- | --- | --- |
| `R` | `sim.ts:268` | 构造器 `sim.ts:305` | `schedule` `sim.ts:377`(判 `a` 合法) | 无(`readonly`) |
| `now` | `sim.ts:270` | `run` `sim.ts:424`、`sim.ts:435`;`fromCiv` `sim.ts:325` | `schedule` 钳制 `sim.ts:364`、`setOwner` 日志年份 `sim.ts:393`、`record` 年份 `sim.ts:403`、`result` `sim.ts:441` | **无**(全仓外部只有读) |
| `floor` | `sim.ts:275` | **`src/gen/civ/index.ts:153`**(`s.floor = u.year`,在 `fromCiv` 的 `first` 回调里) | `schedule` 钳制 `sim.ts:364` | **唯一的"外部直接写引擎字段"**,但由注释 `sim.ts:271-275` 明确授权(地形大事接着推用) |
| `owners` | `sim.ts:277` | `setOwner` `sim.ts:391`(运行期唯一);构造器 `sim.ts:306`、`fromCiv` `sim.ts:319-320`(工厂重建 `.set`) | `result` `sim.ts:444-445`、`checkpoint` `sim.ts:453-454`;各系统只读索引 | **运行期无旁路**(全仓 grep `.owners[` 无元素写入) |
| `version` | `sim.ts:279` | `setOwner` `sim.ts:392`;构造器 `sim.ts:307`、`fromCiv` `sim.ts:323`(按日志逐条 `++`) | `schedule` `sim.ts:377`、`run` 过期判定 `sim.ts:431` | 无(全仓仅这 4 处 `version[`) |
| `processed` | `sim.ts:302` | `run` `sim.ts:430` | **全仓无任何读取** | 无 |
| `log` | `sim.ts:281`(private) | `setOwner` `sim.ts:393`;`fromCiv` `sim.ts:321` | `result` `sim.ts:442` | 无(private) |
| `annals` | `sim.ts:282`(private) | `record` `sim.ts:412`;`fromCiv` `sim.ts:322` | `result` `sim.ts:446` | 无(private) |
| `checkpoints` | `sim.ts:283`(private) | `checkpoint` `sim.ts:451`;`fromCiv` `sim.ts:324` | `result` `sim.ts:443` | 无(private) |
| `nextCheckpoint` | `sim.ts:284`(private) | `checkpoint` `sim.ts:456`;`fromCiv` `sim.ts:328` | `run` `sim.ts:423`/`sim.ts:434`、`checkpoint` `sim.ts:452` | 无(private) |
| `heap` / `evT`/`evKind`/`evA`/`evB`/`evVer` / `evCount` / `free` / `seq` | `sim.ts:287-295`(private) | `schedule` `sim.ts:368-378`、`run` `sim.ts:421`/`sim.ts:429`、`growEvents` `sim.ts:459-476` | `schedule`/`run`/`get pending` | 无(private) |
| `handlers` | `sim.ts:297`(private) | `on` `sim.ts:349` | `run` 分发 `sim.ts:432` | 无(private) |
| `watch` | `sim.ts:298`(private) | 构造器 `sim.ts:308`(读 `EVENT_INFO`)、`on` `sim.ts:350`(仅当显式传 `opts.watch`) | `schedule` `sim.ts:377` | 无 |
| `listeners` | `sim.ts:299`(private) | `onChange` `sim.ts:355`(**追加**,不是覆盖) | `setOwner` 同步通知 `sim.ts:394` | 无 |

**分类小结**

- **合法写入路径**:`setOwner`(运行期改归属的唯一入口)、`record`(只写 annals)、`on`/`onChange`(注册)、
  `schedule`(唯一入堆)、`run`(推进 `now` / `processed` / 检查点)、`fromCiv`(受控重建)。
- **潜在旁路**:只有 `index.ts:153` 的 `s.floor = u.year` 一处是"外部直接写字段";
  它是文档授权的设计用法,但**没有方法封装** —— 记为「可接受的公开可变字段」,不是缺陷。
- **未证实**:`processed` 注释说"调参 / 测试用",但当前代码库**没有任何读者**;它的值不影响任何行为。

---

## 3. 事件类型表

`Ev` 枚举 `sim.ts:40-136`;**取值不是连续的 0..35**,实际是 `0..15`、`20..23`、`25..26`、`30..33`
(缺 `16-19`、`24`、`27-29`、`34-35`)。`EVENT_INFO` `sim.ts:146-173` 每个取值一行。
**`watch: true` 只有两个**:`CultureArrive`(2)与 `PolityArrive`(5)—— 只有它们参与"过期"判定。

"install 路径" = `generateCiv` 里可达(`index.ts:113-121` + 大事分支 `index.ts:156`);
"resume 路径" = `CivSim.fromCiv` 里可达(`sim.ts:334-342`)。

| Ev | 名字 | watch | 谁安排(file:line,函数) | 谁处理(`sim.on`,file:line) | setOwner(层) | `record` 种类 | 模型改动 | 写日志/史事 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 `None` | 无 | false | 从不安排 | 无 | — | — | — | —(只当 cause) |
| 1 `CultureBorn` | 民族诞生 | false | `cultures.ts:647` install / `:680` resume | `cultures.ts:642` | Culture `:645` | — | — | 日志 ✓ / 史事 ✗ |
| 2 `CultureArrive` | 民族到达 | **true** | `cultures.ts:622`(spread)/ `:714` resume | `cultures.ts:629` | Culture `:640` | — | `passed` `:635` | 日志 ✓ / 史事 ✗ |
| 3 `SettlementFound` | 建城 | false | `polities.ts:570`(onChange Culture)/ `:867` resume | `polities.ts:602` | — | — | `settlements`/`stag`/`cityOf`(经 `foundCity` `:677-679`),并安排 `PolityFound` `:681` | ✗ / ✗ |
| 4 `PolityFound` | 立国 | false | `polities.ts:681`(foundCity)/ `politics.ts:670`(TribalCheck)/ `:874` resume | `polities.ts:607` | Polity `:612` | `found` `:613` | `addPolity` `:746` | ✓ / ✓ |
| 5 `PolityArrive` | 国家到达 | **true** | `polities.ts:578`(onChange Culture)/ `:646`(spreadFrom)/ `:944` resume | `polities.ts:616` | Polity `:622` | — | `size`/`lands`/`met`(经 onChange `:583-600`),安排 `PolityRank` `:591` | ✓ / ✗ |
| 6 `PolityRank` | 升格 | false | `polities.ts:591`(onChange Polity) | `polities.ts:625` | — | `rank` `:632` | `tier` `:629`、`titles` `:630` | ✗ / ✓ |
| 7 `WarCheck` | 看邻国 | false | `wars.ts:252`(onChange Polity)/ `:514`(自续)/ `:649` resume | `wars.ts:511` | — | `war`(经 `declare` `:494`) | `wars`/`active` `:492-493` | ✗ / ✓ |
| 8 `Campaign` | 战役 | false | `wars.ts:495`(declare)/ `:603`(自续)/ `:659` resume | `wars.ts:571` | **Polity** `:431`/`:476`(cause=9 攻占) | `battle`/`conquer`/`fall`/`capital`/`peace` `:581,587,433,477,419,454,413` | `War.takes`、`wm.active/rest/truce`、`moveCapital`/`endPolity`、经 `onAssault` 动城市 | ✓ / ✓ |
| 9 `Conquer` | 攻占 | false | **从不安排** | 无 | Polity `wars.ts:431,476` | `conquer` `:433,477` | `War.takes.push` | ✓ / ✓(只当 cause) |
| 10 `PoliticsCheck` | 看内政 | false | `politics.ts:249`(onChange Polity)/ `:570`(自续)/ `:697` resume | `politics.ts:567` | Polity(经 `secede` `:347-348` cause=11、`tryMerge` `:471` cause=12) | `split`/`merge`/`capital` `:349,474,563` | `addPolity`/`endPolity`/`lastSplit`/`merged` | ✓ / ✓ |
| 11 `Split` | 分裂 | false | **从不安排** | 无 | Polity `politics.ts:347-348` | `split` `:349` | `addPolity`、`lastSplit` | ✓ / ✓(只当 cause) |
| 12 `Merge` | 合并 | false | **从不安排** | 无 | Polity `politics.ts:471` | `merge` `:474` | `endPolity` `:472`、`merged` | ✓ / ✓(只当 cause) |
| 13 `RestoreCheck` | 看复国 | false | `politics.ts:252`(onChange)/ `:659`(自续)/ `:701` resume | `politics.ts:655` | Polity(经 `secede`) | `split` `:349` | `addPolity`、`restored` `:651` | ✓ / ✓ |
| 14 `TribalCheck` | 看部落地带 | false | `politics.ts:232`(install)/ `:664`(自续)/ `:706` resume | `politics.ts:663` | — | — | 只安排 `PolityFound` `:670` | ✗ / ✗ |
| 15 `DynastyCheck` | 看王朝 | false | `dynasty.ts:155`(onChange)/ `:236`(自续)/ `:280` resume | `dynasty.ts:233` | — | `dynasty` `:261` | `dynasties` `:259-260`、`moveCapital` `:256` | ✗ / ✓ |
| 20 `CultureCheck` | 看民族 | false | `assimilation.ts:209`(onChange)/ `:411`(自续)/ `:502` resume | `assimilation.ts:408` | **Culture** `:219`(cause 21/22) | `assimilate`/`migrate`/`vanish` `:220,223` | `since`/`count`、`cultures[].ended`/`migrations` | ✓ / ✓ |
| 21 `Assimilate` | 同化 | false | **从不安排** | 无 | Culture `assimilation.ts:219` | `assimilate` `:220` | `cultures[].ended` `:222` | ✓ / ✓(只当 cause) |
| 22 `Migrate` | 迁徙 | false | **从不安排** | 无 | Culture `assimilation.ts:219` | `migrate` `:220` | `migrations.push` `:244` | ✓ / ✓(只当 cause) |
| 23 `EnclaveCheck` | 看孤地 | false | `assimilation.ts:188`(install)/ `:442`(自续)/ `:506` resume | `assimilation.ts:441` | Culture `:219`(cause 21) | 同 20 | 同 20 | ✓ / ✓ |
| 25 `CityRebuild` | 看重建 | false | `cities.ts:169`(onAssault)/ `:189`(自续)/ `:225`(scheduleRebuild)/ `:254` resume | `cities.ts:183` | — | `rebuild` `:197` | 经 `foundCity` 动城市/安排 `PolityFound` | ✗ / ✓ |
| 26 `CityDecline` | 看旧都 | false | `cities.ts:205`(onCapitalLost 回调)/ `:262` resume | `cities.ts:207` | — | `decline` `:215` | — | ✗ / ✓ |
| 30 `Intervene` | 干预 | false | `interventions.ts:256`(scheduleInterventions) | `interventions.ts:384` | Polity `:308,323`(cause 31)、`:359`(cause 4)、`:363`(cause 31) | `intervene`/`found`/`capital`/`fall` | `addPolity`/`foundCity`/`endPolity`/`moveCapital`/`makePeace`/`declare` | ✓ / ✓ |
| 31 `Cede` | 划州 | false | **从不安排** | 无 | Polity `interventions.ts:308,323,363` | `intervene` | `moveCapital`/`endPolity` | ✓ / ✓(只当 cause) |
| 32 `HaltEnd` | 解除禁扩 | false | `interventions.ts:253`(scheduleInterventions) | `interventions.ts:423` | — | — | `respread`→`spreadFrom` 安排 `PolityArrive` | ✗ / ✗ |
| 33 `Upheaval` | 地形大事 | false | `upheaval.ts:351`(scheduleUpheaval,由 `index.ts:154` 的 `first` 回调调) | `upheaval.ts:363`(installUpheaval,`index.ts:156`,**在 `fromCiv` 之后**) | Polity `:416,427` + Culture `:418` | `upheaval`/`sunk`/`fall`/`capital` | `Settlement.ended`、`cityOf`、`endPolity`、`moveCapital`、`scheduleRebuild`、`makePeace`、`fact.*` | ✓ / ✓ |

**只当 cause、没有 handler 的 7 个**:`None`(0)、`Conquer`(9)、`Split`(11)、`Merge`(12)、
`Assimilate`(21)、`Migrate`(22)、`Cede`(31)—— 它们只作为 `setOwner(..., cause)` 的参数,
写进 ChangeLog 的 cause 字节。

---

## 4. 排序、过期、注册的确切语义(逐条引代码)

### 4.1 同一刻的排序

```ts
// sim.ts:364,378
const tick = Math.round(Math.max(t, this.now, this.floor) * TICKS_PER_YEAR);
this.heap.push(id, tick * SEQ_SPAN + this.seq++);
```

- `TICKS_PER_YEAR = 256`(`sim.ts:179`)、`SEQ_SPAN = 2**28`(`sim.ts:181`)、`MAX_TICK = 2**24`(`sim.ts:183`)。
- 主键 = 量化到 1/256 年的时刻;次键 = **全局预约序号 `seq`**(每次 `schedule` 自增)。
  因此**同一刻按"谁先预约"处理**;`seq` 永不重复,优先级唯一,堆不需要额外 tie-break。
- 钳制:`Math.max(t, now, floor)` —— **"预约到过去"会落在当前这一刻**,并因为拿到更大的 `seq`
  排在**同一刻已排队的那些之后**(这条对干预 / 大事的"当年生效"很关键)。
- 丢弃:`!(t < Infinity)` 挡掉 `+Infinity`/`NaN`;`tick >= MAX_TICK`(65536 年)丢弃。
  注意 `-Infinity` 能通过第一关,但随后被 `Math.max` 抬到 `now`/`floor`。
- 溢出:`seq >= SEQ_SPAN` 抛 `CivSim:事件太多(超过 2^28 个)`(`sim.ts:366`)。

### 4.2 过期(作废)规则

```ts
// sim.ts:377 预约时
this.evVer[id] = this.watch[kind] && a >= 0 && a < this.R ? this.version[a] : -1;
// sim.ts:431 弹出时
if (ver >= 0 && this.version[a] !== ver) continue; // 过期
```

- 只有 **`watch` 为真且 `a` 合法**的事件记版本号;`ver >= 0` 是门槛,所以 `ver = -1` 的事件**永不判过期**。
- 全仓 `on(...)` 调用**没有一处**传 `opts.watch`(`sim.ts:350` 的覆写分支实际未使用)⇒
  运行期 `watch` 表完全由 `EVENT_INFO` 决定 ⇒ **只有 `CultureArrive` 与 `PolityArrive` 会过期**。
- 被判定过期的事件仍然 `free.push(id)` + `processed++`(`sim.ts:429-430`),只是不调 handler。

### 4.3 注册语义

- `on`(`sim.ts:348-351`):**覆盖式** —— `handlers[kind] = handler`,同一类只有一个 handler,
  **后注册的静默覆盖先前的**,没有守卫、不报错。当前代码库里**每类只有一个注册点**,所以还没触发过覆盖。
- `onChange`(`sim.ts:354-356`):**追加式** —— `listeners[layer].push(fn)`,可以有多个;
  `setOwner` 里按**注册顺序**同步调用(`sim.ts:394`)。

### 4.4 `setOwner` / `record` / `run` / `checkpoint`

```ts
// setOwner sim.ts:387-395
const prev = own[region];
if (prev === value) return;      // 新值 = 旧值:什么都不做(不写 owners/version/日志,不通知)
own[region] = value;
this.version[region]++;
this.log.push(this.now, region, layer, value, cause);
for (const fn of this.listeners[layer]) fn(region, value, prev, cause);   // 同步
```

- `record`(`sim.ts:401-413`):`year = this.now`;未给字段一律 `-1`;`via` 只在显式提供时带上;只追加 `annals`。
- `run`(`sim.ts:416-436`):`untilTick = Math.floor(untilYear*256 + 1e-9)`,`limit = (untilTick+1)*SEQ_SPAN`,
  弹堆条件是 `heap.pri[0] < limit` ⇒ **恰好落在 `untilYear` 的事件会被处理**(含这一年);
  每个事件处理前补检查点(`while nextCheckpoint <= untilYear && t > nextCheckpoint`),收尾再补齐;
  `now` 只前进(`if (t > this.now)`,末尾 `if (untilYear > this.now)`);`processed` 每个弹出事件 +1。
- `checkpoint`(`sim.ts:450-457`):以 `nextCheckpoint` 为年份快照两层 `owners`(`.slice()` 副本),
  然后 `nextCheckpoint += 100`。`fromCiv` 把 `nextCheckpoint` 设为"最后一个检查点 + 100"(`sim.ts:328`)。

---

## 5. `CivSim.fromCiv`:恢复路径与"完整生成"的差异

`fromCiv`(`sim.ts:317-345`)重建:`owners`(`.set`)、`log`、`annals`(浅拷贝)、
`version`(**按 `civ.log` 逐条 `++`**,不是存下来的计数)、`checkpoints`、`now = civ.endYear`、
`nextCheckpoint`;然后 `first?.(sim)` → `scheduleInterventions(..., resume=true)` →
`resumeCultures` → `resumePolities` → `resumeWars` → `resumePolitics` → `resumeDynasty` →
`resumeAssimilation` → `resumeCities` → `resumeInterventions`。

**恢复顺序与 `generateCiv` 的 install 顺序完全一致**(`index.ts:113-121`);每个 `resumeX`
要么直接调 `installX`、要么走共享的 `hook`,所以**注册的 handler / listener 集合与完整生成完全相同**。

**没有恢复的东西**:`floor`(留在 `-Infinity`,除非 `first` 设它)、`seq`(**从 0 重来**)、
`processed`(0)、事件堆(空的)。

### 5.1 唯一的结构性差异:`seq` 重来 ⇒ 同刻跨系统顺序可能与一口气跑不同

一口气跑时,`seq` 反映**真实预约的先后**(handler 链里各系统互相交错);
恢复时,只剩 `resume*` 重新安排的那些事件,顺序被**固定的 resume 顺序**决定:

```text
first(地形大事) < 干预(HaltEnd 全部 < Intervene 全部) < 民族 < 城镇/国家(建城 < 立国 < 到达)
                < 战争 < 内政 < 王朝 < 同化 < 城市
```

**具体例子(跨系统)**:A 国 0 年立国、B 国 200 年立国,都活到切开点。
`Ev.PoliticsCheck` 落在 `立国年 + POL_FIRST + POL_EVERY*(k+0.2..0.8)`(`politics.ts:59-60`、`:198`),
`Ev.WarCheck` 落在 `立国年 + CHECK_FIRST + CHECK_EVERY*(j+0.2..0.8)`(`wars.ts:60-61`、`:187`);
取 `k`/`j` 让两者量化到同一 tick(例如 260 年前后):一口气跑时,谁的那一次**预约得更早**谁先;
恢复时 `resumeWars`(`wars.ts:649`)排在 `resumePolitics`(`politics.ts:697`)**之前**,
于是 **WarCheck 一定先**。同刻先后被换掉。

**同系统内的例子**:`resumePolities` 先安排**全部** `SettlementFound`(`polities.ts:867`)、
再安排**全部** `PolityArrive`(`polities.ts:944`);一口气跑时,100 年由扩张排的 `PolityArrive`
(`polities.ts:646`)可能早于 110 年由建城排的 `SettlementFound`(`polities.ts:570`),
只要两者量化到同一 tick 就会反过来。`resumeCities` 同理(`CityRebuild` 全部先于 `CityDecline`)。

**为什么现有测试仍然逐字节过**:要撞上"反转",需要两个各自带抖动的时刻**量化到同一个 1/256 年**;
撞上时两个事件通常落在不相干的州上、最终状态一样,**但日志 / 史事的先后会不同** ——
现有测试只采样了一部分种子与切点(`civ-sim.test.ts:231`、`civ-wars.test.ts:77`、
`civ-politics.test.ts:71`、`civ-assimilation.test.ts:79`、`civ-cities.test.ts:118`、
`civ-dynasty.test.ts:85`、`civ-polities.test.ts:195`、`civ-interventions.test.ts:395,734`)。
代码里唯一显式处理过同刻顺序无关的地方是 `polities.ts:281-287`(`distFor`,迁都与扩张谁先谁后都一样)。

另外 `floor` 的不对称:大事分支里 `Ev.Upheaval` 拿到 `seq = 0`(`index.ts:154`),
于是它排在**同刻的干预之前**;非大事路径里 `scheduleInterventions` 永远最先。
这是大事分支有意为之,但也是"与无大事路径不同"的一处同刻顺序。

---

## 6. 系统模型(`WeakMap<CivSim, Model>`)清单

八个模块各一个,`install*`/`resume*` 时 `set`,各模块的 `*ModelOf(sim)` 取。

| 模型 | 声明 | 谁 set | 谁 get | 未 install 就 get 会怎样 |
| --- | --- | --- | --- | --- |
| `CultureModel` | `cultures.ts:599` | `installCultures` `:611` | `cultureModelOf` `:606` | `installAssimilation` 抛错 `assimilation.ts:185`;`resumeAssimilation` 直接 return `:489`;`index.ts:158,220` 用 `!` |
| `PolityModel` | `polities.ts:549` | `installPolities` `:558` | `polityModelOf` `:553` | `installPolitics`/`installDynasty` 抛错;`wars.ts:615`/`cities.ts:238`/`interventions.ts:263`/`upheaval.ts:359` 有守卫 |
| `WarModel` | `wars.ts:229` | `installWars` `:241` | `warModelOf` `:233` | `index.ts:120` 用 `!`(排在 `installWars` 之后,安全);其余有守卫 |
| `PoliticsModel` | `politics.ts:216` | `hook` `:237` | `politicsModelOf` `:220` | `dynasty.ts:174` 用 `?.`(安全) |
| `DynastyModel` | `dynasty.ts:106` | `hook` `:147` | `dynastyModelOf` `:110` | 只有测试读 |
| `AssimModel` | `assimilation.ts:171` | `hook` `:193` | `assimModelOf` `:175` | 只有测试读 |
| `CityModel` | `cities.ts:110` | `installCities` `:142` | `cityModelOf` `:114`;`scheduleRebuild` 直接 `models.get` `:223` | `scheduleRebuild` 有 `cm &&` 守卫(安全) |
| `InterventionModel` | `interventions.ts:231` | `installInterventions` `:266` | `interventionModelOf` `:235` | `installInterventions` 先判 `pm`/`wm` 缺失就 return `:263-265` |

**要点**:模型**不在** `CivSim` 上,而是以 `CivSim` 实例为键 ⇒ **实例身份必须保持**
(包装一层新引擎 = `resume*` 找不到模型)。另有 `capitalLost`(`WeakMap<PolityModel, 回调>`,`polities.ts:701`)
每次 `installCities`/`resumeCities` 重新挂。

---

## 7. 风险清单(按等级)

| 等级 | 事项 | 依据 | 现状 |
| --- | --- | --- | --- |
| **中** | **`seq` 重来导致同刻跨系统顺序可能与一口气跑不同** | §5.1;`sim.ts:378`、`:334-342` | 未保证等价;现有逐字节测试只采样部分种子 / 切点。**不在本阶段修**(计划明确:统一恢复语义另立任务) |
| **低** | `on` 是静默覆盖式,没有守卫 | `sim.ts:348-351` | 当前每类只有一个注册点;加一条测试把它**钉住**(010B) |
| **低** | `floor` 由外部直接赋值,没有方法封装 | `index.ts:153` | 文档授权的设计用法;**不改** |
| **低** | `processed` 全仓无读者 | `sim.ts:302,430` | 不影响行为;不动 |
| **提示** | 7 个事件类型只当 cause、没有 handler | §3 | 语义如此(它们表示"谁改的归属"),不是缺陷 |
| **提示** | `owners`/`version` 是公开可变数组(引用只读、内容可变) | `sim.ts:277-279` | 运行期无旁路(全仓 grep 已核);**不批量封装**(计划明确排除) |
| **未证实** | 是否真有一次"反转"发生在历史结果上 | §5.1 | 现有测试未覆盖到;本阶段**只记录,不下结论** |

---

## 8. 现有测试覆盖(哪些语义已经有护栏,哪些没有)

| 语义 | 覆盖 |
| --- | --- |
| 同刻按预约先后 | **已有直接覆盖**:`tests/civ-sim.test.ts:107`(断言 `seen` 序列与日志顺序) |
| 过期事件按 `version` 丢弃 | **已有直接覆盖**:同上(`civ-sim.test.ts:107`,并断言 `version` 与 `log.size`) |
| `setOwner` 写日志 / 版本 +1 / 同步通知 / 值不变时什么都不做 | **已有直接覆盖**:`civ-sim.test.ts:151`(日志只断言 `.size`) |
| 检查点节奏、`run` 只推到给定年份 | **已有直接覆盖**:`civ-sim.test.ts:129`、`:208` |
| 切段恢复 vs 一口气跑逐字节一致 | **已有直接覆盖**(多处,见 §5.1 列表) |
| `on` 覆盖式注册(后注册覆盖先前) | **没有覆盖** |
| `record` 的默认 `-1` 与调用先后 | **只有间接覆盖**(经生成结果 / 编年史读出来) |
| `run(untilYear)` 恰好落在 `untilYear` 的事件会触发 | **没有覆盖**(现有用例没把事件放在参数那一年) |
| `onChange` 多个监听者按注册顺序触发 | **没有覆盖**(只注册过一个) |
| `schedule` 把过去的时间钳到 `now`/`floor`;`+Infinity`/超 65536 年丢弃 | **没有覆盖** |
| `floor` 的作用(早于 floor 的事件被抬到 floor) | **只有间接覆盖**(经地形大事测试) |
| `setOwner` 写进 ChangeLog 的字段内容(year/region/layer/value/cause) | **只有间接覆盖**(只断言过 `.size`,字段级由切段逐字节比对间接守着) |

010B 只补上表里「没有覆盖 / 只有间接覆盖」的几条 —— 见 `tests/sim-event-semantics.test.ts`。

---

## 9. 本步产出与边界

- 本文件 = 事件类型表 + 状态写入点 + 恢复路径差异 + 风险等级。
- **未改任何源码**;`src/gen/**`、`src/render/**`、存档格式、生成器版本都没动。
- 下一步(010B):按 §8 的缺口补测试(测试优先,尽量不动生产代码)。

---

## 10. TASK-010C 决策:本阶段**不改代码**

计划要求:010C 只在"审计确实发现值得修复的问题"时才动代码;现状合理就只输出决策报告,
不为完成任务而强行重构。**结论:不改。** 逐条对照:

| 审计发现 | 是真缺陷吗 | 在本阶段范围内吗 | 决定 |
| --- | --- | --- | --- |
| 恢复路径 `seq` 从 0 重来 ⇒ 同刻跨系统顺序可能与一口气跑不同(§5.1,中) | 是**语义缺口**(未保证等价),但不是"错误":撞上需要两个带抖动的时刻量化到同一 tick | **不在** —— 计划把"统一恢复推演入口"明确排除在本阶段之外,要求另设设计与验证任务 | 记录 + 分级;**不改**。将来要动,先补一条"能稳定撞上反转"的用例,再谈方案 |
| `on` 静默覆盖(低) | 不是缺陷(当前每类只有一个注册点),是**潜在陷阱** | 在(010B 已用测试钉住) | 已加测试;**不加守卫** |
| `floor` 由外部直接赋值(低) | 不是缺陷,是注释授权的设计用法(`sim.ts:271-275`) | — | **不改**(计划排除"清理公开可变字段") |
| `processed` 全仓无读者(提示) | 不是缺陷 | — | **不改**(删它要动引擎,收益为零) |
| 7 个事件类型只当 cause、没有 handler(提示) | 不是缺陷,语义如此 | — | **不改** |
| `owners`/`version` 是公开可变数组(提示) | 运行期无旁路(全仓 grep 已核) | — | **不改**(计划明确排除批量封装) |

**评估过、但决定不做的两个候选**(留档,供以后审查):

1. **给 `floor` 加一个方法**(例如 `setFloor(y)`),把"唯一一处外部直接写引擎状态"收口成命名 API。
   改动约 2 行、零行为变化,好处是这条不变量变得可 grep、可断言。**不做**:它不是缺陷;
   `floor` 目前只有一处写入、注释已写明用途,为"收口"加 API 属于计划 §四 说的"为架构统一而增加抽象层"。
   若将来出现第二个写入点,再收口。
2. **给 `on` 加"重复注册就报错"的守卫**。**不做**:当前没有任何路径会重复注册;
   加守卫只会在将来某次合法重注册时把程序炸掉 —— 那是**新增失败模式**,不是消除风险。
   010B 的测试已经把"覆盖"写成显式契约,谁想改语义会先撞到它。

**本阶段真正的交付不是代码**,而是:一张能定位到 `file:line` 的语义表(§2/§3)、一张覆盖缺口表(§8)、
以及 12 条把关键语义钉死的回归测试(`tests/sim-event-semantics.test.ts`)—— 它们让**下一阶段**
(事件抽象 / mutation 边界)的任何改动都有即时反馈。

---

# TASK-011A:恢复推演的同刻事件顺序 —— 证据

## 结论(先说结果)

**风险是真的,但只发生在"内部事件顺序"这一层:**
在 **24 组样本(6 个种子 × 4 个切分年份)里有 22 组**的事件执行顺序与一口气跑不同;
但 **24/24 组的可观察结果完全一致** —— ChangeLog 逐字段、史事(annals)、检查点、最终归属都一样。

也就是说:审计 §5.1 提的"`seq` 重来 ⇒ 同刻跨系统顺序可能不同"**确实会发生**;
但它**没有**泄漏到日志 / 史事 / 存档 / 最终状态。

## 怎么测的

- 工具:`scripts/probe-resume-order.ts`(一次性探索脚本,可重复运行)。
- **怎么"看见"顺序**:给 `CivSim.prototype.on` 打桩,把每个 handler 包一层,记下
  **(时刻 t, 事件类型, a, b)** —— 这是引擎**实际调用 handler 的先后**,不是从结果反推的。
- 比较两条路径:
  ① 一口气跑 `generateCiv(world, { endYear })`;
  ② 切段恢复 `generateCiv(world, { endYear: cut })` → `CivSim.fromCiv(world, half)` → `sim.run(endYear)`。
- 比较字段:事件轨迹(**只取 `t > cut`** 那一段)、ChangeLog 逐字段(size/year/region/layer/value/cause)、
  annals、检查点(年份 + 国家归属)、最终归属(民族层 + 国家层逐字节)。
- 排除项:切开那一刻(`t == cut`)的边界语义另属一类,两边都丢掉。

## 扫描结果

```text
共 24 组:轨迹不同 22、日志不同 0、史事不同 0、检查点不同 0、归属不同 0
```

## 最小复现(已进正式测试 `tests/sim-resume-order.test.ts`)

**seed 42,切 2600,推到 2610**(轨迹只算 `t > 2600` 的那一段):

```text
一口气跑(23 条):… 看内政(41,0)@2600.418 | 看民族(20,5)@2600.961 | 看邻国(6,12)@2601.25
                    | 看邻国(1,16)@2601.605 | 立国(4,214)@2602.414 | 看内政(1,16)@2603.098 …
切段恢复(21 条):… 看内政(41,0)@2600.418 | 看民族(20,5)@2600.961 | 看邻国(6,12)@2601.25
                    | 立国(4,214)@2602.414 | 战役(0,31)@2603.621 | 立国(99,314)@2603.75 …
```

前三条一致,第 4 条起分叉:一口气跑在 2601.605 有一次 `看邻国(1,16)`,恢复路径没有;
恢复路径多出 `战役(0,31)` 与 `立国(99,314)`。**但两边的日志 / 史事 / 检查点 / 最终归属逐字节相同。**

测试把两件事同时钉住:①顺序差异是真的(条数与内容都不同,精确到事件序列);
②结果一致也是真的(不许在没解释的情况下把它放宽成"结果可以不同")。

## 差异的性质(据轨迹所见;**机制未完全证实**)

从轨迹看,两条路径的差别**不只是"同样的事件换了先后"**,还包括"**哪些事件被重新造了出来**":
恢复路径是从成品 `Civ`(log / annals)重建事件的,而一口气跑里有些事件早就作为**过期事件**
被丢掉(`version` 判定),恢复时它们会被**重新预约**并带上新的版本戳,于是**真的执行了**;
反过来,一口气跑里某些由动态事件链排出来的事件,恢复路径没有对应的重建来源。

为什么结果还能一样:这些"多出来 / 少了"的 handler 执行在**归属、日志、史事上都是空操作**
(例如目标州已经归该民族,`setOwner` 值不变直接 return)。**这一层是推断,不是证明** ——
要坐实需要逐事件追一遍(留给 011B/后续,不阻塞本阶段的结论)。

## 探索范围(不许当成"不存在差异"的证明)

- 样本:**6 个种子**(7 / 2024 / 3 / 99 / 1 / 42)× **4 个切分年份**(900 / 1200 / 2000 / 2600),终点 3000;
  另对 seed 42 切 2600 试过终点 2610 / 2620 / 2650(都复现)。
- 只扫了 `DEFAULT_PARAMS`(36000 地块)与"无干预、无地形大事"的情形。
- **扩大扫描的办法**:`npx tsx scripts/probe-resume-order.ts <seed> <cut> <endYear>`,或改脚本里的
  `seeds` / `cuts` 默认值。带干预、带地形大事、其他精细度的组合**尚未扫**。
- 因此本阶段只能说"在这一批样本里,顺序差异真实存在、结果差异没有出现",**不能说**"任何情况下结果都一致"。
