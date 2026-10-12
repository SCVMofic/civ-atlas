# 阶段 2:浏览器后退导航 —— 行为设计与最小复现(设计报告,不含实现)

> 本文件只描述**设计**与**复现证据**,不改生产代码。实现留待复审通过后另开提交。
> 约束:不引入大型路由依赖;不改模拟 / RNG / 事件调度 / 存档格式 / 续跑契约;不改部署配置。
>
> 修订说明:
> - 第一版:初稿。
> - 第二版:统一详情导航语义;修正 Esc / Back 断言;补齐范围与 state 合并策略。
> - 第三版:把"改 URL"与"改导航描述"拆成两个职责不同的接口;给出世界标识的明确定义;微调 T3/T5 措辞;把已确认的决策写死。
> - **第四版**:① 明确"刷新时 `history.state` 不一定是 `null`",把**启动初始化规则**写完整(靠世界标识比较归一化,而不是靠 `state === null`),并加 T6 直接验证刷新后旧 state 被安全降级;② 统一 `pushView` / `replaceNavView` 的类型契约(调用方传 `NavView`,模块内部补 `world`),全文只用一套约定。
> - **第五版(本版)**:实现后回归发现"Esc = 返回上一视图"会改动既有 68 处 Esc 交互(冒烟在 `replay-check.ts:696` 就挂)。维护者决定改为:**Esc = 关闭当前面板**(清选中 / 收起概览 + `replaceNavView(base)`,不新增记录),**浏览器 Back / Forward 才负责回到上一个应用视图**。§3.4 的关闭行与 §8 的 Esc 行已同步。注意:概览(`WorldOverview.tsx:76-84`)有自己的**捕获阶段** Esc 处理器并 `stopPropagation`,所以概览开着时第一次 Esc 关概览、第二次才关详情面板。

## 1. 最小复现(实测)

环境:本地 `vite` dev server(`http://localhost:5199`),Chromium(内置浏览器)。

步骤:

1. 先访问**任意上一个页面**(本站的 `privacy.html` 即可),让浏览器里存在"上一条记录"。
2. 打开一个世界:`http://localhost:5199/?seed=7`(等 `window.__wfCiv.ready`)。
3. 在侧栏点一个国家(如「尼梅亚帝国 1992 年立国…」)→ 国家详情面板打开。
4. 观察:**网址不变、`history.length` 不变**(3 → 3)。
5. 按**浏览器后退**。

实测结果:

| 时刻 | `location.href` | `history.length` | 应用在不在 | 详情面板 |
| --- | --- | --- | --- | --- |
| 打开详情后 | `…?seed=7&gen=9&lon=-84.61` | 3 | 在(`window.__wf` 存在) | 打开 |
| 按后退后 | `http://localhost:5199/privacy.html` | — | **不在**(`window.__wf` 为 `undefined`) | 没了 |

即:后退**没有关闭详情**,而是**整个应用被导航走**(回到上一条历史记录)。这就是要修的问题。

补充观察:应用运行期间会持续用 `replaceState` 改写当前条目(上面 `lon=-84.61` 就是拖动地图时写进去的中心经度),所以历史里那条记录是"应用当前的样子"被原地覆盖,历史栈里没有"上一个应用视图"。

## 2. 现状盘点

**没有路由库,也没有 `pushState`。**

- 全仓 `pushState` / `popstate` **零命中**(`grep -rn "pushState\|popstate" src/` 为空);也没有 `beforeunload` / `pagehide`。
- 只有 `replaceState`,共 7 处:
  - `src/ui/route.ts:79`(`writeLayerUrl`)、`:199`(`writeWorldUrl`)、`:207`(`writeHomeUrl`);
  - `src/ui/App.tsx:898`(去掉分享 `#`)、`:910`(hashchange 重新导入分享)、`:1217`(投影 / 中心经度 / 经纬网,防抖);
  - `src/account/session.ts:222`(去掉 `invite`)。
- 因此**当前条目被原地改写**:历史里没有"上一个视图",后退只能去更早的**整页**记录(即离开应用)。

**视图状态的归属(全部是模块 store,URL 里没有):**

| 视图 | 状态归属 | 打开 / 关闭 |
| --- | --- | --- |
| 国家 / 城市 / 州 / 信仰 / 地点 / 人物详情 | `src/ui/civView.ts:303` 的 selection store | `setSelection`(`:310`) / `clearSelection`(`:315`) |
| 编年史 / 世界概览 | `src/ui/overviewStore.ts` | `openOverview` / `closeOverview` |
| 史书阅读器(AI) | `src/ui/bookStore.ts:112,125` | `openHistoryBook` / `openBookReader` |
| 助手面板 | `src/ui/astPanel.ts:16,29-37` | 开合 |
| 地形编辑 | `src/ui/TerrainTools.tsx:79-96` | 只在新建草稿里开 |
| 搜索 | `src/ui/Sidebar.tsx` | 打开搜索框 / 选结果 → `setSelection` |
| 侧栏折叠 | `src/ui/sideStore.ts:14` | localStorage,不算导航 |

**URL 里已有的**:世界身份(`seed` / 参数 / `w` / `new` / `s` / `gen`)、图层(`layer` / `civ` / `style`)、投影(`proj` / `lon` / `grat`);舞台(`home` / `draft` / `world`)只在加载时由 `firstRoute` 读一次(`src/ui/route.ts:159-174`)。这些都用 `replaceState`,不产生新记录。

**结论**:后退当前的行为是"离开站点",前进是"整页重新加载应用"(详情丢失)。关闭面板的现有入口是 Esc / 点外部 / 关闭键,它们只改 store,不动历史。

## 3. 最小导航状态模型

目标:让"进入一个应用内视图"成为一次可后退的历史记录,Back/Forward 只切换**视图**,不重新加载世界。

### 3.1 三个职责分离的接口(不引依赖)

新增一个小模块(例如 `src/ui/nav.ts`),**三个接口各管一件事,不混用**。统一契约:前两个接口接收 **`NavView`**(只含视图字段,不含 `world`),由模块内部**补上当前世界标识**再写 `NavState`;调用方不需要、也不应该自己拼 `world`。

| 接口(签名) | 职责 | 改 URL | 改导航 state | 新增记录 |
| --- | --- | --- | --- | --- |
| `pushView(view: NavView)` | 进入一个新视图 | 否 | 是(写入 `{ ...view, world }`) | **是**(描述相同则 no-op) |
| `replaceNavView(view: NavView)` | 更新**当前条目**的导航描述(世界切换重置 base、启动归一化) | 否 | 是(原地换成 `{ ...view, world }`) | 否 |
| `replaceUrl(next: string)` | 只改 URL,供现有 7 处 `replaceState` 使用 | **是** | **否(原样保留)** | 否 |

- `pushView(view)` = 目标 `NavState` 与 `history.state` 相同时 no-op;否则 `history.pushState({ ...view, world: currentWorld() }, '')`。
- `replaceNavView(view)` = `history.replaceState({ ...view, world: currentWorld() }, '', location.href)`。
- `replaceUrl(next)` = `history.replaceState(history.state, '', next)`。

> 契约要点:`NavView` 是**调用方**传的(只有 `v` 等视图字段);`world` 一律由**模块内部**补。任何地方都不出现"调用方自己传 world",也不会出现"写了视图描述却漏了 world"的不一致 —— 全文只用这一套约定。

### 3.2 视图描述(可序列化的最小信息)

```ts
type NavView =
  | { v: 'base' }
  | { v: 'detail'; kind: MapSelection['kind']; id: string }
  | { v: 'overview'; tab: string };

interface NavState extends NavView {
  /** 这条记录属于哪个世界(见 §3.3);恢复前先比它 */
  world: string;
}
```

- `id` 用**稳定 ID**(`polityKey` / `regionKey` / `settlementKey` / `placeKeyOf`,`src/gen/edits.ts`),不存数组下标(重推后下标会变)。
- 描述**不含**世界参数 / 图层 / 投影 / 地图中心——那些继续由 `replaceUrl` 写进 URL。
- **调用方只构造 `NavView`**;`world` 由 §3.1 的 `pushView` / `replaceNavView` **内部补齐**。`NavState` 只出现在 `nav.ts` 内部与 `popstate` 读取处,不出现在调用点。

### 3.3 世界标识 `world` 的明确定义

**来源(现有字段 + 一个页面级 nonce):**

```
world = `${sessionNonce}:${worldId}`
```

- `worldId`:**已有字段**,`getWorldSession().worldId`(`src/session/worldSession.ts:74`,由 `newGeneration()` 维护,`src/session/worldSession.ts:154`)。注释写明它的口径:`协议里的 id,每换一代加一(生成新世界、按新地形重新生成都算)`。
- `sessionNonce`:**页面加载时生成一次的随机串**(模块级常量,不持久化、不进存档、不碰模拟)。它只为"刷新后旧记录失效"服务。

**必须成立的三条性质(实现后按此验收):**

| 性质 | 为什么成立 |
| --- | --- |
| 改图层 / 投影 / 地图中心,**标识不变** | 这些都不调用 `newGeneration()`,只走 `replaceUrl`(`route.ts:79`、`App.tsx:1217`),`worldId` 与 `sessionNonce` 都不动 |
| 切换到另一个世界,**标识能区分** | 生成新世界 / 打开别的世界 / 按新地形重新生成都走 `newGeneration(p)`,调用点只有 `App.tsx:849`(新世界 / 读档)与 `App.tsx:930`(改地形后重生成),`worldId` 必增 |
| 刷新后,旧记录不再被当成当前世界 | `sessionNonce` 重新生成 → 刷新前写的 `world` 与刷新后的不同 → 旧记录一律落回 base(§3.5 本来也不承诺刷新恢复详情) |

**恢复时比什么:**`popstate` 里比较 **`state.world` 与当前 `world`**,**不比较 URL 字符串**(URL 会随图层 / 投影 / 中心改写,不能当世界身份)。不一致 → 落回 base,绝不拿旧世界的 `id` 去解析当前世界的实体。

> 备注:`worldId` 在"改地形重新生成"时也会增(这是它的既有口径)。对导航来说这是**安全**的:重生成后实体 ID 可能变,旧记录本就该失效。

### 3.4 统一的操作规则

| 操作 | 历史动作 |
| --- | --- |
| 从 base 打开详情 / 概览 | `pushView`(新增 1 条) |
| **详情 → 另一个详情**(不同实体) | `pushView`(新增 1 条;Back 回到上一个实体) |
| **重复打开同一实体 / 同一概览页签** | **不新增记录**(`pushView` 判定描述相同即 no-op) |
| 概览 → 点某国打开详情 | `pushView`(新增 1 条;Back 回到概览) |
| 关闭当前面板(Esc / 点地图空白) | 清选中 / 收起概览,并把**当前条目**归一化为 base(`replaceNavView`,**不新增记录**)。**浏览器 Back / Forward 才负责"回到上一个视图"** |
| 拖动地图 / 缩放 / 换图层 / 换投影 / 播放时间轴 / 悬停 / 各种菜单与对话框 | **不写历史** |

由此,`base → A → B → C` 是 **3 次 push**;Back ×3 依次回到 **B、A、base**;Forward ×3 依次回到 **A、B、C**。

### 3.5 Back / Forward 恢复什么

- `popstate` 收到 `state`(**启动时**的恢复走 §3.6 的启动初始化规则,这里说的是运行期间):
  - `state.world !== 当前 world` → 落回 base(不解析任何 id);
  - `base` → `clearSelection()` 并关掉概览;
  - `detail` → 按 `id` 解析实体并 `setSelection`;**解析不到也落回 base,不报错**;
  - `overview` → 打开对应页签。
- **世界与地图不在历史里**:世界数据在内存,Back 只是换面板、不重新加载世界;地图缩放 / 中心、时间轴年份、侧栏折叠、滚动位置**全部保留**。

### 3.6 启动初始化 / 直接打开 / 刷新 / base 视图按 Back

**启动初始化规则(不依赖 `history.state === null`):**

刷新时浏览器**通常会保留**当前条目的 `history.state` —— 刷新前那条可能是 `{ v: 'detail', …, world: 旧 }`。所以"刷新后回 base"**不能**靠 `state === null` 判断,必须由**世界标识比较**保证。应用启动时按下面流程走:

1. 读当前条目的 `history.state`(可能是 `null`,也可能是刷新前留下的**旧** `NavState`);
2. 取出其中的 `world`,与新页面当前的 `world`(§3.3,含**本次加载新生成的 `sessionNonce`**)比较;
3. **不一致 → 进入 base**,并调 `replaceNavView({ v: 'base' })` 把**当前条目归一化**成新的 base state(`state` 为 `null`、或不是合法 `NavState`、或 `world` 对不上,都走这条);
4. 一致(同一页面生命周期内,没刷新)→ 可按 §3.5 恢复。

因为刷新一定会重新生成 `sessionNonce`,**刷新后 `world` 必然对不上**,所以刷新一律回 base —— 这条由世界标识比较保证,而不是由 `state === null` 保证。

- URL 语义不变(仍是世界 / 图层 / 投影),刷新回到基础视图,**与现状一致**。
- **不承诺**刷新后恢复详情面板(要恢复得把视图写进 URL,属后续可选项);文档与测试写明。
- **base 视图按 Back**:若浏览器里**没有本站的前序记录**,按 Back 会离开本站 —— 浏览器默认行为,**本设计不引入哨兵记录、不拦截 Back**,不承诺此时留在本站。要求只针对"**存在站内前序视图**"的情形(§5 T2/T3)。

### 3.7 首轮范围、面板互斥、世界切换

**首轮纳入的视图(仅这些写历史):**

1. 详情面板:`selection` 的国家 / 城市 / 州 / 信仰 / 地点 / 人物(`civView.ts`);
2. 概览 / 编年史(`overviewStore.ts`,按页签区分)。

**首轮不纳入(行为不变,不写历史、不受 Back 影响):** 史书阅读器(`bookStore.ts`)、助手面板(`astPanel.ts`)、地形编辑(`TerrainTools.tsx`)、搜索框、图层弹层、导出 / 存档菜单、各种对话框、地图悬停浮层、侧栏折叠。它们仍是"开合即改 store",与浏览器历史无关。明确写出来,免得被当成"漏了"。

**面板互斥规则:** 同一时刻**最多一个**视图打开(`base` | `detail` | `overview`);打开新视图时先关掉当前视图的 store(**不触发额外历史动作**)。

**世界切换后的失效实体:**

- 世界标识变化(生成新世界 / 打开另一个世界 / 读档 / 改地形重生成)时,用 **`replaceNavView({ v: 'base' })`**(§3.1 内部会补上新世界标识)把**当前条目**重置为 base(不加记录)。
- 历史里更早的记录属于旧世界:`popstate` 恢复前先比 `state.world`(§3.3),**不一致就落回 base**;即便 `world` 一致,`id` 解析不到也落回 base。两条都安全降级,不报错、不崩。

## 4. 统一 URL 改写、恢复流程不写

- **现有 7 处 `replaceState` 全部改用 `replaceUrl(next)`**(只改 URL,保留 `history.state`):

  | 位置 | 现状 | 改为 |
  | --- | --- | --- |
  | `src/ui/route.ts:79` | `history.replaceState(null, '', next)` | `replaceUrl(next)` |
  | `src/ui/route.ts:199` | `history.replaceState(null, '', next)` | `replaceUrl(next)` |
  | `src/ui/route.ts:207` | `history.replaceState(null, '', rest ? …)` | `replaceUrl(…)` |
  | `src/ui/App.tsx:898` | `history.replaceState(null, '', …)` | `replaceUrl(…)` |
  | `src/ui/App.tsx:910` | `history.replaceState(null, '', …)` | `replaceUrl(…)` |
  | `src/ui/App.tsx:1217` | `history.replaceState(null, '', next)` | `replaceUrl(next)` |
  | `src/account/session.ts:222` | `history.replaceState(null, '', …)` | `replaceUrl(…)` |

  只要有一处漏改,`pushState` 写进去的 `{ v, world }` 就会被抹成 `null`,Back 立刻退化成现状 —— 测试 T2/T3 专门守这一点。

- **恢复流程只读不写**:`popstate` 里只读 `event.state` 并调用 store 的 setter,**绝不 push / replace / replaceNavView**(URL 已经是对的那一条)。加一个 `restoring` 标志(或让恢复路径只走纯 setter),杜绝"恢复 → 触发打开 → 又 push"的回环。
- **`pushView` 只在用户主动打开视图时调用**;描述相同不重复 push。
- **上下文保留**:因为不重新加载世界,Back 天然保留地图视图、时间轴年份与滚动位置。

## 5. 测试矩阵(每条对应确定的产品语义)

**单测(纯函数,无浏览器):**

| # | 断言 |
| --- | --- |
| U1 | 同一实体产生同一描述;不同实体 / 不同页签产生不同描述;`base` 与 `detail` 不相等 |
| U2 | `pushView` 在描述相同时 no-op(重复打开同一实体不新增记录) |
| U3 | `id` 用稳定键;重推改变下标后仍解析得到同一实体 |
| U4 | 世界标识:同一 worldId + 同一 nonce 相等;worldId 变则不等;nonce 变则不等 |
| U5 | 启动恢复判定 `restoreOnStart(state, world)`:`state` 为 `null` / 非法结构 / `world` 不匹配 → 返回 `base`(并要求 `replaceNavView({v:'base'})` 归一化);`world` 匹配 → 返回该视图 |

**浏览器端**(加进 `scripts/replay-check.ts` 或新脚本):

| # | 场景 | 断言(确定语义) |
| --- | --- | --- |
| T1 | 直接打开带种子网址(全新条目,`history.state` 为 `null`) | base 视图;URL 不变;不崩;启动后当前条目被**归一化**为 `{ v: 'base', world: 当前 }`。**不断言 Back 留在本站**(无站内前序记录时允许离开) |
| T2 | 打开详情 → Back | **回到 base;仍在应用内**(`window.__wf` 存在、`location.host` 不变);世界未重载(时间轴年份、地图中心不变) |
| T3 | 记录 `L0 = history.length`;执行 base → A → B → C;Back ×3;Forward ×3 | 执行后 `history.length === L0 + 3`(**相对 L0 增 3,不要求等于某个固定值**);Back 依次回到 **B、A、base**;Forward 依次回到 **A、B、C**;全程世界未重载 |
| T4 | 重复打开同一实体 | `history.length` **不变**(no-op) |
| T5 | 打开详情,记 `L1 = history.length`;按 Esc | **关闭面板**(清选中 / 收起概览,当前条目归一化为 base);Esc 后 `history.length` **不再超过 `L1`**(不要求回到打开前的值,也不要求删除刚创建的那条记录);无重复 push、无导航循环 |
| T6 | 打开详情(当前条目 state = `{ v: 'detail', …, world: 旧 }`)→ **刷新** | 回到 base;URL 不变;不崩;**刷新后当前条目的 state 变成 `{ v: 'base', world: 新 }`** —— 旧世界的 detail state 被安全降级,旧实体 id 绝不用于新世界 |
| T7 | 打开详情 → 生成 / 打开另一个世界 → Back | **不恢复旧世界的实体**,落回 base;不报错 |
| T8 | 全程 | 有站内前序视图时 Back 不离开站点;无重复历史项;无导航循环;无 React 状态更新警告 |

**回归**:现有 UI 测试(`tests/ui-panels.test.ts` 等)与 `pnpm typecheck` / `pnpm test` / `pnpm build` 必须仍过;不动模拟、存档、续跑。

## 6. 风险与不做

- 把"关闭面板"改成 `history.back()` 会**改变交互时序**(异步):需处理用户快速连开关;实现时保证 store 更新幂等。
- 7 处 `replaceState` 必须逐个换成 `replaceUrl`,漏一处即失效(§4)。
- **直接打开 / 刷新不恢复详情面板**、**base 无前序记录时 Back 会离开本站**:本轮明确不承诺,写进文档与测试。
- **不做**:不引路由库;不把视图写进 URL;不引入历史哨兵 / Back 拦截;不改模拟 / RNG / 调度 / 存档 / 续跑;不顺手做阶段 3;不动部署配置。

## 7. 交付与回滚

- 本阶段产出:本设计报告(单独提交)。
- 实现阶段将**独立提交**,可单独回滚;不与阶段 1a 的实现提交混在一起。

## 8. 已确认的决策

| 决策 | 取值 | 原因 |
| --- | --- | --- |
| Esc 语义 | **关闭当前面板**(清选中 / 收起概览 + 当前条目归一化为 base,不新增记录) | 保留用户熟悉的"Esc = 关面板";导航历史回退交给浏览器 Back / Forward(第五版调整,见下) |
| 详情之间导航 | push | 符合"回看上一个实体"的需求,T3 已按此设计 |
| 世界切换后的旧记录 | 落回 base | 不跨世界恢复实体,安全且简单 |
| 首轮视图范围 | 仅详情与概览 | 限制实现复杂度,避免一次性协调更多独立 store |

**无待决问题。** 实现按本版执行;若实现中发现与既有 store 生命周期冲突,先停下来报告证据与选项,不擅自改契约。
