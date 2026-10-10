/**
 * 浮在地图上的按钮(宽屏的主体界面在左边的侧栏里,见 Sidebar.tsx):
 *
 *   右上 MapBar       图层分段按钮(政区 / 民族 / 信仰 / 地形 / 实景 / 更多图层)、导出、编年史、助手;写史书时最前面是写作进度
 *                     新建世界这一步还没有历史:只有地形 / 实景 / 高程 / 更多图层、助手(没有政区、民族、信仰,不放导出、编年史)
 *                     「助手」开关右边的助手面板(Assistant.tsx),开着时按钮是按下去的样子
 *   右下 MapControls  「标记」(点了在地图上放作者标记)、"地球 / 平面"切换、放大、缩小(触屏不放 + −,窄屏整个不放)
 *   窄屏(手机):
 *   右上 PhoneButtons 竖排的毛玻璃按钮:图层与投影(弹层从底部升起)、放标记、地球 / 平面、助手;写史书时进度条在它们左边。
 *                     世界名、搜索、存档、成书都在底部的世界卡片里(PhoneSheet.tsx)
 *   底部 FirstHint    第一次打开时的一行操作提示,第一次拖动 / 缩放 / 点击之后不再出现(触屏换成"双指缩放"的说法)
 *   跟随鼠标 HoverCard 悬停小卡片(内容见 hoverInfo.ts)
 *   左上 OldSiteBadge 旧版网站(oldSite.ts)一直挂着的「旧版 10 月 11 日更新以前」和「到最新版」;「我的世界」页顶上也放一个
 * 地图上的文字按钮不加底、只带描边(--halo),悬停出现浅灰底。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { Civ } from '../gen/civ/types';
import { currentWorld, useSavesVersion } from './saveStore';
import { bookProgress, bookTitleText, bookUnit, openBookReader, useBook } from './bookStore';
import type { HoverInfo } from './hoverInfo';
import { Icon } from './icons';
import { LayerPopover, type LayerPopoverProps } from './LayerPopover';
import { ExportMenu, type ExportMenuProps } from './ExportMenu';
import { openOverview } from './overviewStore';
import { layerDef, type MapLayer } from './mapLayers';
import { toggleAssistant, useAstOpen } from './astPanel';
import { togglePlacing } from './markStore';
import { useAssistant } from './assistantStore';
import { useAiOn } from '../ai/client';
import { OLD_SITE, OLD_UNTIL, latestUrl } from './oldSite';
import './book.css';

/** 右上图层分段按钮里直接列出的几个图层(其余的在"更多图层"里) */
export const SEG_LAYERS: MapLayer[] = ['political', 'cultures', 'faith', 'terrain', 'realistic'];
/** 新建世界时(还没有历史) */
export const DRAFT_SEG: MapLayer[] = ['terrain', 'realistic', 'elevation'];

/** 宽屏右上:写作进度、图层分段按钮、导出、编年史、助手(「使用 AI 功能」关着时没有助手和写作进度) */
export function MapBar({ layers, exp, civ, draft }: { layers: LayerPopoverProps; exp: ExportMenuProps; civ: Civ | null; draft?: boolean }) {
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const seg = draft ? DRAFT_SEG : SEG_LAYERS;
  const inSeg = seg.includes(layers.layer);
  return (
    <div className="map-bar" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      <BookChip />
      <div className="glass seg-bar" role="radiogroup" aria-label="图层">
        {seg.map((id, i) => (
          <button
            key={id}
            className={`seg-btn${layers.layer === id ? ' on' : ''}`}
            role="radio"
            aria-checked={layers.layer === id}
            data-layer={id}
            data-tip={layerDef(id).name}
            data-tip-key={`layer${i + 1}`}
            disabled={layers.disabled}
            onClick={() => layers.onLayer(id)}
          >
            {layerDef(id).name}
          </button>
        ))}
        <LayerPopover {...layers} trigger="seg" inSeg={inSeg} draft={draft} />
      </div>
      {!draft && <ExportMenu {...exp} icon={<Icon name="export" size={16} />} />}
      {!draft && (
        <button className="glass mb-btn" data-act="chronicle" disabled={!civ || !civ.viable} onClick={() => openOverview('chronicle', { polity: null })} title="按年份看全部大事">
          <Icon name="book" size={16} />
          <span className="mb-label">编年史</span>
        </button>
      )}
      <AssistantButton disabled={!civ} />
    </div>
  );
}

/** 「助手」:开 / 关右边的助手面板(世界第一次生成出来之前点不了) */
function AssistantButton({ disabled }: { disabled: boolean }) {
  const open = useAstOpen();
  if (!useAiOn()) return null;
  return (
    <button className={`glass mb-btn${open ? ' on' : ''}`} data-act="assistant" aria-pressed={open} disabled={disabled} onClick={toggleAssistant} title={open ? '收起助手' : '用一句话改世界、问问这个世界'}>
      <Icon name="bubble" size={16} />
      <span className="mb-label">助手</span>
    </button>
  );
}

/**
 * 右上的写作进度:"正在撰写《某某通史》"+ 80px 细进度条;分几次写的(长篇一章一次)写"正在写《某某通史》第 2 章(共 5 章)",
 * 手机上只有进度条和左边的"2/5 章"。写完"《某某通史》已完成 · 打开",点开读过就收起。
 * 助手开着、这本书是助手写的:进度在助手里那一行,这里不再重复
 */
function BookChip() {
  const { job } = useBook();
  const astOpen = useAstOpen();
  const ast = useAssistant();
  const on = useAiOn();
  useSavesVersion();
  if (!on || !job || !(job.status === 'writing' || (job.status === 'done' && !job.seen))) return null;
  if (astOpen && ast.turns.some((t) => t.steps.some((s) => s.book?.id === job.id))) return null;
  const name = bookTitleText(job.title, job.opts.scope, currentWorld()?.title);
  const writing = job.status === 'writing';
  const pct = Math.round(bookProgress(job) * 100);
  const unit = bookUnit(job.opts.style);
  const parts = writing && job.calls > 1;
  return (
    <button
      className={`book-chip${writing ? '' : ' done'}`}
      data-act="book-progress"
      onClick={() => openBookReader(writing ? null : job.key)}
      title={writing ? '看看写到哪了' : '打开阅读'}
    >
      <span className="book-chip-text">
        {!writing ? `${name}已完成 · 打开` : parts ? `正在写${name}第 ${job.call + 1} ${unit}（共 ${job.calls} ${unit}）` : `正在撰写${name}`}
      </span>
      {parts && <span className="book-chip-n">{`${job.call + 1}/${job.calls} ${unit}`}</span>}
      <span className="book-chip-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </span>
    </button>
  );
}

/** 手机右上:竖排的毛玻璃按钮(图层与投影、地球 / 平面、助手;「使用 AI 功能」关着时没有助手);写史书时进度条在它们左边 */
export function PhoneButtons({
  layers,
  globeOn,
  onToggleGlobe,
  marking,
}: {
  layers: LayerPopoverProps;
  globeOn: boolean;
  onToggleGlobe: () => void;
  /** 「标记」按钮:正在放标记 = true;不放这个按钮(还没有历史、新建时)= undefined */
  marking?: boolean;
}) {
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const astOpen = useAstOpen();
  const aiOn = useAiOn();
  return (
    <div className="phone-btns" onPointerDown={stop} onDoubleClick={stop} onClick={stop}>
      <BookChip />
      <div className="pb-group">
        <LayerPopover {...layers} trigger="icon" />
        {marking !== undefined && (
          <button
            className={`pb-btn${marking ? ' on' : ''}`}
            data-act="mark"
            aria-pressed={marking}
            disabled={layers.disabled}
            onClick={togglePlacing}
            aria-label="放标记"
            title="在地图上放一个标记"
          >
            <Icon name="pin" size={20} />
          </button>
        )}
        <button
          className={`pb-btn globe-toggle${globeOn ? ' on' : ''}`}
          data-act="globe"
          disabled={layers.disabled}
          onClick={onToggleGlobe}
          aria-label={globeOn ? '回到平面地图' : '显示成可以转动的地球仪'}
          title={globeOn ? '回到平面地图' : '显示成可以转动的地球仪'}
        >
          <Icon name={globeOn ? 'map' : 'globe'} size={19} />
        </button>
        {aiOn && (
          <button
            className={`pb-btn${astOpen ? ' on' : ''}`}
            data-act="assistant"
            aria-pressed={astOpen}
            disabled={layers.disabled}
            onClick={toggleAssistant}
            aria-label="助手"
            title="用一句话改世界、问问这个世界"
          >
            <Icon name="bubble" size={22} />
          </button>
        )}
      </div>
    </div>
  );
}

export function MapControls({
  globeOn,
  onToggleGlobe,
  onZoom,
  shifted,
  hidden,
  zoom = true,
  marking,
}: {
  globeOn: boolean;
  onToggleGlobe: () => void;
  onZoom: (factor: number) => void;
  shifted: boolean;
  hidden?: boolean;
  /** 放不放 + −(触屏用双指捏合,不放) */
  zoom?: boolean;
  /** 「标记」按钮:正在放标记 = true;不放这个按钮(还没有历史)= undefined */
  marking?: boolean;
}) {
  if (hidden) return null;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className={`map-controls${shifted ? ' shifted' : ''}`} onPointerDown={stop} onDoubleClick={stop}>
      {marking !== undefined && (
        <button className={`glass mc-btn mc-globe mc-mark${marking ? ' on' : ''}`} data-act="mark" aria-pressed={marking} onClick={togglePlacing} title="在地图上放一个标记(Esc 取消)">
          <Icon name="pin" size={18} />
          <span>标记</span>
        </button>
      )}
      <button className="glass mc-btn mc-globe globe-toggle" data-act="globe" onClick={onToggleGlobe} title={globeOn ? '回到平面地图' : '显示成可以转动的地球仪'}>
        <Icon name={globeOn ? 'map' : 'globe'} size={18} />
        <span>{globeOn ? '平面' : '地球'}</span>
      </button>
      {zoom && (
        <div className="glass mc-zooms">
          <button className="mc-btn mc-zoom" data-act="zoom-in" onClick={() => onZoom(1.5)} aria-label="放大" data-tip="放大" data-tip-key="zoomIn" data-tip-side="left">
            +
          </button>
          <button className="mc-btn mc-zoom" data-act="zoom-out" onClick={() => onZoom(1 / 1.5)} aria-label="缩小" data-tip="缩小" data-tip-key="zoomOut" data-tip-side="left">
            −
          </button>
        </div>
      )}
    </div>
  );
}

/** 第一次打开的操作提示是否已经看过(拖过、缩放过、点过);存在浏览器里,存不了就只管这一次 */
const HINT_KEY = 'wenming-ditu:hint-seen';
export function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}
export function markHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* 隐私模式:只管这一次 */
  }
}

export function FirstHint({ show, touch }: { show: boolean; touch?: boolean }) {
  if (!show) return null;
  return <div className="first-hint">{touch ? '拖动地图，双指缩放，点国家看它的历史' : '拖动地图，滚轮缩放，点一个国家看它的历史'}</div>;
}

/**
 * 悬停小卡片:跟着鼠标,靠右 / 靠下时翻到另一边;放在鼠标下面会压住底部的时间轴时也翻到上面。
 * place(作者标记用):'above' = x、y 是图钉尖,卡片放在图钉左上方,不压住写在图钉右边的名字;
 * 'left' = 放在鼠标左边(圈州时不挡住右边正在圈的地方)。放不下再照常放
 */
export function HoverCard({ info, x, y, place }: { info: HoverInfo; x: number; y: number; place?: 'above' | 'left' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== size.w || h !== size.h) setSize({ w, h });
  });
  const vw = typeof window === 'undefined' ? 1e4 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 1e4 : window.innerHeight;
  if (place === 'above' && x - 14 - size.w >= 8 && y - 34 - size.h >= 8) {
    return (
      <div ref={ref} className="hover hover-card" style={{ left: x - 14 - size.w, top: y - 34 - size.h }} role="tooltip">
        <HoverLines info={info} />
      </div>
    );
  }
  const left = place === 'left' && x - 14 - size.w >= 8 ? x - 14 - size.w : x + 16 + size.w > vw - 8 ? x - 12 - size.w : x + 16;
  let top = y + 14 + size.h > vh - 8 ? y - 10 - size.h : y + 14;
  const bar = ref.current?.closest('.app')?.querySelector('.bottom-row .timebar')?.getBoundingClientRect();
  if (bar && bar.height && top > y && y < bar.top && top + size.h > bar.top - 4 && left < bar.right && left + size.w > bar.left) top = y - 10 - size.h;
  return (
    <div ref={ref} className="hover hover-card" style={{ left, top }} role="tooltip">
      <HoverLines info={info} />
    </div>
  );
}

function HoverLines({ info }: { info: HoverInfo }) {
  return (
    <>
      <div className="hc-line">
        {info.color && <i className="hc-sw" style={{ background: info.color }} />}
        <span className="hc-name">{info.name}</span>
        {info.sub && <span className="hc-sub">{info.sub}</span>}
      </div>
      {info.extra && <div className="hc-extra">{info.extra}</div>}
    </>
  );
}

/** 旧版网站:地图左上(和「我的世界」页顶上)一直挂着的标记,写明是旧版、哪天以前的,带回最新版的链接;最新版不放 */
export function OldSiteBadge() {
  if (OLD_SITE === null) return null;
  return (
    <div className="glass old-badge" data-testid="old-site">
      <Icon name="history" size={16} />
      <b>旧版</b>
      {OLD_UNTIL && <span className="old-badge-when">{OLD_UNTIL}更新以前</span>}
      <a className="old-badge-go" href={latestUrl().href} data-act="old-latest">
        到最新版
      </a>
    </div>
  );
}
