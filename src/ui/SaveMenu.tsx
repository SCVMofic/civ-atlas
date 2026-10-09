/**
 * 世界卡片头部的"存档"菜单:只管正在看的这一个世界(打开别的世界、从文件打开在"我的世界"那一页,见 MyWorlds.tsx) ——
 *
 *   当前世界:缩略图、名字、种子、地形改过几处、"已自动存在这个浏览器里"(打开的链接还没动过 = 还没存)
 *   存成文件:下载 .json(文明与地图-九州大陆.json;格式见 gen/savefile.ts)
 *   复制分享链接:整份存档压缩进网址的 # 后面(gen/savefile.ts 的 encodeShare),复制到剪贴板;
 *     没有修改 = 普通网址(只带种子、参数);剪贴板用不了:菜单留着,里面多一行选中了链接的输入框,让用户自己复制
 *   登录了网站账号:当前世界那一行写同步到账号了没有;"复制分享链接"换成"分享…"(短链接,随时能停,AccountDialogs.tsx 的分享窗)
 *   看原样:旧版本建的世界(留着原来那一份,saveStore 的 currentOriginal)到那一版的旧网站里打开,新页面(oldSite.ts)
 *
 * 存、读、列都在 saveStore.ts。存储满了之类的提示(saveStore 的 notify)显示在顶部的提示条上。
 * ⌘S 打开这个菜单(openSaveMenu;世界本来就自动存着,菜单上写着存没存好)。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GEN_KEY, SHARE_WARN_LENGTH, editCount, encodeShare, hasShareData, saveFileName, saveText, type SaveFile } from '../gen/savefile';
import { GENERATOR_VERSION } from '../gen/edits';
import { useEdits } from './editsStore';
import { addFileSaver, currentOriginal, currentSave, currentWorld, loadWorld, notify, persistent, storageIsFull, useSavesVersion } from './saveStore';
import { oldSiteFor, openOriginal } from './oldSite';
import { Icon } from './icons';
import { noteDismiss } from './dismissClick';
import { copyText } from './clipboard';
import { openShareDialog } from './AccountDialogs';
import { when } from './worldParts';
import { useSession } from '../account/session';
import { useSyncView, worldSync } from '../account/sync';

export interface SaveMenuProps {
  /** 世界生成完了(能存) */
  ready: boolean;
  /** 按钮上文字前面的小图标 */
  icon?: ReactNode;
}

/** 调试 / 冒烟测试用:最近一次"存成文件" */
interface SaveDebug {
  name: string;
  bytes: number;
  count: number;
}

/** 调试 / 冒烟测试用:最近一次"复制分享链接" */
interface ShareDebug {
  url: string;
  length: number;
  /** 带不带修改(没有修改 = 普通网址) */
  withData: boolean;
  count: number;
  copied: boolean;
}

const LONG_HINT = '链接较长,可能打不开,建议存成文件';

/** 当前世界存成文件(菜单里的"存成文件"、存储满了时提示条上的"存成文件") */
function saveCurrentFile() {
  const save = currentSave();
  if (!save) return;
  const name = saveFileName(save);
  const text = saveText(save);
  download(text, name);
  (window as unknown as { __wfSave?: SaveDebug }).__wfSave = { name, bytes: new Blob([text]).size, count: editCount(save.edits) };
  notify({ kind: 'ok', text: '已存成文件', more: [name] });
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 剪贴板用不了:菜单里一行"没能自动复制",下面是选中了链接的输入框(不另开窗口) */
function ManualCopy({ url }: { url: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [url]);
  return (
    <div className="save-manual" data-testid="share-manual">
      <span>{url.length > SHARE_WARN_LENGTH ? `没能自动复制,请手动复制 · ${LONG_HINT}` : '没能自动复制,请手动复制'}</span>
      <input ref={ref} readOnly value={url} spellCheck={false} aria-label="分享链接" onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? <img className="save-thumb" src={src} alt="" draggable={false} /> : <div className="save-thumb empty" />;
}

/**
 * 分享链接的网址部分:种子、参数、图层……照当前网址,带上生成器版本;去掉只在这个浏览器里有意义的世界编号、
 * 别人的分享短链接的码(那个分享停了,链接就打不开了)。
 * 网址带的版本比这个页面新(页面是旧的,还没刷新)就照留,别人打开还知道是新版本的世界
 */
function shareBase(): string {
  const q = new URLSearchParams(location.search);
  q.delete('w');
  q.delete('new');
  q.delete('s');
  const g = Number(q.get(GEN_KEY));
  if (!(Number.isInteger(g) && g > GENERATOR_VERSION)) q.set(GEN_KEY, String(GENERATOR_VERSION));
  const s = q.toString();
  return location.origin + location.pathname + (s ? `?${s}` : '');
}

/** 页面上的存档菜单(宽屏侧栏顶上一个;手机在世界卡片里):⌘S 打开看得见的那一个 */
const openers = new Set<{ root: () => HTMLElement | null; open: () => void }>();

/** ⌘S:打开看得见的那个存档菜单(已经开着就留着);没有看得见的 = false */
export function openSaveMenu(): boolean {
  for (const o of openers) {
    const el = o.root();
    if (!el || !el.getClientRects().length || el.closest('[inert]')) continue;
    o.open();
    return true;
  }
  return false;
}

export function SaveMenu({ ready, icon }: SaveMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const o = { root: () => rootRef.current, open: () => setOpen(true) };
    openers.add(o);
    return () => {
      openers.delete(o);
    };
  }, []);
  const v = useSavesVersion();
  const edits = useEdits();
  const cur = ready ? currentWorld() : null;
  const curStored = useMemo(() => (open && cur ? loadWorld(cur.id) : null), [open, cur, v]);
  const count = editCount(edits);
  const keep = persistent();
  const full = storageIsFull();
  const session = useSession();
  const syncView = useSyncView();
  const synced = useMemo(() => (open && session && cur && curStored ? worldSync(cur.id) : null), [open, session, cur, curStored, syncView]);

  // 点菜单外面就收起(在捕获阶段听:地图上的按钮条拦了冒泡,点旁边的按钮照样收起)
  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const saveFile = () => {
    setOpen(false);
    saveCurrentFile();
  };

  // 复制分享链接:网址(种子 + 参数 + 画风……)+ #share=整份存档;没有修改就是普通网址。
  // 剪贴板用不了:菜单留着,里面多一行选中了链接的输入框(不另开窗口)
  const [manual, setManual] = useState<string | null>(null);
  const shareLink = async () => {
    const save = currentSave();
    if (!save) return;
    const base = shareBase();
    const withData = hasShareData(save);
    let url = base;
    if (withData) {
      try {
        url = base + (await encodeShare(save));
      } catch {
        setOpen(false);
        notify({ kind: 'error', text: '做不了分享链接', more: ['浏览器版本太旧,请改用存成文件'] });
        return;
      }
    }
    const n = url.length;
    const count = editCount(save.edits);
    const copied = await copyText(url);
    (window as unknown as { __wfShare?: ShareDebug }).__wfShare = { url, length: n, withData, count, copied };
    const long = n > SHARE_WARN_LENGTH;
    if (!copied) {
      setManual(url);
      return;
    }
    setOpen(false);
    const more = long ? [`${LONG_HINT}(${n} 字)`] : withData ? [] : ['还没有修改,只带种子和参数'];
    notify({ kind: long ? 'warn' : 'ok', text: `已复制${withData ? '分享' : ''}链接`, more });
  };
  useEffect(() => {
    if (!open) setManual(null);
  }, [open]);
  // 存储满了 / 浏览器不让存时,提示条上的"存成文件"
  useEffect(() => addFileSaver(saveCurrentFile), []);

  const title = cur?.title;
  const nTerrain = edits.terrain.length;
  // 存没存住:浏览器不让存 / 存不下 / 已经在"我的世界"里 / 打开的链接还没动过
  const status: { cls: string; text: string; icon?: 'cloudok' | 'cloudup' | 'cloudoff' } = !keep
    ? { cls: 'warn', text: '浏览器不让网页存数据，关掉前请存成文件' }
    : full
      ? { cls: 'warn', text: '浏览器存储已满，没能自动存' }
      : curStored && synced
        ? synced.state === 'synced'
          ? { cls: 'ok', icon: 'cloudok', text: `已同步到你的账号${synced.at ? `，${when(synced.at)}` : ''}` }
          : synced.state === 'busy'
            ? { cls: 'ok', icon: 'cloudup', text: '正在同步到你的账号' }
            : { cls: 'warn', icon: 'cloudoff', text: '还没同步上，联网后会自动同步' }
        : curStored
          ? { cls: 'ok', text: '已自动存在这个浏览器里' }
          : { cls: '', text: '还没存进我的世界；改了名字或历史就会自动存' };
  // 旧版本建的世界:能到那一版的旧网站里看原样(菜单开着才找)
  const orig = open && cur ? currentOriginal() : null;
  const site = orig ? oldSiteFor(orig.generator) : null;
  const seeOriginal = () => {
    if (!orig || !site) return;
    setOpen(false);
    void openOriginal(orig).then((ok) => ok || notify({ kind: 'error', text: '这个浏览器打不开', more: [`请把世界存成文件，到 ${site.href} 打开`] }));
  };
  const share = () => {
    if (!cur) return;
    setOpen(false);
    openShareDialog(cur.id, title ?? '');
  };
  return (
    <div className="save" ref={rootRef}>
      <button className={`save-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} data-tip="存档" data-tip-key="save">
        {icon}
        存档
      </button>
      {open && (
        <div className="save-menu" role="menu">
          {cur ? (
            <div className="save-cur">
              <Thumb src={curStored?.thumb ?? null} />
              <div className="save-info">
                <b className="save-cur-name">{title || '未命名世界'}</b>
                <small>
                  种子 {cur.params.seed}
                  {nTerrain ? `，地形改过 ${nTerrain} 处` : ''}
                </small>
                <small className={`save-status ${status.cls}`} data-testid="save-status">
                  {status.icon && <Icon name={status.icon} size={14} />}
                  {status.text}
                </small>
              </div>
            </div>
          ) : (
            <div className="save-empty">正在生成世界</div>
          )}
          <button className="save-it" data-act="save-file" disabled={!cur} onClick={saveFile}>
            <Icon name="save" size={17} />
            <span>
              <b>存成文件（.json）</b>
              <small>{session ? '留一份备份，或者发给别人' : '换台电脑、换个浏览器也能打开'}</small>
            </span>
          </button>
          {session ? (
            <button className="save-it" data-act="share" disabled={!cur} onClick={share}>
              <Icon name="link" size={17} />
              <span>
                <b>分享…</b>
                <small>生成一个链接，别人打开就能看；随时能停止</small>
              </span>
            </button>
          ) : (
            <button className="save-it" data-act="share-link" disabled={!cur} onClick={shareLink}>
              <Icon name="link" size={17} />
              <span>
                <b>复制分享链接</b>
                <small>{count || title ? '对方打开看到同一个世界、同样的修改' : '还没有修改，只带种子和参数'}</small>
              </span>
            </button>
          )}
          {site && (
            <button className="save-it" data-act="see-original" onClick={seeOriginal}>
              <Icon name="history" size={17} />
              <span>
                <b>看原样</b>
                <small>这个世界是旧版建的，在新页面里用当时的版本打开</small>
              </span>
            </button>
          )}
          {manual !== null && <ManualCopy url={manual} />}
        </div>
      )}
    </div>
  );
}

/** 把一个存档存成文件(我的世界里卡片上的"存成文件") */
export function downloadSave(save: SaveFile) {
  const name = saveFileName(save);
  const text = saveText(save);
  download(text, name);
  (window as unknown as { __wfSave?: SaveDebug }).__wfSave = { name, bytes: new Blob([text]).size, count: editCount(save.edits) };
  notify({ kind: 'ok', text: '已存成文件', more: [name] });
}
