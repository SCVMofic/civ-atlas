/**
 * 文明生成总流程:generateWorld() 之后在 worker 里调用。纯计算,不碰 DOM。
 *
 * 步骤顺序固定:
 *   ① 宜居度 + 州          habitat.ts / regions.ts
 *   ② 民族扩张 + 回放引擎   sim.ts / cultures.ts   → cultures、log、checkpoints、culture
 *   ③ 城市成长 + 国家       polities.ts            → settlements、polities、polity
 *   ④ 道路网               routes.ts              → routes
 *   ⑤ 地理名称             places.ts              → places
 *   ⑥ 人物                 people.ts              → people(历代君主、战争里的统帅;按推出来的历史排,不改历史)
 *   ⑦ 信仰                 religion.ts            → religion(民间信仰、大教、国教、教派;照推出来的历史贴上去,不改历史)
 *
 * 阶段 4 干预(params.interventions,interventions.ts):带着干预从第 0 年整段重推;干预年份之前和不干预时逐字节一致。
 * 阶段 4 改地形(world.terrain):扩张节拍按没改地形时的同一颗星球定(planetTempo),只有改动附近的历史跟着地形变。
 *
 * 随机数一律从 subSeed(seed, 'civ-…') 取(见 rand.ts),不用 Math.random。
 */
import { generateWorld, type Progress, type World, type WorldParams } from '../world';
import type { Sketch } from '../sketch';
import type { ChangeLog, Civ, CivParams, Culture, Habitat, Place, Polity, Route, Settlement } from './types';
import { computeHabitat } from './habitat';
import { buildRegions, emptyRegions, reshapeRegions } from './regions';
import { CivSim } from './sim';
import { BIRTH_SPAN, cultureModelOf, finishCultures, installCultures, planCultures } from './cultures';
import { buildRoutes } from './routes';
import { finishPolities, installPolities, planPolities, polityModelOf, routeCities } from './polities';
import { findPlaces, keepPlaceNames } from './places';
import { installWars } from './wars';
import { installPolitics } from './politics';
import { installDynasty } from './dynasty';
import { installAssimilation } from './assimilation';
import { installCities } from './cities';
import { warModelOf } from './wars';
import { installInterventions, scheduleInterventions } from './interventions';
import { buildPeople } from './people';
import { installUpheaval, scheduleUpheaval, upheavalImpact } from './upheaval';
import type { CultureModel } from './cultures';
import type { PolityModel } from './polities';
import type { InterventionModel } from './interventions';
import type { CivEra, NamePins, Regions, UpheavalFact } from './types';
import type { TerrainOp } from '../edits';
import { buildReligion } from './religion';
import { cleanMix, type NameMix } from '../names';

export * from './types';

export const DEFAULT_CIV_PARAMS: CivParams = {
  endYear: 3000,
  cultures: 'auto',
  polities: 'auto',
  regionArea: 750,
  pace: 1,
};

/** 可居地块(宜居分 ≥ 这个值)的总面积占陆地不到这个比例时,认为这颗星球没有文明 */
const MIN_HABITABLE_SUIT = 1;
const MIN_HABITABLE_FRAC = 0.02;

/** 陆地有几块、能不能有文明(可居的地方够不够) */
function viability(world: World, habitat: Habitat): { land: number; viable: boolean } {
  let land = 0;
  let habitable = 0;
  for (let i = 0; i < world.mesh.n; i++) {
    if (world.water[i] !== 0) continue;
    land++;
    if (habitat.suitability[i] >= MIN_HABITABLE_SUIT) habitable++;
  }
  return { land, viable: land > 0 && habitable >= land * MIN_HABITABLE_FRAC };
}

/**
 * 一颗星球的扩张节拍:民族走一个"标准路程"要几年(不含 pace;cultures.ts 的 calibrate),按**没改地形**的这组世界参数生成、标定。
 * 节拍是整个世界一起标定的(到第 3000 年约九成可居州有人住):改过地形的世界要是按改后的地形重新标定,
 * 远海放一座小岛也会把全世界的扩张都拨快或拨慢,各处的历史全跟着错开。所以改过地形的世界沿用原来星球的节拍,
 * 只有改动附近(和受它牵连)的历史跟着地形变。
 * 要多生成一遍没改过的地形;worker 按参数缓存,经 CivParams.tempo 传给 generateCiv。
 * 草图(新建世界时画的大陆和海)算星球的一部分:画过草图的世界,"没改地形的星球"是照草图长出来的那一颗(sketch 传进来)。
 * 没改过的星球长不出文明 = undefined(改过的世界按它自己标定)
 */
export function planetTempo(params: WorldParams, civ: Partial<CivParams> = {}, sketch?: Sketch | null): number | undefined {
  const p: CivParams = { ...DEFAULT_CIV_PARAMS, ...civ };
  const world = generateWorld(params, undefined, undefined, sketch);
  const habitat = computeHabitat(world);
  if (!viability(world, habitat).viable) return undefined;
  const regions = buildRegions(world, habitat, { regionArea: p.regionArea });
  const model = planCultures(world, habitat, regions, { cultures: p.cultures, pace: 1, birthSpan: p.birthSpan ?? BIRTH_SPAN });
  return model?.spreadYears;
}

export function generateCiv(world: World, params: Partial<CivParams> = {}, progress: Progress = () => {}): Civ {
  const p: CivParams = { ...DEFAULT_CIV_PARAMS, ...params };
  const n = world.mesh.n;
  /** 整个世界的地名风格(清理过;自动 = undefined) */
  const mix = cleanMix(p.names);

  progress('宜居度', 0);
  const habitat = computeHabitat(world);
  const { land, viable } = viability(world, habitat);

  progress('划分州', 0.3);
  const regions = land > 0 ? buildRegions(world, habitat, { regionArea: p.regionArea }) : emptyRegions(n);

  progress('文明', 0.8);
  const R = regions.count;
  // ---- 以下各步:viable 为 false 时一律保持为空 ----
  // ② 民族扩张 + 回放引擎(cultures.ts / sim.ts):定民族 → 按年推演到 endYear → 按最终疆域配色、起名。
  // ③ 城市成长 + 国家(polities.ts):在 sim.run 之前装上自己的事件(建城、立国、国家到达、升格),
  //    同一个引擎、同一本日志
  const sim = new CivSim(R);
  const birthSpan = p.birthSpan ?? BIRTH_SPAN;
  // 改过地形:扩张节拍沿用没改地形时的同一颗星球(planetTempo);没改 = 按这个世界自己标定
  const tempo = viable && world.terrain?.length ? (p.tempo === undefined ? planetTempo(world.params, p, world.sketch) : (p.tempo ?? undefined)) : undefined;
  const model = viable ? planCultures(world, habitat, regions, { cultures: p.cultures, pace: p.pace, birthSpan, tempo }) : null;
  const pm = model ? planPolities(world, model, { polities: p.polities, pace: p.pace }) : null;
  // 阶段 4 干预(interventions.ts):事件最先预约(同一刻里先于别的一切事件,干预之前的历史一字不差)
  const iv = pm ? scheduleInterventions(sim, world.params.seed, p.interventions) : null;
  if (model) installCultures(sim, model);
  if (pm) installPolities(sim, pm);
  if (pm) installWars(sim, pm); // 阶段 3 战争与攻占(wars.ts):宣战、攻占、迁都、灭亡、议和
  if (pm) installPolitics(sim, pm, world); // 阶段 3 分与合(politics.ts):分裂、合并、复国、主动迁都、部落地带补立国
  if (pm) installDynasty(sim, pm); // 阶段 3 王朝更替(dynasty.ts):改朝换代、王室更迭,新朝定都根据地
  if (pm) installAssimilation(sim, pm, world); // 阶段 3 同化与迁徙(assimilation.ts):同化、随征服而来的移民、避兵外迁、民族消亡
  if (pm) installCities(sim, pm, warModelOf(sim)!); // 阶段 3 城市兴衰(cities.ts):洗劫、毁城、重建、旧都衰落
  if (iv) installInterventions(sim, iv); // 阶段 4 干预:不许灭、结盟、宣战、禁止分裂(各机制在决策点查 WarModel.iv)
  progress('民族推演', 0.85);
  // 地形大事:推到第一件的前一刻,之后每件套上新地形接着推(upheaval.ts)
  const ups = pm ? (p.upheavals ?? []).filter((u) => u.year > 0 && u.year < p.endYear) : [];
  sim.run(ups.length ? ups[0].year - 1 / 256 : p.endYear);
  let fin = { sim, model, pm, world, habitat, regions };
  const pins: NamePins | undefined = ups.length ? { regionNames: [], polities: new Map(), settlements: new Map() } : undefined;
  const eras: CivEra[] = [];
  const facts: UpheavalFact[] = [];
  /** 配了地名风格时,各段的起名等推完再做(要按真正推演结束时各民族住的地方凑份数,见下面 nameEra) */
  const later: ((areas: Int16Array) => void)[] = [];
  for (let k = 0; k < ups.length; k++) {
    const u = ups[k];
    const before = fin.regions;
    const eraWorld = fin.world;
    const eraHabitat = fin.habitat;
    // 名字、配色、这一段的地名和道路:照"没有这件大事、照原样推到底"的那份历史(大事之前和它一模一样,见 NamePins)
    const same = partialCiv(fin.sim, fin.model!, fin.pm!, eraHabitat, before, world.params.seed, iv);
    const branch = CivSim.fromCiv(eraWorld, same, same.interventions ?? []);
    branch.run(p.endYear);
    // 起名只读这一段的分支,不影响之后的推演。配了地名风格时份数按真正的结局凑(areas = 推演结束时的民族归属):
    // 照"没有大事"的那份结局凑的话,大事淹掉、改变了大片地方以后,实际的占比会和配的差出一截
    const nameEra = (areas?: Int16Array) => {
      const b = pinNames(pins!, eraWorld, branch, k ? ups[k - 1].year : -Infinity, u.year, k === 0, mix, areas);
      const eraPlaces = findPlaces(eraWorld, before, { cultures: b.cultures, culture: b.culture, names: mix });
      if (k) keepPlaceNames(eraWorld, eras[k - 1].places, eraPlaces);
      const eraRoutes = buildRoutes(eraWorld, eraHabitat, before, { cities: b.settlements.length ? routeCities(b.settlements, b.polities, p.endYear) : undefined });
      eras.push({ until: u.year, habitat: eraHabitat, regions: before, places: eraPlaces, routes: eraRoutes });
    };
    if (mix) later.push(nameEra);
    else nameEra();
    // 新地形:州沿用编号,只改变了的地方;比出这件大事改了什么
    const h1 = computeHabitat(u.world);
    const r1 = reshapeRegions(u.world, h1, before, { regionArea: p.regionArea });
    const impact = upheavalImpact(fin.world, before, u.world, r1, u.ops);
    const { joined, ...rest } = impact;
    const fact: UpheavalFact = { year: u.year, kinds: kindsOf(u.ops), items: u.items.slice(), ...rest, polity: -1, drownedBy: [], ...(joined ? { joined } : {}) };
    facts.push(fact);
    const half = partialCiv(fin.sim, fin.model!, fin.pm!, h1, r1, world.params.seed, iv);
    // 从前一刻接着推:大事那一刻的事件照常补上(同一年下的干预、民族诞生……),排在大事后面;
    // 按新地形重算出来的、本该更早发生的事(新海路上的到达……)一律从大事那一刻起(CivSim.floor)
    const s1 = CivSim.fromCiv(u.world, half, half.interventions ?? [], (s) => {
      s.floor = u.year;
      scheduleUpheaval(s, k, u.year);
    });
    installUpheaval(s1, k, u, impact, fact, fin.world);
    s1.run(k + 1 < ups.length ? ups[k + 1].year - 1 / 256 : p.endYear);
    const m1 = cultureModelOf(s1)!;
    const pm1 = polityModelOf(s1)!;
    pm1.cultures = m1.cultures; // 接着推时两层各复制了一份民族表:起城名、国名要用起好名的那份
    fin = { sim: s1, model: m1, pm: pm1, world: u.world, habitat: h1, regions: r1 };
  }
  const { log, checkpoints, culture, polity, annals } = fin.sim.result();
  progress('起名', 0.92);
  for (const f of later) f(culture);
  if (fin.model) finishCultures(fin.world, fin.model, culture, checkpoints, pins, mix);
  if (fin.pm) finishPolities(fin.world, fin.pm, polity, pins);
  const cultures: Culture[] = fin.model?.cultures ?? [];
  const settlements: Settlement[] = fin.pm?.settlements ?? []; // ③ polities.ts
  const polities: Polity[] = fin.pm?.polities ?? []; // ③ polities.ts
  // ④ routes.ts:城镇列表交给道路(国都之间修大路,路的修建年份取两端较晚者)
  const routes: Route[] = viable
    ? buildRoutes(fin.world, fin.habitat, fin.regions, { progress, cities: settlements.length ? routeCities(settlements, polities, p.endYear) : undefined })
    : [];
  const places: Place[] = findPlaces(fin.world, fin.regions, { cultures, culture, names: mix }); // ⑤ places.ts(山海湖岛是地理,不看 viable)
  // 地形大事以后:同一处地方沿用大事以前的地名
  if (eras.length) keepPlaceNames(fin.world, eras[eras.length - 1].places, places);
  const people = buildPeople({ seed: world.params.seed, endYear: p.endYear, polities, settlements, cultures, annals }); // ⑥ people.ts

  const civ: Civ = {
    seed: world.params.seed,
    endYear: p.endYear,
    habitat: fin.habitat,
    regions: fin.regions,
    cultures,
    settlements,
    polities,
    routes,
    places,
    culture,
    polity,
    log,
    checkpoints,
    annals,
    viable,
    spreadYears: model?.spreadYears,
    polityYears: pm?.years,
    ...(iv ? { interventions: iv.list.slice() } : {}),
    people,
    ...(facts.length ? { upheavals: facts, eras } : {}),
    ...(mix ? { names: mix } : {}),
  };
  // ⑦ religion.ts:要整份 civ(按年份查归属、国都、君主;地形大事以前按那时的州)
  if (viable && cultures.length) civ.religion = buildReligion(fin.world, civ);
  return civ;
}

/** 一件地形大事里有哪几种修改(按第一次出现的先后) */
function kindsOf(ops: readonly TerrainOp[]): UpheavalFact['kinds'] {
  const out: UpheavalFact['kinds'] = [];
  for (const o of ops) if ((o.kind === 'volcano' || o.kind === 'raise' || o.kind === 'sink') && !out.includes(o.kind)) out.push(o.kind);
  return out;
}

/**
 * 一段推演(到第 k 件大事的前一刻)不套这件大事、照原样推到底(branch)以后起的名字、配色:
 * 年份在 [from, to) 里出现的国家、城、王朝,和这一段里新划出来的州,钉住(第一段还钉住民族)。
 * 返回 branch 起好名的民族、城、国家和推到底的民族归属(这一段的地名、道路照它定)。
 * areas = 配了地名风格时按份数凑占比看的民族归属(真正推演结束时的;只在第一段用)
 */
function pinNames(pins: NamePins, world: World, branch: CivSim, from: number, to: number, first: boolean, mix?: NameMix, areas?: Int16Array) {
  const res = branch.result();
  const bm = cultureModelOf(branch)!;
  const bpm = polityModelOf(branch)!;
  bpm.cultures = bm.cultures; // 接着推时两层各复制了一份民族表:起城名、国名要用起好名的那份
  finishCultures(world, bm, res.culture, res.checkpoints, first ? undefined : pins, mix, areas);
  finishPolities(world, bpm, res.polity, pins);
  if (first) pins.cultures = bm.cultures.map((c) => ({ name: c.name, style: c.style, ...(c.autoStyle ? { autoStyle: c.autoStyle } : {}), color: [...c.color] as [number, number, number] }));
  const names = bm.terrain.regions.name ?? [];
  for (let r = 0; r < bm.terrain.regions.count; r++) if (pins.regionNames[r] === undefined) pins.regionNames[r] = names[r] ?? '';
  for (const q of bpm.polities) {
    let v = pins.polities.get(q.id);
    if (q.founded >= from && q.founded < to) {
      v = { name: q.name, color: [...q.color] as [number, number, number], dynasties: [] };
      pins.polities.set(q.id, v);
    }
    if (!v) continue;
    q.dynasties?.forEach((d, i) => {
      if (d.year >= from && d.year < to) v.dynasties[i] = d.name;
    });
  }
  for (const c of bpm.settlements) if (c.founded >= from && c.founded < to) pins.settlements.set(c.id, c.name);
  return { cultures: bm.cultures, culture: res.culture, settlements: bpm.settlements, polities: bpm.polities };
}

/** 推到一半的历史(地形大事前一刻)拼成 CivSim.fromCiv 要的 Civ(州、宜居度按给的);归属数组、检查点按州数补齐(新州 = 没人) */
function partialCiv(sim: CivSim, model: CultureModel, pm: PolityModel, habitat: Habitat, regions: Regions, seed: number, iv: InterventionModel | null): Civ {
  const res = sim.result();
  const pad = (a: Int16Array) => {
    if (a.length >= regions.count) return a;
    const b = new Int16Array(regions.count).fill(-1);
    b.set(a);
    return b;
  };
  return {
    seed,
    endYear: res.endYear,
    habitat,
    regions,
    cultures: model.cultures,
    settlements: pm.settlements,
    polities: pm.polities,
    routes: [],
    places: [],
    culture: pad(res.culture),
    polity: pad(res.polity),
    log: res.log,
    checkpoints: res.checkpoints.map((c) => (c.culture.length >= regions.count ? c : { year: c.year, culture: pad(c.culture), polity: pad(c.polity) })),
    annals: res.annals,
    viable: true,
    spreadYears: model.spreadYears,
    polityYears: pm.years,
    ...(iv ? { interventions: iv.list.slice() } : {}),
    people: [],
  } as Civ;
}

export function emptyLog(): ChangeLog {
  return {
    size: 0,
    year: new Float32Array(0),
    region: new Int32Array(0),
    layer: new Uint8Array(0),
    value: new Int16Array(0),
    cause: new Uint8Array(0),
  };
}

/** Civ 里所有类型化数组的底层缓冲区(去重),worker 发消息时用 transfer 传,省得复制 */
export function civTransferables(civ: Civ): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer && v.buffer.byteLength > 0) out.add(v.buffer);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(civ, 0);
  return [...out];
}
