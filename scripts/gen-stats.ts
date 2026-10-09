/**
 * 打印一个世界的统计数字:npx tsx scripts/gen-stats.ts [种子] [cells=…]
 * 地形(耗时、陆地、湖、河、海拔 / 降水分位数、群落、陆块大小(长尾)、海冰按纬度、河流去向、两极)
 * + 文明(国家、战争、分合、王朝更替、同化与迁徙、城市兴衰)。
 *
 * 极地大陆的比例:npx tsx scripts/gen-stats.ts polar=40 [from=1] [cells=…]
 *   从种子 from 起连续 40 个世界(只生成地形),每个一行:两极的极圈(纬度 66° 以上)里陆地占多少、其中属于大陆(≥ 球面 1% 的陆块)的占多少;
 *   "有极地大陆" = 至少一极的极圈里大陆 ≥ 40%(像南极洲)。最后一行是合计
 */
import { generateWorld, type World, type WorldParams } from '../src/gen/world';
import { BIOMES, Biome } from '../src/gen/biomes';
import { simulation } from '../src/simulation/simulation';
import { geometryOf } from '../src/gen/geometry';
import { warStats } from '../src/gen/civ/wars';
import { politicsStats } from '../src/gen/civ/politics';
import { dynastyStats } from '../src/gen/civ/dynasty';
import { cityStats } from '../src/gen/civ/cities';
import { buildChronicle, filterChronicle } from '../src/gen/civ/chronicle';
import { polityName } from '../src/gen/civ/growth';
import { assimStats } from '../src/gen/civ/assimilation';
const args = process.argv.slice(2);
const opt = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);

/** 极圈的纬度;极圈里大陆占到这么多算"有极地大陆";大陆 = 不小于球面这么大比例的陆块 */
const POLAR_CIRCLE = 66;
const POLAR_SHARE = 0.4;
const CONTINENT = 0.01;

/** 两极的样子:极圈里陆地、大陆各占多少(按面积),极点是不是陆地 */
function polarCaps(w: World) {
  const { mesh, water } = w;
  const { n, adjStart, adj } = mesh;
  const geo = geometryOf(mesh);
  const area = geo.cellAreas();
  const comp = new Int32Array(n).fill(-1);
  const compA: number[] = [];
  for (let i = 0; i < n; i++) {
    if (water[i] === 1 || comp[i] >= 0) continue;
    const id = compA.length;
    const q = [i];
    comp[i] = id;
    let a = 0;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      a += area[c];
      for (let k = adjStart[c]; k < adjStart[c + 1]; k++) {
        const j = adj[k];
        if (water[j] !== 1 && comp[j] < 0) {
          comp[j] = id;
          q.push(j);
        }
      }
    }
    compA.push(a);
  }
  return ([1, -1] as const).map((sgn) => {
    let cap = 0;
    let land = 0;
    let cont = 0;
    for (let i = 0; i < n; i++) {
      if (geo.latitude(i) * sgn <= POLAR_CIRCLE) continue;
      cap += area[i];
      if (water[i] === 1) continue;
      land += area[i];
      if (compA[comp[i]] >= CONTINENT * geo.area) cont += area[i];
    }
    const pole = geo.nearest(w.width / 2, sgn > 0 ? 0 : w.height, 0);
    return { name: sgn > 0 ? '北极' : '南极', land: land / cap, continent: cont / cap, poleLand: water[pole] !== 1 };
  });
}

if (opt('polar')) {
  const N = Number(opt('polar'));
  const from = Number(opt('from') ?? 1);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  let yes = 0;
  let both = 0;
  const t = performance.now();
  for (let seed = from; seed < from + N; seed++) {
    const p = { seed } as WorldParams;
    if (opt('cells')) p.cells = Number(opt('cells'));
    const caps = polarCaps(generateWorld(p));
    const k = caps.filter((c) => c.continent >= POLAR_SHARE).length;
    if (k) yes++;
    if (k === 2) both++;
    console.log(
      `种子 ${seed}:${k ? (k === 2 ? '两极都有' : `${caps.find((c) => c.continent >= POLAR_SHARE)!.name}大陆`) : '—'} | ` +
        caps.map((c) => `${c.name}${c.poleLand ? '是陆地' : '是海'},极圈里陆地 ${pct(c.land)}(大陆 ${pct(c.continent)})`).join(' | '),
    );
  }
  console.log(`有极地大陆(至少一极的极圈里大陆 ≥ ${pct(POLAR_SHARE)}):${yes} / ${N}(${pct(yes / N)}),两极都有 ${both} 个;${Math.round((performance.now() - t) / 1000)} 秒`);
  process.exit(0);
}

const seed = Number(args.find((a) => !a.includes('=')) ?? 1);
const params = { seed } as WorldParams;
if (opt('cells')) params.cells = Number(opt('cells'));
const t0 = performance.now();
let last = t0;
const w = generateWorld(params, (stage, pct) => {
  const now = performance.now();
  if (now - last > 0) process.stdout.write(`${stage} ${(pct * 100).toFixed(0)}% +${(now - last).toFixed(0)}ms\n`);
  last = now;
});
const t1 = performance.now();
const n = w.mesh.n;
let land = 0, lake = 0;
for (let i = 0; i < n; i++) { if (w.water[i] === 0) land++; if (w.water[i] === 2) lake++; }
const counts = new Map<number, number>();
for (let i = 0; i < n; i++) counts.set(w.biome[i], (counts.get(w.biome[i]) ?? 0) + 1);
console.log({ ms: Math.round(t1 - t0), cells: n, plates: w.tect.plateCount, land, lake, rivers: w.rivers.length, maxElev: Math.round(w.maxElevation) });
const landEl = [] as number[]; for (let i = 0; i < n; i++) if (w.water[i] === 0) landEl.push(w.elevation[i]);
landEl.sort((a, b) => a - b);
console.log('elev pct 10/50/90/99:', [0.1, 0.5, 0.9, 0.99].map(q => Math.round(landEl[Math.floor(q * landEl.length)])));
const pr = [] as number[]; for (let i = 0; i < n; i++) if (w.water[i] === 0) pr.push(w.precipitation[i]); pr.sort((a,b)=>a-b);
console.log('precip pct 10/50/90:', [0.1, 0.5, 0.9].map(q => Math.round(pr[Math.floor(q * pr.length)])));
console.log([...counts].sort((a,b)=>b[1]-a[1]).map(([b, c]) => `${BIOMES[b].name}:${c}`).join(' '));
shapeStats();

// 文明:3000 年里的国家与战争
const t2 = performance.now();
const civ = simulation.run({ world: w });
const s = warStats(civ);
const ps = politicsStats(civ);
const ds = dynastyStats(civ);
console.log(`文明 ${Math.round(performance.now() - t2)}ms:州 ${civ.regions.count},先后立国 ${civ.polities.length} 个(含分裂 / 复国出来的)`);
console.log(
  `分裂 ${ps.splits} 次 · 合并 ${ps.merges} 次 · 复国 ${ps.restorations} 次 · 主动迁都 ${ps.capitalMoves} 次 · 分出来不到百年就亡的 ${ps.shortLived} 国`,
);
console.log(
  `战争 ${s.wars} 场 · 攻占 ${s.conquests} 次 · 灭亡 ${s.falls} 国 · 迁都 ${s.capitalMoves} 次 · 结束时在世 ${s.alive} 国\n` +
    `部落地带占有人州 ${(s.tribalShare * 100).toFixed(1)}% · 50 年内易手 3 次以上的州 ${s.flippy} 个 · 飞地州 ${s.exclaves} 个(${(s.exclaveShare * 100).toFixed(1)}%)`,
);
// 王朝更替:东方改朝换代(换国号)、西幻王室更迭(国名不变)分开数;每国几朝;已经结束的朝代平均立了多少年
const perPolity = [...ds.perPolity]
  .map(([id, n]) => `${polityName(civ.polities[id], civ.polities[id].ended ?? civ.endYear)} ${n} 朝`)
  .join('、');
console.log(
  `王朝更替:东方改朝换代 ${ds.eastern} 次(一朝平均 ${Math.round(ds.meanEastern)} 年)· 西幻王室更迭 ${ds.western} 次(一朝平均 ${Math.round(ds.meanWestern)} 年)· 新朝定都根据地 ${ds.moved} 次\n` +
    `  换过的国家:${perPolity || '无'}`,
);
const as = assimStats(civ);
console.log(
  `同化 ${as.assimilated} 州次(统治民族反被同化 ${as.reverse})· 迁徙 ${as.migrations} 波、迁入 ${as.migrated} 州(随征服而来 ${as.settlerWaves} 波)· ` +
    `改换过民族的州 ${as.changed} 个(占有人州 ${(as.changedShare * 100).toFixed(1)}%)\n` +
    `民族 ${civ.cultures.length} 个,消亡 ${as.vanished} 个,结束时还在 ${as.alive} 个 · 各国统治民族占本国州数平均 ${(as.rulingShare * 100).toFixed(1)}% · ` +
    `50 年内民族变了 2 次以上的州 ${as.flippy} 个`,
);
// 城市兴衰:洗劫、毁城(按被毁前的级别)、重建、结束时的遗址、旧都衰落(失去国都之位时的人口 → 记"渐衰"那年的人口)
const cs = cityStats(civ);
const rank = cs.ruinsByRank;
console.log(
  `城市兴衰:洗劫 ${cs.sacks} 次 · 毁城 ${cs.ruins} 座(村 ${rank[0]} · 镇 ${rank[1]} · 城 ${rank[2]} · 大城 ${rank[3]};一场战争最多毁 ${cs.maxRuinsPerWar} 座)· ` +
    `重建 ${cs.rebuilds} 座 · 结束时遗址 ${cs.ruinsAtEnd} 处 · 旧都渐衰 ${cs.declines} 次`,
);
for (const d of cs.declineExamples.slice(0, 3)) {
  const k = (v: number) => (v / 10).toFixed(1);
  console.log(`  旧都 ${civ.settlements[d.settlement].name}:第 ${Math.floor(d.year)} 年失去国都之位时 ${k(d.before)} 万人 → 第 ${Math.floor(d.at)} 年 ${k(d.after)} 万人`);
}
const chron = buildChronicle(civ);
console.log(`编年史 ${chron.length} 条,大事 ${filterChronicle(chron, { major: true }).length} 条`);
console.log(`生成 + 文明共 ${Math.round(performance.now() - t0)}ms`);

/** 陆地按面积的比例、陆块大小(长尾)、海冰按纬度、河流去向、两极 */
function shapeStats() {
  const { mesh, water, seaIce, elevation } = w;
  const geo = geometryOf(mesh);
  const area = geo.cellAreas();
  const lat = (i: number) => geo.latitude(i);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  let landA = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += area[i];
    if (water[i] !== 1) landA += area[i];
  }
  // 陆块:连在一起的陆地(含湖)
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const polar: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (water[i] === 1 || comp[i] >= 0) continue;
    const id = sizes.length;
    const q = [i];
    comp[i] = id;
    let a = 0;
    let pol = false;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      a += area[c];
      if (Math.abs(lat(c)) > 80) pol = true;
      for (let k = mesh.adjStart[c]; k < mesh.adjStart[c + 1]; k++) {
        const j = mesh.adj[k];
        if (water[j] !== 1 && comp[j] < 0) {
          comp[j] = id;
          q.push(j);
        }
      }
    }
    sizes.push(a);
    polar.push(pol);
  }
  const order = sizes.map((_, k) => k).sort((a, b) => sizes[b] - sizes[a]);
  const tiny = sizes.filter((a) => a < landA * 0.001).length;
  const mid = sizes.filter((a) => a >= landA * 0.001 && a < landA * 0.02).length;
  console.log(
    `陆地(按面积)${pct(landA / total)} · 陆块 ${sizes.length} 块(大于陆地 2% 的 ${sizes.length - mid - tiny} 块、0.1–2% 的 ${mid} 块、更小的岛 ${tiny} 块)\n` +
      `  最大的几块占陆地:${order.slice(0, 6).map((k) => pct(sizes[k] / landA) + (polar[k] ? '(极地)' : '')).join(' ')}`,
  );
  // 海冰按纬度带:冰(> 0.5)占这一带海面的比例
  const bands = [0, 30, 45, 55, 65, 75, 85, 90];
  const row: string[] = [];
  let lowIce = 90;
  for (let b = 0; b + 1 < bands.length; b++) {
    let sea = 0;
    let ice = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(lat(i));
      if (water[i] !== 1 || a < bands[b] || a >= bands[b + 1] + (b + 2 === bands.length ? 1 : 0)) continue;
      sea += area[i];
      if (seaIce[i] > 0.5) ice += area[i];
    }
    row.push(`${bands[b]}–${bands[b + 1]}° ${sea ? pct(ice / sea) : '—'}`);
  }
  for (let i = 0; i < n; i++) if (water[i] === 1 && seaIce[i] > 0.5) lowIce = Math.min(lowIce, Math.abs(lat(i)));
  console.log(`海冰(> 0.5)占海面:${row.join(' · ')};最低到纬度 ${lowIce.toFixed(1)}°`);
  // 河流去向:入海 / 入湖 / 汇入别的河
  let toSea = 0, toLake = 0, join = 0, other = 0;
  for (const r of w.rivers) {
    const c = r.cells![r.cells!.length - 1];
    if (water[c] === 1) toSea++;
    else if (water[c] === 2) toLake++;
    else if (w.flux[c] >= w.riverThreshold) join++;
    else other++;
  }
  console.log(`河流 ${w.rivers.length} 条:入海 ${toSea} · 入湖 ${toLake} · 汇入干流 ${join} · 其他 ${other}`);
  // 两极:极点处是什么,|纬度| > 70° 里陆地、冰原的比例
  for (const [name, sgn] of [['北极', 1], ['南极', -1]] as const) {
    const c = geo.nearest(1024, sgn > 0 ? 0 : 1024, 0);
    let a70 = 0, l70 = 0, ice70 = 0, sea70 = 0, sice70 = 0;
    for (let i = 0; i < n; i++) {
      if (lat(i) * sgn <= 70) continue;
      a70 += area[i];
      if (water[i] !== 1) {
        l70 += area[i];
        if (w.biome[i] === Biome.Ice) ice70 += area[i];
      } else {
        sea70 += area[i];
        if (seaIce[i] > 0.5) sice70 += area[i];
      }
    }
    console.log(
      `${name}:极点是${BIOMES[w.biome[c]].name}(海拔 ${Math.round(elevation[c])} 米,${w.temperature[c].toFixed(0)}°C)· ` +
        `纬度 70° 以上陆地 ${pct(l70 / a70)}(其中冰原 ${l70 ? pct(ice70 / l70) : '—'})· 海面结冰 ${sea70 ? pct(sice70 / sea70) : '—'}`,
    );
  }
}
