/**
 * 新建世界的「地名风格」页:左边「名字」组里点「地名风格」进来,换掉左边(手机上是卡片里换页、卡片拉到最高),左上返回。
 *
 *   自动 / 自己配   默认自动(和以前一样,每个民族按住的地方挑);自己配 = 12 种语感每种配几份,按份数的比例分给各民族
 *   顶上的条        这颗星球上各种语感实际占了多少地方(按推演结束时各民族住的州数),中式在左、音译在右;改了份数跟着重新算
 *   每种一行        自动:写占比,没有的写「没有」;自己配:「− 份数 +」和折成的百分比,0 份写「不用」;最后一种有份数的减号是灰的
 *   快捷按钮        照自动(回到一开始:还是自动起名,份数按自动的比例折好)、全中式、全音译、中西各半
 *
 * 切到「自己配」但没动份数:不算改动,还是自动;点了加减或快捷按钮才按份数起名。只换名字,历史不变。
 * 连着点加减:份数马上变,停手一会儿(SETTLE_MS)才一起重新起名 —— 每点一下都重推一遍整段历史,点几下就要等好几遍。
 * 离开这一页、点「创建世界」时马上交上。
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Civ } from '../../gen/civ/types';
import { MIX_SHARE_MAX, type NameMix } from '../../gen/names/mix';
import { setNameMix, useEdits } from '../editsStore';
import { Icon } from '../icons';
import { MIX_PRESETS, MIX_STYLES, autoMix, easternPct, pctText, styleAreas, type MixStyle } from '../nameMix';

export interface NameMixPageProps {
  /** 左上返回的字(新建世界 / 以某世界为底稿新建) */
  backLabel: string;
  onBack: () => void;
  /** 这颗星球推演出来的文明(没套改名的);还没有 = null */
  civ: Civ | null;
  /** 正在重新生成(换了份数以后重新起名):条先淡一点 */
  busy: boolean;
  /** 世界还没生成好(换了种子、改了地形正在生成):先不能改份数 */
  ready: boolean;
  phone: boolean;
  /** 这一页把"马上交出还没交的份数"放在这里:点「创建世界」时先交上,确认框和创建都按最新的份数 */
  flush?: MutableRefObject<(() => void) | null>;
}

/** 连着点加减时,停手多久才重新起名(毫秒) */
const SETTLE_MS = 400;

export function NameMixPage(p: NameMixPageProps) {
  const edits = useEdits();
  const mix = edits.nameMix;
  const [customSeg, setCustomSeg] = useState(!!mix);
  // 点了加减、还没交给生成的份数(停手 SETTLE_MS 后交;离开这一页时马上交)
  const [draft, setDraft] = useState<NameMix | null>(null);
  const pending = useRef<{ mix: NameMix; timer: ReturnType<typeof setTimeout> } | null>(null);
  const commit = (next: NameMix | undefined) => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setDraft(null);
    setNameMix(next);
  };
  useEffect(
    () => () => {
      const left = pending.current;
      if (!left) return;
      clearTimeout(left.timer);
      setNameMix(left.mix);
    },
    [],
  );
  useEffect(() => {
    const ref = p.flush;
    if (!ref) return;
    ref.current = () => {
      if (pending.current) commit(pending.current.mix);
    };
    return () => {
      ref.current = null;
    };
  });
  const custom = customSeg || !!mix || !!draft;
  // 自己配时一行行显示的份数:正在点的、配过的,还没动就是照自动折好的
  const shares: NameMix = draft ?? mix ?? autoMix(p.civ);
  const total = MIX_STYLES.reduce((a, s) => a + (shares[s.id] ?? 0), 0);
  const used = MIX_STYLES.filter((s) => (shares[s.id] ?? 0) > 0).length;
  const areas = p.civ ? styleAreas(p.civ) : null;
  const actual = areas?.share ?? {};
  const eActual = easternPct(actual);

  const bump = (id: string, d: number) => {
    const n = Math.max(0, Math.min(MIX_SHARE_MAX, (shares[id] ?? 0) + d));
    const next: Record<string, number> = { ...shares, [id]: n };
    if (!n) delete next[id];
    if (!Object.keys(next).length) return;
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { mix: next, timer: setTimeout(() => commit(next), SETTLE_MS) };
    setDraft(next);
  };
  const pickSeg = (on: boolean) => {
    setCustomSeg(on);
    if (!on) commit(undefined);
  };

  const bar = MIX_STYLES.filter((s) => (actual[s.id] ?? 0) > 0);
  const famShares = (fam: MixStyle['family']) => MIX_STYLES.reduce((a, s) => (s.family === fam ? a + (shares[s.id] ?? 0) : a), 0);
  const ePlan = easternPct(shares);

  const row = (s: MixStyle) => {
    const n = shares[s.id] ?? 0;
    const has = custom ? n > 0 : (actual[s.id] ?? 0) > 0;
    const last = n > 0 && used <= 1;
    return (
      <div key={s.id} className={`sb-row static nm-row${has ? '' : ' zero'}`} data-style={s.id}>
        <i className="nm-dot" style={{ background: has ? s.color : 'transparent', boxShadow: `inset 0 0 0 1px ${s.color}` }} />
        <span className="sb-row-main">
          <b>{s.label}</b>
          <small>{s.examples}</small>
        </span>
        {custom ? (
          <>
            <span className={`nm-pct${n ? '' : ' none'}`}>{n ? pctText(n / total) : '不用'}</span>
            <span className="nm-step">
              <button className="nm-b" data-act="mix-less" aria-label={`${s.label}少一份`} disabled={!p.ready || !n || last} onClick={() => bump(s.id, -1)}>
                <Icon name="minus" size={14} />
              </button>
              <span className={`nm-n${n ? '' : ' zero'}`} aria-label={`${s.label} ${n} 份`}>
                {n}
              </span>
              <button className="nm-b" data-act="mix-more" aria-label={`${s.label}多一份`} disabled={!p.ready || n >= MIX_SHARE_MAX} onClick={() => bump(s.id, 1)}>
                <Icon name="plus" size={14} />
              </button>
            </span>
          </>
        ) : (
          <span className={`nm-pct${has ? '' : ' none'}`}>{has ? pctText(actual[s.id]) : '没有'}</span>
        )}
      </div>
    );
  };
  const section = (fam: MixStyle['family'], name: string) => {
    const pct = fam === 'eastern' ? ePlan : 100 - ePlan;
    const aPct = fam === 'eastern' ? eActual : 100 - eActual;
    return (
      <section className="sb-sec" data-family={fam}>
        <div className="sb-sec-head">
          <span>{name}</span>
          {custom ? (
            <small>
              {famShares(fam)} 份，<b>{pct}%</b>
            </small>
          ) : (
            areas && (
              <small>
                这颗星球上 <b>{aPct}%</b>
              </small>
            )
          )}
        </div>
        <div className="sb-group">{MIX_STYLES.filter((s) => s.family === fam).map(row)}</div>
      </section>
    );
  };

  return (
    <>
      <div className="st-top">
        <button className="nw-back" data-act="names-back" onClick={p.onBack}>
          <Icon name="back" size={18} />
          {p.backLabel}
        </button>
      </div>
      <div className="nw-title-row">
        <div className="nw-title">地名风格</div>
      </div>
      <div className="nw-intro">国名、城名、山河和民族的名字照它来起。只换名字，同一颗星球的历史不变。</div>
      <div className="nm-seg" role="radiogroup" aria-label="地名风格">
        <button role="radio" aria-checked={!custom} className={custom ? '' : 'on'} data-act="mix-auto" disabled={!p.ready} onClick={() => pickSeg(false)}>
          自动
        </button>
        <button role="radio" aria-checked={custom} className={custom ? 'on' : ''} data-act="mix-custom" disabled={!p.ready} onClick={() => pickSeg(true)}>
          自己配
        </button>
      </div>
      <div className={`nm-card${p.busy || draft ? ' busy' : ''}`}>
        <div className="nm-head">
          <span>这颗星球上</span>
          {areas && areas.peoples > 0 && (
            <span>
              <b>中式 {eActual}%</b>　<b>音译 {100 - eActual}%</b>
            </span>
          )}
        </div>
        <div className="nm-bar" aria-hidden="true">
          {bar.map((s) => (
            <i key={s.id} style={{ flex: Math.round(actual[s.id] * 1000) / 10, background: s.color }} />
          ))}
        </div>
        <div className="nm-note">
          {!areas || !areas.peoples
            ? '这颗星球还没有民族。'
            : custom
              ? `按各民族住的地方算。一个民族只用一种，这颗星球有 ${areas.peoples} 个民族，所以是大约凑到你配的比例。`
              : '各民族按住的地方（冷热、森林草原、靠海靠河）挑，相邻的错开。想改比例，点「自己配」。'}
        </div>
      </div>
      {custom && (
        <div className="nm-chips">
          <button data-act="mix-preset-auto" disabled={!p.ready} onClick={() => commit(undefined)}>
            照自动
          </button>
          {MIX_PRESETS.map((x) => (
            <button key={x.id} data-act={`mix-preset-${x.id}`} disabled={!p.ready} onClick={() => commit(x.mix)}>
              {x.name}
            </button>
          ))}
        </div>
      )}
      {section('eastern', '中式')}
      {section('western', '音译')}
    </>
  );
}
