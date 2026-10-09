# 开发说明

给想在自己电脑上运行、或者读代码的人。网站怎么用见 [README](../README.md)。

## 本地运行

需要 Node 22 以上和 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm dev        # 打开 http://localhost:5188
```

网址参数可以直接指定世界和画面,比如 `?seed=7&layer=cultures`(种子 7、民族图层)、`?seed=2024&layer=realistic&proj=robinson`(实景、罗宾森投影);
图层名见 `src/ui/mapLayers.ts`。
看世界时网页写进地址栏、复制出来的网址还带 `gen=`(生成器版本,`src/gen/edits.ts` 的 `GENERATOR_VERSION`;新建中的 `new=1` 不带):以后打开比现在旧的网址,提示条会说清世界变了什么。

网站账号、云同步、短链接和"我们的 AI"要连一个账号服务器(另一个独立程序,不在本仓库里),地址在构建时用环境变量 `VITE_AI_SERVER` 给;
不设这个变量(本地开发、自己部署的默认情况),这些入口都不出现,其余功能照常。

## 开发命令

```bash
pnpm typecheck             # 类型检查
pnpm test                  # 单元测试
pnpm stress                # 极端参数压力测试:出现 NaN 就失败,顺带打印各步耗时
pnpm smoke                 # 冒烟测试:无头浏览器里加载、回放、悬停、各界面流程
pnpm test:visual           # 画面回归:固定种子渲染缩略图,和 tests/visual/baseline/ 里的基准图逐像素比
pnpm test:visual --update  # 画面是有意改的:用当前画面更新基准图,和代码一起提交
pnpm build                 # 生产构建(输出到 dist/)
```

冒烟测试、画面回归和截图脚本要用无头浏览器,第一次先装:`pnpm exec playwright install chromium`。

截图和调试脚本(都会自己起一个临时服务,不用先 `pnpm dev`;截图默认写到 `snaps/`,这个目录不进仓库):

```bash
npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/x.png canvas              # 整张地图原图
npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/z.png zoom=4,0.7,0.3      # 滚轮放大 4 倍再截,看文字清不清楚
npx tsx scripts/snap.ts "seed=7&style=fantasy" snaps/c.png crop=800,300,300,200,3  # 局部放大
npx tsx scripts/globe-snap.ts "seed=7&civ=polities" snaps/g.png 30,20,1 0,90,1  # 地球仪(经度,纬度,缩放)
npx tsx scripts/gen-stats.ts 7             # 打印一个世界的统计数字(地形、国家、战争、王朝……)
npx tsx scripts/names-demo.ts              # 各种语感的地名样品
npx tsx scripts/subset-fonts.ts            # 重新裁剪地图字体(地名生成器加了新字、单测报"缺字"时)
```

## 代码结构

```
src/
├── gen/            世界生成:纯计算,不碰界面,在后台线程(也能在 Node)里跑
│   ├── geometry.ts     几何层:球面上的距离、噪声、纬度、最近的地块;生成和文明都通过它算,不直接拿 x、y 算
│   ├── mesh.ts         网格:几万个不规则地块
│   ├── tectonics.ts    板块、大陆轮廓、抬升
│   ├── erosion.ts      流水侵蚀与排水
│   ├── climate.ts      温度、风带、水汽、降水(加上洋流的冷暖)
│   ├── biomes.ts       生物群落
│   ├── seaice.ts       海冰
│   ├── world.ts        总流程、湖泊、河道
│   ├── raster.ts       网格 → 等距圆柱主图的像素
│   ├── history.ts      形成过程的回放帧
│   ├── terrainEdits.ts 改地形(火山、山脉、湖、抬升 / 下沉)
│   ├── currents.ts     洋流:海面冷暖偏差和表层流向
│   ├── characters.ts   作者的人物(存在使用者的修改里)
│   ├── edits.ts        使用者的修改:稳定键、改名、干预、地形修改、标记的格式;生成器版本
│   ├── savefile.ts     存档文件格式
│   ├── heightmap.ts    高度图编码
│   ├── names/          地名生成器
│   └── civ/            文明:宜居度、州、推演引擎、民族、城市与国家、战争、分合、王朝与世系、人物、同化迁徙、城市兴衰、
│                       宗教、国旗、干预、编年史、道路、地理名称
├── render/         画风:只读世界数据,切换画风不用重新生成
│   ├── realistic.ts / fantasy.ts / layers.ts   写实、手绘、数据图层
│   ├── projection.ts   各种地图投影
│   ├── globe*.ts       3D 地球仪(WebGL2,另有 CPU 退路)
│   ├── civ/            文明叠加层:国土、国界、道路、城镇符号、高亮
│   ├── flag/           国旗的画法
│   ├── marks.ts / trail.ts   作者标记、人物足迹
│   ├── labels/         地图文字:排版、避让、字体
│   └── export.ts       导出图片、图例
├── ai/             AI 接入:唯一入口 aiChat、各家服务商、设置与密钥、本地调用记录、提示词;agent/ 是助手(调用工具、试推演对照)
├── account/        网站账号、云同步、短链接(只在配了 VITE_AI_SERVER 时启用)
├── ui/             界面(React)
├── worker.ts / exportWorker.ts / globeWorker.ts   后台线程
└── main.tsx
scripts/            冒烟测试、压力测试、画面回归、截图、统计、字体裁剪等脚本(lib/ 是它们共用的零件)
tests/              单元测试(vitest);visual/baseline/ 是画面回归的基准图
public/fonts/       地图文字用的字体子集和许可证
```

几条约定:

- **同一个种子必须生成同一个世界**:所有随机数都从 `subSeed(seed, '用途')` 取,不用 `Math.random`;
  同一版本下,不同电脑、浏览器生成的地形和历史逐位一致(有单测核对)
- 改了生成算法、同一个种子得到的世界变了,就把 `src/gen/edits.ts` 里的 `GENERATOR_VERSION` 加一(旧存档靠它提示"来自旧版本")
- 性能预算:默认 36k 地块,生成 + 铺像素不超过 2 秒
