/**
 * 打印 AI 释名 / 起名的完整提示词(调提示词、贴 PR 用):npx tsx scripts/ai-names-demo.ts [种子]
 * 默认种子 7:挑一个东方国家(改朝换代过的优先)、一座西幻城、一条河,各打印释名、起名两份提示词。不联网。
 */
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { simulation } from '../src/simulation/simulation';
import { rasterize } from '../src/gen/raster';
import { explainRequest, nameMaterial, styleGuide, suggestRequest, type NameTarget } from '../src/ai/prompts/names';
import type { AiRequest } from '../src/ai/types';

const seed = Number(process.argv[2] ?? 7);
const world = generateWorld({ ...DEFAULT_PARAMS, seed });
const civ = simulation.run({ world });
const raster = rasterize(world, 1);

const east = civ.polities
  .filter((p) => p.eastern)
  .sort((a, b) => (b.dynasties?.length ?? 0) - (a.dynasties?.length ?? 0) || (b.titles?.length ?? 0) - (a.titles?.length ?? 0))[0];
const westCity = civ.settlements
  .filter((s) => styleGuide(civ.cultures[s.culture]?.style)?.family === 'western' && s.capitalSpans?.length)
  .sort((a, b) => a.founded - b.founded)[0];
const river = civ.places.map((p, i) => ({ p, i })).filter((x) => x.p.kind === 'river').sort((a, b) => b.p.rank - a.p.rank)[0];

const targets: [string, NameTarget | null][] = [
  ['东方国家', east ? { kind: 'polity', id: east.id } : null],
  ['西幻城', westCity ? { kind: 'settlement', id: westCity.id } : null],
  ['河', river ? { kind: 'place', id: river.i } : null],
];

const show = (req: AiRequest) => {
  console.log(`feature=${req.feature} title=${req.title} temperature=${req.temperature} maxTokens=${req.maxTokens}${req.json ? ' json' : ''}`);
  for (const m of req.messages) console.log(`--- ${m.role} ---\n${m.content}`);
};

for (const [label, t] of targets) {
  if (!t) {
    console.log(`\n######## ${label}:这个世界里没有`);
    continue;
  }
  const m = nameMaterial(civ, t, raster)!;
  console.log(`\n######## ${label}:${m.info.shown}(${m.info.key})\n\n==== 释名 ====`);
  show(explainRequest(m));
  console.log('\n==== 起名 ====');
  show(suggestRequest(m, label === '河' ? '听起来清澈一点' : undefined));
}
