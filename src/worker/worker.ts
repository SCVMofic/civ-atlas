/// <reference lib="webworker" />
/**
 * 后台线程:生成世界 + 文明骨架 + 铺像素 + 回放帧 + 带着干预重推文明,不卡界面。
 * 铺像素里最慢的沟和山脊分给几个帮手线程(gullyPool.ts;核多的电脑最多 3 个),和推文明同时算。
 * 主线程要生成新世界时如果本线程还在忙,会直接 terminate() 再开一个新的;
 * 回放帧、重推文明这些短活不打断,排在后面(消息按先后处理)。每个线程只需要把手头的活按顺序干完。
 *
 * 改地形(阶段 4):世界 = 参数 + 草图(sketch)+ 地形修改(terrain)。改了地形、画了草图就带着它们重新 generate(连同当时的干预一起推文明);
 * 回放帧、重推文明也带着它们,线程被重开过时按"参数 + 草图 + 地形修改"重新生成(同样的输入 = 同一个世界)。
 * 试推演(助手)和重推一样算,只是结果单独交回,主线程不换上它。
 *
 * 地形大事(gen/civ/upheaval.ts):推文明时带着作者的地形大事(upheavals),每件大事以后的世界(原来的地形修改 + 前几件大事的修改)
 * 照样从头生成,记在线程里(同样的输入不再生成);推完把各段的世界交给主线程(eras:地图、地名、河按时间轴换段)。
 * 各段的主图太大,不整张交:交完文明以后在后台逐段铺整张主图、和上一段比,只交回变了的那一块(gen/rasterPatch.ts 的补丁,
 * 主线程有了的不再交);后台的活排在消息后面,有新消息先处理消息。
 * "会怎么样"预览(upPreview):照"那一年的地形 + 这几笔"生成一遍,和那一年的地形、州逐地块比(previewUpheaval)。
 *
 * 消息约定在 worker/protocol.ts(和主线程共用的那一份):每条请求带 requestId,回执原样带回去。
 * 某条请求处理时抛异常:先回一条可序列化的 { type: 'error', requestId, error }(界面据此说明白出了什么事,
 * 而不是进度条停在那里),再按老样子把它抛到线程的 error 事件上。
 */
import { generateWorld, type World, type WorldParams } from '../gen/world';
import { finishGully, rasterizeDeferred, type Raster } from '../gen/raster';
import { GullyPool } from '../gullyPool';
import { buildHistoryFrames } from '../gen/history';
import { DEFAULT_CIV_PARAMS, civTransferables, planetTempo, type Civ, type Regions } from '../gen/civ';
import { simulation } from '../simulation/simulation';
import type { Intervention, TerrainOp, Upheaval } from '../gen/edits';
import { sketchGrid, type SketchEdit } from '../gen/sketch';
import { mergeUpheavals, previewUpheaval, type UpheavalStep } from '../gen/civ/upheaval';
import { computeHabitat } from '../gen/civ/habitat';
import { buildRegions, reshapeRegions } from '../gen/civ/regions';
import { diffRaster, patchTransferables } from '../gen/rasterPatch';
import type { TempoNote, EraWorld, CivInput, WorkerRequest, WorkerResponse } from './protocol';
import { serializeError } from './protocol';

/** 上一个生成的世界(含回放快照),回放时直接用 */
let last: { key: string; world: World } | null = null;
const keyOf = (p: WorldParams, terrain?: readonly TerrainOp[], sketch?: SketchEdit) =>
  JSON.stringify([Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)), terrain ?? [], sketch ?? null]);

const post = (m: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(m, { transfer });

/**
 * 各颗星球(参数 + 草图,没改地形)的扩张节拍(gen/civ 的 planetTempo;null = 长不出文明):改过地形的世界推文明时要用。
 * 生成没改过地形的世界时顺手记下(线程不改 pace,civ.spreadYears 就是节拍),新建时先看原样再改地形就不用多生成一遍
 */
const tempos = new Map<string, number | null>();
const TEMPO_KEEP = 32;
function rememberTempo(params: WorldParams, sketch: SketchEdit | undefined, tempo: number | null) {
  const key = keyOf(params, undefined, sketch);
  tempos.delete(key);
  tempos.set(key, tempo);
  if (tempos.size > TEMPO_KEEP) tempos.delete(tempos.keys().next().value!);
}
/** 主线程带回来的节拍:星球对得上才记 */
function takeTempo(params: WorldParams, sketch: SketchEdit | undefined, note?: TempoNote) {
  if (note && note.key === keyOf(params, undefined, sketch) && !tempos.has(note.key)) rememberTempo(params, sketch, note.tempo);
}
/** 回报给主线程的节拍(手里没有 = 不给) */
function noteOf(params: WorldParams, sketch: SketchEdit | undefined): TempoNote | undefined {
  const key = keyOf(params, undefined, sketch);
  const tempo = tempos.get(key);
  return tempo === undefined ? undefined : { key, tempo };
}
/** 推文明时带的节拍:没改地形 = 不用(按世界自己标定);改过 = 这颗星球(参数 + 草图)的节拍,手里没有就现算 */
function tempoOf(params: WorldParams, terrain: TerrainOp[] | undefined, sketch: SketchEdit | undefined): number | null | undefined {
  if (!terrain?.length) return undefined;
  const key = keyOf(params, undefined, sketch);
  if (!tempos.has(key)) rememberTempo(params, sketch, planetTempo(params, undefined, sketchGrid(sketch)) ?? null);
  return tempos.get(key);
}

/** 这组参数(+ 草图 + 地形修改)的世界:手里有就用,没有(线程被重开过)就重新生成(同样的输入 = 同一个世界) */
function worldOf(params: WorldParams, terrain?: TerrainOp[], sketch?: SketchEdit): World {
  const key = keyOf(params, terrain, sketch);
  if (!last || last.key !== key) last = { key, world: generateWorld(params, undefined, terrain, sketchGrid(sketch)) };
  return last.world;
}

// ---------------------------------------------------------------------------
// 地形大事:各段的世界、州(同样的输入不再算)

/** 地形大事以后的世界、预览生成的世界(不带回放快照);最多记 WORLD_KEEP 个,先丢最久没用的 */
const WORLD_KEEP = 8;
const worlds = new Map<string, World>();
function cachedWorld(params: WorldParams, ops: readonly TerrainOp[], sketch: SketchEdit | undefined): { key: string; world: World } {
  const key = keyOf(params, ops, sketch);
  let w = worlds.get(key);
  if (w) worlds.delete(key);
  else {
    w = generateWorld(params, undefined, ops, sketchGrid(sketch));
    w.history = [];
  }
  worlds.set(key, w);
  if (worlds.size > WORLD_KEEP) worlds.delete(worlds.keys().next().value!);
  return { key, world: w };
}

/** 推演里的一步,外加它在线程里的键、套上它以后的全部地形修改 */
type Step = UpheavalStep & { key: string; all: TerrainOp[] };

/** 作者的地形大事 → 推演用的几步(gen/civ/upheaval.ts 的 upheavalSteps,世界按键记着) */
function stepsOf(params: WorldParams, terrain: readonly TerrainOp[] | undefined, sketch: SketchEdit | undefined, list: readonly Upheaval[] | undefined, onStep?: (k: number, n: number) => void): Step[] {
  if (!list?.length) return [];
  const merged = mergeUpheavals(list);
  let all: TerrainOp[] = [...(terrain ?? [])];
  return merged.map((m, k) => {
    onStep?.(k, merged.length);
    all = [...all, ...m.ops];
    const { key, world } = cachedWorld(params, all, sketch);
    return { ...m, key, all, world };
  });
}

/** 推文明时带的地形大事(没有 = 不带,和不加这一项逐字节一样) */
const upOpt = (steps: Step[]) => (steps.length ? { upheavals: steps } : {});

/** 各段的世界交给主线程:不带网格、回放快照 */
function eraWorlds(steps: Step[]): EraWorld[] | undefined {
  if (!steps.length) return undefined;
  return steps.map((s) => {
    const { mesh: _m, history: _h, ...rest } = s.world;
    void _m;
    void _h;
    return { key: s.key, world: { ...rest, history: [] } as unknown as World };
  });
}

/** 州的划分(按一路过来的几段世界的键记着:大事以后的沿用上一段的(reshapeRegions),同样的地形分几步走到的划分不一样) */
const REGION_KEEP = 8;
const regionsMemo = new Map<string, Regions>();
const REGION_AREA = DEFAULT_CIV_PARAMS.regionArea;
function remember(key: string, r: Regions): Regions {
  regionsMemo.delete(key);
  regionsMemo.set(key, r);
  if (regionsMemo.size > REGION_KEEP) regionsMemo.delete(regionsMemo.keys().next().value!);
  return r;
}
/** 第 year 年的地形和州(upheavalBase:同一年已有的大事地形算在内、州不算),和那时的全部地形修改 */
function baseAt(params: WorldParams, terrain: TerrainOp[] | undefined, sketch: SketchEdit | undefined, steps: Step[], year: number): { world: World; regions: Regions; ops: TerrainOp[] } {
  const k0 = keyOf(params, terrain, sketch);
  let w = worldOf(params, terrain, sketch);
  let r = regionsMemo.get(k0) ?? remember(k0, buildRegions(w, computeHabitat(w), { regionArea: REGION_AREA }));
  let ops: TerrainOp[] = [...(terrain ?? [])];
  let chain = k0;
  for (const s of steps) {
    if (s.year > year) break;
    w = s.world;
    ops = s.all;
    if (s.year === year) break;
    const prev = r;
    chain = `${chain}>${s.key}`;
    r = regionsMemo.get(chain) ?? remember(chain, reshapeRegions(w, computeHabitat(w), prev, { regionArea: REGION_AREA }));
  }
  return { world: w, regions: r, ops };
}

// ---------------------------------------------------------------------------
// 各段的主图补丁(后台慢慢铺)

/** 最近铺好的两张整图(下一段要和它比) */
const rasters = new Map<string, Raster>();
async function rasterOfWorld(key: string, world: () => World): Promise<Raster> {
  const r = rasters.get(key);
  if (r) return r;
  await pool.up;
  const { raster, job } = rasterizeDeferred(world(), 1);
  finishGully(raster, job, await pool.heights(job));
  rasters.set(key, raster);
  while (rasters.size > 2) rasters.delete(rasters.keys().next().value!);
  return raster;
}

/** 推完文明:主线程手里没有的各段补丁排进后台(之前排着、现在用不上的作废) */
function queuePatches(requestId: string, id: number, m: CivInput, steps: Step[]) {
  bg.length = 0;
  const have = new Set(m.have ?? []);
  let prevKey = keyOf(m.params, m.terrain, m.sketch);
  let prevWorld: () => World = () => worldOf(m.params, m.terrain, m.sketch);
  for (const s of steps) {
    const pair = `${prevKey}>${s.key}`;
    const a = prevKey;
    const wa = prevWorld;
    prevKey = s.key;
    prevWorld = () => s.world;
    // 主线程手里有没有以它说的为准(它会丢掉用不着的旧补丁,丢了的再要就重新铺)
    if (have.has(pair)) continue;
    bg.push(async () => {
      const ra = await rasterOfWorld(a, wa);
      const rb = await rasterOfWorld(s.key, () => s.world);
      const patch = diffRaster(ra, rb);
      post({ type: 'eraPatch', requestId, id, key: s.key, prev: a, patch }, patch ? patchTransferables(patch) : []);
    });
  }
}

// ---------------------------------------------------------------------------
// 帮手线程(gullyPool.ts):整张主图的沟和山脊分给它们算,本线程同时推文明。开线程时就起好
const pool = new GullyPool();

/**
 * 消息按先后一件件处理(生成要等帮手线程,等的时候后面来的消息排着,不插进来);
 * 后台的活(各段主图)排在所有消息后面,每做完一件先看有没有新消息
 */
const fg: WorkerRequest[] = [];
const bg: (() => Promise<void>)[] = [];
let running = false;
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  fg.push(e.data);
  void pump();
};
async function pump() {
  if (running) return;
  running = true;
  try {
    while (fg.length || bg.length) {
      const m = fg.shift();
      try {
        if (m) await handle(m);
        else await bg.shift()!();
      } catch (err) {
        // 这条请求的活失败了:先回一条可序列化的错误(界面据此说明白,而不是进度条停在那里);
        // 后台的活(各段主图)没有对应的请求,和以前一样只报到线程的 error 事件上
        if (m) post({ type: 'error', requestId: m.requestId, id: m.id, error: serializeError(err) });
        // 和以前同步处理时一样,出错报到线程的 error 事件上
        setTimeout(() => {
          throw err;
        });
      }
      // 让一下:这期间到了的消息先排进来
      if (!fg.length && bg.length) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    running = false;
  }
}

async function handle(m: WorkerRequest): Promise<void> {
  const rid = m.requestId;
  if (m.type !== 'history' && m.type !== 'upPreview') takeTempo(m.params, m.sketch, m.tempo);
  if (m.type === 'generate') {
    // 换了世界:后台排着的补丁和记着的整图都作废
    bg.length = 0;
    rasters.clear();
    await pool.up;
    const t0 = performance.now();
    const world = generateWorld(m.params, (stage, pct) => post({ type: 'progress', requestId: rid, id: m.id, stage, pct }), m.terrain, sketchGrid(m.sketch));
    last = { key: keyOf(m.params, m.terrain, m.sketch), world };
    const steps = stepsOf(m.params, m.terrain, m.sketch, m.upheavals, (k, n) => post({ type: 'progress', requestId: rid, id: m.id, stage: '地形大事', pct: 0.9 + (0.03 * k) / n }));
    const genMs = performance.now() - t0;
    // 先铺像素(山坡上的沟和山脊交给帮手线程),同时推文明
    post({ type: 'progress', requestId: rid, id: m.id, stage: '铺展地图', pct: 0.93 });
    const { raster, job } = rasterizeDeferred(world, m.scale);
    const { heights, result: civ } = await pool.run(job, () => {
      // 文明骨架(宜居度、州……)只读 World,之后的文明步骤都在 gen/civ/index.ts 里接
      post({ type: 'progress', requestId: rid, id: m.id, stage: '文明', pct: 0.95 });
      const c = simulation.run({ world, params: { interventions: m.interventions?.length ? m.interventions : undefined, tempo: tempoOf(m.params, m.terrain, m.sketch), ...upOpt(steps) } });
      if (!m.terrain?.length) rememberTempo(m.params, m.sketch, c.spreadYears ?? null);
      return c;
    });
    finishGully(raster, job, heights);
    const transfer = [raster.elev, raster.temp, raster.precip, raster.water, raster.biome, raster.cell, raster.ice, raster.iceConc, raster.iceTone, raster.gully!].map((a) => a.buffer);
    transfer.push(...civTransferables(civ));
    // 回放快照体积大且主线程用不上,不随世界一起发送
    const { history: _history, ...rest } = world;
    void _history;
    const baseKey = keyOf(m.params, m.terrain, m.sketch);
    post({ type: 'done', requestId: rid, id: m.id, world: { ...rest, history: [] }, raster, civ, ms: performance.now() - t0, genMs, tempo: noteOf(m.params, m.sketch), eras: eraWorlds(steps), baseKey }, transfer);
    queuePatches(rid, m.id, m, steps);
  } else if (m.type === 'history') {
    const h = buildHistoryFrames(worldOf(m.params, m.terrain, m.sketch));
    post({ type: 'history', requestId: rid, id: m.id, ...h }, h.frames.map((f) => f.buffer));
  } else if (m.type === 'resim' || m.type === 'trial') {
    const t0 = performance.now();
    const world = worldOf(m.params, m.terrain, m.sketch);
    const steps = stepsOf(m.params, m.terrain, m.sketch, m.upheavals);
    const civ = simulation.run({ world, params: { interventions: m.interventions, tempo: tempoOf(m.params, m.terrain, m.sketch), ...upOpt(steps) } });
    const ms = performance.now() - t0;
    const tempo = noteOf(m.params, m.sketch);
    if (m.type === 'resim') {
      post({ type: 'civ', requestId: rid, id: m.id, seq: m.seq, civ, ms, tempo, eras: eraWorlds(steps), baseKey: keyOf(m.params, m.terrain, m.sketch) }, civTransferables(civ));
      queuePatches(rid, m.id, m, steps);
    } else post({ type: 'trial', requestId: rid, id: m.id, tid: m.tid, civ, ms, tempo }, civTransferables(civ));
  } else if (m.type === 'upPreview') {
    const t0 = performance.now();
    const steps = stepsOf(m.params, m.terrain, m.sketch, m.upheavals);
    const at = baseAt(m.params, m.terrain, m.sketch, steps, m.year);
    const w1 = cachedWorld(m.params, [...at.ops, ...m.ops], m.sketch).world;
    const preview = previewUpheaval(at.world, at.regions, w1, m.ops, REGION_AREA);
    const water = w1.water.slice();
    post({ type: 'upPreview', requestId: rid, id: m.id, pid: m.pid, preview, water, ms: performance.now() - t0 }, [water.buffer]);
  }
}
