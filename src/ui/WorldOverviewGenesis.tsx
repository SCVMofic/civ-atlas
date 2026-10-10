/**
 * 世界概览的"世界设定"页:这个世界创建时定下的根 —— 种子、六项世界参数、改过的地形、地名风格,都只能看,不能再改
 * (一改三千年的历史就要整个重来)。想换个样子:"以它为底稿新建…"(回到新建这一步,设定照原样带过去,存成另一个世界)。
 * 右栏还有"回放世界形成"。
 *
 * 世界参数的滑条(SLIDERS、ParamSlider)在这里定义,新建世界(studio/Studio.tsx)用。
 */
import { useEffect, useState } from 'react';
import type { WorldParams } from '../gen/world';
import type { TerrainKind } from '../gen/edits';
import { useEdits } from './editsStore';
import { currentWorld, useSavesVersion } from './saveStore';
import { Icon } from './icons';
import { genSeconds } from './genSpeed';
import { mixSummary } from './nameMix';

interface Slider {
  key: keyof WorldParams;
  name: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  hint: string;
  /** 拖滑条时数字后面再加一句(只在新建世界的滑条上;世界设定页只写数字) */
  more?: (v: number) => string | null;
}

export const SLIDERS: Slider[] = [
  { key: 'landFraction', name: '陆地比例', min: 0.12, max: 0.6, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, hint: '陆地占整个星球的比例' },
  { key: 'plates', name: '板块数量', min: 8, max: 60, step: 1, fmt: (v) => `${v}`, hint: '板块越多,陆地越破碎、岛屿和山脉越多(板块有大有小)' },
  { key: 'mountains', name: '造山强度', min: 0.2, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, hint: '板块碰撞隆起的力度' },
  { key: 'temperature', name: '气温', min: -12, max: 12, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${v}°C`, hint: '整体偏冷(冰河期)还是偏暖' },
  { key: 'rainfall', name: '降水', min: 0.4, max: 1.8, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`, hint: '整体偏干还是偏湿' },
  {
    key: 'cells',
    name: '精细度',
    min: 12000,
    max: 200000,
    step: 2000,
    fmt: (v) => `${Math.round(v / 1000)}k 地块`,
    hint: '越精细越慢',
    more: (v) => {
      const sec = genSeconds(v);
      return sec === null ? null : `约 ${sec} 秒`;
    },
  },
];

/** 世界参数的一行简写(卡片里"世界参数"那一行右边) */
export function paramsSide(p: WorldParams): string {
  return `陆地 ${Math.round(p.landFraction * 100)}%，${p.plates} 个板块`;
}

const KIND_NAME: Record<TerrainKind, string> = { volcano: '火山', range: '山脉', lake: '湖', raise: '抬起陆地', sink: '沉成海', river: '河' };

/**
 * 改过的地形:"2 处：火山 1、山脉 1";画过草图的和编辑地形里一个说法:"画了 12 笔：草图 11 笔、河 1"
 * (一笔没涂、没涂的地方都是海:"都是海");没改 = "没有"
 */
export function terrainBrief(ops: readonly { kind: TerrainKind }[], sketch?: { rest: string; strokes: readonly unknown[] }): string {
  const n = new Map<TerrainKind, number>();
  for (const o of ops) n.set(o.kind, (n.get(o.kind) ?? 0) + 1);
  const parts = [...n].map(([k, c]) => `${KIND_NAME[k]} ${c}`);
  if (!sketch) return ops.length ? `${ops.length} 处：${parts.join('、')}` : '没有';
  const k = sketch.strokes.length;
  if (!k && !ops.length) return '都是海';
  return `画了 ${k + ops.length} 笔：${[...(k ? [`草图 ${k} 笔`] : []), ...parts].join('、')}`;
}

/** 一项世界参数的滑条:拖动时只改数字,松手(或键盘改完)才算数 */
export function ParamSlider({ s, value, onCommit, disabled }: { s: Slider; value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const pct = ((v - s.min) / (s.max - s.min)) * 100;
  const more = s.more?.(v);
  return (
    <label className="param-slider" title={s.hint} data-param={s.key}>
      <span className="param-slider-row">
        <span>{s.name}</span>
        <b>{more ? `${s.fmt(v)}，${more}` : s.fmt(v)}</b>
      </span>
      <input
        type="range"
        min={s.min}
        max={s.max}
        step={s.step}
        value={v}
        disabled={disabled}
        style={{ '--fill': `${pct}%` } as React.CSSProperties}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => v !== value && onCommit(v)}
        onKeyUp={() => v !== value && onCommit(v)}
      />
    </label>
  );
}

export interface SettingsProps {
  params: WorldParams;
  /** 回放世界形成:能不能点、正在放 */
  replay: { on: boolean; ready: boolean };
  /** 世界还在生成 */
  generating: boolean;
  onReplay: () => void;
  /** 以它为底稿新建 */
  onDraftFrom: () => void;
}

export function SettingsPage(p: SettingsProps) {
  useSavesVersion();
  const edits = useEdits();
  const title = currentWorld()?.title;
  const { params } = p;
  return (
    <div className="ov-settings">
      <section className="ov-sec">
        <h3>
          创建时定下的
          <small>
            <Icon name="lock" size={14} />
            不能再改
          </small>
        </h3>
        <div className="ov-kv">
          <div className="ov-kv-row" data-param="seed">
            <span>种子</span>
            <b>{params.seed}</b>
          </div>
          {SLIDERS.map((s) => (
            <div key={s.key} className="ov-kv-row" data-param={s.key}>
              <span>{s.name}</span>
              <b>{s.fmt(params[s.key])}</b>
            </div>
          ))}
          <div className="ov-kv-row" data-param="terrain">
            <span>改过的地形</span>
            <b>{terrainBrief(edits.terrain, edits.sketch)}</b>
          </div>
          <div className="ov-kv-row" data-param="name-mix">
            <span>地名风格</span>
            <b>{mixSummary(edits.nameMix)}</b>
          </div>
        </div>
      </section>
      <section className="ov-sec">
        <h3>想换个样子</h3>
        <p className="ov-txt">
          种子、参数和地形一变，三千年的历史就要整个重来。想试试别的样子，可以以{title || '它'}为底稿另建一个世界：设定全部带过去，改过的名字和干预也跟过去，
          {title || '原来的世界'}本身不变。
        </p>
        <button className="ov-btn ov-primary ov-ico-btn" data-act="draft-from" disabled={p.generating} onClick={p.onDraftFrom}>
          <Icon name="copy" size={16} />
          以它为底稿新建…
        </button>
        <h3 className="ov-gap">这颗星球是怎么来的</h3>
        <p className="ov-txt dim">从板块漂移到流水侵蚀，几秒钟看完这颗星球长成现在的样子，接着放三千年的历史。</p>
        <button className="ov-btn ov-ico-btn replay" data-act="replay" disabled={p.generating || p.replay.on} onClick={p.onReplay}>
          <Icon name="replay" size={16} />
          {p.replay.on ? (p.replay.ready ? '正在回放' : '正在准备回放') : '回放世界形成'}
        </button>
      </section>
    </div>
  );
}
