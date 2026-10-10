/**
 * AI 释名 / 起名(阶段 5)的提示词:给地图上的一个名字整理材料(语感、地理、历史),拼成发给 aiChat 的消息;
 * 解析起名回来的 JSON。纯函数,不碰 DOM、不调 AI(界面在 src/ui/AiNamePanel.tsx)。
 *
 * - 对象(NameTarget):国家(东方改朝换代过的,可以指定第几朝 —— 改 / 释的是那一朝的国号)、城、地理实体
 *   (山河湖海岛漠)、民族、州。nameInfo 给出它的稳定键、现在的名字、语感(界面用,很便宜)
 * - 材料(nameMaterial):和时间轴拖到哪一年无关,讲的是它的一生 ——
 *   语感(12 种,见 STYLE_GUIDES:中式讲字义典故、西幻讲拟造的词源)、地理(位置、地貌、气候、临近的山川)、
 *   历史(建城 / 立国年份、国号变迁、国都、兴衰、归属变迁、编年史里和它有关的几条)、同一语感的其他名字(给 AI 找语感)
 * - 释名:explainRequest → 100–250 字的"名字由来"(流式);起名:suggestRequest(json: true)→ parseSuggestions
 * - 过时检查:nameStamp 只由年份、地块等数字拼成(不含任何名字),历史改写 / 改地形后会变,改名不会变;
 *   释名存下时记着当时的名字和 stamp,界面据此标"写于改名前""写于历史改写前"
 *
 * 不引起名器(gen/names)和推演代码,免得主线程打包地名词库:语感的说明在本文件里另写一份(单测核对和起名器一致)。
 */
import type { Civ, Place, Polity } from '../../gen/civ/types';
import type { Raster } from '../../gen/raster';
import { BIOMES } from '../../gen/biomes';
import { mulberry32, subSeed } from '../../gen/util';
import { pickStyle, type NameMix } from '../../gen/names/mix';
import { KIND_INFO, cultureLabel, regionLabel, regionNamed } from '../../gen/civ/display';
import {
  SETTLEMENT_RANKS,
  capitalAt,
  easternTitles,
  polityName,
  polityTitles,
  populationAt,
  populationLabel,
  settlementRank,
} from '../../gen/civ/growth';
import { ownersAt, type Owners } from '../../gen/civ/timeline';
import { MAJOR, buildChronicle, cnNumber, type ChronicleEntry } from '../../gen/civ/chronicle';
import { NAME_MAX, cleanName, cultureKey, dynastyKey, placeKeyOf, polityKey, regionKey, settlementKey, type KeyKind } from '../../gen/edits';
import { habitatScore, habitatWord } from '../../ui/civDescribe';
import type { AiMessage, AiRequest } from '../types';

// ---------------------------------------------------------------------------
// 语感(12 种):和 gen/names 的 NAME_STYLES 一一对应、顺序一致(单测核对 id、label、desc)

export interface StyleGuide {
  id: string;
  label: string;
  family: 'western' | 'eastern';
  desc: string;
  /** 释名时怎么讲 */
  explain: string;
  /** 起名时怎么起 */
  suggest: string;
}

export const STYLE_GUIDES: readonly StyleGuide[] = [
  {
    id: 'imperial',
    label: '帝国(拉丁风)',
    family: 'western',
    desc: '古罗马式的庄重感,多以 -ia、-ona、-entia 收尾,如 阿尔多里亚、塞雷诺纳',
    explain:
      '拟造语言近于拉丁语,庄重古典。国名常以 -ia / -oria / -entia / -onia 收尾(意为"……之地""……之国"),城名常以 -ona / -enna / -ano / -ara 收尾。' +
      '讲词源时写出拉丁字母原形,拆成词根和词尾,词根可取光、金、高、强、海、鹰、胜利之类的意思。',
    suggest: '音译成中文,庄重典雅;国名四五个字、多以"亚"收尾(如 阿尔多里亚、塞雷诺纳),城名三四个字(如 卡斯泰纳、维拉诺)',
  },
  {
    id: 'kingdom',
    label: '王国(英法风)',
    family: 'western',
    desc: '中世纪骑士王国,城镇多带 -顿、-维尔、-堡、-福德,如 卡斯特维尔、雷文福德',
    explain:
      '拟造语言近于中古英语、古法语。城名多是"词根 + 地理词尾":-ton 围起来的村镇、-ford 浅滩渡口、-wick 聚落、-bury 堡寨、-ville 城镇、' +
      '-mont 山、-port 港、-haven 避风港、-bridge 桥、-dale 山谷、-field 原野、-chester 古营垒;国名多为 -ia / -land。讲词源要把词根和词尾各自的意思讲出来。',
    suggest: '音译为主,词尾用固定译法(-顿、-福德、-威克、-伯里、-维尔、-堡、X港),三到五个字(如 卡斯特维尔、雷文福德、阿什伯里)',
  },
  {
    id: 'nordic',
    label: '北境(北欧风)',
    family: 'western',
    desc: '维京与冰原,常见 -海姆、-加德、-维克、-霍尔姆,如 斯卡尔海姆、拉夫维克',
    explain:
      '拟造语言近于古诺尔斯语:-heim 家园、-gard 围地与疆域、-vik 海湾、-holm 小岛、-by 村庄、-stad 城镇、-borg 城堡、-sund 海峡、-nes 岬角、' +
      '-dal 山谷、-fjord 峡湾;词根多与狼、鸦、熊、冰霜、岩石、铁、雷有关。讲词源要写出原形并拆开讲。',
    suggest: '音译,常见 -海姆、-加德、-维克、-霍尔姆、-比、-斯塔德(如 斯卡尔海姆、拉夫维克),冷峻硬朗',
  },
  {
    id: 'slavic',
    label: '雪原(斯拉夫风)',
    family: 'western',
    desc: '东欧森林与雪原,城市多叫 -格勒、-斯克、-沃,如 别洛格勒、兹拉托沃',
    explain:
      '拟造语言近于古斯拉夫语:-grad / -gorod 城、-sk 与 -ovo / -evo 表"……的地方"、-ets / -ka 表小称;' +
      '词根如 bel 白、zlat 金、nov 新、slav 荣耀、mir 和平、gor 山、yar 春日与烈性、vol 意志、dub 橡树、bor 松林。讲词源要写出原形并拆开讲。',
    suggest: '音译,城名多用 -格勒、-哥罗德、-斯克、-沃(如 别洛格勒、兹拉托沃),带东欧森林与雪原的味道',
  },
  {
    id: 'hellenic',
    label: '群岛(希腊风)',
    family: 'western',
    desc: '爱琴海城邦与神话,常见 -斯、-波利斯、-亚,如 塞罗斯、卡利波利斯',
    explain:
      '拟造语言近于古希腊语:-polis 城邦、-ia 地,-os / -is / -a 是常见词尾;词根多与海、光、风、橄榄、葡萄、智慧、神话人物有关。' +
      '讲词源要写出原形并拆开讲,可以附会一段神话或英雄传说(写明"相传")。',
    suggest: '音译,常见 -斯、-波利斯、-亚、-拉(如 塞罗斯、卡利波利斯),明亮、有海风的味道',
  },
  {
    id: 'desert',
    label: '沙海(阿拉伯风)',
    family: 'western',
    desc: '沙漠、绿洲与商队,常见 -斯坦、-阿巴德、-尔,如 扎希尔、卡斯拉巴德',
    explain:
      '拟造语言近于阿拉伯语、波斯语:-stan "……之地"、-abad 城镇与耕地、qasr 城堡、bahr 海、wadi 河谷、bir 井;' +
      '词根多与沙、星辰、水井、绿洲、商旅、盐有关。讲词源要写出原形并拆开讲。',
    suggest: '音译,常见 -斯坦、-阿巴德、-尔(如 扎希尔、卡斯拉巴德),有沙漠、绿洲与商队的味道',
  },
  {
    id: 'steppe',
    label: '草原(突厥蒙古风)',
    family: 'western',
    desc: '草原与游牧,沿用中文里熟悉的蒙古 / 突厥地名写法,如 查干浩特、喀拉郭勒',
    explain:
      '沿用中文里熟悉的蒙古 / 突厥地名写法,每一段都有意思:浩特 城、郭勒 河、诺尔 湖、乌拉 山、塔拉 草原、戈壁 荒漠、查干 白、喀拉 黑、' +
      '阿勒坦 金、巴彦 富饶、腾格里 天、宝力格 泉。讲的时候逐段拆开意思。',
    suggest: '按蒙古 / 突厥地名的写法组合,每一段都要有意思(如 查干浩特、喀拉郭勒、巴彦塔拉)',
  },
  {
    id: 'elven',
    label: '林语(精灵风)',
    family: 'western',
    desc: '轻柔流动的精灵语感,多用 瑟、希、艾、林,如 艾尔瑟里昂、希尔瓦兰',
    explain:
      '拟造的精灵语,轻柔流动,多元音和 l、r、s、th、n;常见词尾 -ion / -ien / -iel / -ar / -wen / -dor,词根多与星光、森林、歌、流水、月、晨曦有关。' +
      '讲词源要写出原形(拉丁字母)并逐段解释,像一门有语法的古老语言那样构词。',
    suggest: '音译,轻柔绵长,多用 瑟、希、艾、林、尔、恩(如 艾尔瑟里昂、希尔瓦兰)',
  },
  {
    id: 'central',
    label: '中原(古风)',
    family: 'eastern',
    desc: '春秋战国、郡县州府式的古地名,如 大靖、北沂、宁州、云阳、雁北道',
    explain:
      '中原古风:国号多取吉字或古国字(靖、宁、昭、雍、沂、汾),城名多是"X州""X阳"(山南水北为阳)、"X陵""X川""X津""X门",或两个吉字相配;' +
      '山水名多是颜色、草木、鸟兽字配"水""河""山""岭"(清水、白河、鹿山)。' +
      '讲字义要讲本义和引申义,点出地名惯例(如"山南水北为阳"),可引《诗经》《尚书》《左传》《水经注》等典籍里的用法。',
    suggest:
      '古雅端正:国号用单字吉字或古国字;城名"X州""X阳""X陵""X川""X津"或两个吉字相配(如 宁州、云阳、嘉平);' +
      '山水名多是颜色、草木、鸟兽字配通名(如 清水、白河、鹿山、苍岭),两三个字',
  },
  {
    id: 'xianxia',
    label: '江南(仙侠风)',
    family: 'eastern',
    desc: '诗意的仙侠地名,如 落霞关、听雪城、苍澜海、摘星峰、烟波泽',
    explain: '江南仙侠风:意象字(霞、雪、云、澜、星、月、烟、剑)配动词(听、摘、落、栖、望),再加通名(关、城、峰、泽、海)。讲字义要讲出意境和画面,可以化用唐诗宋词。',
    suggest: '诗意空灵:意象字 + 动词 + 通名(如 落霞关、听雪城、摘星峰、烟波泽),三个字为主',
  },
  {
    id: 'frontier',
    label: '边塞(西域风)',
    family: 'eastern',
    desc: '唐诗里的边关与西域古国,如 镇北关、黄沙堡、楼勒、伊昌泽、疏兰河',
    explain:
      '唐诗边塞与西域古国:关塞名多是"镇 / 定 / 安 / 平 / 靖 + 方位或景物 + 关 / 堡 / 城 / 戍",西域古国名是当地古语的音译(楼勒、疏兰、伊昌)。' +
      '讲关塞名要讲字义和守边之意,可引边塞诗;讲音译名要给出一个拟造的当地古语原意。',
    suggest: '边关雄浑(镇北关、黄沙堡、定远城);西域古国式的用两三个字的音译(楼勒、疏兰、伊昌泽)',
  },
  {
    id: 'mythic',
    label: '山海(神话风)',
    family: 'eastern',
    desc: '《山海经》式的奇异地名,如 玄冒之山、翼留之台、雷墟、千目国、桂台之野',
    explain: '《山海经》式的奇异地名:"X之山""X之野""X之台""X国"(千目国)、"X墟",常带异兽、神木、奇石。讲字义时像给《山海经》作注,讲其中的神怪、物产、异兽传说(可以编,写明"相传")。',
    suggest: '古奥奇异:"X之山""X之野""X墟""X国"(如 玄冒之山、雷墟、千目国、桂台之野)',
  },
];

/** 海洋、大洋、海湾:不带民族色彩的通行叫法 */
export const SEA_GUIDE: StyleGuide = {
  id: 'sea',
  label: '通行的中文叫法',
  family: 'eastern',
  desc: '海洋不带哪个民族的语感:意象 + 海 / 洋 / 湾(长风洋、寒雾海),或方位 + 海(北大洋)',
  explain: '海洋、大洋、海湾的名字是这个世界通行的中文叫法,不带哪个民族的语感。讲字义,讲它为什么被这样叫(气候、海况、方位、沿岸的人)。',
  suggest: '中文意译:意象 + 海 / 洋 / 湾(如 长风洋、寒雾海、碧澜海),或方位 + 海',
};

export function styleGuide(id: string | undefined): StyleGuide | null {
  return STYLE_GUIDES.find((s) => s.id === id) ?? null;
}

/**
 * 没人住的地方的地名用的"这个世界通行的语感"(和 gen/civ/places.ts 的 worldNameStyle 一样,单测核对);
 * names = 整个世界的地名风格(Civ.names),按份数挑
 */
export function worldStyleId(seed: number, names?: NameMix): string {
  const rng = mulberry32(subSeed(seed, 'civ-places-style'));
  return pickStyle(names, rng());
}

// ---------------------------------------------------------------------------
// 对象与基本信息

export type NameTargetKind = 'polity' | 'settlement' | 'place' | 'culture' | 'region';

export interface NameTarget {
  kind: NameTargetKind;
  id: number;
  /** 国家:第几朝(东方改朝换代过的,释 / 改的是这一朝的国号;0 或不给 = 国名本身) */
  dynasty?: number;
}

export interface NameInfo {
  /** 稳定键(改名、存释名都用它) */
  key: string;
  /** 改名时 cleanName 用的种类 */
  keyKind: KeyKind;
  /** 东方语感(国家的国号走中式写法;起名的国号是单字或双字) */
  eastern: boolean;
  /** 种类的说法:国家 / 城 / 河流 / 山脉 / 湖泊 / 大洋 / 海 / 海湾 / 岛屿 / 荒漠 / 民族 / 州 */
  kindLabel: string;
  /** 现在的名字(国家 = 国名本身,如"霄";民族不带"族";没起名的州 = '') */
  name: string;
  /** 显示用的叫法(国家 = 全称,如"大霄";民族 = "X族") */
  shown: string;
  /** 起名依据的语感(海洋 = SEA_GUIDE) */
  style: StyleGuide | null;
}

const PLACE_KIND: Record<Place['kind'], string> = {
  sea: '海',
  mountains: '山脉',
  river: '河流',
  lake: '湖泊',
  island: '岛屿',
  desert: '荒漠',
};

/** 地理实体的种类名:"山脉""河流""大洋""海湾"…… */
export function placeKindLabel(p: Place): string {
  if (p.kind !== 'sea') return PLACE_KIND[p.kind];
  const n = p.defaultName ?? p.name;
  return n.endsWith('洋') ? '大洋' : n.endsWith('湾') ? '海湾' : '海';
}

/** 国家最后(或现在)的年份 */
function lastYear(civ: Civ, p: Polity): number {
  return Math.min(p.ended !== undefined ? p.ended - 1 / 512 : civ.endYear, civ.endYear);
}

/** 第 i 朝最后(或现在)的那一刻 */
function dynastyEnd(civ: Civ, p: Polity, i: number): number {
  const next = p.dynasties?.[i + 1]?.year;
  return Math.min(next !== undefined ? next - 1 / 512 : Infinity, lastYear(civ, p));
}

/** 对象的基本信息;对象不存在 = null */
export function nameInfo(civ: Civ, t: NameTarget): NameInfo | null {
  const cus = civ.cultures;
  switch (t.kind) {
    case 'polity': {
      const p = civ.polities[t.id];
      if (!p) return null;
      const di = p.eastern && p.dynasties && t.dynasty && t.dynasty > 0 && t.dynasty < p.dynasties.length ? t.dynasty : 0;
      const style = styleGuide(cus[p.culture]?.style);
      return {
        key: di > 0 ? dynastyKey(civ, p.id, di) : polityKey(civ, p.id),
        keyKind: di > 0 ? 'dynasty' : 'polity',
        eastern: !!p.eastern,
        kindLabel: '国家',
        name: di > 0 ? p.dynasties![di].name : p.name,
        shown: polityName(p, di > 0 ? dynastyEnd(civ, p, di) : p.dynasties && p.dynasties.length > 1 && p.eastern ? dynastyEnd(civ, p, 0) : lastYear(civ, p)),
        style,
      };
    }
    case 'settlement': {
      const s = civ.settlements[t.id];
      if (!s) return null;
      const style = styleGuide(cus[s.culture]?.style);
      return { key: settlementKey(civ, s.id), keyKind: 'settlement', eastern: style?.family === 'eastern', kindLabel: '城', name: s.name, shown: s.name, style };
    }
    case 'place': {
      const p = civ.places[t.id];
      if (!p) return null;
      const style = p.kind === 'sea' ? SEA_GUIDE : styleGuide(p.culture >= 0 ? cus[p.culture]?.style : worldStyleId(civ.seed, civ.names));
      return { key: placeKeyOf(civ, t.id), keyKind: 'place', eastern: style?.family === 'eastern', kindLabel: placeKindLabel(p), name: p.name, shown: p.name, style };
    }
    case 'culture': {
      const cu = cus[t.id];
      if (!cu) return null;
      const style = styleGuide(cu.style);
      return { key: cultureKey(civ, cu.id), keyKind: 'culture', eastern: style?.family === 'eastern', kindLabel: '民族', name: cu.name, shown: cultureLabel(cu), style };
    }
    case 'region': {
      if (!(t.id >= 0 && t.id < civ.regions.count)) return null;
      const c = civ.culture[t.id];
      const style = styleGuide(c >= 0 ? cus[c]?.style : undefined);
      const named = regionNamed(civ, t.id);
      return {
        key: regionKey(civ, t.id),
        keyKind: 'region',
        eastern: style?.family === 'eastern',
        kindLabel: '州',
        name: named ? regionLabel(civ, t.id) : '',
        shown: regionLabel(civ, t.id),
        style,
      };
    }
  }
}

/** 存释名用的键(AI 笔记里各功能共用一个表,前面加功能名免得撞键) */
export function explainNoteKey(key: string): string {
  return `释名:${key}`;
}

// ---------------------------------------------------------------------------
// 过时检查:只由数字拼成(年份、地块、档位),不含名字 —— 改名不变,历史改写 / 改地形才变

const r1 = (y: number) => Math.round(y * 4) / 4;

export function nameStamp(civ: Civ, t: NameTarget): string {
  const S = civ.settlements;
  const cellOfCity = (id: number) => S[id]?.cell ?? -1;
  switch (t.kind) {
    case 'polity': {
      const p = civ.polities[t.id];
      if (!p) return '';
      const caps = (p.capitals ?? []).map((c) => `${r1(c.year)}@${cellOfCity(c.settlement)}`).join(',');
      const dyn = (p.dynasties ?? []).map((d) => `${r1(d.year)}@${cellOfCity(d.seat)}`).join(',');
      const titles = (p.titles ?? []).map((x) => `${r1(x.year)}:${x.tier}`).join(',');
      const rel = (q: number | undefined) => (q === undefined ? '' : cellOfCity(civ.polities[q]?.capital ?? -1));
      return `P|${cellOfCity(p.capital)}|${r1(p.founded)}|${p.ended === undefined ? '' : r1(p.ended)}|${caps}|${dyn}|${titles}|${rel(p.parent)}|${rel(p.restores)}|${p.lineage ?? ''}`;
    }
    case 'settlement': {
      const s = S[t.id];
      if (!s) return '';
      const spans = (s.capitalSpans ?? []).map((x) => `${r1(x.from)}-${x.until === undefined ? '' : r1(x.until)}`).join(',');
      const sacks = (s.sacks ?? []).map((x) => r1(x.year)).join(',');
      return `S|${s.cell}|${r1(s.founded)}|${s.ended === undefined ? '' : r1(s.ended)}|${spans}|${sacks}|${s.rebuilds === undefined ? '' : cellOfCity(s.rebuilds)}|${s.port ? 1 : 0}`;
    }
    case 'place': {
      const p = civ.places[t.id];
      if (!p) return '';
      const cu = p.culture >= 0 ? civ.cultures[p.culture] : undefined;
      return `L|${p.kind}|${p.cell ?? ''}|${cu ? civ.regions.seat[cu.hearth] : ''}|${Math.round(p.size ?? 0)}`;
    }
    case 'culture': {
      const cu = civ.cultures[t.id];
      if (!cu) return '';
      return `C|${civ.regions.seat[cu.hearth]}|${r1(cu.born)}|${cu.ended === undefined ? '' : r1(cu.ended)}|${cu.kind}|${(cu.migrations ?? []).map((m) => r1(m.year) + m.dir).join(',')}`;
    }
    case 'region': {
      if (!(t.id >= 0 && t.id < civ.regions.count)) return '';
      const seat = civ.regions.seat;
      const cuSeat = (c: number) => (c >= 0 && civ.cultures[c] ? seat[civ.cultures[c].hearth] : -1);
      const poCell = (q: number) => (q >= 0 && civ.polities[q] ? cellOfCity(civ.polities[q].capital) : -1);
      const hist = civ.checkpoints.map((cp) => `${cuSeat(cp.culture[t.id])}/${poCell(cp.polity[t.id])}`).join(',');
      return `R|${seat[t.id]}|${civ.regions.biome[t.id]}|${hist}|${cuSeat(civ.culture[t.id])}/${poCell(civ.polity[t.id])}`;
    }
  }
}

// ---------------------------------------------------------------------------
// 地理:地块位置(从铺好的像素里求地块中心)、气候、临近的山川

interface Centers {
  x: Float32Array;
  y: Float32Array;
}
const centerCache = new WeakMap<Raster, Centers>();

/** 每个地块的中心(世界坐标;没铺到像素的 = NaN)。按 raster 缓存,扫一遍像素 */
function cellCenters(raster: Raster, n: number): Centers {
  const hit = centerCache.get(raster);
  if (hit && hit.x.length >= n) return hit;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const cnt = new Uint32Array(n);
  const { w, h, cell } = raster;
  for (let py = 0, k = 0; py < h; py++) {
    for (let px = 0; px < w; px++, k++) {
      const c = cell[k];
      if (c >= 0 && c < n) {
        sx[c] += px;
        sy[c] += py;
        cnt[c]++;
      }
    }
  }
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    x[c] = cnt[c] ? (sx[c] / cnt[c] + 0.5) / raster.scale : NaN;
    y[c] = cnt[c] ? (sy[c] / cnt[c] + 0.5) / raster.scale : NaN;
  }
  const out = { x, y };
  centerCache.set(raster, out);
  return out;
}

interface Geo {
  civ: Civ;
  raster: Raster | null;
  centers: Centers | null;
}

function geoOf(civ: Civ, raster: Raster | null | undefined): Geo {
  return { civ, raster: raster ?? null, centers: raster ? cellCenters(raster, civ.regions.of.length) : null };
}

function posOf(g: Geo, cell: number): [number, number] | null {
  if (!g.centers || !(cell >= 0 && cell < g.centers.x.length)) return null;
  const x = g.centers.x[cell];
  const y = g.centers.y[cell];
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** 世界坐标处的像素下标 */
function pixelAt(r: Raster, x: number, y: number): number {
  const px = Math.min(r.w - 1, Math.max(0, Math.floor(x * r.scale)));
  const py = Math.min(r.h - 1, Math.max(0, Math.floor(y * r.scale)));
  return py * r.w + px;
}

function tempWord(t: number): string {
  return t < -8 ? '酷寒' : t < 0 ? '严寒' : t < 8 ? '寒冷' : t < 14 ? '凉爽' : t < 20 ? '温和' : t < 25 ? '温暖' : '炎热';
}

function rainWord(p: number): string {
  return p < 150 ? '极干' : p < 350 ? '干旱' : p < 700 ? '半干' : p < 1400 ? '湿润' : p < 2500 ? '多雨' : '极多雨';
}

/** "年均温 12°C、年降水 820 mm(温和湿润)" */
function climateText(g: Geo, x: number, y: number): string {
  if (!g.raster) return '';
  const k = pixelAt(g.raster, x, y);
  const t = g.raster.temp[k];
  const p = g.raster.precip[k];
  if (!Number.isFinite(t) || !Number.isFinite(p)) return '';
  return `年均温 ${Math.round(t)}°C、年降水 ${Math.round(p)} mm(${tempWord(t)}${rainWord(p)})`;
}

/** 在地图的哪一带:"地图西北部" */
function mapPart(g: Geo, x: number, y: number): string {
  if (!g.raster) return '';
  const W = g.raster.w / g.raster.scale;
  const H = g.raster.h / g.raster.scale;
  const ns = y < H / 3 ? '北' : y > (2 * H) / 3 ? '南' : '';
  const ew = x < W / 3 ? '西' : x > (2 * W) / 3 ? '东' : '';
  return ns || ew ? `地图${ew}${ns}部` : '地图中部';
}

const landCache = new WeakMap<Int32Array, number[]>();

/** 在哪块陆地上:"最大的大陆""第二大陆""一座大岛""一座小岛" */
function landText(civ: Civ, region: number): string {
  const lm = civ.regions.landmass;
  if (!(region >= 0 && region < civ.regions.count)) return '';
  let count = landCache.get(lm);
  if (!count) {
    count = [];
    for (let r = 0; r < civ.regions.count; r++) count[lm[r]] = (count[lm[r]] ?? 0) + 1;
    landCache.set(lm, count);
  }
  const id = lm[region];
  const n = count[id] ?? 0;
  if (n <= 2) return '一座小岛';
  if (id === 0) return '最大的大陆';
  if (n <= 15) return '一座大岛';
  return `第${cnNumber(id + 1)}大陆`;
}

/** 点 (x, y) 到路径的最近距离 */
function pathDist(path: Float32Array, x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i + 1 < path.length; i += 2) {
    const dx = path[i] - x;
    const dy = path[i + 1] - y;
    const e = dx * dx + dy * dy;
    if (e < d) d = e;
  }
  return Math.sqrt(d);
}

/** 离 (x, y) 多近算"临近":河 / 山脉 / 湖 / 海 / 岛 / 荒漠(世界单位;州约 25 单位宽) */
function nearLimit(p: Place): number {
  const s = p.size ?? 0;
  switch (p.kind) {
    case 'river':
      return 12;
    case 'mountains':
      return 40;
    case 'lake':
      return s + 14;
    case 'sea':
      return s + 40;
    case 'island':
      return s + 4;
    case 'desert':
      return s + 20;
  }
}

const NEAR_WORD: Record<Place['kind'], string> = { river: '临', mountains: '近', lake: '濒', sea: '濒', island: '在', desert: '邻' };

/** 临近的山川:"临碧溪河、近苍岭山脉、濒寒雾海"(海只在海边的地方算;每种最多一两个) */
function nearbyText(g: Geo, x: number, y: number, coastal: boolean, skip = -1): string {
  const found: { p: Place; d: number }[] = [];
  g.civ.places.forEach((p, i) => {
    if (i === skip || (p.kind === 'sea' && !coastal)) return;
    const d = pathDist(p.path, x, y);
    if (d <= nearLimit(p)) found.push({ p, d });
  });
  found.sort((a, b) => a.d - b.d);
  const per: Partial<Record<Place['kind'], number>> = {};
  const out: string[] = [];
  for (const f of found) {
    const k = f.p.kind;
    const n = per[k] ?? 0;
    if (n >= (k === 'river' ? 2 : 1)) continue;
    per[k] = n + 1;
    out.push(`${NEAR_WORD[k]}${f.p.name}${k === 'island' ? '上' : ''}`);
  }
  return out.slice(0, 4).join('、');
}

/** 一个地块处的地理:"位于地图西北部最大的大陆上;温带森林,海拔 320 米;年均温……;临碧溪河" */
function siteText(g: Geo, cell: number, opts: { coastal?: boolean; skipPlace?: number } = {}): string {
  const civ = g.civ;
  const r = cell >= 0 && cell < civ.regions.of.length ? civ.regions.of[cell] : -1;
  const parts: string[] = [];
  const pos = posOf(g, cell);
  const land = r >= 0 ? landText(civ, r) : '';
  if (pos || land) parts.push(`位于${pos ? mapPart(g, pos[0], pos[1]) : ''}${land ? `${pos ? '的' : ''}${land}上` : ''}`);
  if (r >= 0) parts.push(`${BIOMES[civ.regions.biome[r]]?.name ?? '—'},海拔约 ${Math.round(civ.regions.elevation[r])} 米`);
  if (pos) {
    const c = climateText(g, pos[0], pos[1]);
    if (c) parts.push(c);
    const near = nearbyText(g, pos[0], pos[1], !!opts.coastal, opts.skipPlace);
    if (near) parts.push(near);
  }
  if (opts.coastal) parts.push('在海边');
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// 历史的小工具

const yearText = (y: number) => `第 ${Math.floor(y)} 年`;
/** 年份段:"第 1288—1541 年" / "第 2857 年至今"(材料里的年份都带"第",模型照抄时格式才统一) */
const yearSpan = (a: number, b: number | undefined) => (b === undefined ? `第 ${Math.floor(a)} 年至今` : `第 ${Math.floor(a)}—${Math.floor(b)} 年`);

interface Peak {
  n: number;
  year: number;
}
const peakCache = new WeakMap<object, { polity: Peak[]; culture: Peak[] }>();

/** 各国、各族最盛时占几州、在哪一年(按每百年一份的检查点 + 结束时) */
function peaks(civ: Civ): { polity: Peak[]; culture: Peak[] } {
  const hit = peakCache.get(civ.checkpoints);
  if (hit) return hit;
  const polity: Peak[] = civ.polities.map(() => ({ n: 0, year: 0 }));
  const culture: Peak[] = civ.cultures.map(() => ({ n: 0, year: 0 }));
  const snaps = [...civ.checkpoints.map((c) => ({ year: c.year, polity: c.polity, culture: c.culture })), { year: civ.endYear, polity: civ.polity, culture: civ.culture }];
  const pc = new Int32Array(civ.polities.length);
  const cc = new Int32Array(civ.cultures.length);
  for (const s of snaps) {
    pc.fill(0);
    cc.fill(0);
    for (let r = 0; r < civ.regions.count; r++) {
      if (s.polity[r] >= 0 && s.polity[r] < pc.length) pc[s.polity[r]]++;
      if (s.culture[r] >= 0 && s.culture[r] < cc.length) cc[s.culture[r]]++;
    }
    pc.forEach((n, i) => {
      if (n > polity[i].n) polity[i] = { n, year: s.year };
    });
    cc.forEach((n, i) => {
      if (n > culture[i].n) culture[i] = { n, year: s.year };
    });
  }
  const out = { polity, culture };
  peakCache.set(civ.checkpoints, out);
  return out;
}

/** 按年代看这几州归谁:"第 450 年前后 部落地带(居兰族)→ 第 900 年 大昌 → 第 3000 年 大武、索拉特" */
function ownershipText(civ: Civ, regions: readonly number[], from = 0): string {
  if (!regions.length || !civ.polities.length) return '';
  const E = civ.endYear;
  const years: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const y = Math.round((E * i) / 8);
    if (y >= from) years.push(y === E ? E : y);
  }
  if (!years.length || years[0] > from + E / 16) years.unshift(Math.ceil(from));
  let buf: Owners | undefined;
  const out: string[] = [];
  let last = '';
  for (const y of years) {
    buf = ownersAt(civ, Math.min(y, E), buf);
    const pc = new Map<number, number>();
    const cc = new Map<number, number>();
    for (const r of regions) {
      const q = buf.polity[r];
      const c = buf.culture[r];
      if (q >= 0) pc.set(q, (pc.get(q) ?? 0) + 1);
      else if (c >= 0) cc.set(c, (cc.get(c) ?? 0) + 1);
    }
    let label: string;
    if (pc.size) {
      label = [...pc]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([q]) => polityName(civ.polities[q], Math.min(y, E)))
        .join('、');
    } else if (cc.size) {
      const c = [...cc].sort((a, b) => b[1] - a[1])[0][0];
      label = `部落地带(${cultureLabel(civ.cultures[c])})`;
    } else label = '无人居住';
    if (label !== last) out.push(`${yearText(y)} ${label}`);
    last = label;
  }
  // 开头的"无人居住"(人还没来)不写,除非一直没人
  while (out.length > 1 && out[0].endsWith('无人居住')) out.shift();
  return out.join(' → ');
}

/**
 * 编年史里和它有关的几条(重要的先挑,再按年份排):"第 312 年 ……"。
 * pick 返回要写的那一条(可以是折叠条目里的子条目)和它的分量(越大越先挑);不要 = null
 */
function chronicleLines(civ: Civ, pick: (e: ChronicleEntry) => { e: ChronicleEntry; rank: number } | null, max: number): string[] {
  const found: { e: ChronicleEntry; rank: number; i: number }[] = [];
  for (const e of buildChronicle(civ)) {
    const x = pick(e);
    if (x) found.push({ ...x, i: found.length });
  }
  return found
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.e.year - b.e.year || a.i - b.i)
    .map(({ e }) => `${yearText(e.year)} ${e.text}`);
}

/** 一国实际用过的国号(按先后,去重):"昌部 → 昌国 → 大昌 → 大景 → 大景王朝" */
function usedTitles(p: Polity): string {
  const years = [p.founded, ...(p.titles ?? []).map((x) => x.year), ...(p.dynasties ?? []).map((x) => x.year)].sort((a, b) => a - b);
  const out: string[] = [];
  for (const y of years) {
    const n = polityName(p, Math.max(y, p.founded));
    if (out[out.length - 1] !== n) out.push(n);
  }
  return out.join(' → ');
}

/** 国号四档(按国土大小自动加):"霄部 → 霄国 → 大霄 → 大霄王朝" */
function titleForms(p: Polity, root: string): string {
  const t = p.eastern ? easternTitles(root, p.lineage) : polityTitles({ ...p, name: root, dynasties: undefined });
  return t.filter((x, i, a) => a.indexOf(x) === i).join(' → ');
}

/** 某州里的城(按建城先后) */
function citiesIn(civ: Civ, region: number): string {
  const list = civ.settlements.filter((s) => s.region === region);
  return list
    .slice(0, 5)
    .map((s) => `${s.name}(${yearText(s.founded)}建${s.ended !== undefined ? `,${yearText(s.ended)}毁` : ''})`)
    .join('、');
}

/** 沿河 / 湖岸 / 海边 / 山下的城 */
function citiesAlong(civ: Civ, g: Geo, p: Place, limit: number): string {
  if (!g.centers) return '';
  const near: { name: string; d: number; founded: number }[] = [];
  for (const s of civ.settlements) {
    if (p.kind === 'sea' && !s.port) continue;
    const pos = posOf(g, s.cell);
    if (!pos) continue;
    const d = pathDist(p.path, pos[0], pos[1]);
    if (d <= nearLimit(p)) near.push({ name: s.name, d, founded: s.founded });
  }
  near.sort((a, b) => a.founded - b.founded);
  return near
    .slice(0, limit)
    .map((x) => `${x.name}(${yearText(x.founded)}建)`)
    .join('、');
}

/** 地理实体经过的州(河、山脉沿路径取样,别的看锚点) */
function placeRegions(civ: Civ, g: Geo, p: Place): number[] {
  const R = civ.regions.of;
  const set = new Set<number>();
  if (g.raster && (p.kind === 'river' || p.kind === 'mountains' || p.kind === 'island' || p.kind === 'desert' || p.kind === 'lake')) {
    for (let i = 0; i + 1 < p.path.length; i += 2) {
      const c = g.raster.cell[pixelAt(g.raster, p.path[i], p.path[i + 1])];
      if (c >= 0 && c < R.length && R[c] >= 0) set.add(R[c]);
    }
  }
  if (p.cell !== undefined && p.cell >= 0 && p.cell < R.length && R[p.cell] >= 0) set.add(R[p.cell]);
  return [...set];
}

// ---------------------------------------------------------------------------
// 材料

export interface NameMaterial {
  target: NameTarget;
  info: NameInfo;
  /** 名字那一行的补充(国家:国号怎么变;西幻地名:拉丁原形) */
  nameNote: string;
  /** 起名的民族("X族(农耕民族)";海洋 / 无人之地说明) */
  people: string;
  /** 地理(一条一行) */
  geography: string[];
  /** 历史(一条一行) */
  history: string[];
  /** 编年史里和它有关的几条 */
  chronicle: string[];
  /** 同一语感的其他名字(给 AI 找语感;不含它自己) */
  peers: string[];
  /** 起名的格式要求 */
  format: string;
  /** 历史改写检查用(见 nameStamp) */
  stamp: string;
}

function peopleText(civ: Civ, c: number, what: string): string {
  const cu = civ.cultures[c];
  if (!cu) return '';
  return `${what}${cultureLabel(cu)}(${KIND_INFO[cu.kind].name}民族)`;
}

/** 同一语感的其他名字:同族的在前,再补同语感的;去掉它自己,最多 n 个 */
function peerNames<T>(list: readonly T[], self: number, name: (x: T) => string, sameCulture: (x: T) => boolean, sameStyle: (x: T) => boolean, n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (pred: (x: T) => boolean) => {
    list.forEach((x, i) => {
      if (out.length >= n || i === self || !pred(x)) return;
      const v = name(x);
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    });
  };
  add(sameCulture);
  add(sameStyle);
  return out;
}

/** 给一个名字整理材料(和时间轴年份无关)。raster 用来求位置、气候、临近的山川(没有就少写这几样) */
export function nameMaterial(civ: Civ, t: NameTarget, raster?: Raster | null): NameMaterial | null {
  const info = nameInfo(civ, t);
  if (!info) return null;
  const g = geoOf(civ, raster);
  const cus = civ.cultures;
  const styleOf = (c: number) => cus[c]?.style;
  const geography: string[] = [];
  const history: string[] = [];
  let chronicle: string[] = [];
  let peers: string[] = [];
  let nameNote = '';
  let people = '';
  const S = civ.settlements;

  if (t.kind === 'polity') {
    const p = civ.polities[t.id];
    const di = info.keyKind === 'dynasty' ? t.dynasty! : 0;
    const d = p.dynasties;
    nameNote = `"${info.name}"是国名本身,国号随国土大小自动变化:${titleForms(p, info.name)}`;
    if (di > 0) nameNote = `这是这个国家第 ${di + 1} 朝的国号;${nameNote}`;
    people = peopleText(civ, p.culture, '主体民族:');
    const cap = S[p.capital];
    if (cap) geography.push(`立国时的国都 ${cap.name}:${siteText(g, cap.cell, { coastal: civ.habitat.coastDist[cap.cell] === 1 })}`);
    const pk = peaks(civ).polity[p.id];
    if (pk && pk.n > 0) geography.push(`国土最盛时约 ${pk.n} 州(${yearText(pk.year)}前后)`);
    let how = '';
    if (p.restores !== undefined && civ.polities[p.restores]) how = `,复${polityName(civ.polities[p.restores], civ.polities[p.restores].ended ?? p.founded)}之国`;
    else if (p.parent !== undefined && civ.polities[p.parent]) how = `,叛${polityName(civ.polities[p.parent], p.founded)}自立`;
    history.push(`${yearText(p.founded)}立国${how}${cap ? `,都于${cap.name}` : ''}`);
    history.push(`国号变迁:${usedTitles(p)}`);
    const caps = p.capitals?.length ? p.capitals : [];
    if (caps.length > 1) history.push(`历任国都:${caps.map((c) => `${S[c.settlement]?.name ?? '?'}(${yearText(c.year)})`).join(' → ')}`);
    if (d && d.length > 1) {
      const rows = d.map((x, i) => {
        const nm = p.eastern ? polityName(p, dynastyEnd(civ, p, i)) : `${x.name}王朝`;
        const until = d[i + 1]?.year ?? p.ended;
        // 新朝从哪座城起兵不写:编年史里写着"某某起于某州,入主某城",再写一个城名模型会当成迁都
        return `${nm}(${yearSpan(x.year, until)})`;
      });
      history.push(`${p.eastern ? '历朝' : '王室'}:${rows.join(' → ')}`);
    }
    let end = '';
    for (const a of civ.annals) {
      if (a.kind === 'fall' && a.a === p.id) end = a.b >= 0 && civ.polities[a.b] ? `亡于${polityName(civ.polities[a.b], a.year)}` : '土崩瓦解';
      else if (a.kind === 'merge' && a.b === p.id && civ.polities[a.a]) end = `并入${polityName(civ.polities[a.a], a.year)}`;
      if (end) break;
    }
    history.push(p.ended === undefined ? `延续至今(${yearText(civ.endYear)})` : `${yearText(p.ended)}${end || '亡'}`);
    const focus = di > 0 ? d![di].year : -1;
    chronicle = chronicleLines(
      civ,
      (e) => {
        const mine = e.polities.includes(p.id) || !!e.children?.some((c) => c.polities.includes(p.id));
        if (!mine) return null;
        // 释 / 改的是后来某一朝的国号:那次改朝换代一定写上
        if (e.kind === 'dynasty' && Math.abs(e.year - focus) < 1e-3) return { e, rank: 9 };
        return e.importance >= 2 ? { e, rank: e.importance } : null;
      },
      8,
    );
    const st = styleOf(p.culture);
    peers = peerNames(
      civ.polities,
      p.id,
      (q) => polityName(q, lastYear(civ, q)),
      (q) => q.culture === p.culture,
      (q) => !!st && styleOf(q.culture) === st,
      8,
    );
    if (p.eastern && d && d.length > 1) {
      // 这国别的朝的国号也是很好的参照
      const extra = d.map((_, i) => (i === di ? '' : polityName(p, dynastyEnd(civ, p, i)))).filter(Boolean);
      peers = [...new Set([...extra, ...peers])].filter((x) => x !== info.shown).slice(0, 10);
    }
  } else if (t.kind === 'settlement') {
    const s = S[t.id];
    people = peopleText(civ, s.culture, '建城的民族:');
    const coastal = s.port || civ.habitat.coastDist[s.cell] === 1;
    geography.push(siteText(g, s.cell, { coastal }));
    if (s.port) geography.push('是港口');
    const old = s.rebuilds !== undefined ? S[s.rebuilds] : undefined;
    history.push(`${yearText(s.founded)}建城${old ? `,在${old.name}故址上重建` : ''}`);
    // 人口最盛
    let best = 0;
    let bestYear = s.founded;
    const endY = s.ended ?? civ.endYear;
    for (let y = s.founded; y <= endY; y += 25) {
      const v = populationAt(s, Math.min(y, endY - 1 / 512));
      if (v > best) {
        best = v;
        bestYear = y;
      }
    }
    if (best > 0) history.push(`人口最盛${populationLabel(best)}(${yearText(bestYear)}前后,${SETTLEMENT_RANKS[settlementRank(best)].name})`);
    const spans = s.capitalSpans ?? [];
    if (spans.length) {
      history.push(
        `做过国都:${spans
          .map((x) => {
            const q = civ.polities[x.polity];
            const until = x.until ?? s.ended;
            const at = Math.min(until ?? Infinity, q?.ended ?? Infinity, civ.endYear + 1) - 1 / 512;
            return `${q ? polityName(q, Math.max(x.from, at)) : '某国'}(${yearSpan(x.from, until)})`;
          })
          .join(';')}`,
      );
    }
    const own = ownershipText(civ, [s.region], s.founded);
    if (own) history.push(`归属变迁:${own}`);
    const rebuiltAs = S.find((x) => x.rebuilds === s.id);
    if (s.ended !== undefined) history.push(`${yearText(s.ended)}毁弃${rebuiltAs ? `,${yearText(rebuiltAs.founded)}故址上重建为${rebuiltAs.name}` : ''}`);
    else history.push(`到${yearText(civ.endYear)}仍在`);
    chronicle = chronicleLines(
      civ,
      (e) => {
        if (e.settlement === s.id) return { e, rank: e.importance };
        const c = e.children?.find((x) => x.settlement === s.id);
        return c ? { e: c, rank: Math.max(c.importance, e.importance) } : null;
      },
      6,
    );
    const st = styleOf(s.culture);
    peers = peerNames(
      S,
      s.id,
      (x) => x.name,
      (x) => x.culture === s.culture,
      (x) => !!st && styleOf(x.culture) === st,
      10,
    );
  } else if (t.kind === 'place') {
    const p = civ.places[t.id];
    if (p.latin) nameNote = `拉丁字母原形:${p.latin}${p.kind === 'lake' || p.kind === 'island' || p.kind === 'desert' ? '(借用的是附近别的名字的原形,仅供参考)' : '(中文名由它音译)'}`;
    people =
      p.kind === 'sea'
        ? '海洋用这个世界通行的中文叫法,不带哪个民族的语感'
        : p.culture >= 0
          ? peopleText(civ, p.culture, '按') + '的语感起名'
          : '起名时这里无人居住,按这个世界通行的语感起名';
    const regs = placeRegions(civ, g, p);
    const anchor = p.cell ?? -1;
    const pos = posOf(g, anchor);
    const bits: string[] = [];
    if (pos) bits.push(`位于${mapPart(g, pos[0], pos[1])}`);
    if (p.kind === 'mountains' && g.raster) {
      let top = -Infinity;
      for (let i = 0; i + 1 < p.path.length; i += 2) top = Math.max(top, g.raster.elev[pixelAt(g.raster, p.path[i], p.path[i + 1])]);
      if (Number.isFinite(top)) bits.push(`主峰海拔约 ${Math.round(top / 10) * 10} 米`);
    }
    if (p.kind === 'river' || p.kind === 'mountains') bits.push(`在这个世界的${p.kind === 'river' ? '河流' : '山脉'}里算${p.rank >= 3 ? '数一数二的' : p.rank >= 2 ? '较大的' : '寻常的'}`);
    if (pos) {
      const c = climateText(g, pos[0], pos[1]);
      if (c) bits.push(`${p.kind === 'river' ? '中游' : '一带'}${c}`);
    }
    if (regs.length && p.kind !== 'sea') {
      const bs = new Map<number, number>();
      for (const r of regs) bs.set(civ.regions.biome[r], (bs.get(civ.regions.biome[r]) ?? 0) + 1);
      const top = [...bs].sort((a, b) => b[1] - a[1]).slice(0, 2);
      bits.push(`${p.kind === 'river' ? '流经' : '多为'}${top.map(([b]) => BIOMES[b]?.name ?? '').join('、')}`);
    }
    geography.push(bits.join(';'));
    if (pos) {
      const near = nearbyText(g, pos[0], pos[1], p.kind !== 'sea', t.id);
      if (near) geography.push(`附近:${near}`);
    }
    const along = citiesAlong(civ, g, p, 6);
    if (along) geography.push(`${p.kind === 'river' ? '沿河' : p.kind === 'sea' ? '沿岸的港口' : p.kind === 'lake' ? '湖边' : p.kind === 'mountains' ? '山下' : '附近'}的城:${along}`);
    if (p.kind !== 'sea') {
      const own = ownershipText(civ, regs);
      if (own) history.push(`${p.kind === 'river' ? '流经' : '所在'}之地归属变迁:${own}`);
    }
    const set = new Set(regs);
    chronicle = set.size ? chronicleLines(civ, (e) => (e.importance >= MAJOR && e.regions.some((r) => set.has(r)) ? { e, rank: e.importance } : null), 5) : [];
    const st = info.style?.id;
    peers = peerNames(
      civ.places,
      t.id,
      (x) => x.name,
      (x) => x.kind === p.kind && (p.kind === 'sea' || (x.culture >= 0 ? styleOf(x.culture) : worldStyleId(civ.seed, civ.names)) === st),
      (x) => x.kind !== 'sea' && p.kind !== 'sea' && (x.culture >= 0 ? styleOf(x.culture) : worldStyleId(civ.seed, civ.names)) === st,
      8,
    );
  } else if (t.kind === 'culture') {
    const cu = cus[t.id];
    people = `类型:${KIND_INFO[cu.kind].name}民族(${KIND_INFO[cu.kind].hint})`;
    const seat = civ.regions.seat[cu.hearth];
    geography.push(`发源地 ${regionLabel(civ, cu.hearth)}:${siteText(g, seat, { coastal: civ.habitat.coastDist[seat] === 1 })}`);
    const pk = peaks(civ).culture[cu.id];
    if (pk && pk.n > 0) geography.push(`最盛时分布约 ${pk.n} 州(${yearText(pk.year)}前后)`);
    history.push(`${yearText(cu.born)}兴起于${regionLabel(civ, cu.hearth)}`);
    const founded = civ.polities.filter((q) => q.culture === cu.id);
    if (founded.length) {
      history.push(
        `建立的国家:${founded
          .slice(0, 6)
          .map((q) => `${polityName(q, lastYear(civ, q))}(${yearSpan(q.founded, q.ended)})`)
          .join('、')}${founded.length > 6 ? ` 等 ${founded.length} 国` : ''}`,
      );
    }
    if (cu.migrations?.length) history.push(`迁徙:${cu.migrations.slice(0, 5).map((m) => `${yearText(m.year)}${m.dir}迁`).join(';')}`);
    let gone = '';
    for (const a of civ.annals) if (a.kind === 'vanish' && a.a === cu.id && cus[a.b]) gone = `,为${cultureLabel(cus[a.b])}所取代`;
    history.push(cu.ended !== undefined ? `${yearText(cu.ended)}消亡${gone}` : `到${yearText(civ.endYear)}仍在`);
    const ids = new Set<number>();
    civ.annals.forEach((a, i) => {
      if ((a.kind === 'migrate' || a.kind === 'assimilate' || a.kind === 'vanish') && (a.a === cu.id || a.b === cu.id)) ids.add(i);
    });
    chronicle = chronicleLines(civ, (e) => (ids.has(e.id) && e.importance >= 2 ? { e, rank: e.importance } : null), 6);
    peers = peerNames(
      cus,
      cu.id,
      (x) => x.name,
      () => false,
      (x) => x.style === cu.style,
      8,
    );
  } else {
    const r = t.id;
    const seat = civ.regions.seat[r];
    const c = civ.culture[r];
    people = c >= 0 ? peopleText(civ, c, '按') + '的语感起名(推演结束时住在这里的民族)' : '无人居住';
    geography.push(siteText(g, seat, { coastal: civ.habitat.coastDist[seat] === 1 }));
    const sc = habitatScore(civ.habitat.suitability[seat]);
    geography.push(`宜居度 ${sc}(${habitatWord(sc)})`);
    const cities = citiesIn(civ, r);
    if (cities) history.push(`州里的城:${cities}`);
    const own = ownershipText(civ, [r]);
    if (own) history.push(`归属变迁:${own}`);
    chronicle = chronicleLines(civ, (e) => (e.importance >= 2 && e.regions.includes(r) ? { e, rank: e.importance } : null), 5);
    // 同族住的州在前,再补同语感的
    const st = styleOf(c);
    const regs = Array.from({ length: civ.regions.count }, (_, q) => q);
    peers = peerNames(
      regs,
      r,
      (q) => (regionNamed(civ, q) ? regionLabel(civ, q) : ''),
      (q) => c >= 0 && civ.culture[q] === c,
      (q) => !!st && civ.culture[q] >= 0 && styleOf(civ.culture[q]) === st,
      8,
    );
  }

  return {
    target: t,
    info,
    nameNote,
    people,
    geography: geography.filter(Boolean),
    history: history.filter(Boolean),
    chronicle,
    peers: peers.filter((x) => x && x !== info.name && x !== info.shown),
    format: formatRule(civ, t, info),
    stamp: nameStamp(civ, t),
  };
}

// ---------------------------------------------------------------------------
// 起名的格式要求

function formatRule(civ: Civ, t: NameTarget, info: NameInfo): string {
  if (t.kind === 'polity') {
    const p = civ.polities[t.id];
    if (p.eastern) {
      const lead =
        info.keyKind === 'dynasty'
          ? `这是第 ${t.dynasty! + 1} 朝的国号(改朝换代后的新国号),只写国号本身`
          : '只写国号本身';
      const others = (p.dynasties ?? []).filter((_, i) => i !== (info.keyKind === 'dynasty' ? t.dynasty : 0)).map((d) => d.name);
      return (
        `${lead}:单字为主(如 霄、景、雍),也可以两个字(如 楼勒、有熊);不要带"大""国""王朝""汗国"这些字 —— ` +
        `程序会按国土大小自动加成 ${titleForms(p, 'X')}` +
        (others.length ? `;别和这国其他各朝的国号(${others.join('、')})重复` : '')
      );
    }
    return `只写国名本身(如 阿尔多里亚、斯卡尔海姆),不要带"王国""帝国""汗国""共和国""国"这些字 —— 程序会按国土大小自动加成 ${titleForms(p, 'X')}`;
  }
  if (t.kind === 'settlement') return '城名,和同族的城名一样带合适的词尾或通名(东方如 X州、X阳、X城、X关;西幻如 -维尔、-堡、-格勒、X港),两到五个字';
  if (t.kind === 'culture') return '只写族名本身,不带"族"字(界面上显示为"X族"),一到三个字为宜';
  if (t.kind === 'region') return '州名,东方如 X州、X郡、X原、X川,西幻如 -郡、-兰、-马克、-谷,两到五个字';
  const p = civ.places[t.id];
  switch (p.kind) {
    case 'river':
      return '河名,带通名"河""水""江"或"川"(西幻多用"X河"),两到五个字';
    case 'mountains':
      return '山名,带通名"山""岭"或"山脉"(原来叫"X山脉"的就还用"山脉"),两到六个字';
    case 'lake':
      return '湖名,带通名"湖""泽"或"池",两到五个字';
    case 'sea': {
      const k = placeKindLabel(p);
      return `照原来的种类带通名:这是${k},名字要以"${k === '大洋' ? '洋' : k === '海湾' ? '湾' : '海'}"结尾,两到五个字`;
    }
    case 'island':
      return '岛名,带通名"岛""屿"或"洲",两到五个字';
    case 'desert':
      return '荒漠名,带通名"漠""沙海""戈壁"或"荒原",两到五个字';
  }
}

// ---------------------------------------------------------------------------
// 提示词

/** 材料写成一段文字(释名、起名共用) */
export function materialText(m: NameMaterial, opts: { chronicle?: number } = {}): string {
  const { info } = m;
  const lines: string[] = [];
  lines.push(info.name ? `名字:${info.shown}` : `名字:还没有(界面上叫"${info.shown}")`);
  if (m.nameNote) lines.push(`说明:${m.nameNote}`);
  lines.push(`种类:${info.kindLabel}`);
  if (info.style) lines.push(`语感:${info.style.label} —— ${info.style.desc}`);
  if (m.people) lines.push(m.people);
  if (m.peers.length) lines.push(`同一语感的其他名字(看风格用):${m.peers.join('、')}`);
  if (m.geography.length) {
    lines.push('', '【地理】');
    for (const x of m.geography) lines.push(`- ${x}`);
  }
  if (m.history.length) {
    lines.push('', '【历史】');
    for (const x of m.history) lines.push(`- ${x}`);
  }
  const ch = m.chronicle.slice(0, opts.chronicle ?? m.chronicle.length);
  if (ch.length) {
    lines.push('', '【编年史里和它有关的几条】');
    for (const x of ch) lines.push(`- ${x}`);
  }
  return lines.join('\n');
}

/** 释名的字数:模型普遍写超(要 100–250 字时实测 290–370 字),所以要求写得比界面能放下的略短,上限写明白 */
export const EXPLAIN_CHARS = { min: 120, max: 200, hard: 230 };

const EXPLAIN_HEAD = `你是一个架空世界的"地名考"执笔人,为中文原创世界(OC)的作者解释地图上一个名字的含义和由来。`;

/** 中式名字怎么讲(东方语感、海洋) */
const EXPLAIN_EASTERN = `   · 这是一个中文名字:逐字讲字义(本义、引申义),点出取名的意象。不要给它编拉丁字母拼写、"古语读音"或外语词源。
   · 可以引一处古诗文或典籍(最多一处),必须确定真实存在、作者和篇名都对;拿不准就不引。`;

/** 音译名字怎么讲(西幻语感;边塞的音译名也按这个讲) */
const EXPLAIN_WESTERN = `   · 这个名字是从这个世界的某种语言音译来的。给出拟造的原文拼写(拉丁字母),拼写要和中文译名的读音对得上(按常见音译习惯,"萨利亚"对 Saliya / Saria,不要另起一个读音不同的词);
     拆成词根、词缀,讲每部分在当地语言里的意思。这是虚构的词源,自洽即可。
   · 只说"当地的古语""某族的语言",不要提现实中的语言(拉丁语、英语、古诺尔斯语、突厥语……)和现实中的词,也不要引用现实里的诗文典籍。`;

/** 边塞风:汉字取义的关塞名和音译名都有,两种讲法都给,说清怎么分 */
const EXPLAIN_MIXED = `   · 先看名字是哪一种:汉字取义的(如 镇北关、黄沙堡、清水河)逐字讲字义,点出意象,可以引一处确定真实存在的古诗文(拿不准就不引);
     音译的(如 楼勒、疏兰、阿支城 的"阿支")给出拟造的原文拼写(拉丁字母,和读音对得上),讲它在当地古语里的意思,只说"当地古语",不要提现实中的语言。
   · 中文名字不要编拉丁字母拼写,音译名字不要按汉字字面去拆。`;

/**
 * 释名的系统提示:按名字是中式还是音译,只给对应的一种讲法(两种都给时,模型会给中文名也编一个拉丁字母的"古语词源")。
 * 西幻语感 = 音译;边塞风两种都有;其余东方语感、海洋 = 中式
 */
export function explainSystem(style: StyleGuide | null): string {
  const how = !style || style.id === 'frontier' ? EXPLAIN_MIXED : style.family === 'western' ? EXPLAIN_WESTERN : EXPLAIN_EASTERN;
  return `${EXPLAIN_HEAD}

写法:
1. 一段 ${EXPLAIN_CHARS.min}–${EXPLAIN_CHARS.max} 字的中文正文(不要超过 ${EXPLAIN_CHARS.hard} 字):不分段、不加标题、不列要点,不用 Markdown。
2. 先讲名字本身:
${how}
3. 再把名字和材料里的地理、历史接上:为什么这个地方会被这样叫,或者后人怎样附会它的意思(国势盛衰、迁都、改朝换代、城破重建……)。
4. 只用材料里给出的事实(年份、国名、城名、民族、事件),不要编造材料里没有的战争、人物、年份,年份和事件要对上号(哪一年发生的什么照材料写);
   可以加民间传说、别称,但要写明"相传""一说""当地人说"。
5. 年份一律写"第 N 年"(这个世界的纪年),不要换算成公元或年号。
6. 语气像地方志、地名辞典里的条目,文雅但好懂,不要堆砌辞藻。材料里的"仙侠风""精灵风"之类是给你的风格提示,不要写进正文。直接写正文,不要开场白。`;
}

/** 释名:写"名字由来"(流式) */
export function explainRequest(m: NameMaterial): AiRequest {
  const style = m.info.style;
  const how = style
    ? `讲法提示(${style.label}):${style.explain}`
    : '讲法提示:按名字本身的字面讲,中式名字讲字义,音译名字给出拟造的词源。';
  const user = `请为下面这个名字写"名字由来"(${EXPLAIN_CHARS.min}–${EXPLAIN_CHARS.max} 字)。\n\n${materialText(m)}\n\n${how}`;
  const messages: AiMessage[] = [
    { role: 'system', content: explainSystem(style) },
    { role: 'user', content: user },
  ];
  return { feature: '释名', title: `${m.info.shown} · ${m.info.kindLabel}`, messages, temperature: 0.8, maxTokens: 800 };
}

/**
 * 起名时给作者看几个候选;问 AI 时多要两个 —— 和已有的名字重复、太长、带了别的符号的会被丢掉
 * (民族名常和国名撞),多要的补上去,作者看到的还是 5 个
 */
export const SUGGEST_SHOW = 5;
const SUGGEST_ASK = SUGGEST_SHOW + 2;

const SUGGEST_SYSTEM = `你是一个架空世界的起名顾问,按当地民族的"语感"给中文原创世界(OC)的作者起名字。

只回一个 JSON 对象,不要别的文字:
{"names":[{"name":"名字","meaning":"一句话含义"}]}
names 里正好 ${SUGGEST_ASK} 个。

要求:
1. name 只写名字本身的中文写法。西幻语感(音译)的名字另加一个 "latin" 字段写拉丁字母原形(如 {"name":"阿尔多里亚","latin":"Aldoria"}),拼写要和中文读音对得上;中式名字不写 latin。
2. 贴合语感说明和"同一语感的其他名字"的风格,贴合这个东西的种类、地理和历史;这些名字彼此要有差别(字面、意象、音节、词尾都别重复)。
3. meaning 用一句 15–40 字的话讲字义或词源、取的是什么意象。音译名字讲"当地语里"的意思,不要提现实中的语言(拉丁语、突厥语、英语……),也不要按汉字字面去拆音译名。
4. 不要和"同一语感的其他名字"、现在的名字重复,不要照搬现实中的国名、朝代名、城市名,也不要借用现成小说、游戏里的名字。
5. 名字格式按下面"名字格式"的要求。作者有额外要求时优先满足。`;

/** 作者加的一句要求:去掉换行、截短 */
export function cleanWish(wish: string | undefined): string {
  return (wish ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** 起名:问 SUGGEST_ASK 个,留 SUGGEST_SHOW 个候选(json: true) */
export function suggestRequest(m: NameMaterial, wish?: string): AiRequest {
  const style = m.info.style;
  const w = cleanWish(wish);
  const now = m.info.name ? `现在叫"${m.info.shown}",想换一个。` : '现在还没有名字,起一个。';
  const parts = [
    `请给下面这个${m.info.kindLabel}起 ${SUGGEST_ASK} 个新名字。${now}`,
    '',
    materialText(m, { chronicle: 4 }),
    '',
    `名字格式:${m.format}`,
    style ? `起名提示(${style.label}):${style.suggest}` : '',
    w ? `作者的额外要求:${w}` : '',
  ].filter((x, i, a) => x || (i > 0 && a[i - 1]));
  const messages: AiMessage[] = [
    { role: 'system', content: SUGGEST_SYSTEM },
    { role: 'user', content: parts.join('\n').trim() },
  ];
  return { feature: '起名', title: `${m.info.shown} · ${m.info.kindLabel}`, messages, temperature: 1, maxTokens: 1000, json: true };
}

// ---------------------------------------------------------------------------
// 解析起名

export interface Suggestion {
  /** 清理过的名字(国家 = 国名本身;民族不带"族") */
  name: string;
  meaning: string;
  latin?: string;
}

export type SuggestParse = { ok: true; list: Suggestion[]; dropped: number } | { ok: false; message: string };

/** 去掉 ```json 围栏,取第一个完整的 JSON 值(AI 改写也用) */
export function looseJson(text: string): unknown {
  const s = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    /* 往下找 */
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const a = s.indexOf(open);
    const b = s.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* 再试另一种 */
      }
    }
  }
  return undefined;
}

const LIST_KEYS = ['names', 'candidates', 'list', 'suggestions', 'result', '候选', '名字', '名单'];
const NAME_KEYS = ['name', 'zh', 'title', '名字', '名称', '名'];
const MEANING_KEYS = ['meaning', 'desc', 'description', 'explanation', 'note', '含义', '寓意', '解释', '说明'];

function pickField(o: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  return '';
}

function listOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of LIST_KEYS) if (Array.isArray(o[k])) return o[k] as unknown[];
    for (const x of Object.values(o)) if (Array.isArray(x)) return x;
  }
  return null;
}

/**
 * JSON 坏了时一条条捞:json 模式下模型偶尔把收尾的引号写成中文引号(”}),或在 JSON 后面接一大段自我检查的话,
 * 整段解析不了;这时按 "name":"…" 一条条找,带上紧跟着的 latin / meaning(实测 16 次起名里坏过 1 次)
 */
function salvageNames(text: string): Record<string, string>[] | null {
  const out: Record<string, string>[] = [];
  for (const m of text.matchAll(/"name"\s*:\s*"([^"“”\n]{1,24})"([^{}]*)/g)) {
    const rest = m[2];
    const latin = /"latin"\s*:\s*"([^"“”\n]{1,40})"/.exec(rest)?.[1] ?? '';
    const meaning = /"meaning"\s*:\s*"([^"“”\n]{1,120})["“”]/.exec(rest)?.[1] ?? '';
    out.push({ name: m[1], latin, meaning });
  }
  return out.length ? out : null;
}

/** 名字里不该有的:拉丁字母、数字、标点(间隔号"·"除外) */
const BAD_CHARS = /[A-Za-z0-9\s,,。.、;;::!!??"'“”‘’()()《》「」【】[\]{}<>/\\|@#$%^&*+=~`_-]/;

/** 名字最多几个字:东方国号 2(可带"大");民族 4;别的 10 */
function maxLen(info: NameInfo): number {
  if ((info.keyKind === 'polity' || info.keyKind === 'dynasty') && info.eastern) return 2;
  if (info.keyKind === 'culture') return 4;
  return Math.min(10, NAME_MAX);
}

/**
 * 解析起名的回复:{"names":[{"name","meaning","latin"?}]}(也认直接一个数组、别的键名、"名字:含义"字符串)。
 * 名字按改名的规则清理(国家去掉顺手打上的国号、民族去掉"族"),太长、带拉丁字母 / 标点、和现在的名字或 taken 重名的丢掉。
 * 一个能用的都没有 = { ok: false, message: 中文说明 }
 */
export function parseSuggestions(text: string, info: NameInfo, taken: ReadonlySet<string> = new Set()): SuggestParse {
  const v = looseJson(text);
  const arr = listOf(v) ?? salvageNames(text);
  if (!arr) return { ok: false, message: 'AI 回的不是约定的格式,没能读出候选名字。点"换一批"再试一次。' };
  const list: Suggestion[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const it of arr) {
    let raw = '';
    let meaning = '';
    let latin = '';
    if (typeof it === 'string') {
      const m = /^\s*([^::——\-–]+?)\s*(?:[::]|——|—|-|–)\s*(.*)$/.exec(it);
      raw = m ? m[1] : it;
      meaning = m ? m[2] : '';
    } else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      raw = pickField(o, NAME_KEYS);
      meaning = pickField(o, MEANING_KEYS);
      latin = typeof o.latin === 'string' ? o.latin : '';
    }
    let name = raw.replace(/^[\s"'“”‘’「」『』《》【】()()]+|[\s"'“”‘’「」『』《》【】()()。.!!]+$/g, '');
    name = cleanName(info.keyKind, name, info.eastern);
    const len = [...name].length;
    if (!name || len > maxLen(info) || BAD_CHARS.test(name) || name === info.name || taken.has(name) || seen.has(name)) {
      dropped++;
      continue;
    }
    seen.add(name);
    latin = latin.trim();
    list.push({
      name,
      meaning: meaning.replace(/\s+/g, ' ').trim().slice(0, 80),
      // 中式名字不要拉丁字母(模型常顺手给个拼音);边塞风的音译名留着
      ...(latin && (!info.eastern || info.style?.id === 'frontier') && /^[A-Za-z][A-Za-z '’-]{0,40}$/.test(latin) ? { latin } : {}),
    });
    if (list.length >= SUGGEST_SHOW) break;
  }
  if (!list.length) {
    return {
      ok: false,
      message: arr.length ? 'AI 给的名字都不合要求(太长、带了别的符号,或者和已有的名字重复)。点"换一批"再试一次。' : 'AI 没给出候选名字。点"换一批"再试一次。',
    };
  }
  return { ok: true, list, dropped };
}

/** 已经被占的名字(起名时和它们重复的丢掉;不含对象自己现在的名字) */
export function takenNames(civ: Civ, t: NameTarget): Set<string> {
  const out = new Set<string>();
  const info = nameInfo(civ, t);
  switch (t.kind) {
    case 'polity':
      for (const p of civ.polities) {
        out.add(p.name);
        for (const d of p.dynasties ?? []) if (d.name) out.add(d.name);
      }
      for (const c of civ.cultures) out.add(c.name);
      break;
    case 'settlement':
      for (const s of civ.settlements) out.add(s.name);
      break;
    case 'place':
      for (const p of civ.places) out.add(p.name);
      break;
    case 'culture':
      for (const c of civ.cultures) out.add(c.name);
      for (const p of civ.polities) out.add(p.name);
      break;
    case 'region':
      for (let r = 0; r < civ.regions.count; r++) if (regionNamed(civ, r)) out.add(regionLabel(civ, r));
      break;
  }
  if (info) out.delete(info.name);
  return out;
}

/** 选中一个候选后要写进改名表的:稳定键 + 新名字(和生成时的名字一样 = null,即恢复默认) */
export function suggestionEdit(info: NameInfo, name: string, fallback: string): { key: string; value: string | null } {
  const v = cleanName(info.keyKind, name, info.eastern);
  return { key: info.key, value: !v || v === fallback ? null : v };
}

/** 改名前的预览:国家 = 国号怎么变("霄部 → 霄国 → 大霄 → 大霄王朝");民族 = "X族";别的 = 名字本身 */
export function suggestionPreview(civ: Civ, t: NameTarget, info: NameInfo, name: string): string {
  if (t.kind === 'polity') {
    const p = civ.polities[t.id];
    if (p) return titleForms(p, name);
  }
  if (t.kind === 'culture') return `${name}族`;
  return name;
}

/** 生成时的名字(改名时和它一样 = 恢复默认)。raw = 没套改名的 Civ */
export function defaultName(raw: Civ, t: NameTarget, info: NameInfo): string {
  switch (t.kind) {
    case 'polity': {
      const p = raw.polities[t.id];
      if (!p) return '';
      return info.keyKind === 'dynasty' ? (p.dynasties?.[t.dynasty!]?.name ?? '') : p.name;
    }
    case 'settlement':
      return raw.settlements[t.id]?.name ?? '';
    case 'place':
      return raw.places[t.id]?.name ?? '';
    case 'culture':
      return raw.cultures[t.id]?.name ?? '';
    case 'region':
      return t.id >= 0 && t.id < raw.regions.count ? regionLabel(raw, t.id) : '';
  }
}

/** 释名的正文:去掉 Markdown 记号(标题、加粗、*斜体*、行首的列表记号)、首尾空白 */
export function cleanExplanation(text: string): string {
  return text
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[*-]\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 测试用假 AI(网址 ai=mock)的默认回复是 {"mock":true,…},起名时换成 5 个占位候选,好检查界面和流程

/** 回复是不是测试用假 AI 的默认 JSON */
export function isMockReply(text: string): boolean {
  const v = looseJson(text);
  return !!v && typeof v === 'object' && (v as Record<string, unknown>).mock === true && !listOf(v);
}

const MOCK_EAST: Record<string, string[]> = {
  polity: ['澜', '昭', '衡', '岚', '澄'],
  settlement: ['听涛城', '栖霞城', '望川城', '临澜城', '云阳城'],
  river: ['澄川', '碧溪河', '听涛水', '白鹭河', '云渡江'],
  mountains: ['栖霞岭', '摘星山', '苍翠岭', '云屏山', '凌霄山'],
  lake: ['镜湖', '烟波泽', '碧落湖', '澄心湖', '月照湖'],
  sea: ['长风海', '碧澜海', '寒雾海', '潮音海', '沧浪海'],
  island: ['蓬莱岛', '栖凤屿', '孤云岛', '月牙岛', '听潮屿'],
  desert: ['流沙漠', '赤沙海', '瀚海原', '金沙漠', '孤烟漠'],
  culture: ['澜', '昭', '衡', '岚', '澄'],
  region: ['宁州', '嘉平郡', '澄原', '云川', '临州'],
};
const MOCK_WEST: Record<string, string[]> = {
  polity: ['阿尔瑟里亚', '维兰迪亚', '卡雷诺', '洛瑟兰', '塞伦尼亚'],
  settlement: ['阿尔瑟维尔', '洛兰堡', '塞伦福德', '维斯特港', '卡雷诺纳'],
  river: ['阿瑟河', '洛兰河', '塞伦河', '维斯河', '卡诺河'],
  mountains: ['阿尔瑟山脉', '洛兰山脉', '塞伦山脉', '维斯山脉', '卡诺山脉'],
  lake: ['阿瑟湖', '洛兰湖', '塞伦湖', '维斯湖', '卡诺湖'],
  sea: ['长风海', '碧澜海', '寒雾海', '潮音海', '沧浪海'],
  island: ['阿瑟岛', '洛兰岛', '塞伦岛', '维斯岛', '卡诺岛'],
  desert: ['阿瑟荒漠', '洛兰荒漠', '塞伦荒漠', '维斯荒漠', '卡诺荒漠'],
  culture: ['阿瑟', '洛兰', '塞伦', '维斯', '卡诺'],
  region: ['阿瑟郡', '洛兰郡', '塞伦郡', '维斯郡', '卡诺郡'],
};

/** 测试用假 AI 的占位候选(和已有名字重复的跳过) */
export function mockSuggestions(civ: Civ, t: NameTarget, info: NameInfo): Suggestion[] {
  const k = t.kind === 'place' ? (civ.places[t.id]?.kind ?? 'river') : t.kind;
  let pool = (info.eastern ? MOCK_EAST : MOCK_WEST)[k] ?? MOCK_EAST.settlement;
  if (t.kind === 'place' && civ.places[t.id]?.kind === 'sea') {
    const g = placeKindLabel(civ.places[t.id]);
    pool = pool.map((x) => x.slice(0, -1) + (g === '大洋' ? '洋' : g === '海湾' ? '湾' : '海'));
  }
  const taken = takenNames(civ, t);
  return pool
    .filter((x) => !taken.has(x) && x !== info.name)
    .map((name) => ({ name, meaning: '测试用假 AI 的占位候选' }));
}
