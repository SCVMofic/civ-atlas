/**
 * "图层与投影"按钮(宽屏是右上分段按钮的最后一段"更多图层",手机是右上竖排的图层图标),点开弹层:
 *   图层:六张缩略图(政区、民族、信仰、地形、生态、实景)+ 一行小字按钮(高程、板块、气温、降水、洋流)
 *         + 一行叠加开关(地名、宜居度、州、城址、道路;CivPanel.tsx 的 CivToggles);
 *         选中"民族"时下面是紧凑的民族色块列表(CultureLegend),选中"信仰"时是信仰的(FaithLegend)
 *   投影:ProjectionSection(六种投影、中央经线滑条、经纬网)
 * 点图层就换(弹层收起);点叠加开关不收起;点外面(包括旁边的按钮)、Esc 收起。
 * 窄屏(手机):弹层是从底部升起的抽屉(右上 ✕ 收起)。
 *
 * 缩略图是当前世界真实画出来的小图:App 给 baseCanvas(画风键)取整张底图(画过的直接从缓存拿,没画过的画一张放进缓存),
 * 政区 / 民族 / 信仰再叠上文明底图,缩成小图存成 dataURL。当前图层的一张在世界出来后就做;其余的等弹层第一次打开时
 * 一张一张做(每张之间让出主线程),没做好的先显示占位。换世界全部作废;历史重推(干预、改地形)只作废政区、民族、信仰三张。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { World } from '../gen/world';
import type { Raster } from '../gen/raster';
import type { Civ } from '../gen/civ/types';
import { CIV_SHOW_OFF, drawCivOverlay } from '../render/civ/overlay';
import { MAP_LAYERS, layerDef, type MapLayer } from './mapLayers';
import { Icon } from './icons';
import { ProjectionSection, projectionName } from './ProjectionPanel';
import { useProjection } from './projection';
import { getCivTime } from './civView';
import { CivToggles, CultureLegend, FaithLegend } from './CivPanel';
import './overview.css';
import { noteDismiss } from './dismissClick';

/** 缩略图大小(显示时 88×44 左右,按两倍像素做) */
const TW = 192;
const TH = 96;

/** 画风键:手绘 / 写实 / data:某数据图层(和 App 的底图缓存同一套键) */
export function styleKey(id: MapLayer): string {
  const d = layerDef(id);
  return d.style === 'data' ? `data:${d.data}` : d.style;
}

export interface ThumbSource {
  data: { world: World; raster: Raster } | null;
  /** 生成出来的文明(不含改名:缩略图只画色块);有地形大事时是时间轴那一段的(州、宜居度和 data 的地形对得上) */
  civ: Civ | null;
  /** 取某画风的整张底图(等距圆柱,和 raster 一样大);取不到 = null */
  baseCanvas: (key: string) => HTMLCanvasElement | null;
}

/** 缩略图:当前图层的先做,其余的按需排队做 */
export function useLayerThumbs(src: ThumbSource, current: MapLayer) {
  const [thumbs, setThumbs] = useState<Partial<Record<MapLayer, string>>>({});
  const srcRef = useRef(src);
  srcRef.current = src;
  const queue = useRef<MapLayer[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const have = useRef<Partial<Record<MapLayer, string>>>({});
  have.current = thumbs;

  const make = (id: MapLayer): string | null => {
    const { data, civ, baseCanvas } = srcRef.current;
    if (!data) return null;
    const def = layerDef(id);
    const base = baseCanvas(styleKey(id));
    if (!base || !base.width) return null;
    const t = document.createElement('canvas');
    t.width = TW;
    t.height = TH;
    const ctx = t.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, TW, TH);
    const civOk = !!civ && civ.viable && civ.habitat.suitability.length === data.world.mesh.n;
    if ((def.polities || def.cultures || def.faiths) && civOk) {
      const { raster, world } = data;
      const cv = document.createElement('canvas');
      cv.width = raster.w;
      cv.height = raster.h;
      const cctx = cv.getContext('2d');
      if (cctx) {
        const y = Math.min(civ!.endYear, Math.max(0, getCivTime().year ?? civ!.endYear));
        drawCivOverlay(cctx, { world, raster, civ: civ!, style: def.style, year: y, show: { ...CIV_SHOW_OFF, polities: def.polities, cultures: def.cultures, faiths: def.faiths } });
        ctx.drawImage(cv, 0, 0, TW, TH);
      }
      cv.width = cv.height = 0;
    }
    const url = t.toDataURL('image/jpeg', 0.82);
    t.width = t.height = 0;
    return url;
  };

  const pump = useCallback(() => {
    if (timer.current !== undefined) return;
    const step = () => {
      timer.current = undefined;
      const id = queue.current.shift();
      if (!id) return;
      if (!have.current[id]) {
        const url = make(id);
        if (url) {
          have.current = { ...have.current, [id]: url };
          setThumbs(have.current);
        }
      }
      if (queue.current.length) timer.current = setTimeout(step, 30);
    };
    timer.current = setTimeout(step, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 缓存是哪个世界的。换了世界:排着的、做好的全部作废 */
  const haveFor = useRef(src.data);
  const reset = useCallback(() => {
    queue.current = [];
    have.current = {};
    haveFor.current = srcRef.current.data;
    setThumbs({});
  }, []);

  /** 把这几张排进队(已有的、已排着的跳过) */
  const request = useCallback(
    (ids: MapLayer[]) => {
      // 子组件的 effect 比下面换世界的 effect 先跑:这时缓存还是上一个世界的,先作废再排
      if (haveFor.current !== srcRef.current.data) reset();
      for (const id of ids) if (!have.current[id] && !queue.current.includes(id)) queue.current.push(id);
      pump();
    },
    [pump, reset],
  );

  // 换世界:全部作废(request 已经作废过就不再清,不然刚排上的又没了);文明重推:政区、民族、信仰作废
  const { data, civ } = src;
  useEffect(() => {
    if (haveFor.current !== data) reset();
  }, [data, reset]);
  const civSeen = useRef<Civ | null>(null);
  useEffect(() => {
    if (civSeen.current && civSeen.current !== civ) {
      const next = { ...have.current };
      delete next.political;
      delete next.cultures;
      delete next.faith;
      have.current = next;
      setThumbs(next);
    }
    civSeen.current = civ;
  }, [civ]);
  // 当前图层的缩略图(图层按钮上用):世界出来、画好以后过一会儿做
  useEffect(() => {
    if (!data || thumbs[current]) return;
    const t = setTimeout(() => request([current]), 700);
    return () => clearTimeout(t);
  }, [data, civ, current, thumbs, request]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return { thumbs, request };
}

export interface LayerPopoverProps {
  layer: MapLayer;
  /** 界面上的文明(套过改名;民族图例用) */
  civ?: Civ | null;
  onLayer: (id: MapLayer) => void;
  thumbs: Partial<Record<MapLayer, string>>;
  requestThumbs: (ids: MapLayer[]) => void;
  disabled?: boolean;
  /**
   * 按钮的样子:seg = 一段文字"更多图层"(宽屏右上的分段按钮最后一段;当前图层不在前几段里时写当前图层名);
   * icon = 只有一个图层图标(手机右上竖排的毛玻璃按钮)
   */
  trigger?: 'seg' | 'icon';
  /** trigger = seg 时:当前图层在不在前几段里(在 = 这一段不亮) */
  inSeg?: boolean;
  /** 新建世界这一步(还没有历史):不列政区、民族,不放国家 / 民族的叠加开关 */
  draft?: boolean;
}

/** 新建世界时列不出来的图层(要有历史) */
const HISTORY_LAYERS: MapLayer[] = ['political', 'cultures', 'faith'];

export function LayerPopover({ layer, civ = null, onLayer, thumbs, requestThumbs, disabled, trigger = 'icon', inSeg = true, draft = false }: LayerPopoverProps) {
  const [open, setOpen] = useState(false);
  const proj = useProjection();
  const rootRef = useRef<HTMLDivElement>(null);
  const cur = layerDef(layer);

  useEffect(() => {
    if (!open) return;
    requestThumbs(MAP_LAYERS.filter((l) => l.main).map((l) => l.id));
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      noteDismiss(e);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, requestThumbs]);

  const pick = (id: MapLayer) => {
    onLayer(id);
    setOpen(false);
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className={`lp ${trigger === 'seg' ? 'lp-seg' : 'lp-icon'}`} ref={rootRef} onPointerDown={stop} onDoubleClick={stop}>
      {trigger === 'seg' ? (
        <button
          className={`seg-btn lp-btn${open ? ' open' : ''}${inSeg ? '' : ' on'}`}
          data-act="layers"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title="全部图层、地图上显示什么、投影"
        >
          {inSeg ? '更多图层' : cur.name}
          <svg className="seg-caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <button
          className={`pb-btn lp-btn${open ? ' on' : ''}`}
          data-act="layers"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`图层与投影(现在是${cur.name}，${projectionName(proj)})`}
          title="图层与投影"
        >
          <Icon name="layers" size={19} />
        </button>
      )}
      {open && (
        <div className="lp-pop" role="dialog" aria-label="图层与投影">
          {/* 窄屏是底部抽屉:顶上一条拖动条的样子 + 关闭(宽屏不显示) */}
          <div className="lp-head">
            <span className="lp-grip" aria-hidden="true" />
            <button className="lp-close" data-act="layers-close" aria-label="关闭" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div className="lp-sec">图层</div>
          <div className="lp-layers" role="radiogroup" aria-label="图层">
            {MAP_LAYERS.filter((l) => l.main && !(draft && HISTORY_LAYERS.includes(l.id))).map((l) => (
              <button key={l.id} className={`lp-layer${layer === l.id ? ' on' : ''}`} role="radio" aria-checked={layer === l.id} data-layer={l.id} onClick={() => pick(l.id)}>
                <Thumb src={thumbs[l.id]} />
                <span>{l.name}</span>
              </button>
            ))}
          </div>
          <div className="lp-minor" role="radiogroup" aria-label="数据图层">
            {MAP_LAYERS.filter((l) => !l.main).map((l) => (
              <button key={l.id} className={`lp-mini${layer === l.id ? ' on' : ''}`} role="radio" aria-checked={layer === l.id} data-layer={l.id} onClick={() => pick(l.id)}>
                {l.name}
              </button>
            ))}
          </div>
          {!draft && (
            <div className="lp-overlays">
              <CivToggles />
              {layer === 'cultures' && <CultureLegend civ={civ} />}
              {layer === 'faith' && <FaithLegend civ={civ} />}
            </div>
          )}
          <ProjectionSection />
        </div>
      )}
    </div>
  );
}

function Thumb({ src }: { src?: string }) {
  return <span className={`lp-thumb${src ? '' : ' empty'}`} style={src ? { backgroundImage: `url(${src})` } : undefined} aria-hidden="true" />;
}
