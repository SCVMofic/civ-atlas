/**
 * 旧版网站:生成器升级(同一个种子的世界变样)以后,上一版网站原样留在 /v<上一版>/ 下面
 * (.github/workflows/deploy-old-site.yml)。那份构建带 VITE_OLD_SITE(第几版)和 VITE_OLD_UNTIL(新版上线那天),
 * 页面上写明是旧版、能回最新版;它的浏览器存储和最新版分开(存储的名字带版本号)。
 *
 * 最新版里打开旧版本建的世界,能到那一版的旧网站里看原样:存档放进链接的 # 后面(和分享链接一样),开一个新页面。
 * 旧网站里打开了更新的版本存的世界,反过来交给最新版。交过去的网址带 own=1:是自己的世界,不是别人分享来的。
 */
import { EMPTY_EDITS, GENERATOR_VERSION } from '../gen/edits';
import { NEWER_NOTE, encodeShare, makeSave, type SaveFile } from '../gen/savefile';
import type { WorldParams } from '../gen/world';

/** 从这一版起,每次升级都把上一版网站留着(更早的版本没有旧网站) */
export const FIRST_OLD_SITE = 9;

/** 网址里的标记:这是自己的世界(最新版和旧网站之间交过来的),不是别人分享的 */
export const OWN_KEY = 'own';

type Env = Record<string, string | boolean | undefined>;
const env: Env = (import.meta as { env?: Env }).env ?? {};

/** 构建时带的旧网站版本号:正整数;不是旧网站 = null */
export function oldSiteVersion(v: unknown): number | null {
  return typeof v === 'string' && /^[1-9]\d{0,5}$/.test(v) ? Number(v) : null;
}

/** 新版上线那天(2026-10-11)→「10 月 11 日」;没给、格式不对、日历上不存在的那天 = '' */
export function untilText(v: unknown): string {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 真日历校验:按 UTC 构造再对回年月日,2 月 31 日、平年 2 月 29 日这类不存在的那天对不上就被否掉
  // (先拿 2000 年构造,避免 Date 把 0–99 年当成 19xx;再 setUTCFullYear 换成真年份)
  const dt = new Date(Date.UTC(2000, mo - 1, d));
  dt.setUTCFullYear(y);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return `${mo} 月 ${d} 日`;
}

/** 这是第几版的旧网站;最新版 = null */
export const OLD_SITE: number | null = oldSiteVersion(env.VITE_OLD_SITE);
/** 旧网站用到哪天(新版上线那天,「10 月 11 日」);不知道 = '' */
export const OLD_UNTIL: string = untilText(env.VITE_OLD_UNTIL);

/** 旧网站里打开了更新的版本存的世界:刷新还是旧网站,不说"刷新页面",说旧版里看到的不一样(提示条上带「到最新版打开」) */
export const OLD_NEWER_NOTE = '来自更新的版本：旧版里看到的和最新版不一样';

/** 读档提示里的一句话,旧网站上换成旧网站的说法;最新版原样 */
export function oldSiteNote(w: string, site = OLD_SITE): string {
  return site !== null && w === NEWER_NOTE ? OLD_NEWER_NOTE : w;
}

/** 只带种子、参数的旧网址(没有修改):当成第 gen 版存的一份没改过的存档(交给别的版本打开用;地形校验留空 = 不核对) */
export function plainSave(params: WorldParams, gen: number): SaveFile {
  return { ...makeSave(params, EMPTY_EDITS, ''), generator: gen };
}

/** 现在这一页的网址(没有页面时当作网站首页,单测用) */
function here(): string {
  return typeof location === 'undefined' ? 'https://atlas.gerdor.top/' : location.href;
}

/**
 * 第 gen 版建的世界在哪个旧网站看原样:最新版网站下面的 v<gen>/。
 * 没有那一版的旧网站(太旧、就是现在这一版、比现在还新、版本号认不出)、这一页自己就是旧网站 = null
 */
export function oldSiteFor(gen: number, page = here(), site = OLD_SITE, current = GENERATOR_VERSION): URL | null {
  if (site !== null || !Number.isInteger(gen) || gen < FIRST_OLD_SITE || gen >= current) return null;
  return new URL(`v${gen}/`, new URL('./', page));
}

/** 旧网站回最新版的网址(旧网站在最新版下面一层);不是旧网站 = 这一页所在的目录 */
export function latestUrl(page = here(), site = OLD_SITE): URL {
  return new URL(site === null ? './' : '../', page);
}

/**
 * 在新页面里打开一份存档(看原样、到最新版打开)。先同步开出新页面(弹窗拦截只放过点击当下开的),
 * 存档压缩好了再让它跳过去;浏览器太旧压缩不了 = false(新页面关掉)
 */
async function openSaveIn(target: URL, save: SaveFile): Promise<boolean> {
  const w = window.open('', '_blank');
  try {
    const u = new URL(target);
    u.searchParams.set(OWN_KEY, '1');
    u.hash = await encodeShare(save);
    if (!w) {
      location.href = u.href;
      return true;
    }
    w.opener = null;
    w.location.href = u.href;
    return true;
  } catch {
    w?.close();
    return false;
  }
}

/** 到这个世界那一版的旧网站里看原样(新页面);没有那一版的旧网站、打不开 = false */
export function openOriginal(save: SaveFile): Promise<boolean> {
  const u = oldSiteFor(save.generator);
  return u ? openSaveIn(u, save) : Promise.resolve(false);
}

/** 旧网站里打开了更新的版本存的世界:到最新版打开(新页面) */
export function openInLatest(save: SaveFile): Promise<boolean> {
  return openSaveIn(latestUrl(), save);
}
