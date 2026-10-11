/**
 * 选中 ↔ 稳定键(阶段 2,A1,ui/navSelection.ts):
 * 历史里只存稳定身份,不存下标;四类实体(国家 / 州 / 城 / 地点)能往返,其余不进历史;
 * 键解析不到(实体不存在)= null → 调用方安全降级,绝不把别的实体当成它。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { generateCiv, type Civ } from '../src/gen/civ';
import { polityKey } from '../src/gen/edits';
import type { MapSelection } from '../src/ui/civView';
import { decodeSelection, encodeSelection } from '../src/ui/navSelection';

let world: World;
let civ: Civ;

beforeAll(() => {
  world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
  civ = generateCiv(world);
});

/** 有人住的州(拿它当 region 样本) */
function inhabitedRegion(): number {
  for (let r = 0; r < civ.regions.count; r++) if (civ.polity[r] >= 0) return r;
  return -1;
}

describe('选中 ↔ 稳定键(U3)', () => {
  it('四类实体的键都能往返:编码再解码 = 原来的选中', () => {
    const region = inhabitedRegion();
    expect(region).toBeGreaterThanOrEqual(0);
    const cases: MapSelection[] = [
      { kind: 'polity', id: 0 },
      { kind: 'settlement', id: 0 },
      { kind: 'place', id: 0 },
      { kind: 'region', id: region },
    ];
    for (const sel of cases) {
      const key = encodeSelection(civ, sel);
      expect(key, sel.kind).toBeTruthy();
      expect(decodeSelection(civ, sel.kind, key!), sel.kind).toEqual(sel);
    }
  });

  it('没有稳定键的种类不进历史:encode = null', () => {
    for (const kind of ['faith', 'person', 'mark', 'character'] as const) {
      expect(encodeSelection(civ, { kind, id: 0 } as MapSelection), kind).toBeNull();
    }
  });

  it('下标越界 = null(不编码出坏键)', () => {
    expect(encodeSelection(civ, { kind: 'polity', id: civ.polities.length + 5 })).toBeNull();
    expect(encodeSelection(civ, { kind: 'polity', id: -1 })).toBeNull();
    expect(encodeSelection(civ, { kind: 'place', id: civ.places.length + 5 })).toBeNull();
  });

  it('键解析不到(实体不存在)= null,不把别的实体当成它', () => {
    // 结构上像模像样、但指不到任何实体的键
    expect(decodeSelection(civ, 'place', 'place:river@c999999#0')).toBeNull();
    expect(decodeSelection(civ, 'polity', 'polity:not-a-real-key')).toBeNull();
    // 种类对不上:拿国家的键当州解码 = null
    const pk = encodeSelection(civ, { kind: 'polity', id: 0 })!;
    expect(decodeSelection(civ, 'region', pk)).toBeNull();
  });

  it('换个历史(重推 / 截断)后,当时还没有的实体 = null', () => {
    // 早期就停的世界里,后期才立国的国家不存在 → 它的键解析不到
    const early = generateCiv(world, { endYear: 1200 });
    const late = civ.polities.find((p) => p.founded > 1200);
    expect(late, 'seed 7 应有 1200 年以后才立国的国家').toBeTruthy();
    const key = polityKey(civ, late!.id);
    expect(decodeSelection(civ, 'polity', key)).toEqual({ kind: 'polity', id: late!.id }); // 完整历史里解析得到
    expect(decodeSelection(early, 'polity', key)).toBeNull(); // 早期历史里没有它 → 安全降级
  });
});
