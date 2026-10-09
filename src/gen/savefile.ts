/**
 * 存档文件(阶段 4):一个世界 = 种子 + 参数 + 用户的修改(gen/edits.ts 的 WorldEdits)。
 * 同种子 + 参数 = 同一个世界,所以不存地形、历史,文件只有几 KB;读档时先按参数重新生成,再套上修改。
 *
 * 文件是普通的 JSON(开放格式,不锁定数据),浏览器里的自动存档(ui/saveStore.ts)也用同一个格式:
 *
 * ```json
 * {
 *   "app": "文明与地图", "format": 1, "generator": 5,
 *   "seed": 7, "params": { "seed": 7, "cells": 36000, ... },
 *   "edits": { "names": { "settlement:c4567#0": "饕餮城", "region:c8123": "九嶷州" }, "interventions": [],
 *              "terrain": [{ "kind": "volcano", "pts": [812, 403], "r": 28, "s": 1.05 }] },
 *   "check": "3f9a0c1d7b2e", "savedAt": "2026-09-27T08:00:00.000Z",
 *   "title": "九州大陆", "view": { "projection": "robinson", "center": 120 }
 * }
 * ```
 *
 * - format:存档格式的版本(字段有不兼容的变化时加一;读到比自己新的格式就不读,提示更新页面)
 * - generator:生成器版本(edits.ts 的 GENERATOR_VERSION);和当前的不同 = 同样的参数可能生成不同的世界
 * - check:地形的短哈希(worldCheck);读档生成完再算一遍,对不上也说明地形变了。两种情况都照样打开,
 *   提示"改过的名字会尽量套上"(稳定键按州、地块定位,地形变化不大时大多还能对上)
 * - edits.aiNames(可选):哪些名字是从 AI 起名里挑的(edits.ts 文件头"改名"),`{ "polity:c4567#0": { "name": "青渊", "was": "渊" } }`;
 *   只存现在还用着的那几个,旧存档没有 = 一个也没有
 * - edits.flags(可选):改过的国旗(edits.ts 文件头"改旗"),`{ "polity:c4567#0": "b/plain/W/e=R/k=long" }`;
 *   读档时逐面核对写法(civ/flags.ts 的 decodeFlag),格式不对的跳过。旧存档没有 = 一面也没改
 * - edits.interventions:干预(具体种类见 edits.ts 文件头"干预");这里当成不透明的数组原样存、原样读回
 * - edits.terrain:地形修改(edits.ts 文件头"地形修改");读档时逐处过 cleanTerrainOp,格式不对的跳过。
 *   旧存档没有这个字段 = 没改地形。check 是**改过地形以后**的地形哈希(读档时带着地形修改生成,再核对)
 * - edits.sketch(可选):地形草图(edits.ts 文件头"地形草图"),`{ "rest": "auto", "strokes": [{ "kind": "land", "r": 32, "pts": [700, 300, 760, 310] }] }`,
 *   导入过图片的多一个 `"image": { "name": "地图.jpg", "cells": "<认出来的格子图>" }`;
 *   没画时不写这个字段。读档时过 cleanSketch,格式不对的笔画、图片跳过。check 同样是照草图生成以后的地形哈希
 * - edits.upheavals(可选):地形大事(edits.ts 文件头"地形大事"),`[{ "year": 1600, "ops": [{ "kind": "sink", "pts": [1856, 574, 1936, 584], "r": 40, "s": 1.1 }] }]`;
 *   没有时不写这个字段。读档时过 cleanUpheaval,格式不对的跳过。check 只核对原来的地形(大事之后的地形由它和大事一起定)
 * - edits.marks(可选):作者标记(edits.ts 文件头"作者标记"),`[{ "id": 1, "title": "主角的故乡", "color": "red", "from": 2490, "at": [1852.4, 512] }]`;
 *   没有标记时不写这个字段。读档时过 cleanMarks,格式不对的跳过
 * - edits.characters(可选):作者的人物(characters.ts),`[{ "id": 1, "name": "林小满", "color": "red", "born": 2490, "died": 2561,
 *   "birthplace": "settlement:c4567#0", "life": [{ "year": 2506, "text": "随军西征", "where": "region:c8123" }] }]`;
 *   没有人物时不写这个字段。读档时逐个过 cleanCharacter,格式不对的跳过
 * - view:看这个世界用的投影和中央经线(`{ "projection": "robinson", "center": 120 }`,可选)。
 *   投影名原样存(render/projection.ts 的 ProjectionId,或 "globe"),认不出的由界面当成等距圆柱;
 *   旧存档没有这个字段 = 等距圆柱、中央经线 0°
 * - origin:底稿出处(可选)。打开别人的分享短链接、改了另存进自己的"我的世界"时记下:分享的人填的署名(可以没有)、
 *   那时的世界名、分享链接(`{ "by": "明月", "title": "苍澜界", "url": "https://…/s/k7Qm2xPa" }`)。
 *   跟着世界走(存成文件、同步、再分享都带着);别人再从这一份另存,记的是直接的来源,不往上追
 *
 * 纯计算,不碰 DOM(Node 里可测)。
 */
import { DEFAULT_PARAMS, type World, type WorldParams } from './world';
import { GENERATOR_CHANGES, GENERATOR_VERSION, MARKS_MAX, MARK_REGIONS_TOTAL, NAME_MAX, aiNameKeys, cleanMark, freeMarkId, type AiNameMark, type AuthorMark, type GeneratorChange, type Intervention, type TerrainOp, type Upheaval, type WorldEdits } from './edits';
import { TERRAIN_MAX_OPS, UPHEAVALS_MAX, UPHEAVAL_KINDS, UPHEAVAL_OPS_MAX, cleanTerrainOp, cleanUpheaval } from './terrainEdits';
import { SKETCH_MAX_STROKES, cleanSketch, cleanSketchStroke, type SketchEdit } from './sketch';
import { decodeFlag } from './civ/flags';
import { CHARACTERS_MAX, cleanCharacters, type AuthorCharacter } from './characters';

export const SAVE_APP = '文明与地图';
/**
 * 存档格式版本。加一时注意:旧版网站读不了更新格式的存档,打开文件、分享链接读进来的存档已经换成了现在的格式,
 * 「看原样」(ui/oldSite.ts)交给旧版网站之前要换回它认得的格式
 */
export const SAVE_FORMAT = 1;

export interface SaveFile {
  app: '文明与地图';
  format: 1;
  /** 生成器版本(GENERATOR_VERSION) */
  generator: number;
  seed: number;
  params: WorldParams;
  edits: WorldEdits;
  /** 地形的短哈希(worldCheck) */
  check: string;
  /** 用户给这个世界起的名字("九州大陆") */
  title?: string;
  /** 看这个世界用的投影和中央经线;没有 = 等距圆柱、0° */
  view?: SaveView;
  /** 底稿出处:从别人的分享链接另存来的 */
  origin?: SaveOrigin;
  /** 存档时间(ISO 8601) */
  savedAt: string;
}

/** 底稿出处 */
export interface SaveOrigin {
  /** 分享的人填的署名;没填 = 没有 */
  by?: string;
  /** 另存那时的世界名(没起名 = 空) */
  title: string;
  /** 分享链接(网站地址/s/<码>) */
  url: string;
}

/** 投影 + 中央经线(存进存档、分享链接) */
export interface SaveView {
  /** 投影名:"equirect" 等距圆柱、"robinson" 罗宾森、"naturalEarth"、"mollweide"、"mercator"、"globe" 地球仪…… */
  projection: string;
  /** 中央经线(度,−180 … 180) */
  center: number;
}

/** 没存投影的存档(旧存档)按这个看 */
export const DEFAULT_VIEW: SaveView = { projection: 'equirect', center: 0 };

/** 整理投影设置:投影名只收短的字母串,中央经线挪到 [−180, 180)、保留两位小数;不像样的 = null */
export function cleanView(raw: unknown): SaveView | null {
  if (!isObj(raw)) return null;
  const p = raw.projection;
  const c = raw.center;
  if (typeof p !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(p)) return null;
  if (typeof c !== 'number' || !Number.isFinite(c)) return null;
  const t = (c + 180) / 360;
  const lon = (t - Math.floor(t)) * 360 - 180;
  return { projection: p, center: Math.round(lon * 100) / 100 };
}

/** 署名最长几个字 */
export const SIGNATURE_MAX = 20;

/** 看不见、但组合表情和连写离不开的字符:零宽连接(👩‍💻)、零宽不连接、各种变体选择(❤️、蒙古文的)、表情旗帜里的标签 */
const JOINERS = /[\u200C\u200D\p{Variation_Selector}\u{E0020}-\u{E007F}]/u;
const JOINERS_ALL = new RegExp(JOINERS.source, 'gu');
/** 开头的这些字符和空白(前面没有字可以组合,没有用) */
const LEADING = new RegExp(`^(?:${JOINERS.source}|\\s)+`, 'u');
/** 署名最多占多长(UTF-16 码元;一个字后面挂上一长串看不见的字符也只算一个字,得另外限住) */
export const SIGNATURE_UNITS = 320;

/**
 * 署名:去掉控制字符和别的看不见的字符(换行、制表这类算空白;零宽空格、改文字方向的都去掉,组合表情要用的留着)、首尾空白,
 * 开头的组合用字符去掉,连续空白并成一个,超长截断(按看到的字数,另外总长不超过 SIGNATURE_UNITS);空(只剩组合用的字符也算)= 没署名
 */
export function cleanSignature(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, (c) => (/\s/.test(c) ? ' ' : JOINERS.test(c) ? c : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING, '');
  let t = '';
  let n = 0;
  // 只分前面够用的一段(超出总长的反正放不下)
  for (const g of graphemes(s.slice(0, SIGNATURE_UNITS + 1))) {
    if (n >= SIGNATURE_MAX || t.length + g.length > SIGNATURE_UNITS) break;
    t += g;
    n++;
  }
  t = t.trimEnd();
  return t.replace(JOINERS_ALL, '').trim() ? t : '';
}

/** 按看到的字分开(一个组合表情、一个带变体选择的 ❤️ 都算一个字);太旧的浏览器没有这个功能就按码位分 */
function graphemes(s: string): string[] {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return [...s];
  return Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(s), (x) => x.segment);
}

/** 分享短链接的样子:http(s)://网站地址/s/<码>(网站可以在子目录里) */
const ORIGIN_CHARS = /^https?:\/\/[^\s"'<>\\]+$/;
const ORIGIN_PATH = /\/s\/[A-Za-z0-9]{4,32}$/;

/** 是不是分享短链接:按网址解析,路径以 /s/<码> 结尾,不带账号密码、问号后的参数、# 后的部分,而且本来就是规范写法 */
function isShareLink(url: string): boolean {
  if (url.length > 300 || !ORIGIN_CHARS.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && !u.search && !u.hash && ORIGIN_PATH.test(u.pathname) && u.href === url;
}

/** 整理底稿出处:链接不像分享短链接的不要(界面上它是一个能点的链接) */
export function cleanOrigin(raw: unknown): SaveOrigin | null {
  if (!isObj(raw)) return null;
  const url = raw.url;
  if (typeof url !== 'string' || !isShareLink(url)) return null;
  const o: SaveOrigin = { title: cleanTitle(raw.title), url };
  const by = cleanSignature(raw.by);
  if (by) o.by = by;
  return o;
}

/** 两份投影设置是不是一样(中央经线差不到 0.01° 算一样) */
export function sameView(a: SaveView | null | undefined, b: SaveView | null | undefined): boolean {
  const x = a ?? DEFAULT_VIEW;
  const y = b ?? DEFAULT_VIEW;
  return x.projection === y.projection && Math.abs(x.center - y.center) < 0.005;
}

export type ParseResult = { ok: true; save: SaveFile; warnings: string[] } | { ok: false; error: string };

/** 生成器每种改动对应的说法(versionNote 接在"来自旧版本："后面) */
const CHANGE_TEXT: Record<GeneratorChange, string> = {
  planet: '整颗星球重新生成了，地形和历史都和原来不同',
  terrain: '地形有局部变化，历史重新推演了',
  climate: '陆地和山没变，气候、河流和历史都重算了',
  history: '地形和气候没变，历史重新推演了',
  chronicle: '疆域和兴亡没变，编年史写得更细了',
  names: '地形和历史没变，默认的地名换了',
};
const CHANGE_RANK: GeneratorChange[] = ['names', 'chronicle', 'history', 'climate', 'terrain', 'planet'];

/** 来自更新的版本(页面是旧的):不知道新版改了什么,只说怎么换到最新版 */
export const NEWER_NOTE = '来自更新的版本，刷新页面换到最新版再看';

/**
 * 从第 from 版生成器到现在,同样的种子、参数(改没改过地形)生成出来的世界变了什么:跨过的几版里最大的那种改动。
 * 一样 = null(比如只动了改过地形的世界的那一版,这个世界没改地形);比现在新 = 'newer';
 * 认不出的旧版本(没记版本号、不是整数、表里没有的)按整颗星球重新生成算
 */
function changeSince(from: number, terrainEdited: boolean): GeneratorChange | 'newer' | null {
  if (from === GENERATOR_VERSION) return null;
  // 不是整数的版本号(手改过、坏了的存档)认不出,不管比现在大还是小,都按整颗星球重新生成算
  if (!Number.isInteger(from)) return 'planet';
  if (from > GENERATOR_VERSION) return 'newer';
  let top = -1;
  for (let v = Math.max(1, from) + 1; v <= GENERATOR_VERSION; v++) {
    const c = GENERATOR_CHANGES[v];
    const rank = c ? CHANGE_RANK.indexOf(c.change) : CHANGE_RANK.length - 1;
    if (c?.edited && !terrainEdited) continue;
    top = Math.max(top, rank);
  }
  return top < 0 ? null : CHANGE_RANK[top];
}

/** 打开旧存档、旧链接时说清变了什么(见 changeSince);一样 = null;比现在新 = NEWER_NOTE */
export function versionNote(from: number, terrainEdited: boolean): string | null {
  const c = changeSince(from, terrainEdited);
  return c === null ? null : c === 'newer' ? NEWER_NOTE : `来自旧版本：${CHANGE_TEXT[c]}`;
}

/** 生成器版本相同、地形却对不上时的提示 */
export const CHECK_WARNING = '地形和存档时对不上(可能来自别的版本),改过的名字会尽量套上';

/** 世界名最长几个字 */
export const TITLE_MAX = 24;
/** 存档文件最大多少字节(再大就不像存档了) */
const MAX_BYTES = 8 * 1024 * 1024;
/** 改名最多多少条、键最长多少字 */
const MAX_NAMES = 20000;
const KEY_MAX = 64;
/** 最多读多少面改过的旗 */
const MAX_FLAGS = 5000;

/** 参数的合理范围:存档里超出的调回范围内(比界面滑条宽;再大生成会慢到卡死) */
const PARAM_RANGE: Record<keyof WorldParams, [number, number]> = {
  seed: [-(2 ** 53), 2 ** 53],
  cells: [2000, 200000],
  landFraction: [0.02, 0.95],
  plates: [2, 64],
  mountains: [0, 5],
  temperature: [-40, 40],
  rainfall: [0, 5],
};

const PARAM_NAME: Record<keyof WorldParams, string> = {
  seed: '种子',
  cells: '精细度',
  landFraction: '陆地比例',
  plates: '板块数量',
  mountains: '造山强度',
  temperature: '气温',
  rainfall: '降水',
};

const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[];

/** 一个世界的身份(种子 + 全部参数,固定顺序):浏览器里按它存、按它找 */
export function worldKey(params: WorldParams): string {
  return PARAM_KEYS.map((k) => `${k}=${params[k] ?? DEFAULT_PARAMS[k]}`).join('&');
}

/** 改了几处:改名条数 + 干预条数 + 地形修改处数 + 草图(画了算一处)+ 地形大事件数 + 作者标记个数 + 改过的旗面数 + 作者的人物个数 */
export function editCount(edits: WorldEdits): number {
  return (
    Object.keys(edits.names).length +
    edits.interventions.length +
    (edits.terrain?.length ?? 0) +
    (edits.sketch ? 1 : 0) +
    (edits.upheavals?.length ?? 0) +
    (edits.marks?.length ?? 0) +
    Object.keys(edits.flags ?? {}).length +
    (edits.characters?.length ?? 0)
  );
}

/** 世界名:去掉控制字符、首尾空白,超长截断;空 = 没起名 */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const cs = [...s];
  return cs.length > TITLE_MAX ? cs.slice(0, TITLE_MAX).join('') : s;
}

/** 生成一份存档(params 按固定顺序复制;修改复制一份,之后改原来的不影响存档)。view = 当前的投影和中央经线;origin = 底稿出处 */
export function makeSave(
  params: WorldParams,
  edits: WorldEdits,
  check: string,
  title?: string,
  savedAt = new Date().toISOString(),
  view?: SaveView | null,
  origin?: SaveOrigin | null,
): SaveFile {
  const p = {} as WorldParams;
  for (const k of PARAM_KEYS) p[k] = params[k] ?? DEFAULT_PARAMS[k];
  const save: SaveFile = {
    app: SAVE_APP,
    format: SAVE_FORMAT,
    generator: GENERATOR_VERSION,
    seed: p.seed,
    params: p,
    edits: {
      names: { ...edits.names },
      interventions: edits.interventions.map((x) => ({ ...x })),
      terrain: (edits.terrain ?? []).map((x) => ({ ...x, pts: x.pts.slice() })),
    },
    check,
    savedAt,
  };
  // AI 起的名字:只存现在还用着的
  const ai = aiNameKeys(edits);
  if (ai.length) save.edits.aiNames = Object.fromEntries(ai.map((k) => [k, { ...edits.aiNames![k] }]));
  // 草图:画了才写
  if (edits.sketch) {
    const { rest, coast, strokes, image } = edits.sketch;
    save.edits.sketch = {
      rest,
      ...(coast !== undefined ? { coast } : {}),
      strokes: strokes.map((x) => ({ ...x, pts: x.pts.slice() })),
      ...(image ? { image: { ...image } } : {}),
    };
  }
  // 地形大事:有才写
  if (edits.upheavals?.length) save.edits.upheavals = edits.upheavals.map((u) => ({ year: u.year, ops: u.ops.map((x) => ({ ...x, pts: x.pts.slice() })) }));
  // 作者标记:有才写
  if (edits.marks?.length) save.edits.marks = edits.marks.map(copyMark);
  if (edits.flags && Object.keys(edits.flags).length) save.edits.flags = { ...edits.flags };
  if (edits.characters?.length) save.edits.characters = edits.characters.map((c) => JSON.parse(JSON.stringify(c)) as AuthorCharacter);
  const t = cleanTitle(title);
  if (t) save.title = t;
  const v = view ? cleanView(view) : null;
  if (v) save.view = v;
  const o = origin ? cleanOrigin(origin) : null;
  if (o) save.origin = o;
  return save;
}

/** 复制一个标记(之后改原来的不影响存档) */
function copyMark(m: AuthorMark): AuthorMark {
  const c: AuthorMark = { ...m };
  if (m.at) c.at = [m.at[0], m.at[1]];
  if (m.regions) c.regions = m.regions.slice();
  return c;
}

/** 存档 → 文件内容(缩进两格,人也能读) */
export function saveText(save: SaveFile): string {
  return JSON.stringify(save, null, 2) + '\n';
}

/** 下载的文件名开头(存档、导出的图片和编年史共用):文明与地图-九州大陆;没起名 = 文明与地图-种子7 */
export function fileBaseName(save: Pick<SaveFile, 'title' | 'seed'>): string {
  // eslint-disable-next-line no-control-regex
  const t = cleanTitle(save.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^\.+/, '').trim();
  return `${SAVE_APP}-${t || `种子${save.seed}`}`;
}

/** 下载用的文件名:文明与地图-九州大陆.json;没起名 = 文明与地图-种子7.json */
export function saveFileName(save: Pick<SaveFile, 'title' | 'seed'>): string {
  return `${fileBaseName(save)}.json`;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * 读存档:文件内容 → 存档。读不了(不是 JSON、不是本应用的存档、格式比自己新、没有种子)给中文错误;
 * 能读但有问题(生成器版本不同、参数超出范围、个别改名 / 干预格式不对)照样打开,附中文提示
 */
export function parseSave(text: string): ParseResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '文件是空的' };
  if (text.length > MAX_BYTES) return { ok: false, error: '文件太大,不像「文明与地图」的存档' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: '读不懂这个文件:它不是「文明与地图」的存档(.json)' };
  }
  if (!isObj(raw) || raw.app !== SAVE_APP) return { ok: false, error: '这不是「文明与地图」的存档文件' };
  const format = raw.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) return { ok: false, error: '存档文件坏了:缺少格式版本' };
  if (format > SAVE_FORMAT) return { ok: false, error: `这个存档来自更新版本的「文明与地图」(存档格式 ${format}),请刷新页面换到最新版再打开` };

  const warnings: string[] = [];
  const P = isObj(raw.params) ? raw.params : {};
  const seedRaw = typeof raw.seed === 'number' ? raw.seed : P.seed;
  if (typeof seedRaw !== 'number' || !Number.isFinite(seedRaw)) return { ok: false, error: '存档文件坏了:没有种子' };
  const params = { ...DEFAULT_PARAMS, seed: seedRaw } as WorldParams;
  const bad: string[] = [];
  for (const k of PARAM_KEYS) {
    if (k === 'seed') continue;
    const v = P[k];
    if (v === undefined) continue; // 老存档没有的参数用默认值
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      bad.push(PARAM_NAME[k]);
      continue;
    }
    const [lo, hi] = PARAM_RANGE[k];
    if (v < lo || v > hi) bad.push(PARAM_NAME[k]);
    params[k] = Math.min(hi, Math.max(lo, v));
  }
  if (bad.length) warnings.push(`存档里的${bad.join('、')}不对,已改成合理的值`);

  const generator = typeof raw.generator === 'number' && Number.isFinite(raw.generator) ? raw.generator : 0;
  // 版本不同的提示排在参数之后、改名之前;变了什么要看改没改过地形,地形修改读完再算
  const noteAt = warnings.length;

  // 修改:改名只收"字符串键 → 非空字符串";干预原样收(只跳过不是对象的)
  const E = isObj(raw.edits) ? raw.edits : {};
  const names: Record<string, string> = {};
  let dropped = 0;
  if (isObj(E.names)) {
    for (const [k, v] of Object.entries(E.names)) {
      if (Object.keys(names).length >= MAX_NAMES) {
        dropped++;
        continue;
      }
      if (typeof v !== 'string' || !v.trim() || k.length > KEY_MAX || !k.includes(':')) {
        dropped++;
        continue;
      }
      const cs = [...v];
      names[k] = cs.length > NAME_MAX ? cs.slice(0, NAME_MAX).join('') : v;
    }
  } else if (E.names !== undefined) dropped++;
  if (dropped) warnings.push(`有 ${dropped} 处改名格式不对,已跳过`);
  // AI 起的名字的记号:只收和改名对得上的(格式不对的悄悄跳过,只是少了"AI 写"的标记)
  const aiNames: Record<string, AiNameMark> = {};
  if (isObj(E.aiNames)) {
    for (const [k, v] of Object.entries(E.aiNames)) {
      if (!isObj(v) || typeof v.name !== 'string' || names[k] !== v.name) continue;
      aiNames[k] = typeof v.was === 'string' && v.was.trim() && [...v.was].length <= NAME_MAX ? { name: v.name, was: v.was } : { name: v.name };
    }
  }
  // 改过的旗:键像改名的键,值要能读成一面旗
  const flags: Record<string, string> = {};
  let droppedF = 0;
  if (isObj(E.flags)) {
    for (const [k, v] of Object.entries(E.flags)) {
      if (Object.keys(flags).length >= MAX_FLAGS || k.length > KEY_MAX || !/^(polity|dynasty):/.test(k) || !decodeFlag(v)) droppedF++;
      else flags[k] = v as string;
    }
  } else if (E.flags !== undefined) droppedF++;
  if (droppedF) warnings.push(`有 ${droppedF} 面改过的旗格式不对,已跳过`);
  const interventions: Intervention[] = [];
  let droppedI = 0;
  if (Array.isArray(E.interventions)) {
    for (const x of E.interventions) {
      if (isObj(x)) interventions.push(x as Intervention);
      else droppedI++;
    }
  } else if (E.interventions !== undefined) droppedI++;
  if (droppedI) warnings.push(`有 ${droppedI} 条干预格式不对,已跳过`);
  // 地形修改:逐处清理(坐标夹回地图内),认不出的跳过;旧存档没有 = 没改地形
  const terrain: TerrainOp[] = [];
  let droppedT = 0;
  if (Array.isArray(E.terrain)) {
    for (const x of E.terrain) {
      const v = terrain.length < TERRAIN_MAX_OPS ? cleanTerrainOp(x) : null;
      if (v) terrain.push(v);
      else droppedT++;
    }
  } else if (E.terrain !== undefined) droppedT++;
  if (droppedT) warnings.push(`有 ${droppedT} 处地形修改格式不对,已跳过`);
  // 草图:逐笔清理,认不出的跳过;旧存档没有 = 没画
  let sketch: SketchEdit | null = null;
  if (E.sketch !== undefined) {
    const raw = isObj(E.sketch) && Array.isArray(E.sketch.strokes) ? (E.sketch.strokes as unknown[]) : null;
    if (!raw) warnings.push('草图格式不对,已跳过');
    else {
      sketch = cleanSketch(E.sketch);
      const bad = raw.slice(0, SKETCH_MAX_STROKES).filter((x) => !cleanSketchStroke(x)).length;
      if (bad) warnings.push(`草图有 ${bad} 笔格式不对,已跳过`);
      if (raw.length > SKETCH_MAX_STROKES) warnings.push(`草图最多 ${SKETCH_MAX_STROKES} 笔,多出来的 ${raw.length - SKETCH_MAX_STROKES} 笔没有读进来`);
      if ((E.sketch as Record<string, unknown>).image !== undefined && !sketch?.image) warnings.push('草图里导入的图片格式不对,已跳过');
    }
  }
  // 地形大事:逐件清理,认不出的跳过;最多 UPHEAVALS_MAX 件、每件 UPHEAVAL_OPS_MAX 笔;旧存档没有 = 没有
  const upheavals: Upheaval[] = [];
  let droppedU = 0;
  let overU = 0;
  let droppedUOps = 0;
  let overUOps = 0;
  if (Array.isArray(E.upheavals)) {
    for (const x of E.upheavals) {
      const v = cleanUpheaval(x);
      if (!v) droppedU++;
      else if (upheavals.length >= UPHEAVALS_MAX) overU++;
      else {
        upheavals.push(v);
        // 读进来了、但丢了几笔的:格式不对的、超过笔数上限的
        const raw = (x as { ops: unknown[] }).ops;
        const bad = raw.filter((o) => {
          const c = cleanTerrainOp(o);
          return !c || !UPHEAVAL_KINDS.includes(c.kind);
        }).length;
        droppedUOps += bad;
        overUOps += raw.length - bad - v.ops.length;
      }
    }
  } else if (E.upheavals !== undefined) droppedU++;
  if (droppedU) warnings.push(`有 ${droppedU} 件地形大事格式不对,已跳过`);
  if (overU) warnings.push(`地形大事最多 ${UPHEAVALS_MAX} 件,多出来的 ${overU} 件没有读进来`);
  if (droppedUOps) warnings.push(`地形大事里有 ${droppedUOps} 笔格式不对,已跳过`);
  if (overUOps) warnings.push(`地形大事每件最多 ${UPHEAVAL_OPS_MAX} 笔,多出来的 ${overUOps} 笔没有读进来`);
  // 作者标记:逐个清理,认不出的跳过;编号重复的换一个新编号;最多留 MARKS_MAX 个、一共圈 MARK_REGIONS_TOTAL 个州;旧存档没有 = 没有标记
  const marks: AuthorMark[] = [];
  let droppedM = 0;
  let overM = 0;
  let overR = 0;
  if (Array.isArray(E.marks)) {
    const ids = new Set<number>();
    let regions = 0;
    for (const x of E.marks) {
      const m = cleanMark(x);
      if (!m) {
        droppedM++;
        continue;
      }
      if (marks.length >= MARKS_MAX) overM++;
      else if (m.regions && regions + m.regions.length > MARK_REGIONS_TOTAL) overR++;
      else {
        regions += m.regions?.length ?? 0;
        marks.push(m);
      }
    }
    let max = marks.reduce((a, m) => Math.max(a, m.id), 0);
    const used = new Set(marks.map((m) => m.id));
    for (let i = 0; i < marks.length; i++) {
      if (ids.has(marks[i].id)) {
        marks[i] = { ...marks[i], id: freeMarkId(used, max) };
        max = Math.max(max, marks[i].id);
      }
      ids.add(marks[i].id);
    }
  } else if (E.marks !== undefined) droppedM++;
  if (droppedM) warnings.push(`有 ${droppedM} 个作者标记格式不对,已跳过`);
  if (overM) warnings.push(`作者标记最多 ${MARKS_MAX} 个,多出来的 ${overM} 个没有读进来`);
  if (overR) warnings.push(`作者标记一共最多圈 ${MARK_REGIONS_TOTAL} 个州,多出来的 ${overR} 个标记没有读进来`);
  // 作者的人物:逐个清理,认不出的跳过;编号重复的换一个新编号;最多留 CHARACTERS_MAX 个;旧存档没有 = 没有人物
  const count = { dropped: 0, over: 0 };
  const characters = Array.isArray(E.characters) ? cleanCharacters(E.characters, count) : [];
  if (E.characters !== undefined && !Array.isArray(E.characters)) count.dropped++;
  if (count.dropped) warnings.push(`有 ${count.dropped} 个作者的人物格式不对,已跳过`);
  if (count.over) warnings.push(`作者的人物最多 ${CHARACTERS_MAX} 个,多出来的 ${count.over} 个没有读进来`);
  const note = versionNote(generator, terrain.length > 0 || !!sketch);
  if (note) warnings.splice(noteAt, 0, note);

  const save: SaveFile = {
    app: SAVE_APP,
    format: SAVE_FORMAT,
    generator,
    seed: params.seed,
    params,
    edits: {
      names,
      ...(Object.keys(aiNames).length ? { aiNames } : {}),
      interventions,
      terrain,
      ...(sketch ? { sketch } : {}),
      ...(upheavals.length ? { upheavals } : {}),
      ...(marks.length ? { marks } : {}),
      ...(Object.keys(flags).length ? { flags } : {}),
      ...(characters.length ? { characters } : {}),
    },
    check: typeof raw.check === 'string' ? raw.check.slice(0, 64) : '',
    savedAt: typeof raw.savedAt === 'string' && !Number.isNaN(Date.parse(raw.savedAt)) ? raw.savedAt : '',
  };
  const title = cleanTitle(raw.title);
  if (title) save.title = title;
  // 投影和中央经线:格式不对就当没存(按等距圆柱、0° 看),不影响打开
  const view = cleanView(raw.view);
  if (view) save.view = view;
  // 底稿出处:格式不对就当没有
  const origin = cleanOrigin(raw.origin);
  if (origin) save.origin = origin;
  return { ok: true, save, warnings };
}

/** 跨过这几种改动,世界(地形、疆域、兴亡)和原来一样:只换了默认的名字、编年史的字 */
const SAME_WORLD: readonly (GeneratorChange | 'newer' | null)[] = [null, 'names', 'chronicle'];

/**
 * 按存档的参数生成完以后核对地形:生成器版本相同(或版本不同、但世界应该一样,见 SAME_WORLD)、地形哈希却对不上时给提示
 * (版本不同、世界变了的,parseSave 已经说过变了什么,这里不重复)。对得上 = null
 */
export function checkWarning(save: SaveFile, check: string): string | null {
  if (!SAME_WORLD.includes(changeSince(save.generator, (save.edits.terrain?.length ?? 0) > 0 || !!save.edits.sketch))) return null;
  if (!save.check || save.check === check) return null;
  return CHECK_WARNING;
}

// ---------------------------------------------------------------------------
// 地形校验

/** 32 位 FNV-1a 的一步(按 32 位整数喂) */
function mix(h: number, v: number): number {
  h = Math.imul(h ^ (v & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619);
  h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619);
  return Math.imul(h ^ (v >>> 24), 16777619);
}

const hex = (h: number, n: number) => (h >>> 0).toString(16).padStart(8, '0').slice(0, n);

/**
 * 地形的短哈希(12 位十六进制):地块数、每个地块的海拔(Float32 的原始位)、水域、生物群落。
 * 同一版本下地形数据在各浏览器 / Node 里逐位一致,所以同种子 + 参数总得到同一个值;
 * 生成算法变了(地形哪怕差一点)就对不上
 */
export function worldCheck(world: World): string {
  const n = world.mesh.n;
  const e = world.elevation;
  const bits = new Uint32Array(e.buffer, e.byteOffset, e.length);
  const { water, biome } = world;
  let a = mix(0x811c9dc5, n);
  let b = mix(0x2166136b, n ^ 0x5bd1e995);
  for (let i = 0; i < n; i++) {
    a = mix(a, bits[i]);
    b = mix(b, (water[i] << 8) | biome[i] | ((i & 0xffff) << 16));
  }
  return hex(a, 8) + hex(b, 4);
}

// ---------------------------------------------------------------------------
// 分享链接:把整份存档塞进网址的 # 后面
//
//   https://…/?seed=7&style=fantasy#share=<base64url(deflate-raw(存档的 JSON))>
//
// - # 后面的东西浏览器不发给服务器,只在打开链接的人自己的页面里读
// - 编码的是**整个** SaveFile(JSON.stringify,不挑字段):存档以后加了字段(比如地形修改),链接自动带上
// - 压缩用浏览器自带的 CompressionStream('deflate-raw')(= zlib 的 raw deflate,Node 里 zlib.inflateRawSync 也能解),
//   再转成 base64url(只有 A–Z a–z 0–9 - _,放进网址不用转义)
// - 解开以后走和"从文件打开"同一个 parseSave:版本不同、参数超范围这些照样打开并提示

/** 网址里生成器版本的键(?…&gen=8):带种子的网址、分享链接都写上,打开时和现在的版本比 */
export const GEN_KEY = 'gen';

/** # 后面的键:#share=… */
export const SHARE_KEY = 'share';
/** 链接超过这么多字就提示"修改太多,链接可能打不开"(聊天软件、浏览器对网址长度各有上限) */
export const SHARE_WARN_LENGTH = 8000;
/** 链接里的数据最多多少字(再长就不像分享链接了) */
const SHARE_MAX_CHARS = 4 * 1024 * 1024;

export const SHARE_BROKEN = '链接不完整或被改动过(可能复制时少了一截),请让对方重新复制一次链接';
const SHARE_EMPTY = '链接里没有世界数据';
const SHARE_OLD_BROWSER = '这个浏览器太旧,打不开分享链接:请换个新版浏览器,或者让对方存成文件发给你';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** 字节 → base64url(不补 =) */
function toBase64Url(bytes: Uint8Array): string {
  const out: string[] = [];
  let s = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i];
    const b = i + 1 < n ? bytes[i + 1] : 0;
    const c = i + 2 < n ? bytes[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < n) s += B64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < n) s += B64[c & 63];
    if (s.length >= 4096) {
      out.push(s);
      s = '';
    }
  }
  out.push(s);
  return out.join('');
}

/** base64url → 字节;有不认识的字符、长度不对 = null */
function fromBase64Url(s: string): Uint8Array | null {
  if (s.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  const v = [0, 0, 0, 0];
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = Math.min(4, s.length - i);
    v[2] = v[3] = 0;
    for (let j = 0; j < n; j++) {
      const code = s.charCodeAt(i + j);
      const x = code < 128 ? B64_INDEX[code] : -1;
      if (x < 0) return null;
      v[j] = x;
    }
    out[o++] = (v[0] << 2) | (v[1] >> 4);
    if (n > 2) out[o++] = ((v[1] & 15) << 4) | (v[2] >> 2);
    if (n > 3) out[o++] = ((v[2] & 3) << 6) | v[3];
  }
  return out.subarray(0, o);
}

type Pipe = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

/** 让字节流过压缩 / 解压;解出来超过 limit 字节 = 'big',数据坏了 = 'bad' */
async function through(data: Uint8Array, ts: Pipe, limit = Infinity): Promise<Uint8Array | 'big' | 'bad'> {
  const w = ts.writable.getWriter();
  const fed = w
    .write(data)
    .then(() => w.close())
    .catch(() => {});
  const r = ts.readable.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      n += value.length;
      if (n > limit) {
        r.cancel().catch(() => {});
        return 'big';
      }
      parts.push(value);
    }
  } catch {
    return 'bad';
  }
  await fed;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 这个存档值得做成带数据的链接吗:有任何修改(改名、干预、以后的地形修改……)或者起了名字 */
export function hasShareData(save: SaveFile): boolean {
  if (save.title) return true;
  for (const v of Object.values(save.edits as unknown as Record<string, unknown>)) {
    if (Array.isArray(v) ? v.length > 0 : isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== false && v !== '') return true;
  }
  return false;
}

/** 网址的 # 那段是不是分享数据(#share=…) */
export function isShareHash(hash: string): boolean {
  return typeof hash === 'string' && new RegExp(`^#?${SHARE_KEY}=`).test(hash.trim());
}

/**
 * 存档 → 网址的 # 那段(`#share=…`,接在网址后面就是分享链接)。
 * 浏览器太旧(没有 CompressionStream)会抛错,调用方提示"存成文件发给对方"
 */
export async function encodeShare(save: SaveFile): Promise<string> {
  if (typeof CompressionStream === 'undefined') throw new Error('这个浏览器太旧,做不了分享链接');
  const bytes = new TextEncoder().encode(JSON.stringify(save));
  const packed = await through(bytes, new CompressionStream('deflate-raw'));
  if (typeof packed === 'string') throw new Error('压缩失败,做不了分享链接');
  return `#${SHARE_KEY}=${toBase64Url(packed)}`;
}

/**
 * 网址的 # 那段(`#share=…`;也认不带 # 的、只有数据的)→ 和 parseSave 一样的结果。
 * 链接坏了(少了一截、被改过、不是本应用的)给中文错误;能读但版本不同之类的照样打开,附提示
 */
export async function decodeShare(hash: string): Promise<ParseResult> {
  if (typeof hash !== 'string') return { ok: false, error: SHARE_EMPTY };
  let s = hash.trim().replace(/^#/, '');
  const m = new RegExp(`(?:^|[&;])${SHARE_KEY}=([^&;]*)`).exec(s);
  if (m) s = m[1];
  else if (/^\w+=/.test(s)) return { ok: false, error: SHARE_EMPTY };
  // 聊天软件折过行、转义过的也认:去掉空白、%编码、末尾的 =
  try {
    if (s.includes('%')) s = decodeURIComponent(s);
  } catch {
    return { ok: false, error: SHARE_BROKEN };
  }
  s = s.replace(/\s+/g, '').replace(/=+$/, '');
  if (!s) return { ok: false, error: SHARE_EMPTY };
  if (s.length > SHARE_MAX_CHARS) return { ok: false, error: '链接太长,不像「文明与地图」的分享链接' };
  const bytes = fromBase64Url(s);
  if (!bytes || !bytes.length) return { ok: false, error: SHARE_BROKEN };
  let ds: DecompressionStream;
  try {
    ds = new DecompressionStream('deflate-raw');
  } catch {
    return { ok: false, error: SHARE_OLD_BROWSER };
  }
  const raw = await through(bytes, ds, MAX_BYTES);
  if (raw === 'big') return { ok: false, error: '链接里的数据太大,不像「文明与地图」的分享链接' };
  if (raw === 'bad') return { ok: false, error: SHARE_BROKEN };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return { ok: false, error: SHARE_BROKEN };
  }
  const r = parseSave(text);
  if (r.ok) return r;
  // 来自更新版本的:照原话提示;别的错(不是 JSON、不是本应用的)都算链接坏了
  if (r.error.startsWith('这个存档来自更新版本')) return { ok: false, error: r.error.replace('这个存档', '这个链接') };
  return { ok: false, error: '链接里的数据不是「文明与地图」的世界(可能被改动过),请让对方重新复制一次链接' };
}

/**
 * 换成 incoming 的修改,会丢掉 local 里的几处:改名(同一个键 incoming 没有或名字不同)、干预(incoming 里没有的)、
 * 世界名(两边都起了名、名字不同);以后加的字段(地形修改……)按"数组的项 / 对象的键"逐个比
 */
export function editsLost(local: SaveFile, incoming: SaveFile): number {
  const L = local.edits as unknown as Record<string, unknown>;
  const I = incoming.edits as unknown as Record<string, unknown>;
  let n = 0;
  for (const [k, lv] of Object.entries(L)) {
    // AI 起名的记号跟着改名走,丢没丢已经按改名算过了
    if (k === 'aiNames') continue;
    const iv = I[k];
    if (Array.isArray(lv)) {
      const has = new Set(Array.isArray(iv) ? iv.map((x) => JSON.stringify(x)) : []);
      n += lv.filter((x) => !has.has(JSON.stringify(x))).length;
    } else if (isObj(lv)) {
      const io = isObj(iv) ? iv : {};
      n += Object.keys(lv).filter((key) => JSON.stringify(lv[key]) !== JSON.stringify(io[key])).length;
    } else if (lv !== undefined && lv !== null && JSON.stringify(lv) !== JSON.stringify(iv)) n++;
  }
  if (local.title && incoming.title && local.title !== incoming.title) n++;
  return n;
}
