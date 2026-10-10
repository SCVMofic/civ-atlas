/**
 * 文明数据结构(文明生成的各个模块共用)。
 *
 * 规则:
 * - 文明数据单独放在 Civ 里,World 一个字段都不加。
 * - 加新功能时只在**相应接口的末尾**追加可选字段,不改已有字段。
 * - 所有数组都是类型化数组或普通对象,能在 worker → 主线程之间传(类型化数组走 transfer)。
 */
import type { World, Progress } from '../world';
import type { Intervention } from '../edits';

/** 文明纪年:0 = 第一批定居者;界面显示方式另定 */
export type Year = number;

/** 地块级:宜居度(habitat.ts) */
export interface Habitat {
  /** 宜居分 0..~40(0 = 不可居;水面为 0) */
  suitability: Float32Array;
  /** 人口上限(相对值,已按地块面积修正:默认精细度下一块普通大小的地块 = 宜居分本身) */
  capacity: Float32Array;
  /** 陆地(含湖):离海岸几块(1 = 海岸块);海:-1 近岸,-2 更远……(饱和在 ±127) */
  coastDist: Int8Array;
  /** 海岸陆地块相邻的海块数;1 = 天然良港(海湾)。其余地块为 0 */
  harbor: Uint8Array;
}

/**
 * 地区级:地块按地形聚成的"州"(regions.ts),生成后不再变。
 * CSR 写法和 Mesh.adjStart/adj 相同:地区 r 的地块是 cells[cellStart[r] .. cellStart[r+1])。
 */
export interface Regions {
  count: number;
  /** 地块 → 地区;水(海、湖)= -1 */
  of: Int32Array;
  /** 地区 → 治所地块(区内最宜居的一块,天然城址) */
  seat: Int32Array;
  cellStart: Int32Array;
  cells: Int32Array;
  /** 地区邻接(CSR),含陆上相邻、海峡、航线;邻居按编号升序 */
  adjStart: Int32Array;
  adj: Int32Array;
  /** 每条邻接边的类型,取值见 AdjKind */
  adjKind: Uint8Array;
  /** 两个治所之间的路程(世界单位,沿地块邻接累加;海上连接含海路) */
  adjLen: Float32Array;
  /** 面积(世界单位²) */
  area: Float32Array;
  /** 区内人口上限之和 */
  capacity: Float32Array;
  /** 主导群落(Biome 枚举) */
  biome: Uint8Array;
  /** 平均海拔(米) */
  elevation: Float32Array;
  /** 所在陆块 / 岛的编号(0 起,按陆块面积从大到小编号) */
  landmass: Int32Array;
  /** 每条邻接边的共享边界长度(世界单位,约等于相邻地块对数 × 地块间距);海上连接为 0 */
  adjBorder: Float32Array;
  /** 州名(按占据它的民族的语感起名;没人住的州为空串,界面上显示"第 N 州") */
  name?: string[];
  /**
   * 地形大事以后(regions.ts 的 reshapeRegions)才有:稳定键(gen/edits.ts 文件头"稳定键")按它定位,大事前后指同一个州。
   * keyOf:地块 → 州,这块地最早属于的那一州(后来沉进海里的也算);keySeat:州 → 治所地块,这州最早时的治所。
   * 没有 = 和 of、seat 一样
   */
  keyOf?: Int32Array;
  keySeat?: Int32Array;
}

/** 地区邻接边的类型 */
export const enum AdjKind {
  Flat = 0,
  River = 1,
  Mountain = 2,
  Strait = 3,
  SeaRoute = 4,
}

export type CultureKind = 'farm' | 'nomad' | 'sea' | 'highland' | 'river' | 'lake' | 'forest';

/** 民族 */
export interface Culture {
  id: number;
  name: string;
  /** 地名语感 id(地名生成器 src/gen/names/ 的语感) */
  style: string;
  /** 按份数配地名风格(CivParams.names)时:自动时会挑的语感(界面上「照自动」按它折份数);自动时不写 */
  autoStyle?: string;
  kind: CultureKind;
  /** 发源地区 */
  hearth: number;
  born: Year;
  expansionism: number;
  color: [number, number, number];
  /** 阶段 3 同化与迁徙(assimilation.ts):最后一州也改换了民族的年份(民族消亡)。还在 = 不给 */
  ended?: Year;
  /**
   * 阶段 3 同化与迁徙:成规模的迁徙(按年份排好),每一波一条:年份、方位(迁出地 → 迁入地,屏幕上 y 向下 = 向南)。
   * 迁入了哪些州见史事里同一年、同一民族的 migrate;编年史写"西迁"用
   */
  migrations?: { year: Year; dir: MigrationDir }[];
}

/** 迁徙的方位 */
export type MigrationDir = '东' | '南' | '西' | '北';

/** 城镇 */
export interface Settlement {
  id: number;
  cell: number;
  region: number;
  culture: number;
  name: string;
  founded: Year;
  /** 阶段 3:被毁 / 废弃(城市兴衰,cities.ts:战争里攻下时被毁)。这一年起人口为 0,地图上留一处"故城遗址" */
  ended?: Year;
  /** S 形成长的上限 */
  capacity: number;
  /** 成长速度(每年) */
  growth: number;
  port: boolean;
  /** 从哪一年起是国都(国都人口上限更高,见 growth.ts 的 populationAt)。不是国都 = 不给 */
  capitalFrom?: Year;
  /**
   * 阶段 3 城市兴衰:做国都的年份段(按先后;polities.ts 的 addPolity / moveCapital / endPolity 维护)。
   * until 不给 = 现在还是国都;polity = 哪国的国都。populationAt 按它算国都加成:立都后渐渐加上去,
   * 迁都 / 亡国后在 CAPITAL_DECLINE 年里渐渐退掉(旧都衰落)。没有这一项、只有 capitalFrom 的(旧数据)= 从 capitalFrom 起一直是国都
   */
  capitalSpans?: { from: Year; until?: Year; polity: number }[];
  /** 阶段 3 城市兴衰:被洗劫(按先后)。loss = 当时人口折损的比例(0..1),之后按 SACK_RECOVER 年慢慢恢复(见 growth.ts) */
  sacks?: { year: Year; loss: number }[];
  /**
   * 阶段 3 城市兴衰:这座城是在哪座被毁的城(Settlement id)的故址上重建的(同一州、同一地块)。
   * 同族重建沿用旧名;换了民族的另起新名。不是重建的 = 不给
   */
  rebuilds?: number;
}

/** 国家 */
export interface Polity {
  id: number;
  /** 国名词根;全称 = 词根 + 当年的国号形态 */
  name: string;
  culture: number;
  /** 国都:Settlement id */
  capital: number;
  founded: Year;
  ended?: Year;
  kind: CultureKind;
  expansionism: number;
  color: [number, number, number];
  /** 国号一系(见 growth.ts 的 POLITY_FORMS):农耕一系 / 游牧汗国一系 / 海洋城邦共和一系 */
  lineage?: PolityLineage;
  /** 国号档位的变化("升格"事件写这里;按年份排好序):第一条是立国那年 */
  titles?: { year: Year; tier: number }[];
  /** 东方语感的国家:国号走中式写法("大昌王朝"而不是"昌帝国"),见 growth.ts 的 easternTitles */
  eastern?: boolean;
  /**
   * 国都的变迁(阶段 3;按年份排好序):第一条是立国那年、= capital。迁都就往后加一条。
   * 某一年的国都用 growth.ts 的 capitalAt(p, 年份) 查,别直接读 capital(capital 只是立国时的国都)
   */
  capitals?: { year: Year; settlement: number }[];
  /**
   * 阶段 3 分合(politics.ts):从哪国分出来的(分裂 / 独立、复国时起兵反抗的那一国)。
   * 分出来的国家没有"立国"史事,只有一条 split(a = 本国,b = parent);立国就不给
   */
  parent?: number;
  /** 阶段 3 分合:复的是哪个亡国(国名沿用故国国名加"后 / 南 / 北…"前缀,编年史写"复国")。不是复国 = 不给 */
  restores?: number;
  /**
   * 阶段 3 王朝更替(dynasty.ts;按年份排好序):第一条 = 立国那年,改朝换代一次往后加一条。没改朝换代过 = 不给。
   * - name:东方语感 = 这一朝的国名词根(大昌 → 大景:地图上的国名跟着年份变,全称仍按当年的国号档位写,见 growth.ts 的 polityName);
   *   西幻语感 = 王室的名字("卡诺",写作"卡诺王朝";国名不变)。推演时留空,推演结束后由起名(naming.ts)填;
   *   第一朝东方 = 国名词根 name,西幻 = 按立国时的国都起
   * - seat:这一朝兴起的城(Settlement id,王室的根据地;第一朝 = 立国时的国都)。西幻的王朝名借它的城名
   * 某一年是哪一朝用 growth.ts 的 dynastyAt(p, 年份) 查
   */
  dynasties?: { year: Year; name: string; seat: number }[];
}

/** 国号一系 */
export type PolityLineage = 'realm' | 'khanate' | 'republic';

/** 道路 / 航线 */
export interface Route {
  kind: 'road' | 'trail' | 'sea';
  /** 经过的地块;画的时候再平滑 */
  cells: Int32Array;
  built: Year;
  abandoned?: Year;
}

/** 地理实体:山脉 / 海域 / 大河 / 湖泊 / 岛屿 / 荒漠…… */
export interface Place {
  kind: 'sea' | 'mountains' | 'river' | 'lake' | 'island' | 'desert';
  name: string;
  /** 按哪个民族的语感起名(海洋为 -1) */
  culture: number;
  /** 标注用的锚点路径 x,y,x,y…(山脊线、河道、海域中心弧) */
  path: Float32Array;
  /** 重要度,决定字号和从哪一级缩放开始显示 */
  rank: number;
  /**
   * 实体大小(世界单位):海域 = 离岸最远距离;山脉 = 山脊长;河 = 半河宽(标注要让开);
   * 湖 / 岛 / 荒漠 = 等面积圆的半径
   */
  size?: number;
  /** 锚点地块(以后悬停、按民族换语感用) */
  cell?: number;
  /**
   * 地形大事以后还是同一处的(keepPlaceNames 认出来的):稳定键按第一件大事以前那一处的锚点地块算,
   * 锚点跟着地形挪了也是同一个键(改的名在大事前后都认得)。没有这一项 = 按 cell
   */
  keyCell?: number;
  /** 西幻风地名的拉丁原形(如 "Aldor Mountains");湖、岛、荒漠借用的是别的名字的原形,仅供参考 */
  latin?: string;
  /**
   * 阶段 4 改名(gen/edits.ts 的 applyNames 填):用户改过名时,原来的名字。生成出来的没有这一项。
   * 画风按它分大洋 / 海 / 海湾的字号("北大洋"改成"饕餮海",字照旧按大洋写)
   */
  defaultName?: string;
}

/**
 * 史事的种类(阶段 3):编年史的原料。字段的含义按种类不同,没用到的字段为 −1:
 *
 * | 种类      | 说明       | a            | b                       | region          | settlement | war      |
 * |-----------|------------|--------------|-------------------------|-----------------|------------|----------|
 * | found     | 立国       | 国家         | −1                      | 国都所在州      | 国都       | −1       |
 * | rank      | 升格 / 降格 | 国家(新国号用 polityName(国家, 年份) 查) | −1 | 国都所在州 | 国都 | −1 |
 * | war       | 宣战       | 攻方         | 守方                    | −1              | **援盟**(阶段 4 干预的结盟):应哪国之约参战 —— 守方刚向这个盟国宣战;不是援盟 = −1 | 战争编号 |
 * | conquer   | 攻占一州   | 攻方         | 原主(−1 = 部落地带)   | 州              | 州里的城(没有 = −1) | 战争编号(不在战争里 = −1) |
 * | peace     | 议和 / 战争结束 | 攻方    | 守方                    | **割让的州数** n(议和时划清边界,两国互割飞地:紧挨在这条 peace 前面的 n 条 conquer 就是割让的,不是打下来的;没割让 = −1) | −1 | 战争编号 |
 * | fall      | 灭亡       | 灭亡的国家   | 灭它的国家(−1 = 自己瓦解 / 并入见 merge;−2 = 亡于天灾:国土在地形大事里全沉入海中、或国都毁了无处可迁) | 最后失去的州 | −1 | 战争编号 / −1 |
 * | capital   | 迁都(国都失守 / 主动迁都) | 国家 | −1(−2 = 地形大事里国都沉了、毁了,迁都) | 新国都所在州 | 新国都 | 战争编号(被迫迁都,战争里国都失守)/ −1(主动迁都) |
 * | split     | 分裂 / 独立 / 复国 | 新国家 | 原来的国家(复国:从哪国手里起兵;复的是哪国见新国家的 Polity.restores) | 起事的州 | 新国都 | −1 |
 * | merge     | 合并       | 并入的一方(继续存在) | 被并掉的国家(它的 ended = 这一年,不另记 fall) | −1 | −1 | −1 |
 * | dynasty   | 改朝换代 / 王室更迭 | 国家(同一个国家编号;新朝见 Polity.dynasties 的最后一条) | −1 | 新朝的根据地(兴起的州) | 新国都(新朝定都根据地时 ≠ 原国都,Polity.capitals 同一刻加一条,不另记 capital) | −1 |
 * | migrate   | 迁徙:一波迁徙迁入的一州(同一波的几州同一刻、连着记;方位记在 Culture.migrations) | **民族**:迁徙的民族 | **民族**:迁入地原来的民族(−1 = 无人之地) | 迁入的州 | 州里的城(没有 = −1) | **国家**(借用这一列):起因 —— 逃避它的兵锋(它的民族 ≠ a),或随它的征服而来(它的民族 = a) |
 * | assimilate | 同化:一州改换民族 | **民族**:新民族 | **民族**:原民族 | 州 | 州里的城(没有 = −1) | **国家**(借用这一列):统治这一州的国家 |
 * | vanish    | 民族消亡:最后一州也改换了民族 | **民族**:消亡的民族 | **民族**:取代它的民族 | 最后的州 | −1 | −1 |
 * | sack      | 洗劫(城市兴衰,cities.ts) | 攻方 | 原主 | 州 | 被洗劫的城(折损见 Settlement.sacks 的最后一条) | 战争编号 |
 * | ruin      | 毁城 | 攻方 | 原主 | 州 | 被毁的城(它的 ended = 这一年) | 战争编号 |
 * | rebuild   | 重建 | 当时的国家(−1 = 部落地带) | −1 | 州 | 新城(被毁的旧城见新城的 Settlement.rebuilds) | −1 |
 * | decline   | 旧都衰落 | 它原是哪国的国都 | −1 | 州 | 旧都(失去国都之位的年份见 Settlement.capitalSpans) | −1 |
 * | intervene | 干预(阶段 4,interventions.ts):一条干预在这一刻生效(种类、字段见 Civ.interventions 里的那一条;各种类 a / b / region / settlement 的含义见下面) | 国家 A | 见下 | 见下 | 见下 | **干预的下标**(Civ.interventions 里第几条,借用这一列) |
 * | upheaval  | 地形大事(upheaval.ts):这一刻地形变了(经过见 Civ.upheavals 里的那一件) | **第几件大事**(Civ.upheavals 的下标) | −1 | 受灾最重的州 | −1 | −1 |
 * | sunk      | 城在地形大事里没了(它的 ended = 这一年;沉入海的不再重建) | 当时的国家(−1 = 部落地带) | 1 = 城址沉入海中,0 = 毁于火山 | 州 | 那座城 | **第几件大事**(借用这一列) |
 * | battle    | 战役:攻方这一仗没打下来(守方守住了;打下来的记 conquer) | 攻方(守方反攻失败时是原守方) | 守方 | 攻打的州 | 州里的城(有城 = 攻城,没有 = 野战;−1) | 战争编号 |
 *
 * 洗劫、毁城和那一次攻占同一刻,记在那条 conquer **前面**(conquer、被迫迁都、灭亡照旧紧挨着,编年史里排回攻占后面)。
 * 议和割让的州也各记一条 conquer(a = 得到的一方,b = 割出的一方),连着记在那条 peace 前面,条数记在 peace 的 region 列。
 *
 * migrate / assimilate / vanish(阶段 3 同化与迁徙,assimilation.ts)的 a、b 是民族编号,不是国家。
 * intervene(阶段 4 干预)各种类的字段:
 *   不许灭 / 禁止分裂 / 不许扩张:a = 国家,b = −1,region / settlement = A 当时的国都所在州 / 国都
 *   结盟 / 宣战:a = 国家 A,b = 国家 B(键指不到 = −1),region / settlement = A 当时的国都所在州 / 国都
 *   划州:a = 得到它的国家,b = 原主(−1 = 部落地带;**−2 = 州里没人住,没划成**),region = 州,settlement = 州里的城(没有 = −1)
 *   立国:a = 新国家(**−1 = 州里没人住,没立成**),b = 原主(新国从哪国分出来;−1 = 部落地带),region = 州,settlement = 新国都
 *   迁都:a = 国家,b = 城所在州此刻的主人(**= a 才迁得成**;−1 = 部落地带;−2 = 城已毁),region / settlement = 那座城所在州 / 那座城
 *     (新历史里还没有这座城 = −1 / −1)
 *   宣战的干预打成了,紧跟在它后面(同一刻)记一条 war;没有 = 没打成(两国不接壤 / 已在交战 / 有一方已亡)。
 *   结盟时两国正在交战、不许扩张的国家正在打它挑起的仗,紧跟着记议和(peace)。
 *   立国紧跟着记一条 found(新国家;编年史并进干预那一条),原主的国都在这州就再记原主迁都(capital,war = −1)或亡国(fall,b = 新国家);
 *   划州同样(原主迁都 / 亡国);迁都迁成了紧跟着记一条 capital(war = −1;编年史并进干预那一条)。
 *   国家 A 的键指不到(新历史里没有这国 / 那一刻还没立国)就不记(立国除外:立国一定记)。
 * battle(人物与战役,wars.ts 的战役):每一仗都算过胜负,打下来的记 conquer,没打下来的(攻方败退、守方反攻没夺回)记一条 battle;
 *   攻方从哪种边打过去记在 Annal.via。不改归属,只是让编年史写得出"某某之战"。
 * upheaval 之后紧跟着(同一刻)记这件大事的后果:sunk(没了的城,国都在前)、迁都(capital,war = −1)、亡国(fall,b = −2),
 * 编年史并进 upheaval 那一条。
 * 阶段 3 以后再有新种类(瘟疫……)在末尾往下加。
 */
export type AnnalKind =
  | 'found'
  | 'rank'
  | 'war'
  | 'conquer'
  | 'peace'
  | 'fall'
  | 'capital'
  | 'split'
  | 'merge'
  | 'dynasty'
  | 'migrate'
  | 'assimilate'
  | 'vanish'
  | 'sack'
  | 'ruin'
  | 'rebuild'
  | 'decline'
  | 'intervene'
  | 'battle'
  | 'upheaval'
  | 'sunk';

/**
 * 一条史事(阶段 3):推演里各事件处理函数用 CivSim.record 往 Civ.annals 里记,编年史(界面上的事件列表)只读它。
 * 和变化日志的分工:日志记"哪一州归了谁"(画图用,回放按它翻),史事记"发生了什么事"(讲故事用)。
 */
export interface Annal {
  year: Year;
  kind: AnnalKind;
  a: number;
  b: number;
  region: number;
  settlement: number;
  war: number;
  /** 战役(battle)才有:攻方从哪种边打过去(AdjKind:平地、跨河、翻山、海峡、航线) */
  via?: AdjKind;
}

/** 变化日志里的"哪一层" */
export const enum Layer {
  Culture = 0,
  Polity = 1,
}

/** 变化日志(按时间排序;结构数组,可增长;只用前 size 条) */
export interface ChangeLog {
  size: number;
  year: Float32Array;
  region: Int32Array;
  layer: Uint8Array;
  /** 新归属;-1 = 无 */
  value: Int16Array;
  /** 事件类型(编号表在 sim.ts) */
  cause: Uint8Array;
}

export interface Checkpoint {
  year: Year;
  culture: Int16Array;
  polity: Int16Array;
}

export interface Civ {
  seed: number;
  endYear: Year;
  habitat: Habitat;
  regions: Regions;
  cultures: Culture[];
  settlements: Settlement[];
  polities: Polity[];
  routes: Route[];
  places: Place[];
  /** endYear 时各地区的民族(-1 = 无) */
  culture: Int16Array;
  /** endYear 时各地区的国家(-1 = 无) */
  polity: Int16Array;
  log: ChangeLog;
  checkpoints: Checkpoint[];
  /** 史事(阶段 3):立国、升格、战争、攻占、灭亡、迁都、分裂、合并……按年份排好序,同一年按发生先后 */
  annals: Annal[];
  /**
   * 这颗星球能不能有文明。false = 可居的地方太少(比如几乎全被冰雪覆盖),
   * 这时只有宜居度和州(地理),民族 / 城镇 / 国家 / 道路都是空的。
   */
  viable: boolean;
  /** 整个世界的地名风格(CivParams.names,清理过的:语感 → 份数);自动 = 不写 */
  names?: import('../names').NameMix;
  /**
   * 民族扩张的时间标定:走一个"标准路程"(平地、普通地形、扩张性 1)要多少年。
   * 按世界自动标定(默认到第 3000 年约九成可居州有人住;改过地形的世界按没改地形时的同一颗星球标定,见 index.ts 的 planetTempo),
   * CivSim.fromCiv 接着推时要用。
   */
  spreadYears?: number;
  /**
   * 国家扩张的快慢:国家在国都旁边走一个"标准路程"要多少年(见 polities.ts,离国都越远越慢)。
   * CivSim.fromCiv 接着推时要用
   */
  polityYears?: number;
  /**
   * 阶段 4 干预:这份历史是带着哪些干预推出来的(清理过的列表,见 gen/edits.ts;史事 intervene 的 war 列是它的下标)。
   * 没有干预 = 不给。CivSim.fromCiv 接着推时默认带着它
   */
  interventions?: Intervention[];
  /**
   * 用户改过的州名(阶段 4,gen/edits.ts 的 applyNames 写入;下标 = 州编号,空串 = 用 regions.name)。
   * 不改 regions 本身:画国土、国界的缓存按 civ.regions 存,改州名不用重画
   */
  regionNames?: string[];
  /**
   * 人物(people.ts):各国的历代君主和战争里的统帅。推演结束后按历史"贴"上去,国界、兴亡、战争胜负一个都不变。
   * 下标 = Person.id;先是君主(按国家编号、即位先后),再是统帅(按第一次领兵的先后)。没有文明 = 空
   */
  people?: Person[];
  /**
   * 信仰(religion.ts):各族的民间信仰、几个大教的创立和传播、各国的国教、教派分立。
   * 推演结束后按历史"贴"上去,国界、兴亡、战争、人物一个都不变。没有文明 = 不给
   */
  religion?: Religion;
  /**
   * 地形大事(upheaval.ts;gen/edits.ts 文件头"地形大事"):按年份排,同一年的合成一件。下标 = 史事 upheaval 的 a。
   * 没有 = 不给。regions、places、routes 是最后一件大事以后的;更早的各段见 eras
   */
  upheavals?: UpheavalFact[];
  /**
   * 地形大事以前的各段(和 upheavals 一一对应):第 i 段到 upheavals[i].year 为止(不含),那段时间的宜居度、州、地名、道路。
   * 州的编号各段一样(后面的段只多出新冒出来的州);归属数组(culture、polity、检查点、日志)按最后一段的州数。没有地形大事 = 不给
   */
  eras?: CivEra[];
  /**
   * 只有地图上画的是更早一段时才有(ui/eras.ts):整段历史那一份(最后一段的州、地名,套好改名)。
   * 编年史这类按整段历史算的用它(后面才冒出来的州也认得),地图用这一份本身
   */
  history?: Civ;
}

/** 地形大事以前的一段:到 until 年为止(不含) */
export interface CivEra {
  until: Year;
  habitat: Habitat;
  regions: Regions;
  places: Place[];
  routes: Route[];
}

/** 一件地形大事在这份历史里的经过(地块、州按大事前后比出来;国家是那一刻、变化之前的主人) */
export interface UpheavalFact {
  year: Year;
  /** 有哪几种修改(火山喷发 volcano、地震抬升 raise、海水漫进来 sink;按第一次出现的先后) */
  kinds: ('volcano' | 'raise' | 'sink')[];
  /** 合进这一件的是作者列表(WorldEdits.upheavals)里的哪几件(下标) */
  items: number[];
  /** 变成水 / 变成陆地的地块数 */
  sunk: number;
  risen: number;
  /** 受灾最重的州(火山 = 火山所在的州)和受灾最重的国家:那州当时的主人;那州无主 = 沉没、沉掉一块、长出新陆地的州最多的国家(火山不算;都无主 = −1) */
  region: number;
  polity: number;
  /** 一块陆地也不剩的州、当时各自的国家(−1 = 无主) */
  drowned: number[];
  drownedBy: number[];
  /** 沉掉一块、还剩陆地的州 */
  shrunk: number[];
  /** 新陆地:并进的老州、新划出来的州(编号接在大事前的州后面) */
  grown: number[];
  added: number[];
  /** 隆起的新陆地连起了大事前分开的两块陆地:两边挨着新陆地的州、当时各自的国家;没有 = 不给 */
  joined?: [number, number];
  joinedBy?: [number, number];
  /** 早先毁了的城(遗址)、城址这回成了海、湖的(城的编号;没有 = 不给) */
  ruins?: number[];
}

/** 信仰的种类:民间信仰(每个民族自带)、大教、从大教分出的教派 */
export type FaithKind = 'folk' | 'great' | 'sect';
/** 大教 / 教派的类型 */
export type FaithForm = '一神' | '多神' | '二元' | '哲理' | '修行';

/** 一种信仰。下标 = Faith.id:先是各族的民间信仰(编号 = 民族编号),再是大教和教派(按创立先后) */
export interface Faith {
  id: number;
  kind: FaithKind;
  /** 教名;民间信仰 = 族名 + 祖灵(东方)/ 旧神(西幻) */
  name: string;
  /** 大教 / 教派 */
  form?: FaithForm;
  /** 民间信仰:哪个民族的 */
  culture?: number;
  /** 教派:从哪个大教分出来 */
  parent?: number;
  /** 大教 / 教派:创立(分出)的年份 */
  founded?: Year;
  /** 大教:圣城(Settlement 编号,创教的那座城) */
  holy?: number;
  /** 大教:创教者 */
  founder?: { name: string; born: Year; died: Year };
  /** 教派:在哪一国分出来的(Polity 编号) */
  polity?: number;
  /** 教派:分出时那国的国都(Settlement 编号) */
  seat?: number;
  color: [number, number, number];
}

/** 信仰的大事:创教、传入一国、立为国教、教派分立、圣城被异教之国夺取 */
export type FaithEventKind = 'found' | 'enter' | 'state' | 'schism' | 'holy';

export interface FaithEvent {
  year: Year;
  kind: FaithEventKind;
  /** 哪种信仰(教派分立 = 新的教派) */
  faith: number;
  /** 哪一国(创教 = 圣城当时的主人;没有 = −1) */
  polity: number;
  /** 事发的州(−1 = 没有) */
  region: number;
  /** 事发的城(−1 = 没有) */
  settlement: number;
  /** 立国教、教派分立:当时在位的君主(Person 编号) */
  ruler?: number;
  /** 圣城易手:从哪国手里夺来 */
  from?: number;
}

/** 一国奉某种信仰为国教的一段时间 */
export interface StateFaith {
  polity: number;
  faith: number;
  from: Year;
  /** 结束的年份(改奉别的、分出教派、亡国);到结束年份还奉着 = 不给 */
  until?: Year;
}

export interface Religion {
  faiths: Faith[];
  /** 按年份排好 */
  events: FaithEvent[];
  states: StateFaith[];
  /** 各州信仰的变化日志(年份、州、新的信仰;−1 = 没人住),按年份排好 */
  log: { size: number; year: Float32Array; region: Int32Array; value: Int16Array };
  /** 每 100 年一份各州的信仰(按年份递增;那一年的变化已经算进去) */
  checkpoints: { year: Year; faith: Int16Array }[];
}

/**
 * 人物:君主或统帅。名字、生卒、在位都是推演结束后按国家的兴亡、王朝更替、战争排出来的(people.ts),
 * 随机数按国家的位置锚 + 第几位取:干预某一年之前已经下台的君主和不干预时一样(称号、编号可能变,见 people.ts)。
 */
export interface Person {
  id: number;
  /** ruler 君主、general 将领、prince 没即位的宗室(世系里补出来的,见 lineage.ts) */
  role: 'ruler' | 'general' | 'prince';
  /** 哪国的人 */
  polity: number;
  /** 本名:东方中式 = 姓 + 名("李昭");东方边塞、山海和西幻 = 名("咄苾""阿尔德里克") */
  name: string;
  born: Year;
  /** 卒年;到结束年份还在世 = 不给 */
  died?: Year;
  /** 结局(君主:怎么失去君位的;统帅:寿终还是战死)。还在位 / 还在世 = 不给 */
  fate?: PersonFate;
  /** 君主:即位的年份 */
  from?: Year;
  /** 君主:失去君位(去世、被废、亡国)的年份;到结束年份还在位 = 不给 */
  until?: Year;
  /** 君主:第几朝(Polity.dynasties 的下标;没改朝换代过 = 0) */
  dynasty?: number;
  /** 君主:怎么即位的 */
  rise?: RulerRise;
  /**
   * 君主的称号(去世以后才有;还在位 = 空串):东方 = 庙号("太祖""世宗")或谥号 + 爵("穆公""庄王",亡国之君"哀帝");
   * 西幻 = 同名君主的序数("三世")或"大帝"。称呼的写法见 peopleText.ts
   */
  title?: string;
  /** 领兵打过的仗(君主亲征也记在这里) */
  commands?: PersonCommand[];
  /** 父亲(Person.id;君主和宗室才有;一朝的第一位、共和国执政官、将领没有) */
  parent?: number;
}

/** 一次领兵:哪场战争、哪一方、任期 */
export interface PersonCommand {
  war: number;
  /** 0 = 攻方(宣战的一方),1 = 守方 */
  side: 0 | 1;
  from: Year;
  until: Year;
  /**
   * 经手的第一件、最后一件事在 Civ.annals 里的下标(宣战,或者那场战争里的战役、攻占)。
   * 同一刻接连几件事中途换了人(上一位战死)时,靠它分清哪一件是谁打的
   */
  first: number;
  last: number;
}

/**
 * 人物的结局:
 * - 君主:died 寿终、murdered 遇弑、deposed 被权臣所废(改朝换代)、overthrown 新朝起兵、死于兵乱、
 *   fell 亡国殉国、surrendered 亡国出降、fled 亡国出奔(国家瓦解也算)、merged 国并入他国(归附)、retired 共和国执政官任满
 * - 统帅:died 寿终、battle 战死
 */
export type PersonFate = 'died' | 'murdered' | 'deposed' | 'overthrown' | 'fell' | 'surrendered' | 'fled' | 'merged' | 'retired' | 'battle';

/** 君主怎么即位的:found 立国、rebel 叛离自立(分裂)、restore 复国(故国王室之后)、usurp 权臣篡位、rise 起兵代之(改朝换代)、heir 继位 */
export type RulerRise = 'found' | 'rebel' | 'restore' | 'usurp' | 'rise' | 'heir';

export interface CivParams {
  /** 文明史长度(年),默认 3000 */
  endYear: Year;
  cultures: number | 'auto';
  polities: number | 'auto';
  /** 每州目标面积(世界单位²)。默认约 900 个州(陆地比例 33% 时) */
  regionArea: number;
  /** 扩张快慢总系数 */
  pace: number;
  /** 民族诞生年份的跨度(年):第一个民族在第 0 年,其余在这么多年里陆续出现。默认 400;0 = 同时诞生 */
  birthSpan?: number;
  /** 阶段 4 干预(gen/edits.ts 的 Intervention;推演前先清理)。不给 / 空 = 不干预 */
  interventions?: readonly Intervention[];
  /**
   * 改过地形的世界用的扩张节拍:planetTempo(同样的世界参数)的结果,调用方缓存了传进来,省得每次多生成一遍没改过的地形;
   * null = 没改过的星球长不出文明(按这个世界自己标定)。不给 = 现算。没改地形的世界不看它
   */
  tempo?: number | null;
  /**
   * 地形大事(upheaval.ts 的 upheavalSteps 排好、生成好的):按年份排(同一年已合成一件),各带改后的世界
   * (第 k 件 = 原来的地形套上前 k 件大事的修改)。不给 / 空 = 没有。年份不在 (0, endYear) 里的不算
   */
  upheavals?: readonly import('./upheaval').UpheavalStep[];
  /**
   * 整个世界的地名风格(gen/names 的 NameMix):每种语感占几份,各民族只在有份的几种里挑、占的地方尽量合比例。
   * 不给 / 一份都没有 = 自动:每个民族按发源地从全部语感里挑(和没有这一项逐字节一样)。只管起名,不改历史
   */
  names?: import('../names').NameMix;
}

/**
 * 推演之后定下的名字、配色里要"钉住"的(地形大事,见 upheaval.ts):大事那一年以前已经有的民族、州、国家、城、王朝,
 * 名字和配色照没有这件大事时的那份历史 —— 起名、配色本来看整段历史(结束时的疆域、历来的邻国),不钉住的话,
 * 大事之后的历史一变,之前的名字也会跟着变。钉住的先占上,新出现的照常起名、配色,不和它们撞
 */
export interface NamePins {
  /** 民族(推演前就定了,整份钉住):族名、语感、配色 */
  cultures?: { name: string; style: string; autoStyle?: string; color: [number, number, number] }[];
  /** 州名(下标 = 州;没有 = 不钉) */
  regionNames: (string | undefined)[];
  /** 国家:国名词根、配色、东方语感;dynasties = 各朝的朝名(下标 = Polity.dynasties 的下标;没有 = 不钉) */
  polities: Map<number, { name?: string; color?: [number, number, number]; dynasties: (string | undefined)[] }>;
  /** 城名 */
  settlements: Map<number, string>;
}

// ---- 对外函数的签名(实现分别在 index.ts / timeline.ts / polities.ts) ----

export type GenerateCiv = (world: World, p?: Partial<CivParams>, progress?: Progress) => Civ;
/** 任意年份的归属(最近检查点 + 补日志);out 可复用,避免分配 */
export type OwnersAt = (
  civ: Civ,
  year: Year,
  out?: { culture: Int16Array; polity: Int16Array },
) => { culture: Int16Array; polity: Int16Array };
export type PopulationAt = (s: Settlement, year: Year) => number;
