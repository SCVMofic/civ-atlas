/**
 * 地形大事以后,地图跟着时间轴换段(gen/civ/upheaval.ts;格式见 gen/edits.ts 文件头"地形大事"):
 * 时间轴在第一件大事以前画原来的地形,过了那一年画大事以后的地形 —— 主图、世界(河、海陆)、州、地名、道路一起换。
 *
 * - 第几段(eraIndex):时间轴那一年已经发生了几件大事(大事那一年的年初发生,那一年就算"以后")。
 *   useEraIndex 只在段变了的时候让组件重画(播放时每帧都变的年份不惊动 App)。
 * - 历史(civAtEra):Civ.eras 存着每件大事以前那一段的宜居度、州、地名、道路;最后一段就是 Civ 本身。
 *   编年史这类按整段历史算的用最后一段(Civ.history,withHistory 挂上),国旗按第一件大事以前的地形配(拖时间轴旗不跟着变)。
 *   各段共用同一份国家、城、人物、史事;州名、稳定键按最后一段的(大事前后一样,见 gen/edits.ts 的 keyCells)。
 *   同一份历史的同一段只拼一次(地图上的缓存认对象,来回拖时间轴不用重画)。
 * - 世界和主图(EraMaps):后台线程交来每段的世界(不带网格,接上原来的)和主图补丁(gen/rasterPatch.ts:只有变了的那一块),
 *   原来的主图复制一份、按先后贴上补丁就是那一段的主图;补丁还没到的段先用前一段的世界和主图(两样对得上;后台铺好就换上)。
 *
 * 不碰 DOM;App 用。
 */
import { useSyncExternalStore } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { keyCells, keySeats } from '../gen/edits';
import { composeRaster, type RasterPatch } from '../gen/rasterPatch';
import { getCivTime, subscribeCivTime } from './civView';

/** 第 year 年已经发生了几件大事(facts 按年份排好;year 不给 = 结束年份) */
export function eraIndex(civ: Pick<Civ, 'upheavals' | 'endYear'> | null, year: number | null): number {
  const f = civ?.upheavals;
  if (!f?.length) return 0;
  const y = year ?? civ!.endYear;
  let k = 0;
  while (k < f.length && f[k].year <= y) k++;
  return k;
}

/** 时间轴现在在第几段(只在段变了时重画) */
export function useEraIndex(civ: Pick<Civ, 'upheavals' | 'endYear'> | null): number {
  return useSyncExternalStore(
    (f) => subscribeCivTime(f),
    () => eraIndex(civ, getCivTime().year),
    () => eraIndex(civ, getCivTime().year),
  );
}

const eraCivs = new WeakMap<Civ, Civ[]>();

/** 第 k 段的历史:宜居度、州、地名、道路换成那一段的(最后一段 = 原样) */
export function civAtEra(civ: Civ, k: number): Civ {
  const eras = civ.eras;
  if (!eras?.length || k >= eras.length) return civ;
  let list = eraCivs.get(civ);
  if (!list) eraCivs.set(civ, (list = []));
  const hit = list[k];
  if (hit) return hit;
  const e = eras[k];
  const R = civ.regions;
  const out: Civ = {
    ...civ,
    habitat: e.habitat,
    // 州名、稳定键按最后一段的:大事以后新划的州也有名字,键在各段一样
    regions: { ...e.regions, name: R.name, keyOf: keyCells(R) as Int32Array, keySeat: keySeats(R) as Int32Array },
    places: e.places,
    routes: e.routes,
  };
  list[k] = out;
  return out;
}

/** 地图上画的是更早一段时,挂上整段历史那一份(编年史、时间轴按它算;见 Civ.history)。同样的两份只拼一次 */
const histOf = new WeakMap<Civ, WeakMap<Civ, Civ>>();
export function withHistory(shown: Civ, full: Civ): Civ {
  if (shown === full) return shown;
  let m = histOf.get(full);
  if (!m) histOf.set(full, (m = new WeakMap()));
  let out = m.get(shown);
  if (!out) m.set(shown, (out = { ...shown, history: full }));
  return out;
}

/** 这份历史在第一件地形大事以前的州(没有大事 = 它的州):同一个世界重推多少次都一样(时间轴、地图按它认"还是同一个世界") */
export const baseRegions = (civ: Civ) => civ.eras?.[0]?.regions ?? civ.regions;
/** 同上,宜居度 */
const baseHabitat = (civ: Civ) => civ.eras?.[0]?.habitat ?? civ.habitat;

/**
 * 重推回来的文明沿用现在这份的州(地理没变;地图上的缓存按对象认"还是同一个世界"):
 * 第一件大事以前的州和宜居度总是一样的(同一个世界);之后各段的只在带着一样的地形大事(sameUps)时沿用。州数对不上的不沿用。
 * 州名(regions.name)不是地理:换了地名风格会重起。names = 要换上的这份是真的换上去(不是试推演):沿用的州换上新起的州名(还是同一个对象)
 */
export function reuseRegions(old: Civ, next: Civ, sameUps: boolean, names = false): Civ {
  const base = baseRegions(old);
  const withNames = names ? carryNames : (keep: Civ['regions']) => keep;
  if (sameUps) {
    if (old.regions.count !== next.regions.count) return next;
    const eras = next.eras?.map((e, i) => {
      const o = old.eras?.[i];
      return o && o.regions.count === e.regions.count ? { ...e, habitat: o.habitat, regions: withNames(o.regions, e.regions) } : e;
    });
    return { ...next, regions: withNames(old.regions, next.regions), habitat: old.habitat, ...(eras ? { eras } : {}) };
  }
  const e0 = next.eras?.[0];
  if (e0) return e0.regions.count === base.count ? { ...next, eras: [{ ...e0, habitat: baseHabitat(old), regions: withNames(base, e0.regions) }, ...next.eras!.slice(1)] } : next;
  // 地形大事都撤销了:州就是原来那一份
  return next.regions.count === base.count ? { ...next, regions: withNames(base, next.regions), habitat: baseHabitat(old) } : next;
}

/** 沿用的州换上新推出来的州名(一样就不动) */
function carryNames(keep: Civ['regions'], from: Civ['regions']): Civ['regions'] {
  const a = keep.name;
  const b = from.name;
  if (b && (!a || a.length !== b.length || a.some((x, i) => x !== b[i]))) keep.name = b;
  return keep;
}

// ---------------------------------------------------------------------------
// 各段的世界和主图

/** 这份历史各段的世界(第 k 个 = 第 k + 1 件大事以后的;已接上网格)、在后台线程里的键 */
export interface EraMaps {
  /** 原来的世界的键(第一件大事的补丁是和它比的) */
  baseKey: string;
  keys: string[];
  worlds: World[];
}

/** 后台线程交来的各段世界接上网格(网格各段一样,线程不交) */
export function eraMapsOf(base: World, baseKey: string, eras: readonly { key: string; world: World }[]): EraMaps {
  return { baseKey, keys: eras.map((e) => e.key), worlds: eras.map((e) => ({ ...e.world, mesh: base.mesh })) };
}

/** 补丁的键:"上一段的键>这一段的键" */
export const patchKey = (prev: string, key: string) => `${prev}>${key}`;

/** 换到第 k 段的主图要贴的补丁(按先后);缺了的那一段起不贴,n = 贴到了第几段 */
function chainOf(maps: EraMaps, patches: ReadonlyMap<string, RasterPatch | null>, k: number): { list: RasterPatch[]; sig: string; n: number } {
  const list: RasterPatch[] = [];
  const sig: string[] = [];
  let prev = maps.baseKey;
  let n = 0;
  for (; n < k; n++) {
    const key = maps.keys[n];
    const pk = patchKey(prev, key);
    if (!patches.has(pk)) break;
    const p = patches.get(pk);
    if (p) list.push(p);
    sig.push(pk);
    prev = key;
  }
  return { list, sig: sig.join('|'), n };
}

/**
 * 地图上实际画第几段:想看第 k 段,那一段的主图补丁还没到就先画前面铺好了的那一段(历史、世界、主图三样对得上;
 * 没有各段的世界 = 原来那一段)
 */
export function eraShown(maps: EraMaps | null, patches: ReadonlyMap<string, RasterPatch | null>, k: number): number {
  if (!maps || k <= 0) return 0;
  return chainOf(maps, patches, Math.min(k, maps.worlds.length)).n;
}

/** 第 k 段的主图补丁都到了没有(没有大事、k = 0 = 到了) */
export function eraReady(maps: EraMaps | null, patches: ReadonlyMap<string, RasterPatch | null>, k: number): boolean {
  if (!maps || k <= 0) return true;
  const kk = Math.min(k, maps.worlds.length);
  return chainOf(maps, patches, kk).n === kk;
}

/** 拼好的各段主图(最多留两张:来回拖时间轴不用重拼) */
const composed = new Map<string, { base: Raster; raster: Raster }>();
/** 同一个世界配同一张主图 = 同一个对象(地图按对象认"换没换图") */
const pairs = new WeakMap<World, WeakMap<Raster, { world: World; raster: Raster }>>();
function pair(world: World, raster: Raster): { world: World; raster: Raster } {
  let m = pairs.get(world);
  if (!m) pairs.set(world, (m = new WeakMap()));
  let p = m.get(raster);
  if (!p) m.set(raster, (p = { world, raster }));
  return p;
}

/**
 * 第 k 段的世界和主图(k = 0 或没有大事 = 原来的)。主图按贴得上的补丁拼,世界跟着主图:
 * 补丁还没到的段先用前一段的世界和主图(河、海岸和底图对得上)。同样的补丁拼出来的是同一个对象
 */
export function eraData(base: { world: World; raster: Raster }, maps: EraMaps | null, patches: ReadonlyMap<string, RasterPatch | null>, k: number): { world: World; raster: Raster } {
  if (!maps || k <= 0) return base;
  const { list, sig, n } = chainOf(maps, patches, Math.min(k, maps.worlds.length));
  if (!n) return base;
  const world = maps.worlds[n - 1];
  if (!list.length) return pair(world, base.raster);
  let hit = composed.get(sig);
  if (!hit || hit.base !== base.raster) {
    hit = { base: base.raster, raster: composeRaster(base.raster, list) };
    composed.delete(sig);
    composed.set(sig, hit);
    while (composed.size > 2) composed.delete(composed.keys().next().value!);
  }
  return pair(world, hit.raster);
}

/** 换了世界:拼好的主图都不要了 */
export function dropComposed() {
  composed.clear();
}
