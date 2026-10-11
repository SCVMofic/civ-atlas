# 阶段 2:浏览器后退导航 —— 行为设计与最小复现(设计报告,不含实现)

> 本文件只描述**设计**与**复现证据**,不改生产代码。实现留待复审通过后另开提交。
> 约束:不引入大型路由依赖;不改模拟 / RNG / 事件调度 / 存档格式 / 续跑契约;不改部署配置。
>
> 修订说明(第二版):统一了详情之间的导航语义(§3.3 与 §5 原本互相矛盾);修正了 Esc 关闭的断言
> (不再要求 `history.back()` 删除历史记录);修正了"无站内前序记录时 Back 留在本站"的预期;
> 补齐了首轮范围、面板互斥、世界切换失效处理;把 7 处 `replaceState` 的统一合并策略写死。

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

### 3.1 一层极薄的历史封装(不引依赖)

新增一个小模块(例如 `src/ui/nav.ts`),只做三件事:

- `pushView(desc)`:若当前 `history.state` 与 `desc` 相同则**不做事**(重复打开同一视图不新增记录);否则 `history.pushState(desc, '')`。
- `replaceUrl(next)`:唯一的 URL 改写入口,`history.replaceState(history.state, '', next)` —— **保留** state 里的视图描述(见 §4)。
- `popstate` 监听:读 `event.state`,回调 `onRestore(desc)`;恢复流程**只读、不写**(见 §4)。

### 3.2 视图描述(可序列化的最小信息,不放全量状态)

```ts
type NavView =
  | { v: 'base' }                                              // 基础视图(世界页面,没有面板)
  | { v: 'detail'; kind: MapSelection['kind']; id: string }     // 详情,id 用稳定 ID
  | { v: 'overview'; tab: string };                             // 概览 / 编年史(按页签)
```

- 每条描述都带一个**世界标识** `world`(见 §3.6),用来判断这条记录是不是当前世界的。
- `id` 用**稳定 ID**(仓库已有 `polityKey` / `regionKey` / `settlementKey` / `placeKeyOf`,`src/gen/edits.ts`),不存数组下标(重推后下标会变)。
- 描述**不包含**世界参数 / 图层 / 投影 / 地图中心——那些继续由现有的 `replaceUrl` 写进 URL。

### 3.3 统一的操作规则(取代旧版的 `replaceView`)

**只保留一条状态转移规则,不再有 `replaceView`:**

| 操作 | 历史动作 |
| --- | --- |
| 从 base 打开详情 / 概览 | `pushView`(新增 1 条) |
| **详情 → 另一个详情**(不同实体) | `pushView`(新增 1 条;Back 回到上一个实体) |
| **重复打开同一实体 / 同一概览页签** | **不新增记录**(`pushView` 内部判定描述相同即 no-op) |
| 概览 → 点某国打开详情 | `pushView`(新增 1 条;Back 回到概览) |
| 关闭当前视图(Esc / 点外部 / 面板关闭键) | `history.back()`(等同浏览器 Back,回到**上一个视图**),不直接清 store |
| 拖动地图 / 缩放 / 换图层 / 换投影 / 播放时间轴 / 悬停 / 各种菜单与对话框 | **不写历史** |

由此,`base → A → B → C` 是 **3 次 push**;Back ×3 依次回到 **B、A、base**;Forward ×3 依次回到 **A、B、C**。

> 待确认(§8):"详情之间导航用 push"按评审建议采用;"Esc = 返回上一视图"而不是"一路清到 base"。

### 3.4 Back / Forward 恢复什么

- `popstate` 收到 `state.v`:
  - `base` → `clearSelection()` 并关掉概览;
  - `detail` → 按 `id` 解析实体并 `setSelection`;**解析不到(见 §3.6)安全降级到 base,不报错**;
  - `overview` → 打开对应页签。
- **世界与地图不在历史里**:世界数据在内存,Back 只是换面板、不重新加载世界;地图缩放 / 中心、时间轴年份、侧栏折叠、滚动位置**全部保留**。

### 3.5 直接打开 / 刷新 / base 视图按 Back

- 直接打开或刷新时 `history.state === null` → 视为 `base`;URL 语义不变(仍是世界 / 图层 / 投影),刷新回到基础视图,**与现状一致**。
- **不承诺**刷新后恢复详情面板(需要把视图写进 URL,属后续可选项);文档与测试写明。
- **base 视图按 Back**:若浏览器里**没有本站的前序记录**,按 Back 会离开本站 —— 这是浏览器默认行为,**本设计不引入哨兵记录或 Back 拦截**,不承诺此时留在本站。要求只针对"**存在站内前序视图**"的情形:Back 必须回到上一个应用视图(见 §5 T2/T3)。若将来确实需要"无前序时也留住",再单独评审哨兵方案。
- 分享链接(`#share=`)与 `s=` 短链接的处理**不动**。

### 3.6 首轮范围、面板互斥、世界切换

**首轮纳入的视图(仅这些写历史):**

1. 详情面板:`selection` 的国家 / 城市 / 州 / 信仰 / 地点 / 人物(`civView.ts`);
2. 概览 / 编年史(`overviewStore.ts`,按页签区分)。

**首轮不纳入(行为不变,不写历史、不受 Back 影响):**

- 史书阅读器(`bookStore.ts`)、助手面板(`astPanel.ts`)、地形编辑(`TerrainTools.tsx`)、搜索框、图层弹层、导出 / 存档菜单、各种对话框、地图悬停浮层、侧栏折叠。这些仍是"开合即改 store",与浏览器历史无关。明确写出来,免得被当成"漏了"。

**面板互斥规则:**

- 同一时刻**最多一个**视图处于打开态(`base` | `detail` | `overview`)。
- 打开新视图时先关掉当前视图的 store(**不触发额外历史动作**,因为历史动作只由 §3.3 的规则产生)。
- 概览 → 详情的转移按 §3.3 记一条 push。

**世界切换后的失效实体:**

- 世界标识变化(生成新世界 / 打开另一个世界 / 读档)时,把**当前条目**的 state 改成 `{ v: 'base', world: 新世界 }`(`replaceUrl` 语义,不加记录)。
- 历史里更早的记录属于旧世界:`popstate` 恢复前先比 `state.world` 与当前世界,**不一致就落回 base**,绝不拿旧世界的 id 去解析当前世界的实体。
- 即便 `world` 一致,`id` 解析不到(实体被重推改变 / 已不存在)也落回 base。两条都安全降级,不报错、不崩。

## 4. 防循环、统一 state 合并、恢复流程不写

- **统一 URL 改写入口**:新增 `replaceUrl(next)` = `history.replaceState(history.state, '', next)`,**保留** `state` 里的视图描述。现有 7 处 `replaceState` 全部改用它,逐个列出:

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

- **恢复流程只读不写**:`popstate` 里只读 `event.state` 并调用 store 的 setter,**绝不再 push / replace**(`replaceUrl` 也不调用,因为 URL 已经是对的那一条)。加一个 `restoring` 标志(或让恢复路径只走纯 setter),杜绝"恢复 → 触发打开 → 又 push"的回环。
- **`pushView` 只在用户主动打开视图时调用**;同一个描述不重复 push(§3.3 的 no-op 规则)。
- **上下文保留**:因为不重新加载世界,Back 天然保留地图视图、时间轴年份与滚动位置;只有被恢复的面板变化。

## 5. 测试矩阵(每条对应确定的产品语义)

**单测(纯函数,无浏览器)**:

| # | 断言 |
| --- | --- |
| U1 | 同一实体产生同一描述;不同实体 / 不同页签产生不同描述;`base` 与 `detail` 不相等 |
| U2 | `pushView` 在描述相同时 no-op(重复打开同一实体不新增记录) |
| U3 | `id` 用稳定键;重推改变下标后仍解析得到同一实体 |

**浏览器端**(加进 `scripts/replay-check.ts` 或新脚本):

| # | 场景 | 断言(确定语义) |
| --- | --- | --- |
| T1 | 直接打开带种子网址;再刷新 | 均为 base 视图;URL 不变;不崩。**不断言 Back 留在本站**(无站内前序记录时允许离开) |
| T2 | 打开详情 → Back | **回到 base;仍在应用内**(`window.__wf` 存在、`location.host` 不变);世界未重载(时间轴年份、地图中心不变) |
| T3 | base → A → B → C(详情/概览混合),Back ×3,再 Forward ×3 | 条目 **+3**;Back 依次回到 **B、A、base**;Forward 依次回到 **A、B、C**;全程世界未重载 |
| T4 | 重复打开同一实体 | 条目数**不变**(no-op) |
| T5 | 打开详情 → Esc | **恢复到上一视图**(等同 Back);**条目数不增长**、无重复 push、无导航循环。**不要求删除历史记录** |
| T6 | 打开详情 → 刷新 | 回到 base(URL 不变);不进入损坏状态 |
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

## 8. 仍需人工决定的问题

1. **Esc 的语义**:本设计取"Esc = 返回上一视图(等同 Back)"。另一种是"Esc = 一路关到 base"(需要 `history.go(-n)` 或 `replaceState`,更复杂)。请确认。
2. **详情之间导航是否 push**:本设计按评审建议取 **push**(Back 能回到上一个实体)。若希望"点来点去只在一条记录里替换",则改用 replace,并相应改 T3。
3. **世界切换时的历史**:本设计按 `world` 判别并把当前条目重置为 base;更早的旧世界记录在 Back 时落回 base。是否接受这种"旧世界记录不可恢复"的处理?
4. **首轮范围**:本设计不含史书阅读器 / 助手 / 地形编辑。若其中某个也要进历史,请指定。
