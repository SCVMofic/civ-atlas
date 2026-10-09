/**
 * 「我的世界」:浏览器里存着的世界,一个一张卡片(缩略图、名字、种子和现存几国、最近打开的时间),最近的在前。
 * 有存档的人进站先到这一页;世界卡片顶上"‹ 我的世界"回到这里。样子照常见的文稿列表(浅灰底、缩略图网格、名字和日期在图下面)。
 *
 *   右上     打开存档文件(也可以把 .json 拖进页面)、新建世界;有网站服务器时再加账号按钮(没登录是「登录」,登录了是名字;手机在左上)
 *   卡片     点一下打开;"没建完"的(还在新建)点开接着建
 *            右上"···"(电脑悬停时出现;手机长按卡片)= 改名、复制一份、存成文件、删除(点两下确认)。没建完的只有改名、删除
 *   底部     源代码、隐私政策、用户协议、版本号(手机上不放,在世界卡片的"更多"里)
 * 手机:两列卡片,新建世界在右上,打开存档文件在列表下面。
 * 一个都没有(第一次来)时:中间一颗慢慢自转的星球、一段话说清能做什么、「新建世界」大按钮,下面"或者打开存档文件",
 * 最下面一行小字说不用登录、做出来的世界归自己(和用户协议「你创作的东西归你」同一个说法)。
 *
 * 标题下那句话:没登录的说清楚世界只存在这个浏览器里、清理浏览器数据会一起删掉;后面跟蓝字「全部存成文件」
 * (所有世界存成一个文件,「打开存档文件」选它全部放回来,见 bundle.ts;一个世界都没有、也没有只在页面里的时不出现)。
 * 登录了的:标题下那句话说世界存在账号里(不再提醒,「全部存成文件」照样在);卡片时间那个位置在没同步好时换成"正在同步""还没同步上"(同步好了不标);
 * 账号窗里点「最近删除」,这一页换成最近删除(30 天内能找回,点一张卡片找回)。
 *
 * 存、读、列都在 saveStore.ts;打开一个世界(生成 + 套上修改)由 App 做。一个都没有时也停在这一页
 * (刚才那个世界存不进浏览器、只在页面里的,标题下有「全部存成文件」)。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAX_WORLDS, currentUnsaved, deleteWorld, duplicateWorld, listWorlds, loadWorld, notify, persistent, renameWorld, restoreWorld, storedCount, syncable, useSavesVersion, type StoredWorld } from './saveStore';
import { closeTrash, openAccount, openLogin, useAccountPanelOpen, useTrashView } from './AccountDialogs';
import { serverBase } from '../account/server';
import { displayName, useSession } from '../account/session';
import { inAccount, syncNow, useSyncView } from '../account/sync';
import { listTrash, restoreTrash, type TrashEntry } from '../account/cloud';
import { downloadSave } from './SaveMenu';
import { downloadAll } from './bundle';
import { copyNotes } from '../ai/library';
import { Icon } from './icons';
import { TitleInput, when } from './worldParts';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { APP_VERSION } from './version';
import { HomeGlobe } from './studio/HomeGlobe';
import { OldSiteBadge } from './Corners';
import { OLD_SITE } from './oldSite';
import './worlds.css';

export interface MyWorldsProps {
  phone: boolean;
  /** 打开一个存着的世界 */
  onOpen: (id: string) => void;
  /** 新建世界 */
  onNew: () => void;
  /** 从文件打开:文件内容(App 解析、存进我的世界、打开) */
  onOpenText: (text: string, fileName?: string) => void;
}

/** 卡片第二行:"种子 7，现存 13 国" / "种子 1009，还在新建" */
function worldLine(w: StoredWorld): string {
  const seed = `种子 ${w.save.seed}`;
  if (w.draft) return `${seed}，还在新建`;
  if (w.alive === undefined) return seed;
  return w.alive ? `${seed}，现存 ${w.alive} 国` : `${seed}，没有文明`;
}

export function MyWorlds({ phone, onOpen, onNew, onOpenText }: MyWorldsProps) {
  const v = useSavesVersion();
  const list = useMemo(() => listWorlds(), [v]);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 菜单开在哪张卡片上 */
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const keep = persistent();

  const pickFile = () => fileRef.current?.click();
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      onOpenText(await f.text(), f.name);
    } catch {
      notify({ kind: 'error', text: `打不开 ${f.name}`, more: ['读不了这个文件'] });
    }
  };
  const session = useSession();
  const server = serverBase() !== null;
  const sync = useSyncView();
  const trash = useTrashView();
  const n = list.length;
  const empty = n === 0;
  // 没登录:世界只在这个浏览器里,清理浏览器数据就没了 —— 直说,后面跟「全部存成文件」;登录了存在账号里,不再提醒。
  // 旧网站(oldSite.ts):这里的世界和最新版的各存各的,说清楚(顶上还有「旧版」标记)
  const sub = !keep
    ? '浏览器不让网页存数据，关掉页面前请把世界存成文件。'
    : session
      ? empty
        ? '建好的世界存在你的账号里，换电脑、换手机登录同一个账号就能打开。'
        : phone
          ? `${n} 个世界，存在你的账号里`
          : `${n} 个世界，存在你的账号里。换电脑、换手机，登录同一个账号就能打开。`
      : empty
        ? server
          ? '建好的世界存在这个浏览器里。登录以后，换电脑、换手机都能接着改。'
          : '建好的世界存在这个浏览器里；换电脑请用存档文件。'
        : OLD_SITE !== null
          ? `${n} 个世界，存在旧版里，和最新版的分开放。`
          : phone
            ? `${n} 个世界只存在这个浏览器里，清理浏览器数据会删掉。`
            : server
              ? `${n} 个世界，只存在这个浏览器里，清理浏览器数据会一起删掉。登录以后存进账号，换电脑、换手机都能接着改。`
              : `${n} 个世界，只存在这个浏览器里，清理浏览器数据会把它们一起删掉。`;
  // 正在看的世界存不进浏览器(存储满了)、一个都没存下时,也能把它存成文件
  const saveAll = (n > 0 || currentUnsaved()) && (
    <button className="mw-link" data-act="save-all" onClick={downloadAll}>
      <Icon name="save" size={phone ? 13 : 14} />
      全部存成文件
    </button>
  );
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const acctOpen = useAccountPanelOpen();
  const acctBtn = server && (
    <button className={`mw-acct${acctOpen ? ' on' : ''}`} data-act={session ? 'account' : 'login'} onClick={() => (session ? openAccount() : openLogin())} title={session ? session.user.account : '登录网站账号'}>
      <Icon name="personc" size={18} />
      <span>{session ? displayName(session.user) : '登录'}</span>
    </button>
  );
  /** 卡片时间那个位置:没同步好时换成同步状态 */
  const syncOf = (id: string): 'sync' | 'off' | null =>
    // 老编号的世界存不进账号(浏览器存储满了没换成新编号):一直算没同步上
    !session ? null : !syncable(id) || sync.failed.has(id) ? 'off' : sync.busy.has(id) ? 'sync' : null;
  if (trash && session) return <TrashPage phone={phone} />;

  return (
    <div className={`mw${phone ? ' mw-phone' : ''}`} role="main" aria-label="我的世界" onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={onFile} data-testid="save-file-input" />
      <header className="mw-top">
        {phone && (!empty || acctBtn) && (
          <div className={`mw-bar${server ? ' has-acct' : ''}`}>
            {acctBtn}
            {!empty && (
              <button className="mw-btn blue round" data-act="new-world" onClick={onNew}>
                <Icon name="plus" size={16} />
                新建世界
              </button>
            )}
          </div>
        )}
        <div className="mw-heading">
          <OldSiteBadge />
          <h1>我的世界</h1>
          <p>
            {sub}
            {phone && saveAll && <br />}
            {saveAll}
          </p>
        </div>
        {/* 一个都没有时,打开存档、新建在中间的大按钮那里;右上只剩账号 */}
        {!phone && (!empty || acctBtn) && (
          <div className="mw-acts">
            {!empty && (
              <>
                <button className="mw-btn" data-act="open-file" onClick={pickFile}>
                  <Icon name="file" size={16} />
                  打开存档文件
                </button>
                <button className="mw-btn blue" data-act="new-world" onClick={onNew}>
                  <Icon name="plus" size={16} />
                  新建世界
                </button>
              </>
            )}
            {acctBtn && (
              <>
                {!empty && <span className="mw-sep" aria-hidden="true" />}
                {acctBtn}
              </>
            )}
          </div>
        )}
      </header>
      {empty && (
        <div className="mw-empty">
          <HomeGlobe size={phone ? 150 : 188} />
          <h2>还没有世界</h2>
          <p>
            <span>打造一颗独属于你的星球，</span>
            <span>它有大陆、海洋、气候、洋流……</span>
            <span>还有城市、文明、种族……</span>
            <span>以及在你引导下推演出来的历史。</span>
          </p>
          <button className="mw-btn blue big" data-act="new-world" onClick={onNew}>
            <Icon name="plus" size={18} />
            新建世界
          </button>
          <button className="mw-or" data-act="open-file" onClick={pickFile}>
            或者打开存档文件
          </button>
          <p className="mw-note">
            <span>无需登录。</span>
            <span>做出来的世界归你，我们不主张任何权利。</span>
          </p>
        </div>
      )}
      {!empty && (
        <div className="mw-grid" role="list">
          {list.map((w) => (
            <WorldCard
              key={w.id}
              w={w}
              phone={phone}
              menuOpen={menu === w.id}
              onMenu={(o) => setMenu(o ? w.id : null)}
              renaming={renaming === w.id}
              onRename={(o) => setRenaming(o ? w.id : null)}
              onOpen={() => onOpen(w.id)}
              sync={syncOf(w.id)}
              loggedIn={!!session}
            />
          ))}
        </div>
      )}
      {phone && !empty && (
        <div className="mw-open-file sb-group">
          <button className="sb-row" data-act="open-file" onClick={pickFile}>
            <Icon name="file" size={18} className="sb-ico" />
            <span className="sb-row-main">
              <b>打开存档文件</b>
            </span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
        </div>
      )}
      {!phone && (
        <footer className="mw-foot">
          <a href={SOURCE_URL} target="_blank" rel="noreferrer" data-link="source">
            源代码
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer" data-link="privacy">
            隐私政策
          </a>
          <a href={TERMS_URL} target="_blank" rel="noreferrer" data-link="terms">
            用户协议
          </a>
          <span className="mw-ver" data-version>
            版本 {APP_VERSION}
          </span>
        </footer>
      )}
    </div>
  );
}

/** 长按多久算长按(毫秒;手机上开卡片的菜单) */
const LONG_PRESS = 480;

/** 卡片时间那个位置的同步状态 */
function SyncTime({ st }: { st: 'sync' | 'off' }) {
  return (
    <span className={`mw-time ${st}`} data-sync={st}>
      <Icon name={st === 'sync' ? 'cloudup' : 'cloudoff'} size={14} />
      {st === 'sync' ? '正在同步' : '还没同步上'}
    </span>
  );
}

function WorldCard({
  w,
  phone,
  menuOpen,
  onMenu,
  renaming,
  onRename,
  onOpen,
  sync,
  loggedIn,
}: {
  w: StoredWorld;
  phone: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  renaming: boolean;
  onRename: (on: boolean) => void;
  onOpen: () => void;
  sync: 'sync' | 'off' | null;
  loggedIn: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  /** 长按:按下的计时器;长按开了菜单以后,松手那一下的点击不算打开 */
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longFired = useRef(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onMenu(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen, onMenu]);
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.t);
    },
    [],
  );

  const name = w.save.title || '未命名世界';
  const act = (f: () => void) => () => {
    onMenu(false);
    f();
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  return (
    <div ref={root} className={`mw-card${w.draft ? ' draft' : ''}${menuOpen ? ' menu-on' : ''}`} role="listitem" data-id={w.id}>
      <button
        className="mw-open"
        data-act="open-world"
        onClick={() => {
          if (longFired.current) {
            longFired.current = false;
            return;
          }
          if (!renaming) onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(true);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          longFired.current = false;
          cancelPress();
          press.current = {
            x: e.clientX,
            y: e.clientY,
            t: setTimeout(() => {
              press.current = null;
              longFired.current = true;
              onMenu(true);
            }, LONG_PRESS),
          };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        title={w.draft ? '接着建这个世界' : '打开这个世界'}
      >
        <span className="mw-thumb" style={w.thumb ? { backgroundImage: `url(${w.thumb})` } : undefined}>
          {w.draft && <span className="mw-tag">没建完</span>}
        </span>
        {phone ? (
          <span className="mw-meta">
            {!renaming && <b className="mw-name">{name}</b>}
            <span className="mw-line">{worldLine(w)}</span>
            {sync ? <SyncTime st={sync} /> : <span className="mw-time">{when(w.at)}</span>}
          </span>
        ) : (
          <span className="mw-meta">
            <span className="mw-row1">
              {!renaming && <b className="mw-name">{name}</b>}
              {sync ? <SyncTime st={sync} /> : <span className="mw-time">{when(w.at)}</span>}
            </span>
            <span className="mw-line">{worldLine(w)}</span>
          </span>
        )}
      </button>
      {renaming && (
        <div className="mw-rename">
          <TitleInput
            className="mw-title-input"
            initial={w.save.title ?? ''}
            onDone={(v) => {
              onRename(false);
              if (v !== null) renameWorld(w.id, v);
            }}
          />
        </div>
      )}
      {!phone && (
        <button className={`mw-dots${menuOpen ? ' on' : ''}`} data-act="world-menu" aria-label="更多" title="更多" onClick={() => onMenu(!menuOpen)}>
          <Icon name="more" size={18} />
        </button>
      )}
      {menuOpen && (
        <div className="pm-menu mw-menu" role="menu">
          <button className="pm-item" data-act="world-rename" onClick={act(() => onRename(true))}>
            <Icon name="rename" size={16} />
            <span className="pm-text">改名</span>
          </button>
          {!w.draft && (
            <>
              <button
                className="pm-item"
                data-act="world-copy"
                onClick={act(() => {
                  const id = duplicateWorld(w.id);
                  if (!id) return notify({ kind: 'error', text: '没能复制', more: ['浏览器存储已满'] });
                  const more = [`新的叫「${loadWorld(id)?.save.title ?? ''}」`];
                  // AI 写的史书、名字由来跟着复制;存不下就说一声(这一页里还看得到,刷新以后没有)
                  if (!copyNotes(w.id, id)) more.push('AI 写的史书、名字由来没能一起存下（浏览器存储已满）');
                  notify({ kind: more.length > 1 ? 'warn' : 'ok', text: `已复制一份「${name}」`, more });
                })}
              >
                <Icon name="copy" size={16} />
                <span className="pm-text">复制一份</span>
              </button>
              <button
                className="pm-item"
                data-act="world-file"
                onClick={act(() => {
                  // 按点的这一刻存着的存(别的页面里可能又改过、删了)
                  const cur = loadWorld(w.id);
                  if (!cur) return notify({ kind: 'error', text: '打不开这个存档', more: ['可能已在别的页面里删掉了'] });
                  downloadSave(cur.save);
                })}
              >
                <Icon name="save" size={16} />
                <span className="pm-text">存成文件</span>
              </button>
            </>
          )}
          <hr className="pm-sep" />
          <button
            className="pm-item red"
            data-act="world-delete"
            onClick={act(() => {
              // 已经存进账号的:账号里跟着删,进最近删除(还没传上去的只是从这里删掉,找不回来,不这么说)
              const synced = loggedIn && inAccount(w.id);
              // 点一下就删,不再问;提示条上的"撤销"兜底(提示条还在的时候点,放回原处;已经存进账号的跟着存回去)
              const gone = deleteWorld(w.id);
              // 别的页面里已经删掉了(这一页的列表还没跟上):没有可撤销的
              if (!gone) return notify({ kind: 'ok', text: `「${name}」已在别的页面里删掉了` });
              notify({
                kind: 'ok',
                text: `已删除「${name}」`,
                ...(synced ? { more: ['所有设备上都会删掉；30 天内能在账号的「最近删除」里找回'] } : {}),
                action: {
                  label: '撤销',
                  act: 'world-undelete',
                  onClick: () => {
                    if (restoreWorld(gone)) notify(null);
                    else notify({ kind: 'error', text: '没能放回去', more: ['浏览器存储已满'] });
                  },
                },
              });
            })}
          >
            <Icon name="trash" size={16} />
            <span className="pm-text">删除</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 还剩几天清除 */
function purgeIn(iso: string): string {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86400e3);
  return Number.isFinite(days) ? (days <= 1 ? '明天清除' : `${days} 天后清除`) : '';
}

/** 最近删除:照「我的世界」的卡片,点一张找回 */
function TrashPage({ phone }: { phone: boolean }) {
  const [list, setList] = useState<TrashEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listTrash()
      .then((l) => live && setList(l))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  const restore = async (t: TrashEntry) => {
    if (busy) return;
    // 找回来要放进这台设备的「我的世界」:满了就先不找回(不然账号里回来了,这里却看不到)
    if (storedCount() >= MAX_WORLDS) {
      setErr(`「我的世界」最多存 ${MAX_WORLDS} 个世界，先删掉几个再找回`);
      return;
    }
    setBusy(t.id);
    try {
      await restoreTrash(t.id);
      setList((l) => (l ?? []).filter((x) => x.id !== t.id));
      notify({ kind: 'ok', text: `已找回「${t.title || '未命名世界'}」`, more: ['回到「我的世界」就能看到'] });
      void syncNow();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const back = (
    <button className={`mw-btn${phone ? ' round' : ''}`} data-act="trash-back" onClick={() => closeTrash()}>
      <Icon name="back" size={16} />
      我的世界
    </button>
  );
  return (
    <div className={`mw${phone ? ' mw-phone' : ''}`} role="main" aria-label="最近删除" onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
      <header className="mw-top">
        {phone && <div className="mw-bar has-acct">{back}</div>}
        <div className="mw-heading">
          <h1>最近删除</h1>
          <p>删掉的世界在这里留 30 天，点一下就能找回。</p>
        </div>
        {!phone && <div className="mw-acts">{back}</div>}
      </header>
      {list && list.length > 0 && (
        <div className="mw-grid" role="list">
          {list.map((t) => {
            const alive = typeof t.meta?.alive === 'number' ? (t.meta.alive as number) : undefined;
            const line = `种子 ${t.seed ?? '?'}${alive === undefined ? '' : alive ? `，现存 ${alive} 国` : '，没有文明'}`;
            return (
              <div className="mw-card" role="listitem" key={t.id} data-id={t.id}>
                <button className="mw-open" data-act="restore-world" disabled={!!busy} onClick={() => void restore(t)} title="找回这个世界">
                  <span className="mw-thumb" style={t.thumb ? { backgroundImage: `url(${t.thumb})` } : undefined} />
                  {phone ? (
                    <span className="mw-meta">
                      <b className="mw-name">{t.title || '未命名世界'}</b>
                      <span className="mw-line">{line}</span>
                      <span className="mw-time">{busy === t.id ? '正在找回' : purgeIn(t.purgeAt)}</span>
                    </span>
                  ) : (
                    <span className="mw-meta">
                      <span className="mw-row1">
                        <b className="mw-name">{t.title || '未命名世界'}</b>
                        <span className="mw-time">{busy === t.id ? '正在找回' : purgeIn(t.purgeAt)}</span>
                      </span>
                      <span className="mw-line">{line}</span>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {list && !list.length && <p className="mw-empty">最近删除里没有世界</p>}
      {err && <p className="mw-empty">{err}</p>}
    </div>
  );
}
