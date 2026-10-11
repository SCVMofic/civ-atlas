/**
 * 选中 ↔ 稳定键(阶段 2,A1):历史里**只存稳定身份,不存会随重推变化的下标**。
 *
 * 用 `gen/edits.ts` 现有的键与解析器(`polityKey` / `regionKey` / `settlementKey` / `placeKeyOf` /
 * `resolveKey`),不另造格式。四类有稳定键的实体才进历史;其余(faith / person / mark / character)
 * 返回 null,调用方就不给它们写历史。
 *
 * 契约(和设计 §3.3 / A1 一致):
 * - `encodeSelection`:选中 → 键;这类没键 / 下标越界 = null。
 * - `decodeSelection`:键 → 选中;**键在字符串层面相同不等于实体还在** —— 交给 `resolveKey` 判定,
 *   解析不到(已删除 / 重推后不存在)返回 null,调用方安全降级,**不选别的实体**。
 * - 跨世界不在这里判:`nav` 先比 `world`,世界不对的整条记录根本不会走到解码。
 */
import type { Civ } from '../gen/civ';
import { placeKeyOf, polityKey, regionKey, resolveKey, settlementKey } from '../gen/edits';
import type { MapSelection } from './civView';

/** 有稳定键、能进历史的选中种类 */
const KEYED = new Set<MapSelection['kind']>(['polity', 'region', 'settlement', 'place']);

/** 选中 → 稳定键;这类没有稳定键(或下标越界)= null(调用方:不进历史) */
export function encodeSelection(civ: Civ, sel: MapSelection): string | null {
  if (!KEYED.has(sel.kind) || sel.id < 0) return null;
  const ok =
    sel.kind === 'polity' ? sel.id < civ.polities.length
    : sel.kind === 'settlement' ? sel.id < civ.settlements.length
    : sel.kind === 'place' ? sel.id < civ.places.length
    : sel.id < civ.regions.count;
  if (!ok) return null;
  try {
    if (sel.kind === 'polity') return polityKey(civ, sel.id);
    if (sel.kind === 'settlement') return settlementKey(civ, sel.id);
    if (sel.kind === 'place') return placeKeyOf(civ, sel.id);
    return regionKey(civ, sel.id);
  } catch {
    return null;
  }
}

/** 稳定键 → 选中;解析不到(实体已不在)= null(调用方:安全降级,不选别的实体) */
export function decodeSelection(civ: Civ, kind: string, key: string): MapSelection | null {
  if (!KEYED.has(kind as MapSelection['kind'])) return null;
  const r = resolveKey(civ, key);
  return r && r.kind === kind ? ({ kind, id: r.id } as MapSelection) : null;
}
