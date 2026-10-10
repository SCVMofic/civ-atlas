/**
 * 网站账号的几个窗口(电脑是居中的弹窗,手机是从下面升起的卡片):
 *
 *   登录       邮箱收验证码(不设密码);「手机号」那一格先置灰写"暂未开放"(网页这边还没做手机号登录);
 *              邀请制下新邮箱要邀请码:从邀请链接打开的已经填好,没填的点"获取验证码"时先说明、露出邀请码一栏(不发邮件)
 *   账号       云同步、最近删除、AI 积分(「使用 AI 功能」关着时不显示)、分享出去的世界(复制链接、停止分享);左下注销账号,右下退出登录
 *   退出登录   问这台设备上的世界留不留(默认留);选"删掉"先全部同步好再删
 *   注销账号   给自己的邮箱发验证码,填上才注销(账号里的都删掉;这台设备上的不动)
 *   分享       一个开关管开和停;署名(别人另存时写进底稿出处,默认不填);短链接、复制;手机上多一个"发给…"(系统分享)
 *
 *   openLogin() / openAccount() / openShareDialog(id, 名字)   打开它们(「我的世界」右上、AI 设置、存档菜单)
 *   openTrash()   「我的世界」那一页换成最近删除(App 回到我的世界)
 *   AccountHost   窗口本身,App 里一直挂着
 *
 * 另外两样也在这里:分享停了的那一页(ShareGone)、打开别人分享的世界时地图下的说明(SharedHint)。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { APP_VERSION } from './version';
import { when } from './worldParts';
import { copyText } from './clipboard';
import { currentUnsaved, currentWorld, isStored, keepWorld, listWorlds, loadWorld, notify, useSavesVersion } from './saveStore';
import { closeAiSettings, openAiSettings } from './AiSettings';
import { refreshOfficialAccount, useOfficialAccount } from '../ai/providers/official';
import { useAiOn } from '../ai/client';
import { ServerError } from '../account/server';
import { deleteAccount, displayName, fetchAuthOptions, getSession, login, pendingInvite, sendCode, useSession, type AuthOptions } from '../account/session';
import { accountDeleted, behindCloud, signOut, syncNow, unsyncedCount, useSyncView } from '../account/sync';
import { createShare, listShares, listTrash, shortLink, stopShare, type ShareInfo, type TrashEntry } from '../account/cloud';
import { SIGNATURE_UNITS, cleanSignature } from '../gen/savefile';
import { OLD_SITE } from './oldSite';
import './account.css';

// ---------------------------------------------------------------------------
// 开关

type Panel = { kind: 'login' } | { kind: 'account' } | { kind: 'logout' } | { kind: 'delete' } | { kind: 'share'; worldId: string; title: string };

let panel: Panel | null = null;
let trash = false;
/** 账号窗、分享窗、最近删除是替哪一次登录(令牌)开的:别的标签页退出、换了账号,开着的就是原来那个账号的了,关掉 */
let openedFor: string | null = null;
const forNow = () => {
  openedFor = getSession()?.token ?? null;
};
let version = 0;
const subs = new Set<() => void>();
function emit() {
  version++;
  for (const f of subs) f();
}
function useUi() {
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => version,
    () => version,
  );
  return { panel, trash };
}

export function openLogin(): void {
  panel = { kind: 'login' };
  emit();
}
export function openAccount(): void {
  panel = { kind: 'account' };
  forNow();
  emit();
}
export function openShareDialog(worldId: string, title: string): void {
  panel = { kind: 'share', worldId, title };
  forNow();
  emit();
}
export function closeAccountPanel(): void {
  if (!panel) return;
  panel = null;
  emit();
}

/** React:开着的是登录窗 / 账号窗(「我的世界」右上那个按钮显示按下) */
export function useAccountPanelOpen(): boolean {
  const k = useUi().panel?.kind;
  return k === 'login' || k === 'account';
}

/** 回到"我的世界"(App 登记) */
let goHome: (() => void) | null = null;
export function setGoHome(f: (() => void) | null): void {
  goHome = f;
}
/** 「我的世界」那一页换成最近删除 */
export function openTrash(): void {
  panel = null;
  trash = true;
  forNow();
  emit();
  closeAiSettings();
  goHome?.();
}
export function closeTrash(): void {
  if (!trash) return;
  trash = false;
  emit();
}
/** React:「我的世界」那一页是不是在看最近删除(只算替现在登着的这次登录开的) */
export function useTrashView(): boolean {
  const { trash: t } = useUi();
  const s = useSession();
  return t && !!s && s.token === openedFor;
}

/** 窗口:App 里挂一次 */
export function AccountHost({ phone }: { phone: boolean }) {
  const { panel: p, trash: t } = useUi();
  const s = useSession();
  // 退出了、换了账号(别的标签页里、令牌过期):开着的账号窗、分享窗、最近删除都是原来那个账号的,关掉;只留登录窗
  const stale = !s || s.token !== openedFor;
  useEffect(() => {
    if (p && p.kind !== 'login' && stale) closeAccountPanel();
    if (p?.kind === 'login' && s) closeAccountPanel();
    if (t && stale) closeTrash();
  }, [p, s, t, stale]);
  if (!p) return null;
  const close = closeAccountPanel;
  const back = () => {
    panel = { kind: 'account' };
    emit();
  };
  if (p.kind === 'login') return <LoginDialog phone={phone} onClose={close} />;
  if (stale) return null;
  if (p.kind === 'account') return <AccountDialog phone={phone} onClose={close} />;
  if (p.kind === 'logout') return <LogoutDialog phone={phone} onClose={close} onBack={back} />;
  if (p.kind === 'delete') return <DeleteDialog phone={phone} onClose={close} onBack={back} />;
  return <ShareDialog key={p.worldId} phone={phone} worldId={p.worldId} title={p.title} onClose={close} />;
}

// ---------------------------------------------------------------------------
// 窗口外壳

/** 对话框开着时按 Esc 关掉(先于页面上别的 Esc) */
function useEscape(f: () => void) {
  const latest = useRef(f);
  latest.current = f;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

function Dialog({
  phone,
  label,
  width = 420,
  onClose,
  head,
  children,
  testId,
}: {
  phone: boolean;
  label: string;
  width?: number;
  onClose?: () => void;
  /** 标题那一行(不给 = 标题 + 右上关闭) */
  head?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  useEscape(() => onClose?.());
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return createPortal(
    <div
      className={`acct-bg${phone ? ' sheet' : ''}`}
      onPointerDown={(e) => {
        stop(e);
        if (e.target === e.currentTarget) onClose?.();
      }}
      onClick={stop}
      onWheel={stop}
    >
      <div className={`acct-dlg${phone ? ' sheet' : ''}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} style={phone ? undefined : { width }}>
        {phone && <div className="acct-grip" aria-hidden="true" />}
        {head ?? (
          <div className="acct-head">
            <h2>{label}</h2>
            {onClose && <CloseX onClose={onClose} />}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

function CloseX({ onClose }: { onClose: () => void }) {
  return (
    <button className="acct-x" onClick={onClose} title="关闭" aria-label="关闭">
      <Icon name="close" size={14} />
    </button>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => (e instanceof ServerError ? e.code : '');

/** 重发倒计时:每秒刷新一次 */
function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sendLabel = (sent: boolean, left: number, busy: boolean) => (busy ? '正在发送' : !sent ? '获取验证码' : left > 0 ? `重发（${left} 秒）` : '重发验证码');

// ---------------------------------------------------------------------------
// 登录

interface Sent {
  to: string;
  until: number;
  /** 验证码几秒内有效 */
  ttl: number;
  dev?: string;
}

function LoginDialog({ phone, onClose }: { phone: boolean; onClose: () => void }) {
  const [opts, setOpts] = useState<AuthOptions | null>(null);
  useEffect(() => {
    let live = true;
    void fetchAuthOptions().then((o) => live && setOpts(o));
    return () => {
      live = false;
    };
  }, []);
  const linkInvite = useMemo(() => pendingInvite(), []);
  const [email, setEmail] = useState('');
  const [invite, setInvite] = useState(linkInvite ?? '');
  const [showInvite, setShowInvite] = useState(!!linkInvite);
  const [needInvite, setNeedInvite] = useState(false);
  const [sent, setSent] = useState<Sent | null>(null);
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<'send' | 'login' | null>(null);
  const [err, setErr] = useState<{ at: 'email' | 'invite' | 'code'; text: string } | null>(null);
  const left = useCountdown(sent?.until ?? null);
  const emailRef = useRef<HTMLInputElement>(null);
  const inviteRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const n = useMemo(() => listWorlds().length, []);
  useEffect(() => emailRef.current?.focus(), []);

  const inviteOnly = opts?.inviteOnly ?? !!linkInvite;
  const okEmail = EMAIL.test(email.trim());
  const sentNow = !!sent && sent.to === email.trim();
  const canSend = okEmail && !busy && !(sentNow && left > 0);
  const canLogin = sentNow && /^\d{6}$/.test(code.trim()) && agree && !busy;

  const send = async () => {
    if (!canSend) return;
    setBusy('send');
    setErr(null);
    try {
      const r = await sendCode(email, showInvite ? invite : undefined);
      setSent({ to: email.trim(), until: Date.now() + r.resendAfter * 1000, ttl: r.expiresIn ?? opts?.codeTtlSec ?? 600, dev: r.devCode });
      setNeedInvite(false);
      if (r.devCode) setCode(r.devCode);
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (e) {
      const c = codeOf(e);
      if (c === 'need-invite') {
        setNeedInvite(true);
        setShowInvite(true);
        setTimeout(() => inviteRef.current?.focus(), 0);
      } else if (c === 'bad-invite') {
        setShowInvite(true);
        setErr({ at: 'invite', text: errText(e) });
      } else setErr({ at: 'email', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };
  const submit = async () => {
    if (!canLogin) return;
    setBusy('login');
    setErr(null);
    try {
      await login(email, code, showInvite ? invite : undefined);
      void refreshOfficialAccount();
      onClose();
    } catch (e) {
      const c = codeOf(e);
      if (c === 'need-invite' || c === 'bad-invite') {
        setShowInvite(true);
        setErr({ at: 'invite', text: errText(e) });
      } else setErr({ at: 'code', text: errText(e) });
      setBusy(null);
    }
  };
  const fromLink = !!linkInvite && invite === linkInvite && err?.at !== 'invite';
  const mins = Math.max(1, Math.round((sent?.ttl ?? 600) / 60));

  return (
    <Dialog phone={phone} label="登录" onClose={busy ? undefined : onClose} testId="login-dialog">
      <div className="acct-body">
        <div className="acct-seg" role="tablist" aria-label="登录方式">
          <button className="on" role="tab" aria-selected="true">
            邮箱
          </button>
          {/* 手机号登录网页这边还没做:服务器开了也先置灰 */}
          <button role="tab" aria-selected="false" disabled title="手机号登录暂未开放">
            手机号<em>暂未开放</em>
          </button>
        </div>
        <p className="acct-lead">
          {inviteOnly ? '用邮箱收验证码登录，不用设密码。现在是邀请制，新邮箱第一次登录要填邀请码。' : '用邮箱收验证码登录，不用设密码。第一次登录会自动注册。'}
        </p>
        <div>
          <div className="acct-fld">
            <input
              ref={emailRef}
              className="acct-in"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="邮箱"
              aria-label="邮箱"
              data-testid="login-email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (err?.at === 'email') setErr(null);
                if (needInvite) setNeedInvite(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && void send()}
            />
            <button className="acct-btn lg" data-act="send-code" disabled={!canSend} onClick={() => void send()} style={phone ? { padding: '0 10px' } : undefined}>
              {sendLabel(sentNow, left, busy === 'send')}
            </button>
          </div>
          {err?.at === 'email' && <p className="acct-err">{err.text}</p>}
        </div>
        {needInvite && (
          <div className="acct-callout" data-testid="need-invite">
            <Icon name="info" size={16} />
            <span>
              这个邮箱还没有账号。现在只开放给收到邀请的人，填上邀请码就能注册。
              <br />
              <span className="sub">没有邀请码也没关系：不登录照样什么都能用，世界存在这个浏览器里。</span>
            </span>
          </div>
        )}
        {showInvite && (
          <div>
            <label className="acct-in inv">
              <span className="pre">邀请码</span>
              <input
                ref={inviteRef}
                autoComplete="off"
                spellCheck={false}
                data-testid="login-invite"
                value={invite}
                onChange={(e) => {
                  setInvite(e.target.value);
                  if (err?.at === 'invite') setErr(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && void send()}
              />
            </label>
            {fromLink && (
              <p className="acct-okl">
                <Icon name="check" size={14} />
                从邀请链接带过来的，已经填好
              </p>
            )}
            {err?.at === 'invite' && <p className="acct-err">{err.text}</p>}
          </div>
        )}
        <div>
          <input
            ref={codeRef}
            className="acct-in code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 位验证码"
            aria-label="验证码"
            data-testid="login-code"
            disabled={!sentNow}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              if (err?.at === 'code') setErr(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
          {sentNow && (
            <p className="acct-small" style={{ marginTop: 6 }}>
              验证码已发到 {sent!.to}，{mins} 分钟内有效。没收到的话，看看垃圾邮件。
              {sent!.dev && `（开发用假服务器：验证码是 ${sent!.dev}，已经填好）`}
            </p>
          )}
          {err?.at === 'code' && <p className="acct-err">{err.text}</p>}
        </div>
        <label className="acct-chk">
          <input type="checkbox" data-testid="login-agree" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <i className="b" aria-hidden="true">
            {agree && <Icon name="check" size={12} />}
          </i>
          <span>
            已阅读并同意{' '}
            <a href={TERMS_URL} target="_blank" rel="noreferrer">
              用户协议
            </a>{' '}
            和{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
              隐私政策
            </a>
          </span>
        </label>
        {phone && <LoginFoot n={n} busy={busy === 'login'} disabled={!canLogin} onLogin={submit} phone />}
      </div>
      {!phone && <LoginFoot n={n} busy={busy === 'login'} disabled={!canLogin} onLogin={submit} />}
    </Dialog>
  );
}

function LoginFoot({ n, busy, disabled, onLogin, phone }: { n: number; busy: boolean; disabled: boolean; onLogin: () => void; phone?: boolean }) {
  const line = n ? `登录后，这个浏览器里的 ${n} 个世界会存进你的账号。` : '登录后，你的世界会存进账号，换电脑、换手机都能接着改。';
  const btn = (
    <button className="acct-btn blue full" data-act="login" disabled={disabled} onClick={onLogin}>
      {busy ? '正在登录' : '登录'}
    </button>
  );
  if (phone)
    return (
      <>
        <div style={{ marginTop: 2 }}>{btn}</div>
        <p className="acct-small center" style={{ marginTop: -4 }}>
          {line}
        </p>
      </>
    );
  return (
    <div className="acct-foot col">
      {btn}
      <p className="acct-small center">{line}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 账号

/** "10月3日"(不是今年的带年份) */
function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`;
}

function AccountDialog({ phone, onClose }: { phone: boolean; onClose: () => void }) {
  const s = useSession()!;
  const sync = useSyncView();
  const acct = useOfficialAccount();
  const aiOn = useAiOn();
  useSavesVersion();
  const [trashList, setTrashList] = useState<TrashEntry[] | null>(null);
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    void listTrash()
      .then((t) => live && setTrashList(t))
      .catch(() => {});
    void listShares()
      .then((l) => live && setShares(l))
      .catch(() => live && setShares([]));
    void refreshOfficialAccount();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const n = listWorlds().length;
  const unsynced = unsyncedCount(sync);
  const syncText =
    sync.phase === 'syncing' || sync.busy.size
      ? { text: '正在同步', warn: false }
      : unsynced
        ? { text: `${unsynced} 个世界还没同步上`, warn: true }
        : sync.phase === 'offline' || sync.phase === 'error'
          ? { text: sync.message ?? '连不上服务器，联网后会自动同步', warn: true }
          : !n
            ? { text: '还没有世界', warn: false }
            : { text: `${n} 个世界都已同步${sync.lastOk ? `，${when(sync.lastOk)}` : ''}`, warn: false };
  const trashText = trashList === null ? '' : trashList.length ? `${trashList.length} 个，30 天内能找回` : '没有';

  const go = (kind: 'logout' | 'delete') => {
    panel = { kind };
    emit();
  };
  return (
    <Dialog
      phone={phone}
      label="账号"
      width={500}
      onClose={onClose}
      testId="account-dialog"
      head={
        <div className="acct-head acct-who">
          <Icon name="personc" size={44} />
          <div className="acct-who-text">
            <h2>{displayName(s.user)}</h2>
            <div className="acct-small">
              {s.user.account.includes('@') ? '邮箱' : '手机号'} {s.user.account}
            </div>
          </div>
          <CloseX onClose={onClose} />
        </div>
      }
    >
      <div className="acct-body" style={{ gap: 18 }}>
        <div className="acct-grp">
          <div className="acct-gr" data-row="sync">
            <Icon name="cloudok" size={19} />
            <span className="main">
              <b>云同步</b>
            </span>
            <span className={`side${syncText.warn ? ' warn' : ''}`}>{syncText.text}</span>
          </div>
          <button className="acct-gr" data-act="open-trash" onClick={() => openTrash()}>
            <Icon name="restore" size={19} />
            <span className="main">
              <b>最近删除</b>
            </span>
            <span className="side">{trashText}</span>
            <Icon name="chevron" size={14} className="chev" />
          </button>
          {aiOn && (
            <button
              className="acct-gr"
              data-act="open-credits"
              onClick={() => {
                onClose();
                openAiSettings('settings');
              }}
            >
              <Icon name="sparkle" size={19} />
              <span className="main">
                <b>AI 积分</b>
              </span>
              <span className="side">{acct.credits !== undefined ? `剩 ${acct.credits}` : ''}</span>
              <Icon name="chevron" size={14} className="chev" />
            </button>
          )}
        </div>
        {!!shares?.length && (
          <>
            <div className="acct-gh">
              分享出去的世界<small>拿到链接的人能看，不能改</small>
            </div>
            <div className="acct-grp" data-testid="share-list">
              {shares.map((sh) => {
                const thumb = loadWorld(sh.worldId)?.thumb;
                return (
                  <div className="acct-gr" key={sh.code}>
                    <span className="th2" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined} />
                    <span className="main">
                      <b>{sh.title || '未命名世界'}</b>
                      <small>
                        {day(sh.createdAt)}开始分享，打开过 {sh.opens} 次
                      </small>
                    </span>
                    <button
                      className="mini"
                      onClick={() =>
                        void copyText(shortLink(sh.code)).then((ok) => (ok ? setCopied(sh.code) : setErr(`没能自动复制，请手动复制：${shortLink(sh.code)}`)))
                      }
                    >
                      {copied === sh.code ? '已复制' : '复制链接'}
                    </button>
                    <button
                      className="mini red"
                      onClick={() =>
                        void stopShare(sh.worldId)
                          .then(() => setShares((l) => (l ?? []).filter((x) => x.code !== sh.code)))
                          .catch((e) => setErr(errText(e)))
                      }
                    >
                      停止分享
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
        {err && <p className="acct-err">{err}</p>}
      </div>
      <div className="acct-foot">
        <button className="acct-link red" data-act="delete-account" onClick={() => go('delete')}>
          注销账号
        </button>
        <span className="acct-sp" />
        <button className="acct-btn lg" data-act="logout" onClick={() => go('logout')}>
          <Icon name="logout" size={16} />
          退出登录
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 退出登录

function LogoutDialog({ phone, onClose, onBack }: { phone: boolean; onClose: () => void; onBack: () => void }) {
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const n = useMemo(() => listWorlds().length, []);
  const go = async () => {
    setBusy(true);
    setErr('');
    const r = await signOut(keep);
    if (r.ok) return onClose();
    setErr(r.message);
    setBusy(false);
  };
  const choice = (v: boolean, title: string, sub: string) => (
    <label className={`acct-radio${keep === v ? ' on' : ''}`}>
      <input type="radio" name="logout-keep" checked={keep === v} onChange={() => setKeep(v)} />
      <i className="o" aria-hidden="true" />
      <span>
        <b>{title}</b>
        <small>{sub}</small>
      </span>
    </label>
  );
  return (
    <Dialog phone={phone} label="退出登录？" width={440} onClose={busy ? undefined : onBack} testId="logout-dialog" head={<div className="acct-head"><h2>退出登录？</h2></div>}>
      <div className="acct-body" style={{ gap: 10 }}>
        <p className="acct-lead" style={{ marginBottom: 4 }}>
          {n ? `账号里的 ${n} 个世界都还在，下次登录会回来。` : '账号里的世界都还在，下次登录会回来。'}这台设备上的要不要留着？
        </p>
        {choice(true, '留在这台设备上', '没登录也能接着看、接着改，下次登录再同步')}
        {choice(false, '从这台设备上删掉', '在别人的电脑、网吧用完选这个')}
        {err && <p className="acct-err">{err}</p>}
      </div>
      <div className="acct-foot">
        <span className="acct-sp" />
        <button className="acct-btn lg" disabled={busy} onClick={onBack}>
          取消
        </button>
        <button className="acct-btn lg blue" data-act="logout-confirm" disabled={busy} onClick={() => void go()}>
          {busy && !keep ? '正在同步' : '退出登录'}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 注销账号(照退出登录那个窗的样子)

function DeleteDialog({ phone, onClose, onBack }: { phone: boolean; onClose: () => void; onBack: () => void }) {
  const s = useSession()!;
  const [until, setUntil] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'delete' | null>(null);
  const [err, setErr] = useState('');
  const left = useCountdown(until);
  const send = async () => {
    setBusy('send');
    setErr('');
    try {
      const r = await sendCode(s.user.account);
      setUntil(Date.now() + r.resendAfter * 1000);
      if (r.devCode) setCode(r.devCode);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const go = async () => {
    setBusy('delete');
    setErr('');
    try {
      // 等回话的工夫别的标签页换了账号:这个窗已经关了,新登录的那个账号的同步不动
      if (await deleteAccount(code)) {
        accountDeleted();
        onClose();
      }
      notify({ kind: 'ok', text: '账号已注销', more: ['这台设备上的世界还在'] });
    } catch (e) {
      setErr(errText(e));
      setBusy(null);
    }
  };
  return (
    <Dialog phone={phone} label="注销账号？" width={440} onClose={busy ? undefined : onBack} testId="delete-dialog" head={<div className="acct-head"><h2>注销账号？</h2></div>}>
      <div className="acct-body" style={{ gap: 10 }}>
        <p className="acct-lead" style={{ marginBottom: 4 }}>
          账号里的世界（连同最近删除）、分享出去的链接和 AI 积分都会删掉，不能恢复。这台设备上的世界不动。
        </p>
        <div className="acct-fld">
          <input
            className="acct-in code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="6 位验证码"
            aria-label="验证码"
            disabled={until === null}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <button className="acct-btn lg" disabled={!!busy || left > 0} onClick={() => void send()}>
            {sendLabel(until !== null, left, busy === 'send')}
          </button>
        </div>
        <p className="acct-small">{until === null ? `验证码会发到 ${s.user.account}` : `验证码已发到 ${s.user.account}`}</p>
        {err && <p className="acct-err">{err}</p>}
      </div>
      <div className="acct-foot">
        <span className="acct-sp" />
        <button className="acct-btn lg" disabled={!!busy} onClick={onBack}>
          取消
        </button>
        <button className="acct-btn lg red" data-act="delete-confirm" disabled={!!busy || !/^\d{6}$/.test(code)} onClick={() => void go()}>
          注销账号
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 分享

/** error 时带着 share = 链接还开着(停分享没成功),开关和链接照旧显示开着 */
type ShareState = { phase: 'prep' } | { phase: 'on'; share: ShareInfo } | { phase: 'off' } | { phase: 'error'; message: string; share?: ShareInfo };

/** 分享是替哪一次登录做的:等的工夫别的标签页退出、换了账号就停下(后面的请求会带上新账号的令牌,链接就开到新账号名下了) */
class ShareAborted extends Error {}
function sameLogin(token: string | undefined): void {
  if (!token || getSession()?.token !== token) throw new ShareAborted('账号变了');
}

/** 正在看的这个世界最新的改动没写进浏览器(存储满了,只在这个页面里):也就存不进账号,分享出去的会是旧的 */
const UNSAVED_WHY = '这个世界最新的改动没能存进浏览器（存储满了），也就没存进账号。先删掉几个世界腾出地方，再分享';
const unsavedHere = (worldId: string) => currentWorld()?.id === worldId && currentUnsaved();

/**
 * 分享前同步一遍(全看一遍,改过的存上去):这个世界没存上就不开分享(不然链接给出去的是账号里的旧样子);
 * 账号里的比这里新(别的设备改过、还没「载入」)也不开(不然给出去的不是眼前这个)
 */
async function pushForShare(worldId: string, token: string | undefined): Promise<void> {
  sameLogin(token);
  if (unsavedHere(worldId)) throw new Error(UNSAVED_WHY);
  const v = await syncNow();
  sameLogin(token);
  if (v.phase === 'offline') throw new ServerError(0, 'network', v.message ?? '连不上服务器');
  // 没同步完(服务器出错之类):不知道账号里是不是眼前这个样子,先不开
  if (v.phase !== 'idle') throw new Error(v.message ?? '没能和账号同步，稍后再试');
  const why = v.failed.get(worldId);
  if (why !== undefined) throw new Error(`这个世界最新的样子还没存进账号：${why}`);
  if (unsavedHere(worldId)) throw new Error(UNSAVED_WHY);
  if (behindCloud(worldId)) throw new Error('这个世界在另一台设备上改过，账号里的比这里新：先点「载入」换成那边的样子，再分享');
}

function ShareDialog({ phone, worldId, title, onClose }: { phone: boolean; worldId: string; title: string; onClose: () => void }) {
  const [st, setSt] = useState<ShareState>({ phase: 'prep' });
  /** 正在开 / 停分享 */
  const [busy, setBusy] = useState(false);
  /** 同一件事,给不等重新渲染就要看的地方(刚离开署名框就点了开关) */
  const busyRef = useRef(false);
  /** 正在存署名 */
  const [savingBy, setSavingBy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  /** 刚改的署名存好了,但系统的分享面板没让打开(等存的时候"刚点过"过期了):请再点一次 */
  const [again, setAgain] = useState(false);
  /** 署名输入框里的字(链接开着时按链接上的填好) */
  const [by, setBy] = useState('');
  useEffect(() => {
    let live = true;
    const token = getSession()?.token;
    // 每个请求发出去之前都看一眼:窗口还开着(关了就不再替用户打开分享)、还是同一次登录(请求带的是发出去那一刻登着的令牌)
    const still = () => {
      if (!live) throw new ShareAborted('关了');
      sameLogin(token);
    };
    void (async () => {
      // 世界要先在账号里:只是看看的(别人分享的)先存进"我的世界",再把改过的存上去
      if (!isStored(worldId)) keepWorld(worldId);
      await pushForShare(worldId, token);
      still();
      const list = await listShares();
      still();
      const share = list.find((x) => x.worldId === worldId) ?? (await createShare(worldId));
      still();
      setSt({ phase: 'on', share });
      setBy(share.by ?? '');
    })().catch((e) => {
      if (!live || e instanceof ShareAborted) return;
      const c = codeOf(e);
      setSt({ phase: 'error', message: c === 'not-found' || c === 'network' ? '这个世界还没存进账号，联网以后再试' : errText(e) });
    });
    return () => {
      live = false;
    };
  }, [worldId]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  /** 开着的链接(停分享失败时还开着) */
  const live = st.phase === 'on' || st.phase === 'error' ? st.share : undefined;
  const on = !!live || st.phase === 'prep';
  const url = live ? shortLink(live.code) : '';
  const toggle = async () => {
    if (busyRef.current || st.phase === 'prep') return;
    const token = getSession()?.token;
    busyRef.current = true;
    setBusy(true);
    try {
      // 刚离开署名框就点了开关:署名那次先存完再停 / 开(两个请求一起发的话,后回来的会把开关改回去)
      if (pendingBy.current) await pendingBy.current;
      if (live) {
        sameLogin(token);
        await stopShare(worldId);
        setSt({ phase: 'off' });
      } else {
        // 停了再开是一个新链接:署名跟着框里的
        await pushForShare(worldId, token);
        sameLogin(token);
        const share = await createShare(worldId, cleanSignature(by));
        sameLogin(token);
        setSt({ phase: 'on', share });
        setBy(share.by ?? '');
      }
    } catch (e) {
      if (e instanceof ShareAborted) return;
      // 停没停成:链接照旧算开着(服务器出错时确实还开着;断网时不知道,按开着说)
      setSt({ phase: 'error', message: errText(e), share: live });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  /** 正在存的署名(离开输入框时开始存、紧接着点了完成:等这一次) */
  const pendingBy = useRef<Promise<boolean> | null>(null);
  /** 署名改完(离开输入框、回车):和链接上的不一样就存上去;没存成的说一声,框里换回原来的。返回存好了没有(没改 = 存好了) */
  const saveBy = (): Promise<boolean> => {
    if (pendingBy.current) return pendingBy.current;
    if (!live) return Promise.resolve(true);
    const next = cleanSignature(by);
    if (next === (live.by ?? '')) {
      setBy(next);
      return Promise.resolve(true);
    }
    if (busyRef.current) return Promise.resolve(false);
    const token = getSession()?.token;
    setSavingBy(true);
    const p = (async () => {
      try {
        sameLogin(token);
        const share = await createShare(worldId, next);
        sameLogin(token);
        setSt({ phase: 'on', share });
        setBy(share.by ?? '');
        return true;
      } catch (e) {
        // 换了账号、退出了:这个窗口本来就该关
        if (e instanceof ShareAborted) return true;
        setSt({ phase: 'error', message: errText(e), share: live });
        setBy(live.by ?? '');
        return false;
      } finally {
        setSavingBy(false);
        pendingBy.current = null;
      }
    })();
    pendingBy.current = p;
    return p;
  };
  /** 关窗口(完成、Esc、点外面):署名还没存的先存上,存好了再关;没存成就留着窗口,上面说为什么 */
  const done = () => {
    void saveBy().then((ok) => {
      if (ok) onClose();
    });
  };
  const name = title || '未命名世界';
  /** 复制链接、发给别人:署名刚改了的先存好(发出去的链接打开就是新署名);没存成就不发,上面说为什么 */
  const copy = async () => {
    if (!url || !(await saveBy())) return;
    const ok = await copyText(url);
    setCopied(ok);
    setManual(!ok);
    (window as unknown as { __wfShortShare?: { url: string; copied: boolean } }).__wfShortShare = { url, copied: ok };
  };
  const sendTo = async () => {
    if (!url) return;
    setAgain(false);
    // 署名没改:马上打开系统的分享面板(要在点按钮的那一下里打开)
    const dirty = !!pendingBy.current || cleanSignature(by) !== (live?.by ?? '');
    if (dirty && !(await saveBy())) return;
    const act = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (dirty && act && !act.isActive) return setAgain(true);
    await navigator.share({ title: `「${name}」`, url }).catch((e: unknown) => {
      if (dirty && e instanceof DOMException && e.name === 'NotAllowedError') setAgain(true);
    });
  };
  const canSend = phone && typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const urlBox = (
    <div className={`url${live ? '' : ' off'}`} data-testid="share-url">
      <Icon name="link" size={15} />
      <span>{live ? url.replace(/^https?:\/\//, '') : st.phase === 'prep' ? '正在生成链接' : '分享已停止，链接打不开了'}</span>
    </div>
  );
  const copyBtn = (
    <button className={`acct-btn lg blue${phone ? ' full' : ''}`} data-act="copy-short-link" disabled={!live} onClick={() => void copy()}>
      <Icon name="copy" size={phone ? 17 : 16} />
      {copied ? '已复制' : '复制链接'}
    </button>
  );
  return (
    <Dialog phone={phone} label={`分享「${name}」`} width={480} onClose={done} testId="share-dialog">
      <div className="acct-body" style={{ paddingTop: phone ? 8 : 10, gap: phone ? 14 : 16 }}>
        <div className="acct-grp">
          <div className="acct-gr" style={{ minHeight: phone ? 58 : 56 }}>
            <Icon name="link" size={19} />
            <span className="main">
              <b>用链接分享</b>
              <small>{phone ? '关掉就停止分享，链接马上打不开' : '关掉就停止分享，发出去的链接马上打不开'}</small>
            </span>
            <button
              className={`acct-tg${on ? ' on' : ''}`}
              role="switch"
              aria-checked={on}
              aria-label="用链接分享"
              data-act="share-toggle"
              disabled={busy || st.phase === 'prep'}
              onClick={() => void toggle()}
            />
          </div>
          <div className="acct-gr" style={{ minHeight: phone ? 58 : 56 }}>
            <Icon name="person" size={19} />
            <span className="main">
              <b>署名</b>
              <small>别人另存时写进出处，可以不填</small>
            </span>
            <input
              className="acct-in sm"
              data-act="share-by"
              aria-label="署名"
              value={by}
              // 只防太长;按看到的字截到 20 个由 cleanSignature 做(maxLength 按 UTF-16 算,一个组合表情就占好几个)
              maxLength={SIGNATURE_UNITS}
              disabled={!live || busy || savingBy}
              onChange={(e) => setBy(e.target.value)}
              onBlur={() => void saveBy()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </div>
        </div>
        {phone ? (
          <>
            <div className="acct-linkbox">{urlBox}</div>
            <div className="acct-pair">
              {copyBtn}
              {canSend && (
                <button
                  className="acct-btn full"
                  style={{ fontWeight: 500 }}
                  disabled={!live}
                  onClick={() => void sendTo()}
                >
                  <Icon name="share" size={17} />
                  发给…
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="acct-linkbox">
            {urlBox}
            {copyBtn}
          </div>
        )}
        {manual && url && (
          <p className="acct-small" style={{ userSelect: 'all' }}>
            没能自动复制，请手动复制：{url}
          </p>
        )}
        {again && <p className="acct-small">署名存好了，再点一次「发给…」</p>}
        {st.phase === 'error' && <p className="acct-err">{st.message}</p>}
        <ul className="acct-notes">
          <li>
            <Icon name="check" size={14} />
            拿到链接的人能看地图和整段历史，不用登录。
          </li>
          <li>
            <Icon name="check" size={14} />
            你之后的改动，对方刷新就能看到。
          </li>
          <li>
            <Icon name="check" size={14} />
            对方想改，会另存一份到自己的「我的世界」，写明底稿来自你的「{name}」，动不到你的。
          </li>
        </ul>
      </div>
      {!phone ? (
        <div className="acct-foot">
          <span className="acct-sp" />
          <button className="acct-btn lg" onClick={done}>
            完成
          </button>
        </div>
      ) : (
        <div style={{ height: 6 }} />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 分享停了的那一页;打开别人分享的世界时地图下的说明

export function ShareGone({ phone, state, onHome, onNew }: { phone: boolean; state: 'loading' | 'gone' | { error: string }; onHome: () => void; onNew: () => void }) {
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className={`share-gone${phone ? ' phone' : ''}`} role="main" data-testid="share-gone" onPointerDown={stop} onClick={stop} onWheel={stop}>
      {state !== 'loading' && (
        <div className="share-gone-box">
          <span className="share-gone-ic">
            <Icon name="link" size={28} />
          </span>
          <h2>{state === 'gone' ? '这个分享已经停止了' : '暂时打不开这个分享'}</h2>
          {state === 'gone' ? (
            <p>
              分享的人关掉了这个链接，或者链接没有复制全。
              <br />
              可以请对方重新分享一次。
            </p>
          ) : (
            <p>{state.error}</p>
          )}
          <div className="share-gone-acts">
            <button className="acct-btn lg" data-act="home" onClick={onHome}>
              <Icon name="grid" size={16} />
              我的世界
            </button>
            <button className="acct-btn lg blue" data-act="new-world" onClick={onNew}>
              <Icon name="plus" size={16} />
              新建世界
            </button>
          </div>
        </div>
      )}
      {!phone && state !== 'loading' && (
        <footer className="mw-foot">
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            源代码
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
            隐私政策
          </a>
          <a href={TERMS_URL} target="_blank" rel="noreferrer">
            用户协议
          </a>
          <span className="mw-ver">版本 {APP_VERSION}</span>
        </footer>
      )}
    </div>
  );
}

/**
 * 地图下的说明。short = 从分享短链接打开的(另存时写明底稿出处);by = 分享的人填的署名。
 * own = 最新版交过来的自己的世界(只在旧网站上出这条说明):换成旧网站的说法
 */
export function SharedHint({ phone, short, by, own, onOk }: { phone: boolean; short: boolean; by: string; own?: boolean; onOk: () => void }) {
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className="shared-hint" role="status" data-testid="shared-hint" onPointerDown={stop} onClick={stop} onDoubleClick={stop}>
      <Icon name="info" size={18} />
      <span>
        {own && OLD_SITE !== null
          ? phone
            ? '你看到的是这个世界原来的样子。改了会另存到旧版的「我的世界」，最新版里的不受影响。'
            : '你看到的是这个世界原来的样子。改了名字或历史会另存一份到旧版的「我的世界」，最新版里的不受影响。'
          : short
            ? `${by || '别人'}分享给你的世界，随便看。改了会另存一份到你的「我的世界」，并写明底稿出处。`
            : phone
              ? '别人分享给你的世界，随便看。改了会另存一份到你的「我的世界」，原来的不受影响。'
              : '别人分享给你的世界，随便看。改了名字或历史会另存一份到你的「我的世界」，原来的不受影响。'}
      </span>
      <button data-act="shared-ok" onClick={onOk}>
        知道了
      </button>
    </div>
  );
}
