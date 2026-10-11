# 阶段 2:浏览器后退导航 —— 行为设计与最小复现(设计报告,不含实现)

> 本文件只描述**设计**与**复现证据**,不改生产代码。实现留待复审通过后另开提交。
> 约束:不引入大型路由依赖;不改模拟 / RNG / 事件调度 / 存档格式 / 续跑契约;不改部署配置。

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
| 助手面板 | `src/ui/astPanel.ts:16,29-37` | `closeAssistant` / 开合 |
| 地形编辑 | `src/ui/TerrainTools.tsx:79-96` | 只在新建草稿里开(`setTerrainTool`) |
| 搜索 | `src/ui/Sidebar.tsx` | 打开搜索框 / 选结果 → `setSelection` |
| 侧栏折叠 | `src/ui/sideStore.ts:14` | localStorage,不算导航 |

**URL 里已有的**:世界身份(`seed` / 参数 / `w` / `new` / `s` / `gen`)、图层(`layer` / `civ` / `style`)、投影(`proj` / `lon` / `grat`);舞台(`home` / `draft` / `world`)只在加载时由 `firstRoute` 读一次(`src/ui/route.ts:159-174`)。这些都用 `replaceState`,不产生新记录。

**结论**:后退当前的行为是"离开站点",前进是"整页重新加载应用"(详情丢失)。关闭面板的现有入口是 Esc / 点外部 / 关闭键,它们只改 store,不动历史。

## 3. 最小导航状态模型

目标:让"进入一个应用内视图"成为一次可后退的历史记录,Back/Forward 只切换**视图**,不重新加载世界。

**3.1 一层极薄的历史封装(不引依赖)**

新增一个小模块(例如 `src/ui/nav.ts`),只做三件事:

- `pushView(desc)`:把视图描述写进 `history.pushState(desc, '')`。
- `replaceView(desc)`:在**不改记录数**的前提下更新 `history.state`(用于当前条目内视图变化)。
- 一个 `popstate` 监听:读 `event.state`,回调 `onRestore(desc)`。

**3.2 视图描述(可序列化的最小信息,不放全量状态)**

```ts
type NavView =
  | { v: 'base' }                                   // 基础视图(我的世界 / 世界页面,没有详情)
  | { v: 'detail'; kind: MapSelection['kind']; id: string }  // 详情,id 用稳定 ID
  | { v: 'overview'; tab: string }                  // 编年史 / 概览
  | { v: 'book'; ... }                              // 史书阅读器
  | { v: 'terrain' };                               // 地形编辑
```

- `id` 用**稳定 ID**(仓库已有 `polityKey` / `regionKey` / `settlementKey` / `placeKeyOf`,`src/gen/edits.ts`),不存数组下标(重推后下标会变)。
- 描述**不包含**世界参数 / 图层 / 投影 / 地图中心——那些继续由现有的 `replaceState` 写进 URL。

**3.3 哪些操作写历史**

- **写**(`pushView`):打开国家 / 城市 / 州 / 信仰 / 地点 / 人物详情;打开编年史 / 概览;打开史书;进入地形编辑。
- **不写**:拖动地图、缩放、换图层、换投影、播放时间轴、悬停、打开纯展示的浮层(悬停卡)。
- **关闭**:Esc / 点外部 / 关闭键 → 走 `history.back()`(**不是**直接清 store),由 `popstate` 统一恢复;这样"打开 + 关闭"是 push + back 的对称操作,历史不增长。
- 详情之间切换(点另一个国家):若当前已是 detail,用 `replaceView` 换 id(不叠加记录);从 base 进入 detail 才 `pushView`。

**3.4 Back / Forward 恢复什么**

- `popstate` 收到 `state.v`:
  - `base` → `clearSelection()` 并关掉概览 / 史书 / 地形编辑;
  - `detail` → 按 `id` 解析出实体并 `setSelection`(解析不到 = 数据不支持,安全降级到 base,不报错);
  - `overview` / `book` / `terrain` → 打开对应面板。
- **世界与地图不在历史里**:世界数据在内存,Back 只是换面板,不重新加载世界;地图缩放 / 中心、时间轴年份、侧栏折叠、滚动位置**全部保留**。

**3.5 直接打开 / 刷新**

- 直接打开或刷新时 `history.state === null` → 视为 `base`;URL 语义不变(仍是世界 / 图层 / 投影),所以刷新回到基础视图,**与现状一致**。
- 本轮**不承诺**刷新后恢复详情面板(那需要把视图写进 URL,属于后续可选项);文档与测试里写明这一点,免得被当成 bug。
- 分享链接(`#share=`)与 `s=` 短链接的处理**不动**。

## 4. 防循环与上下文保留

- **防循环**:`pushView` 只在"用户主动打开视图"这一处调用;`popstate` 里**只读 state 恢复 store,绝不再 push/replace**。用一个 `restoring` 标志(或让恢复路径只走纯 setter)杜绝"恢复 → 触发打开 → 又 push"的回环。
- **与现有 `replaceState` 共存**:世界 / 图层 / 投影的 `replaceState` 会把 `history.state` 覆盖成 `null`,必须改成**合并写**:`history.replaceState({ ...history.state }, '', next)`,保住 `v` 描述。
- **上下文保留**:因为不重新加载世界,Back 天然保留地图视图、选中实体的邻接信息、时间轴年份与滚动位置;只有被恢复的面板变化。
- **边界**:
  - 连续打开 A→B→C:push 三次,Back 依次回 B、A、base;Forward 反向。
  - 重复点同一个实体:描述相同 → 不 push(`replaceView`)。
  - 详情打开时点地图空白(现有 `clearSelection`):若语义是"关闭当前详情" → 走 `history.back()`;若是"切到另一个实体" → `replaceView`。
  - 面板自身的"返回 / 关闭"按钮:同样走 `history.back()`,与浏览器 Back 行为一致。

## 5. 测试方案

**单测(纯函数,无浏览器)** —— 描述序列化与比较:同一个实体产生同一描述、不同实体产生不同描述、`base` 与 `detail` 不相等;`id` 用稳定键、重推后仍解析得到。

**浏览器端(加进 `scripts/replay-check.ts` 或新脚本)**,覆盖计划里要求的场景:

| # | 场景 | 断言 |
| --- | --- | --- |
| 1 | 直接打开带种子网址 | 基础视图;按 Back 不崩、不离开站点 |
| 2 | 打开详情 → Back | **仍在应用内**(`window.__wf` 存在、`location.host` 不变);详情关闭;世界还在 |
| 3 | 连续打开 3 个详情 → Back ×3 → Forward ×3 | 依次回到第 2、1 个与 base,再依次前进;不丢世界 |
| 4 | 打开详情 → 刷新 | 回到基础视图(URL 不变),不进入损坏状态 |
| 5 | 打开详情 → Esc 关闭 | `history.length` 不增长(打开 + 关闭对称);无重复历史项 |
| 6 | 全程 | 无重复历史项、无导航循环、无 React 状态更新警告 |

**回归**:现有 UI 测试(`tests/ui-panels.test.ts` 等)与 `pnpm typecheck` / `pnpm test` / `pnpm build` 必须仍过;不动模拟、存档、续跑。

## 6. 风险与不做

- 把"关闭面板"改成 `history.back()` 会**改变交互时序**(异步):需处理用户快速连开关;实现时保证 store 更新是幂等的。
- 与现有 7 处 `replaceState` 共存:必须逐个改成"合并 state",否则 `pushState` 写的描述会被覆盖。这是本阶段最容易出错的地方,测试 #2/#3 专门守它。
- **直接打开 / 刷新不恢复详情面板**:本轮明确不承诺,写进文档与测试。
- **不做**:不引路由库;不把视图写进 URL(分享某个详情是后续可选项);不改模拟 / RNG / 调度 / 存档 / 续跑;不顺手做阶段 3 的历史差异摘要;不动部署配置。

## 7. 交付与回滚

- 本阶段产出:本设计报告(单独提交)。
- 实现阶段将**独立提交**,可单独回滚;不与阶段 1a 的实现提交混在一起。
