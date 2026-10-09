/**
 * 存档的浏览器存储:"我的世界"。
 *
 * - 一个世界一个编号(newWorldId,网址里的 w=):同一个种子 + 参数可以存好几个,各走各的历史。
 *   存档本身(gen/savefile.ts 的 SaveFile,和"存成文件"同一个格式)、缩略图、几项只在本地用的信息(还在新建、最近打开、现存几国)
 *   各存一个键;以前按"种子 + 参数"当编号存的,第一次读的时候原地换成新编号(换不了就照旧用老编号,照样能打开);
 *   改版前的网址(只带种子、参数)刷新还回到它(legacyWorld)。
 * - 世界分三种(attachWorld 的 kind):
 *     draft    新建世界这一步(种子、参数、地形还能改):作者动过(起名、调参数、改地形)才存,在"我的世界"里标"没建完"
 *     created  建好的世界(种子、参数、地形锁住):一直存着,没有修改也在列表里
 *     visit    打开别人的分享链接、带种子的网址:先不存;改了名字、历史(或起了名)才存进"我的世界",从此算建好的
 * - 自动存:App 生成完一个世界就 attachWorld;之后修改(editsStore)一变就写一次。换世界前 App 先 detachWorld,
 *   清空旧世界的修改就不会被当成这个世界的。
 * - 缩略图(480×240 JPEG dataURL)单独存一个键,第一次存这个世界时由 App 给的 thumbMaker 截一张(截不到就过一会儿再试);
 *   新建中的世界地形变了、刚创建完,App 调 refreshThumb 重截。
 * - 存储有上限:最多存 MAX_WORLDS 个世界;写不下(配额满了)就删最旧的再试 —— 删了别的世界就在顶部提示一句;
 *   删光了也写不下:提示"浏览器存储已满",带"存成文件"(同一次满只提示一回,之后写成功了再重新算)。
 * - 浏览器不让用 localStorage(隐私模式、禁用了存储)时退回"只在内存里":这次打开的页面里照样能用,
 *   刷新就没了;第一次存的时候顶部提示一句(带"存成文件",10 秒后自己收起),存档菜单里一直写着。所有读写都 try/catch,从不往外抛错。
 * - 投影和中央经线(ui/projection.ts、mapWrap.ts)跟着世界存:存档时按当时的设置写进 view;
 *   已经存着的世界换了投影 / 中心,App 调 viewChanged 重写一次。
 * - 删掉一个世界,AI 给它写的东西(ai/library.ts,按世界编号存)一起删。
 * - 旧版本生成器存的世界,第一次按新版重存时,把浏览器里原来那份原样另存一份(keepOriginal;同一个世界只留最早那份,
 *   以后不覆盖):重存会把存档里的生成器版本换成新的,留着这份才知道它原来是哪一版、长什么样。删除、撤销、复制跟着世界走;
 *   存储满了留不下就不留,不为它删别的世界,也不挡着新的存进去。打开旧版本的分享链接、旧网址(还没存着)以后改了才存进来的,
 *   第一次存时把打开的那一份同样留着。「看原样」(ui/oldSite.ts)读的就是这一份(originalOf、currentOriginal)。
 * - 登录了网站账号的,世界还会同步进账号(account/sync.ts):这里给它原样读写一个世界(rawWorld / putSyncedWorld),
 *   用户删掉一个世界时告诉它(setDeleteHook);为了腾地方删掉的旧世界不算删除(账号里的还在)。
 */
import { useSyncExternalStore } from 'react';
import type { WorldParams } from '../gen/world';
import { GENERATOR_VERSION, type WorldEdits } from '../gen/edits';
import {
  CHECK_WARNING,
  SHARE_BROKEN,
  TITLE_MAX,
  cleanOrigin,
  cleanTitle,
  editCount,
  makeSave,
  parseSave,
  sameView,
  worldKey,
  type SaveFile,
  type SaveOrigin,
  type SaveView,
} from '../gen/savefile';
import { getEdits, subscribeEdits } from './editsStore';
import type { DraftBase } from './stageStore';
import { getProjection } from './projection';
import { getMapCenter } from './mapWrap';
import { clearToast, showToast, type ToastAction } from './toastStore';

/** 当前的投影和中央经线(存档时写进去) */
export function currentView(): SaveView {
  return { projection: getProjection(), center: Math.round(getMapCenter() * 100) / 100 };
}

const PREFIX = 'wenming-ditu:world:';
const THUMB = 'wenming-ditu:thumb:';
const META = 'wenming-ditu:meta:';
/** AI 写的东西(ai/library.ts)按世界编号存的键 */
const NOTES = 'civ-atlas:ai-notes:';
/** 以前按"种子 + 参数"当编号存的世界换成了哪个新编号(旧网址只带种子、参数,刷新还回到它) */
const LEGACY = 'wenming-ditu:legacy:';
/** 旧版本生成器存的世界,第一次按新版重存之前的原样(存档原文;见 keepOriginal) */
const ORIG = 'wenming-ditu:orig:';
/** 最多存多少个世界(每个几 KB + 缩略图三十来 KB) */
export const MAX_WORLDS = 60;
/** 缩略图的大小("我的世界"里一张卡片宽 480) */
export const THUMB_W = 480;
export const THUMB_H = 240;

// ---------------------------------------------------------------------------
// 键值存储:localStorage,用不了就退回内存

interface KV {
  get(k: string): string | null;
  /** 写不下(配额满了)= false */
  set(k: string, v: string): boolean;
  remove(k: string): void;
  keys(): string[];
}

const mem = new Map<string, string>();
const memKV: KV = {
  get: (k) => mem.get(k) ?? null,
  set: (k, v) => (mem.set(k, v), true),
  remove: (k) => void mem.delete(k),
  keys: () => [...mem.keys()],
};

function isQuota(e: unknown): boolean {
  const x = e as { name?: string; code?: number } | null;
  return !!x && (x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED' || x.code === 22 || x.code === 1014);
}

function openLocal(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) return null;
    const probe = 'wenming-ditu:probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

let local: Storage | null | undefined;
/** 以前按"种子 + 参数"当编号存的世界换过新编号了(每次打开页面查一次) */
let migrated = false;
/** 浏览器存储能不能用(第一次用到时探测) */
function store(): KV {
  if (local === undefined) local = openLocal();
  const s = local;
  const kv: KV = !s
    ? memKV
    : {
        get: (k) => {
          try {
            return s.getItem(k);
          } catch {
            return mem.get(k) ?? null;
          }
        },
        set: (k, v) => {
          try {
            s.setItem(k, v);
            return true;
          } catch (e) {
            if (isQuota(e)) return false;
            // 别的错(存储突然不让用了):退回内存
            local = null;
            mem.set(k, v);
            return true;
          }
        },
        remove: (k) => {
          try {
            s.removeItem(k);
          } catch {
            /* 删不掉就算了 */
          }
          mem.delete(k);
        },
        keys: () => {
          try {
            const out: string[] = [];
            for (let i = 0; i < s.length; i++) {
              const k = s.key(i);
              if (k !== null) out.push(k);
            }
            return out;
          } catch {
            return [...mem.keys()];
          }
        },
      };
  if (!migrated) {
    migrated = true;
    migrateLegacy(kv);
  }
  return kv;
}

/** 存档能不能留到下次打开(false = 只在这次打开的页面里) */
export function persistent(): boolean {
  store();
  return !!local;
}

// ---------------------------------------------------------------------------
// 世界编号

const ID_RE = /^w[0-9a-z]{6,24}$/;

/** 一个新的世界编号(w + 时间 + 随机几位,只有小写字母和数字,放进网址不用转义) */
export function newWorldId(): string {
  const kv = store();
  for (;;) {
    let r = '';
    try {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      r = a[0].toString(36);
    } catch {
      r = Math.floor(Math.random() * 2 ** 32).toString(36);
    }
    const id = `w${Date.now().toString(36)}${r.padStart(7, '0').slice(-5)}`;
    if (kv.get(PREFIX + id) === null && kv.get(META + id) === null) return id;
  }
}

/** 像不像一个世界编号(网址里的 w= 先过一遍;老编号是"种子 + 参数"那一串,也认) */
export function isWorldId(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 400 && (ID_RE.test(s) || /^seed=/.test(s));
}

/** 以前按"种子 + 参数"当编号存的世界:换成新编号(连同缩略图、AI 写的东西);写不下就照旧用老编号 */
function migrateLegacy(kv: KV) {
  for (const k of kv.keys()) {
    if (!k.startsWith(PREFIX)) continue;
    const old = k.slice(PREFIX.length);
    if (ID_RE.test(old)) continue;
    const text = kv.get(k);
    if (text === null) continue;
    let id = '';
    for (let i = 0; i < 4 && !id; i++) {
      const c = `w${Date.now().toString(36)}${(Math.floor(Math.random() * 36 ** 5) + i).toString(36).padStart(5, '0').slice(-5)}`;
      if (kv.get(PREFIX + c) === null) id = c;
    }
    if (!id || !kv.set(PREFIX + id, text)) continue;
    const moved = [THUMB, NOTES].every((p) => {
      const v = kv.get(p + old);
      return v === null || kv.set(p + id, v);
    });
    if (!moved) {
      for (const p of [PREFIX, THUMB, NOTES]) kv.remove(p + id);
      continue;
    }
    // 旧版本的原样跟过去;写不下就不带,不挡着换新编号
    const orig = kv.get(ORIG + old);
    if (orig !== null) kv.set(ORIG + id, orig);
    for (const p of [PREFIX, THUMB, NOTES, META, ORIG]) kv.remove(p + old);
    kv.set(LEGACY + old, id);
  }
}

/** 以前按"种子 + 参数"存的那个世界(改版前的网址只带种子、参数,刷新时找回它);没有 = null */
export function legacyWorld(params: WorldParams): StoredWorld | null {
  const kv = store();
  const old = worldKey(params);
  // 没换成新编号的(写不下)照旧用老编号
  const direct = loadWorld(old);
  if (direct) return direct;
  const id = kv.get(LEGACY + old);
  if (id === null) return null;
  const w = ID_RE.test(id) ? loadWorld(id) : null;
  if (w && worldKey(w.save.params) === old) return w;
  kv.remove(LEGACY + old);
  return null;
}

// ---------------------------------------------------------------------------
// 订阅(菜单里的列表、提示)

let version = 0;
const subs = new Set<() => void>();
function changed() {
  version++;
  for (const f of subs) f();
}
// 别的标签页存了、删了世界(同步取回来的也算):这里跟着刷新"我的世界",云同步也看一眼
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => otherTabChanged(e.key, e.newValue));
}

/** 别的页面里改过正在看的世界,点"载入"重新打开它(App 给) */
let reopenHandler: ((id: string) => void) | null = null;
export function setReopenHandler(f: ((id: string) => void) | null) {
  reopenHandler = f;
}

/** 别的标签页改了浏览器存储(storage 事件;单测直接调):key = null 是整个清空 */
export function otherTabChanged(key: string | null, newValue: string | null): void {
  if (key !== null && ![PREFIX, THUMB, META, NOTES, LEGACY].some((p) => key.startsWith(p))) return;
  const c = current;
  // 整个清空:存过的当前世界也没了
  const cleared = key === null && !!c && (c.kind === 'created' || (c.kind === 'draft' && !c.pristine)) && store().get(PREFIX + c.id) === null;
  if (c && (key === PREFIX + c.id || cleared)) {
    const now = cleared ? null : newValue;
    if (now !== null && now === c.wrote) {
      // 那边撤销了删除(放回来的就是这里存的那份):接着自动存
      if (c.gone) clearToast('other-tab');
      c.gone = undefined;
    } else {
      // 删了,或者存成了别的样子(那边也开着它改了、同步取回了另一台设备改过的):这里的还是旧的,不再自动存,不然一改就把那边的盖掉
      const why = now === null ? 'deleted' : 'changed';
      if (c.gone !== why) {
        if (!c.gone) stopThumb();
        c.gone = why;
        const id = c.id;
        if (why === 'deleted') {
          showToast({ id: 'other-tab', kind: 'warn', text: '这个世界在别的页面里删掉了', more: ['这里再改不会自动存下来；要留着就存成文件'], action: saveFileAction(), ttl: 0 });
        } else {
          const reopen = reopenHandler;
          showToast({
            id: 'other-tab',
            kind: 'warn',
            text: '这个世界在别的页面里改过',
            more: ['这里再改不会自动存下来；载入那边改过的样子'],
            action: reopen
              ? {
                  label: '载入',
                  act: 'other-tab-reload',
                  onClick: () => {
                    clearToast('other-tab');
                    reopen(id);
                  },
                }
              : saveFileAction(),
            ttl: 0,
          });
        }
      }
    }
  } else if (key !== null && newValue === null) {
    // 别的标签页删了别的世界,可能腾出了地方
    retryUnsaved();
  }
  changed();
}

/** 存档有变化时调 f(返回取消函数) */
export function subscribe(f: () => void) {
  subs.add(f);
  return () => void subs.delete(f);
}

/** 存档有变化时重新渲染(返回一个递增的版本号) */
export function useSavesVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export interface SaveNotice {
  kind: 'ok' | 'warn' | 'error';
  /** 第一行 */
  text: string;
  /** 第二行小字(版本不同、找不到的改名……;几条连成一行) */
  more?: string[];
  /** 右侧的按钮 */
  action?: ToastAction;
  /** 左边一个绿点(存好了一个文件这类) */
  dot?: boolean;
  stamp: number;
}

let notice: SaveNotice | null = null;
/**
 * 存档的提示(读档结果、复制了分享链接……):显示在顶部的提示条上(toastStore,来源 'save');
 * 成功的 7 秒后收起,有警告 / 出错的留着等用户关。null = 收起
 */
export function notify(n: Omit<SaveNotice, 'stamp'> | null) {
  notice = n ? { ...n, stamp: performance.now() } : null;
  if (n) showToast({ id: 'save', kind: n.kind, text: n.text, more: n.more?.length ? n.more : undefined, action: n.action, dot: n.dot });
  else clearToast('save');
  changed();
}
export function useSaveNotice(): SaveNotice | null {
  useSavesVersion();
  return notice;
}

// ---------------------------------------------------------------------------
// 读档提示的短说法:gen/savefile.ts 的原话是完整的句子,提示条上只留一行小字里的几个短句

const BRIEF_WARNING: Record<string, string> = {
  [CHECK_WARNING]: '地形和存档时对不上',
};
/** 读档的警告(版本不同、地形对不上……)→ 短句;认不出的原样 */
export function briefWarning(w: string): string {
  return BRIEF_WARNING[w] ?? w;
}
/** 打不开存档 / 分享链接的原因 → 短句;认不出的原样 */
export function briefError(e: string): string {
  if (e === SHARE_BROKEN) return '链接不完整,请让对方重新复制';
  if (e.includes('来自更新版本')) return '来自更新的版本,刷新页面后再打开';
  if (e.includes('浏览器太旧')) return '浏览器版本太旧,请换新版浏览器或改用存档文件';
  if (e.includes('不是「文明与地图」')) return e.includes('链接') ? '链接被改动过,请让对方重新复制' : '不是「文明与地图」的存档';
  return e;
}

// ---------------------------------------------------------------------------
// 存不下时的提示(顶部提示条,来源 'storage':不和读档结果的 'save' 互相顶掉)

/**
 * "存成文件"(提示条上的按钮调它):每个挂着的 SaveMenu 登记一次、卸下时撤掉自己那一次,
 * 用最后登记的那个 —— 同时挂着几个存档菜单(手机的世界卡片和概览)时,卸下其中一个不影响别的
 */
const fileSavers: (() => void)[] = [];
export function addFileSaver(f: () => void): () => void {
  fileSavers.push(f);
  return () => {
    const i = fileSavers.lastIndexOf(f);
    if (i >= 0) fileSavers.splice(i, 1);
  };
}
function saveFileAction(): ToastAction | undefined {
  if (!fileSavers.length) return undefined;
  return {
    label: '存成文件',
    onClick: () => {
      clearToast('storage');
      fileSavers[fileSavers.length - 1]?.();
    },
  };
}

/** 自动存写不下(删光别的世界也腾不出地方);写成功一次就清掉 */
let storageFull = false;
/** 只在内存里存(浏览器不让存)的提示已经说过了 */
let memoryWarned = false;
/** 这一次写入为了腾地方删掉的世界(名字) */
let evicted: string[] = [];

/** 自动存是不是写不下了(菜单里的一行字用) */
export function storageIsFull(): boolean {
  return storageFull;
}

function reportFull() {
  if (storageFull) return;
  storageFull = true;
  showToast({ id: 'storage', kind: 'warn', text: '没能自动存档:浏览器存储已满', more: ['在「我的世界」里删掉几个,或存成文件'], action: saveFileAction() });
  changed();
}

function reportEvicted(why: 'quota' | 'count') {
  const names = evicted;
  evicted = [];
  if (!names.length) return;
  const list = names.length > 2 ? `「${names[0]}」等 ${names.length} 个` : names.map((n) => `「${n}」`).join('');
  showToast({
    id: 'storage',
    kind: 'warn',
    text: why === 'quota' ? '浏览器存储已满' : `「我的世界」最多存 ${MAX_WORLDS} 个`,
    more: [`已删掉最旧的存档${list}`],
  });
}

function reportMemoryOnly() {
  if (memoryWarned || local) return;
  memoryWarned = true;
  // 停 10 秒自己收起(存档菜单里当前世界那一行一直写着)
  showToast({ id: 'storage', kind: 'warn', text: '浏览器不让网页存数据', more: ['修改只留在这个页面里,关掉前请存成文件'], action: saveFileAction(), ttl: 10_000 });
}

// ---------------------------------------------------------------------------
// 存、读、列、删

/** 只在本地用的几项(不进存档文件) */
interface Meta {
  /** 还在新建(没点"创建世界") */
  draft?: boolean;
  /** 最近一次打开(ISO 8601) */
  opened?: string;
  /** 结束那一年现存几国(没长出文明 = 0);还不知道 = 没有 */
  alive?: number;
  /** 新建中、以某个世界为底稿:原来那个世界 */
  base?: DraftBase;
}

export interface StoredWorld {
  id: string;
  save: SaveFile;
  /** 改了几处 */
  count: number;
  thumb: string | null;
  /** 还在新建("没建完") */
  draft: boolean;
  /** 最近打开或修改的时间(ISO;列表按它排,最近的在前) */
  at: string;
  /** 结束那一年现存几国;还不知道 = undefined */
  alive?: number;
  /** 新建中、以某个世界为底稿:原来那个世界 */
  base?: DraftBase;
}

function readSave(id: string): SaveFile | null {
  const text = store().get(PREFIX + id);
  if (!text) return null;
  const r = parseSave(text);
  return r.ok ? r.save : null;
}

function readMeta(id: string): Meta {
  const text = store().get(META + id);
  return text ? parseMeta(text) : {};
}

function parseMeta(text: string): Meta {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const m: Meta = {};
    if (v.draft === true) m.draft = true;
    if (typeof v.opened === 'string' && !Number.isNaN(Date.parse(v.opened))) m.opened = v.opened;
    if (typeof v.alive === 'number' && Number.isFinite(v.alive) && v.alive >= 0) m.alive = Math.floor(v.alive);
    const b = v.base as Record<string, unknown> | undefined;
    if (b && typeof b === 'object' && typeof b.id === 'string' && typeof b.title === 'string')
      m.base = { id: b.id, title: cleanTitle(b.title) || '未命名世界', names: Math.max(0, Math.floor(Number(b.names) || 0)), interventions: Math.max(0, Math.floor(Number(b.interventions) || 0)) };
    return m;
  } catch {
    return {};
  }
}

/** 浏览器里存的一个世界;没有 = null */
export function loadWorld(id: string): StoredWorld | null {
  const save = readSave(id);
  if (!save) return null;
  const m = readMeta(id);
  const at = m.opened && m.opened > save.savedAt ? m.opened : save.savedAt;
  return { id, save, count: editCount(save.edits), thumb: store().get(THUMB + id), draft: !!m.draft, at, alive: m.alive, base: m.draft ? m.base : undefined };
}

/** 存过的世界,最近打开或改过的在前 */
export function listWorlds(): StoredWorld[] {
  const out: StoredWorld[] = [];
  for (const k of store().keys()) {
    if (!k.startsWith(PREFIX)) continue;
    const w = loadWorld(k.slice(PREFIX.length));
    if (w) out.push(w);
  }
  return out.sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : a.id < b.id ? -1 : 1));
}

/** 这个编号在浏览器里存着 */
export function isStored(id: string): boolean {
  return store().get(PREFIX + id) !== null;
}

const nameOf = (id: string) => {
  const s = readSave(id);
  return s ? s.title || `种子 ${s.seed}` : null;
};

function removeKeys(id: string) {
  const kv = store();
  for (const p of [PREFIX, THUMB, META, NOTES, ORIG]) kv.remove(p + id);
}

/** 删掉最旧的一个世界(不删 keep;读不出来的坏条目、没有存档的缩略图和原样最先删);没得删 = false */
function evictOldest(keep: string): boolean {
  const kv = store();
  const ids = new Set<string>();
  for (const k of kv.keys()) {
    for (const p of [PREFIX, THUMB, META, ORIG]) if (k.startsWith(p)) ids.add(k.slice(p.length));
  }
  ids.delete(keep);
  if (shield) ids.delete(shield);
  let oldest: string | null = null;
  let at = '￿';
  for (const id of ids) {
    const s = readSave(id);
    const m = s ? readMeta(id) : {};
    const t = s ? (m.opened && m.opened > s.savedAt ? m.opened : s.savedAt) : '';
    if (t < at || (t === at && oldest !== null && id < oldest)) {
      oldest = id;
      at = t;
    }
  }
  if (oldest === null) return false;
  const name = nameOf(oldest);
  if (name) evicted.push(name);
  removeKeys(oldest);
  return true;
}

/** 存不下要删旧世界时,除了正在写的那个,这一个也不删(复制时的原件) */
let shield: string | null = null;

/** 写一个键;写不下就删最旧的世界再试 */
function put(key: string, value: string, keep: string): boolean {
  const kv = store();
  for (let i = 0; i < 8; i++) {
    if (kv.set(key, value)) return true;
    if (!evictOldest(keep)) return false;
  }
  return false;
}

function writeMeta(id: string, m: Meta): boolean {
  const v: Meta = {};
  if (m.draft) v.draft = true;
  if (m.opened) v.opened = m.opened;
  if (m.alive !== undefined) v.alive = m.alive;
  if (m.draft && m.base) v.base = m.base;
  return put(META + id, JSON.stringify(v), id);
}

/** 只写本地信息(最近打开、现存几国):存不下删了旧世界的,也提示一句 */
function touchMeta(id: string, m: Meta): boolean {
  evicted = [];
  const ok = writeMeta(id, m);
  reportEvicted('quota');
  return ok;
}

/**
 * 一个世界要存成第 next 版生成器的存档:浏览器里原来那份是更旧的版本存的、还没留过,返回它的原文(存档原文,一个字不改),
 * 新的存进去以后由 keepOriginal 另存;不用留 = null。同一个世界只留最早那份(以后再升级也不覆盖);读不出来的坏存档不留
 */
function originalToKeep(id: string, next: number): string | null {
  const kv = store();
  if (kv.get(ORIG + id) !== null) return null;
  const text = kv.get(PREFIX + id);
  if (text === null) return null;
  const r = parseSave(text);
  return r.ok && r.save.generator < next ? text : null;
}

/** 新的存进去了:把原来那份原样留着。写不下就算了:不为它删别的世界,也不拦着这次存 */
function keepOriginal(id: string, text: string | null) {
  if (text !== null) store().set(ORIG + id, text);
}

/**
 * 写一个世界的存档(和本地信息);新存一个超过上限就删最旧的。
 * 本地信息没写进去也算没存成:没有"还在新建"那一条,没建完的世界下次打开会被当成建好的、锁住。
 * 新存的就把存档也拿掉;原来就有的留着原来那份本地信息。
 * first:第一次存进来的世界原来是哪一份(打开旧版本的分享链接、旧网址以后改了才存的):比这次存的版本旧就原样留着
 */
function writeSave(id: string, save: SaveFile, meta?: Meta, first?: SaveFile | null): boolean {
  const kv = store();
  const fresh = kv.get(PREFIX + id) === null;
  evicted = [];
  const text = JSON.stringify(save);
  const orig = !fresh ? originalToKeep(id, save.generator) : first && first.generator < save.generator ? JSON.stringify(first) : null;
  let ok = put(PREFIX + id, text, id);
  if (ok && meta && !writeMeta(id, meta)) {
    if (fresh) kv.remove(PREFIX + id);
    ok = false;
  }
  // 存档和本地信息都写成了才留原样(留它占的地方不挤掉别的世界、不挡着本地信息)
  if (ok) keepOriginal(id, orig);
  reportEvicted('quota');
  // 新存一个世界:超过上限就删最旧的
  if (ok && fresh) {
    const list = listWorlds();
    let extra = list.length - MAX_WORLDS;
    for (let i = list.length - 1; i >= 0 && extra > 0; i--) {
      const w = list[i];
      if (w.id === id || w.id === shield) continue;
      evicted.push(w.save.title || `种子 ${w.save.seed}`);
      removeKeys(w.id);
      extra--;
    }
    reportEvicted('count');
  }
  if (ok) {
    if (current?.id === id) current.wrote = text;
    if (storageFull) {
      storageFull = false;
      clearToast('storage');
    }
    reportMemoryOnly();
  } else reportFull();
  return ok;
}

/** 用户删掉了一个世界(云同步记下来,账号里跟着删) */
let deleteHook: ((id: string) => void) | null = null;
export function setDeleteHook(f: ((id: string) => void) | null) {
  deleteHook = f;
}

/**
 * 删掉一个存档(连同缩略图、AI 写的东西)。删的是正在看的世界:不再自动存它。
 * 返回撤销用的那份;存档本身已经不在了(别的页面里删掉了)= null,没有可撤销的
 */
export function deleteWorld(id: string): DeletedWorld | null {
  const kv = store();
  const keys: [string, string][] = [];
  for (const p of [PREFIX, THUMB, META, NOTES, ORIG]) {
    const v = kv.get(p + id);
    if (v !== null) keys.push([p + id, v]);
  }
  const had = keys.some(([k]) => k === PREFIX + id);
  removeKeys(id);
  if (had) deleteHook?.(id);
  if (current?.id === id) {
    current = null;
    stopThumb();
  }
  retryUnsaved();
  changed();
  return had ? { id, keys } : null;
}

/** 删掉的世界删之前的样子(撤销删除用):存档、缩略图、打开记录、AI 写的史书和名字由来、旧版本的原样,各自原来存的字符串 */
export interface DeletedWorld {
  id: string;
  keys: [string, string][];
}

/**
 * 撤销删除:把删之前的几样原样写回,"我的世界"里回到原来的位置(按最近打开 / 修改的时间排)。
 * 别的页面里还开着它、删了以后又自动存过的:以那边新存的为准,只补回现在没有的。
 * 存档、打开记录(没建完的世界靠它记着还在建)、AI 写的东西有一样写不下(浏览器存储满了)
 * = false,这次写回的都撤掉;缩略图(再打开会重画)、旧版本的原样写不下就算了,不为它们挡着世界放回来
 */
export function restoreWorld(d: DeletedWorld): boolean {
  const kv = store();
  const wrote: string[] = [];
  for (const p of [PREFIX, META, NOTES, ORIG, THUMB]) {
    const k = p + d.id;
    const v = d.keys.find((e) => e[0] === k)?.[1];
    if (v === undefined || kv.get(k) !== null) continue;
    if (kv.set(k, v)) wrote.push(k);
    else if (p !== THUMB && p !== ORIG) {
      for (const w of wrote) kv.remove(w);
      changed();
      return false;
    }
  }
  changed();
  return true;
}

/** 给存档起名(改名);当前世界还没存过的(打开的链接),顺手存下来 */
export function renameWorld(id: string, title: string) {
  const t = cleanTitle(title);
  if (current?.id === id) {
    current.title = t || undefined;
    saveCurrent(true);
    changed();
    return;
  }
  const w = readSave(id);
  if (!w) return;
  // 改名也算改了它:最后修改时间跟着变(我的世界里排到前面)
  const next: SaveFile = { ...w, savedAt: new Date().toISOString() };
  if (t) next.title = t;
  else delete next.title;
  writeSave(id, next);
  changed();
}

const CN = ['二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 另一个世界的名字:"苍澜界" → "苍澜界(二)";已经有了就(三)、(四)……(和存着的世界、当前世界都不重名) */
export function nextTitle(base: string): string {
  const root = cleanTitle(base).replace(/（[二三四五六七八九十\d]+）$/, '') || '未命名世界';
  const taken = new Set(listWorlds().map((w) => w.save.title ?? ''));
  if (current?.title) taken.add(current.title);
  for (let i = 0; i < 99; i++) {
    const n = i < CN.length ? CN[i] : String(i + 2);
    const suffix = `（${n}）`;
    const head = [...root].slice(0, TITLE_MAX - suffix.length).join('');
    const t = head + suffix;
    if (!taken.has(t)) return t;
  }
  return root;
}

/** "我的世界"里复制一份(名字加"(二)",缩略图、旧版本的原样一起;AI 写的东西由 ai/library 的 copyNotes 复制);返回新编号,复制不了 = null */
export function duplicateWorld(id: string): string | null {
  const w = loadWorld(id);
  if (!w) return null;
  const nid = newWorldId();
  const save: SaveFile = { ...w.save, title: nextTitle(w.save.title || '未命名世界'), savedAt: new Date().toISOString() };
  // 存不下要删旧的:原件不删(它可能正好是最旧的)
  shield = id;
  try {
    if (!writeSave(nid, save, { draft: w.draft, alive: w.alive })) return null;
    // 缩略图写不下(删了旧的也不行)就先不要,打开它时再截一张;删了旧的照样提示
    if (w.thumb) {
      evicted = [];
      put(THUMB + nid, w.thumb, nid);
      reportEvicted('quota');
    }
    // 原样写不下就不带(不为它删别的世界;原件那里还有)
    keepOriginal(nid, store().get(ORIG + id));
  } finally {
    shield = null;
  }
  changed();
  return nid;
}

/** 两份存档是不是同一个世界的同一个样子(参数、修改、名字、底稿出处都相同;投影、存档时间不算) */
export function sameSave(a: SaveFile, b: SaveFile): boolean {
  return worldKey(a.params) === worldKey(b.params) && (a.title ?? '') === (b.title ?? '') && JSON.stringify(a.edits) === JSON.stringify(b.edits) && sameOrigin(a.origin, b.origin);
}

/** 两个底稿出处是不是一样(都没有也算) */
export function sameOrigin(a: SaveFile['origin'], b: SaveFile['origin']): boolean {
  if (!a || !b) return !a && !b;
  return (a.by ?? '') === (b.by ?? '') && a.title === b.title && a.url === b.url;
}

/**
 * 从文件打开:存进"我的世界"(算建好的),返回它的编号。
 * 已经有一个一模一样的(参数、修改、名字、底稿出处都相同,比如同一个文件打开了两次)就用那一个,不重复存
 */
export function importSave(save: SaveFile): string | null {
  for (const w of listWorlds()) {
    if (w.draft || !sameSave(w.save, save)) continue;
    // 只差投影 / 中央经线:用文件里的(下次打开还是文件里的样子)
    let ok = true;
    if (!sameView(w.save.view, save.view)) {
      const next: SaveFile = { ...w.save, savedAt: new Date().toISOString() };
      if (save.view) next.view = save.view;
      else delete next.view;
      ok = writeSave(w.id, next);
      changed();
    }
    // 存着的已经是更新的版本、还没留原样:文件这份就是它原来的样子(看原样);存档写成了以后再留
    if (ok && save.generator < w.save.generator && originalOf(w.id) === null) keepOriginal(w.id, JSON.stringify(save));
    return w.id;
  }
  const id = newWorldId();
  const copy: SaveFile = { ...save, savedAt: new Date().toISOString() };
  if (!writeSave(id, copy, { opened: copy.savedAt })) return null;
  changed();
  return id;
}

// ---------------------------------------------------------------------------
// 当前世界 + 自动存

export type WorldKind = 'draft' | 'created' | 'visit';

interface Current {
  id: string;
  params: WorldParams;
  check: string;
  title?: string;
  kind: WorldKind;
  /** 新建中、作者还没动过(没起名、没调参数、没改地形):不存 */
  pristine: boolean;
  /** 结束那一年现存几国(存进本地信息,"我的世界"的卡片上写) */
  alive?: number;
  /** 新建中、以某个世界为底稿:原来那个世界 */
  base?: DraftBase;
  /** 最近一次存下的修改(同一个对象不重复存) */
  saved: WorldEdits | null;
  /** 最近一次存下的投影设置 */
  savedView?: SaveView;
  /** 最近一次没写进去(浏览器存储满了):最新的改动只在这个页面里 */
  unsaved?: boolean;
  /**
   * 别的标签页把它删了(删掉、退出登录时选了从这台设备上删掉)、或者存成了别的样子(那边也开着它改了、同步取回了另一台设备改过的):
   * 不再自动存,不然一改又存回去、把那边的盖掉
   */
  gone?: 'deleted' | 'changed';
  /** 浏览器里存着的这个世界、这里知道的最新一份(这里写进去的、打开时存着的):别的标签页写的和它不一样 = 那边改过 */
  wrote?: string | null;
  /** 底稿出处(从别人的分享短链接另存来的;存进存档) */
  origin?: SaveOrigin;
  /** 打开时还没存着、来自旧版本的世界(分享链接、旧网址):原来那一份,第一次存进来时原样留着 */
  original?: SaveFile;
}

let current: Current | null = null;
/** 截缩略图(App 给):画布还没画好这个世界 = null */
let thumbMaker: ((id: string) => string | null) | null = null;
let thumbTimer: ReturnType<typeof setTimeout> | undefined;
/** 等着的那一张是要重截的(已经有了也截):这个世界的编号 */
let thumbForce: string | null = null;

/** 不截了(换世界、删掉) */
function stopThumb() {
  if (thumbTimer !== undefined) clearTimeout(thumbTimer);
  thumbTimer = undefined;
  thumbForce = null;
}

export function setThumbMaker(f: ((id: string) => string | null) | null) {
  thumbMaker = f;
}

export type CurrentWorld = Readonly<Omit<Current, 'saved' | 'savedView'>>;

/** 当前世界(自动存的对象);换世界途中 = null */
export function currentWorld(): CurrentWorld | null {
  return current;
}

/** 当前世界最近的改动没写进浏览器(存储满了,只在这个页面里;退出登录选"删掉"前要拦住) */
export function currentUnsaved(): boolean {
  return !!current?.unsaved;
}

/** 当前世界 → 存档(存成文件用) */
export function currentSave(): SaveFile | null {
  if (!current) return null;
  return makeSave(current.params, getEdits(), current.check, current.title, undefined, currentView(), current.origin);
}

/** 过一会儿截一张缩略图(画布这时可能还没画好这个世界,截不到就再等等);force = 已经有了也重截 */
function scheduleThumb(id: string, force = false, tries = 0) {
  // 等着重截的不被随后一次普通的盖掉
  if (thumbForce === id) force = true;
  stopThumb();
  if (tries > 40) return;
  if (force) thumbForce = id;
  thumbTimer = setTimeout(() => {
    thumbTimer = undefined;
    thumbForce = null;
    if (current?.id !== id || !store().get(PREFIX + id) || (!force && store().get(THUMB + id))) return;
    let url: string | null = null;
    try {
      url = thumbMaker?.(id) ?? null;
    } catch {
      url = null;
    }
    if (!url) return scheduleThumb(id, force, tries + 1);
    evicted = [];
    const ok = put(THUMB + id, url, id);
    reportEvicted('quota');
    if (ok) changed();
  }, 700);
}

/** 当前世界的样子变了(新建中改了地形、刚创建完):缩略图重截 */
export function refreshThumb() {
  if (current && store().get(PREFIX + current.id) !== null) scheduleThumb(current.id, true);
}

function metaOf(c: Current, opened?: string): Meta {
  const m = readMeta(c.id);
  return { draft: c.kind === 'draft', opened: opened ?? m.opened, alive: c.alive ?? m.alive, base: c.kind === 'draft' ? c.base : undefined };
}

/** 把当前世界存下来(修改没变就不存;force = 起名、换了投影、刚创建……) */
/** 存当前世界;返回写进去没有(没有当前世界、没改过不用存 = false) */
function saveCurrent(force = false): boolean {
  const c = current;
  if (!c || c.gone) return false;
  const edits = getEdits();
  // 上次没写进去的(存储满了):修改没再变也再试一次
  if (!force && edits === c.saved && !c.unsaved) return false;
  // 干预、地形大事变了:历史要重推,缩略图上结束那一年的地形、国家跟着变,重截(App 等重推完、那一段的主图铺好才给图)
  const was = c.saved;
  const differs = (a: unknown, b: unknown) => a !== b && JSON.stringify(a ?? []) !== JSON.stringify(b ?? []);
  const redraw = !!was?.interventions && (differs(edits.interventions, was.interventions) || differs(edits.upheavals, was.upheavals));
  c.saved = edits;
  // 新建中:走到这里就是作者动了(改了地形、起了名、调了参数);只换投影的走不到这里(没存过的不为它存)
  if (c.kind === 'draft') c.pristine = false;
  // 打开的链接改过了:存进"我的世界",从此算建好的
  if (c.kind === 'visit') c.kind = 'created';
  const view = currentView();
  c.savedView = view;
  const ok = writeSave(c.id, makeSave(c.params, edits, c.check, c.title, undefined, view, c.origin), metaOf(c), c.original);
  c.unsaved = !ok;
  if (ok) scheduleThumb(c.id, redraw);
  changed();
  return ok;
}

/** 当前世界上次没写进浏览器(存储满了):删了别的世界、腾出地方以后再存一次(不然要等再改一处才存) */
function retryUnsaved() {
  if (current?.unsaved) saveCurrent(true);
}

/**
 * 这个世界里存了 AI 写的东西(史书、名字由来):只是看看的世界从此存进"我的世界"(那些东西按世界编号存,
 * 不存这个世界的话刷新以后就找不回来了)。新建中的、已经存着的不用管
 */
export function keepWorld(id: string) {
  const c = current;
  if (!c || c.id !== id || c.kind !== 'visit') return;
  saveCurrent(true);
}

/**
 * 投影 / 中央经线变了(App 停下来以后调):当前世界已经存着的话重写一次(最后修改时间跟着变);
 * 没存过的世界不存(只改了看法、没改世界,不占"我的世界"列表)
 */
export function viewChanged() {
  const c = current;
  if (!c || sameView(c.savedView, currentView())) return;
  if (store().get(PREFIX + c.id) === null) return;
  saveCurrent(true);
}

export interface AttachSpec {
  id: string;
  params: WorldParams;
  /** 地形的短哈希(worldCheck) */
  check: string;
  kind: WorldKind;
  title?: string;
  /**
   * 已经存下的(或者打开时就带着的)修改:App 套上的修改和它是同一个对象就不重写;
   * 不一样(比如旧格式的键换成了新的)就写一次
   */
  saved: WorldEdits;
  /** 存档里的投影设置(打开存着的世界时) */
  view?: SaveView;
  /** 新建中、作者还没动过:不存 */
  pristine?: boolean;
  /** 新建中、以某个世界为底稿:原来那个世界 */
  base?: DraftBase | null;
  /** 底稿出处(存着的世界、存档文件里带着的;打开别人的分享短链接时是那个链接)。新建中的没有 */
  origin?: SaveOrigin | null;
  /** 还没存着、来自旧版本的世界(分享链接、旧网址、存不进浏览器的存档文件):原来那一份(看原样用,第一次存进来时原样留着) */
  original?: SaveFile | null;
}

/**
 * 生成完一个世界、App 套上修改(setEdits)之后调:以后它的修改自动存。
 * 建好的世界、动过的新建世界:浏览器里没存过、或者存的和现在的对不上(参数、地形、名字、修改),就写一次;
 * 存着的世界原样打开:只记一下"最近打开"
 */
export function attachWorld(spec: AttachSpec) {
  const prev = readSave(spec.id);
  const title = cleanTitle(spec.title) || undefined;
  current = {
    id: spec.id,
    params: { ...spec.params },
    check: spec.check,
    title,
    kind: spec.kind,
    pristine: spec.kind === 'draft' && !!spec.pristine,
    base: spec.kind === 'draft' ? (spec.base ?? undefined) : undefined,
    saved: spec.saved,
    savedView: spec.view ?? prev?.view,
    origin: spec.kind === 'draft' ? undefined : (cleanOrigin(spec.origin) ?? undefined),
    original: spec.kind === 'draft' || !spec.original || spec.original.generator >= GENERATOR_VERSION ? undefined : spec.original,
  };
  const keep = spec.kind === 'created' || (spec.kind === 'draft' && !spec.pristine);
  const same =
    !!prev &&
    worldKey(prev.params) === worldKey(spec.params) &&
    prev.check === spec.check &&
    (prev.title ?? '') === (title ?? '') &&
    JSON.stringify(prev.origin ?? null) === JSON.stringify(current.origin ?? null) &&
    getEdits() === spec.saved &&
    !!readMeta(spec.id).draft === (spec.kind === 'draft');
  if (keep && !same) {
    saveCurrent(true);
    // 新建中换了参数、地形:换了一颗星球,缩略图重截
    if (prev && (worldKey(prev.params) !== worldKey(spec.params) || prev.check !== spec.check)) scheduleThumb(spec.id, true);
  } else if (prev && spec.kind === 'draft' && spec.pristine) {
    // 新建中又变回没动过(换了一颗星球,改过的地形作废):原来存的那份拿掉
    removeKeys(spec.id);
    deleteHook?.(spec.id);
  } else if (prev) {
    touchMeta(spec.id, metaOf(current, new Date().toISOString()));
    // 刚从文件打开的(先存了、再生成):还没有缩略图,截一张
    if (store().get(THUMB + spec.id) === null) scheduleThumb(spec.id);
  }
  current.wrote = store().get(PREFIX + spec.id);
  changed();
}

/** 回到我的世界、又点开下面一直开着的这个世界(不用重新打开):记一下"最近打开" */
export function markOpened(id: string) {
  const c = current;
  const text = store().get(PREFIX + id);
  if (!c || c.id !== id || text === null) return;
  // 别的页面里存过、但和这里开着的一样(App 比过,只差投影之类):以存着的为准,接着自动存
  if (c.gone) {
    c.gone = undefined;
    c.wrote = text;
    clearToast('other-tab');
  }
  touchMeta(id, metaOf(c, new Date().toISOString()));
  changed();
}

/** 新建世界点了"创建世界":从此算建好的(种子、参数、地形锁住),一直存着 */
export function markCreated(): boolean {
  const c = current;
  if (!c || c.kind !== 'draft') return false;
  c.kind = 'created';
  c.pristine = false;
  c.base = undefined;
  return saveCurrent(true);
}

/** 结束那一年现存几国(App 推演完告诉这里;"我的世界"的卡片上写) */
export function setWorldStats(alive: number) {
  const c = current;
  if (!c || c.alive === alive) return;
  c.alive = alive;
  if (store().get(PREFIX + c.id) !== null) {
    touchMeta(c.id, metaOf(c));
    changed();
  }
}

/** 当前世界按新的地形修改重新生成完(新建中改地形):记下新的地形校验,已经存着的存档跟着改、缩略图重截 */
export function updateCheck(check: string) {
  const c = current;
  if (!c || c.check === check) return;
  c.check = check;
  if (store().get(PREFIX + c.id) === null) return;
  saveCurrent(true);
  scheduleThumb(c.id, true);
}

/** 换世界(或读档)之前:之后的修改(clearEdits)不再算这个世界的 */
export function detachWorld() {
  current = null;
  stopThumb();
  changed();
}

/** 开始自动存(App 挂载时调一次;返回取消函数) */
export function startAutoSave(): () => void {
  return subscribeEdits(() => saveCurrent());
}

// ---------------------------------------------------------------------------
// 云同步(account/sync.ts)用:原样读写一个世界

/** 跟着世界同步的本地信息(最近打开不同步:每台设备各记各的) */
export interface SyncMeta {
  draft?: boolean;
  alive?: number;
  base?: DraftBase;
}

/** 本地信息 → 同步的那几项(键的顺序固定,算指纹用) */
export function syncMetaOf(m: Meta): SyncMeta {
  const v: SyncMeta = {};
  if (m.draft) v.draft = true;
  if (m.alive !== undefined) v.alive = m.alive;
  if (m.draft && m.base) v.base = m.base;
  return v;
}

/** 服务器给的 meta(不认识的字段不要,坏的当没有) */
export function cleanSyncMeta(v: unknown): SyncMeta {
  if (!v || typeof v !== 'object') return {};
  return syncMetaOf(parseMeta(JSON.stringify(v)));
}

export interface RawWorld {
  /** 存档原文(JSON) */
  save: string;
  meta: SyncMeta;
  thumb: string | null;
}

/** 浏览器里存着的世界编号(老编号"种子 + 参数"的不算:服务器只认新编号) */
export function storedIds(): string[] {
  const out: string[] = [];
  for (const k of store().keys()) {
    if (!k.startsWith(PREFIX)) continue;
    const id = k.slice(PREFIX.length);
    if (ID_RE.test(id)) out.push(id);
  }
  return out;
}

/** 能不能存进账号(老编号"种子 + 参数"的不能:服务器只认新编号) */
export function syncable(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * 还用老编号存着的世界(打开网页时换新编号,浏览器存储满了没换成的,留在原处;腾出地方、刷新页面会再换一次)。
 * 它们存不进账号:退出登录选"从这台设备上删掉"前要先看一眼
 */
export function legacyIds(): string[] {
  const out: string[] = [];
  for (const k of store().keys()) {
    if (!k.startsWith(PREFIX)) continue;
    const id = k.slice(PREFIX.length);
    if (!ID_RE.test(id) && readSave(id)) out.push(id);
  }
  return out;
}

/** 浏览器里存着几个世界(连同老编号的) */
export function storedCount(): number {
  return storedIds().length + legacyIds().length;
}

/** 一个世界的原样(读不出来的坏存档 = null) */
export function rawWorld(id: string): RawWorld | null {
  const kv = store();
  const save = kv.get(PREFIX + id);
  if (!save || !parseSave(save).ok) return null;
  return { save, meta: syncMetaOf(readMeta(id)), thumb: kv.get(THUMB + id) };
}

/**
 * 把同步下来的世界写进浏览器(不为它删别的世界:写不下 = false,原来的不动)。
 * opened:这边还没记"最近打开"时用它(「全部存成文件」放回来时带着)。
 * 正在看的就是它:先不再自动存它(App 重新打开)
 */
export function putSyncedWorld(id: string, w: RawWorld, opened0?: string): boolean {
  const r = ID_RE.test(id) ? parseSave(w.save) : null;
  if (!r?.ok) return false;
  const kv = store();
  const old = kv.get(PREFIX + id);
  const opened = readMeta(id).opened ?? opened0;
  // 另一台设备在新版里重存过的旧世界:写成了以后,这里原来那份原样留着
  const orig = old === null ? null : originalToKeep(id, r.save.generator);
  if (!kv.set(PREFIX + id, w.save)) return false;
  const m: Meta = { ...w.meta };
  if (opened) m.opened = opened;
  if (!kv.set(META + id, JSON.stringify(m))) {
    if (old === null) kv.remove(PREFIX + id);
    else kv.set(PREFIX + id, old);
    return false;
  }
  keepOriginal(id, orig);
  // 缩略图写不下就先不要(打开时再截一张)
  if (!w.thumb || !kv.set(THUMB + id, w.thumb)) kv.remove(THUMB + id);
  if (current?.id === id) {
    current = null;
    stopThumb();
  }
  changed();
  return true;
}

/**
 * 「全部存成文件」放回来时,已经有的同一个世界:存档里没记投影、缺缩略图、不知道现存几国、没建完的不知道底稿的,用文件里的补上;
 * 文件里"最近打开"更晚的也用文件里的(存不下就算了,不为它删别的);返回补了没有("最近打开"不算)
 */
export function fillMissing(id: string, w: { view?: SaveView; thumb: string | null; alive?: number; base?: DraftBase; opened?: string }): boolean {
  const kv = store();
  const save = readSave(id);
  if (!save) return false;
  let done = false;
  // 正在看的这个:投影按页面上的(下次自动存就写页面上的),不补
  const open = current?.id === id ? current : null;
  if (w.view && !save.view && !open && kv.set(PREFIX + id, JSON.stringify({ ...save, view: w.view }))) done = true;
  if (w.thumb && !kv.get(THUMB + id) && kv.set(THUMB + id, w.thumb)) done = true;
  const m = readMeta(id);
  const next: Meta = { ...m };
  if (w.alive !== undefined && m.alive === undefined) next.alive = w.alive;
  if (w.base && m.draft && !m.base) next.base = w.base;
  // 文件里的"最近打开"比这边卡片上的时间晚:用文件里的(卡片时间、排序跟着回来;不算"补上了")
  const at = m.opened && m.opened > save.savedAt ? m.opened : save.savedAt;
  if (w.opened && w.opened > at) next.opened = w.opened;
  const more = next.alive !== m.alive || next.base !== m.base;
  let moved = false;
  if ((more || next.opened !== m.opened) && kv.set(META + id, JSON.stringify(next))) {
    // 正在看的这个也记上(下次自动存按页面里的写本地信息,不然又写没了)
    if (open && open.alive === undefined && next.alive !== undefined) open.alive = next.alive;
    if (open && open.kind === 'draft' && !open.base && next.base) open.base = next.base;
    if (more) done = true;
    moved = next.opened !== m.opened;
  }
  if (done || moved) changed();
  return done;
}

/** 别的设备上删掉了:这里跟着删(不算这台设备上的删除) */
export function removeSyncedWorld(id: string) {
  removeKeys(id);
  if (current?.id === id) {
    current = null;
    stopThumb();
  }
  // 腾出了地方:当前世界没存进去的再存一次。放到这一步做完以后(同步这时不理睬"存了"的通知),存了就会再排一次同步把它传上去
  queueMicrotask(retryUnsaved);
  changed();
}

/**
 * 退出登录时选了"从这台设备上删掉":浏览器里的世界全删;返回删干净了没有。
 * 浏览器不让删、看不了还剩什么 = false:删掉了的几样原样放回去(不然剩下半个世界,下次同步会把缺了东西的那份存进账号),
 * 正在看的世界接着用
 */
export function removeAllWorlds(): boolean {
  const ours = (k: string) => [PREFIX, THUMB, META, NOTES, LEGACY, ORIG].some((p) => k.startsWith(p));
  if (!wipeBrowser(ours)) {
    // 正在看的那份没能放回去:马上再存一次
    if (current?.wrote != null && store().get(PREFIX + current.id) === null) saveCurrent(true);
    changed();
    return false;
  }
  for (const k of [...mem.keys()]) if (ours(k)) mem.delete(k);
  current = null;
  stopThumb();
  changed();
  return true;
}

/**
 * 直接对浏览器存储删一遍、再看一遍还剩没剩。浏览器存储能不能用以这时直接看的为准(打开页面时探测不成功、
 * 后来出错退回内存的,浏览器里都可能还存着);看不了 = false。这个页面存在内存里、浏览器里却还存着的 = false,不删
 * (页面没看到它们,不知道同步过没有)。没删干净:删掉了的按删之前的样子放回去
 */
function wipeBrowser(ours: (k: string) => boolean): boolean {
  let s: Storage | undefined;
  try {
    s = (globalThis as { localStorage?: Storage }).localStorage;
  } catch {
    return false;
  }
  // 没有浏览器存储(不在网页里):世界只在内存里
  if (!s) return true;
  const st = s;
  // 这个页面存在内存里(打开时探测不成功、后来出错退回内存):浏览器里还存着的这个页面没列出来、也就没同步过,删了就没了
  if (local === undefined) store();
  const fallback = local === null;
  const left = () => {
    const out: string[] = [];
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i);
      if (k !== null && ours(k)) out.push(k);
    }
    return out;
  };
  const before = new Map<string, string>();
  try {
    for (const k of left()) {
      const v = st.getItem(k);
      if (v !== null) before.set(k, v);
    }
  } catch {
    return false;
  }
  if (fallback && before.size) return false;
  let ok = true;
  for (const k of before.keys()) {
    try {
      st.removeItem(k);
    } catch {
      ok = false;
    }
  }
  try {
    if (ok && left().length) ok = false;
  } catch {
    ok = false;
  }
  if (ok) return true;
  for (const [k, v] of before) {
    try {
      if (st.getItem(k) === null) st.setItem(k, v);
    } catch {
      /* 放不回去的:正在看的那份由上面再存一次 */
    }
  }
  return false;
}

/** 测试用:清空内存里的状态(不动浏览器存储) */
export function _resetForTest() {
  current = null;
  notice = null;
  local = undefined;
  migrated = false;
  storageFull = false;
  memoryWarned = false;
  evicted = [];
  mem.clear();
  stopThumb();
}

/**
 * 旧版本建的世界原来的样子(看原样用):留过底的是留的那份;没留过、存着的还是旧版本存的,就是存着的这份;
 * 都不是 = null(新版建的、读不出来的)。给的是存档原文(存档格式、各项都是当时写的,旧网站按它自己的读法读),
 * 只把生成器版本换成读出来的(老存档没写版本的)
 */
export function originalOf(id: string): SaveFile | null {
  const kv = store();
  for (const text of [kv.get(ORIG + id), kv.get(PREFIX + id)]) {
    if (text === null) continue;
    const r = parseSave(text);
    if (r.ok && r.save.generator < GENERATOR_VERSION) return { ...(JSON.parse(text.replace(/^\uFEFF/, '')) as SaveFile), generator: r.save.generator };
  }
  return null;
}

/** 正在看的世界原来的样子(存着的按 originalOf;还没存着的是打开时带的那一份);不是旧版本的 = null */
export function currentOriginal(): SaveFile | null {
  const c = current;
  if (!c) return null;
  return originalOf(c.id) ?? c.original ?? null;
}
