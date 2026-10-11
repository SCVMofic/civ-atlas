/**
 * 新建界面里星球的动画和摆放(不碰 React):换样式淡入淡出、换投影变形、开场(板块漂移 → 卷成地球仪)、
 * 换一颗时的漂移、摊平改地形、创建后展开成平常页面的地图、自转和拖动。
 *
 * 每帧按状态算出 PlanetFrame 交给 PlanetGL 画。界面(面板、字幕、光晕)由 Studio.tsx 管,这里通过 hooks 告诉它
 * 星球在哪、漂移到哪了、平面地图该放在哪。异步的几段动画(开场、换一颗)各拿一个序号,后开始的作废先开始的。
 */
import type { PlanetProjection } from '../../render/planet';
import { PlanetGL, type PlanetFrame } from './planetGL';
import { TILT, easeInOut, fitPose, flatRect, lerpPose, projExtent, type Box, type Pose } from './layout';

export interface SceneHooks {
  /** 画完一帧:星球的中心、卷起来时的半径、卷了多少、图的半高(光晕、字幕跟着它) */
  frame(info: { cx: number; cy: number; r: number; m: number; hh: number }): void;
  /** 漂移进度(字幕);null = 没在漂移 */
  caption(t: number | null): void;
  /** 平面模式:平常的地图该铺在哪(视口坐标),lon = 让它正中是哪条经线(度,只在刚摊平时给);null = 收起平面地图 */
  flat(rect: Box | null, lon?: number): void;
  /** 用户按住拖了星球(收起提示、手机上收起样式列表) */
  touched(): void;
  /** 星球停住了(不变形、不转、没在拖):这时的样子(地名按它排);null = 又动起来了 / 摊平了 */
  still(pose: StillPose | null): void;
}

/** 停住时星球的样子:投影、正中的经纬度(弧度;平面投影纬度 = 0)、投影平面 1 单位多少像素、图的中心 */
export interface StillPose {
  proj: PlanetProjection;
  lon: number;
  lat: number;
  k: number;
  cx: number;
  cy: number;
  /** 视口大小 */
  w: number;
  h: number;
}

/** 平常的地图现在的样子(从平面模式回到星球时,从这里接着变形) */
export interface FlatGeom {
  /** 正中的经度(度) */
  lon: number;
  /** 等距圆柱 1 弧度多少像素 */
  kpx: number;
  cx: number;
  cy: number;
}

interface Tween {
  from: number;
  to: number;
  t0: number;
  dur: number;
  ease: (t: number) => number;
  done: () => void;
}

type Num = 'mix' | 's' | 'drift' | 'boxT' | 'markA' | 'lon' | 'tilt';

/** 自转:约 1 分钟一圈(弧度 / 毫秒) */
const SPIN = 0.00011;
const linear = (t: number) => t;

/**
 * 卷起来时的俯仰跟着卷的程度走,但几乎卷好才开始俯:没卷严的球两极还开着口、背后还有一道缝,
 * 早早俯下去会从北极的口里看穿背后的缝,露出一块黑
 */
function tiltIn(m: number): number {
  const x = Math.min(1, Math.max(0, (m - 0.94) / 0.06));
  return x * x * (3 - 2 * x);
}

export class StudioScene {
  readonly gl: PlanetGL;
  private hooks: SceneHooks;
  readonly reduce: boolean;
  phone = false;
  // 样式:a 是现在的,b 是上一张(淡入淡出时 mix 从 0 到 1)
  a = '';
  b = '';
  mix = 1;
  /** 漂移用的实景贴图键 */
  real = '';
  // 投影:A → B 变形到 s;poseA / poseB 不为空时用它的位置(平常的地图那边接过来、送过去)
  projA: PlanetProjection = 'equirect';
  projB: PlanetProjection = 'equirect';
  s = 1;
  poseA: Pose | null = null;
  poseB: Pose | null = null;
  lon = 0;
  /** 用户上下拖出来的俯仰(加在 TILT 上) */
  tilt = 0;
  spin = false;
  drift: number | null = null;
  markA = 0;
  /** 开场:地图占满窗口(两边面板还没出来) */
  intro = false;
  /** 两边、底下让出多少(面板、手机的底部卡片) */
  private insets = { l: 0, r: 0, b: 0 };
  private vw = 1;
  private vh = 1;
  private box: Box = { x: 0, y: 0, w: 1, h: 1 };
  private boxFrom: Box | null = null;
  private boxT = 1;
  /** 平面模式(改地形、平常的地图露出来):星球不画 */
  flatOn = false;
  /** 摊平之前是哪种投影(收起时变回去) */
  private flatBack: PlanetProjection = 'globe';
  private tweens = new Map<Num, Tween>();
  private raf = 0;
  private last = 0;
  /** 开场 / 换一颗 / 摊平这几段动画的序号 */
  private tok = 0;
  private drag: { x: number; y: number; lon: number; tilt: number; id: number } | null = null;
  /** 上次告诉界面的停住的样子(没变就不再说) */
  private stillKey = '';

  constructor(gl: PlanetGL, hooks: SceneHooks, reduce: boolean) {
    this.gl = gl;
    this.hooks = hooks;
    this.reduce = reduce;
    const cv = gl.canvas;
    cv.addEventListener('pointerdown', this.onDown);
    cv.addEventListener('pointermove', this.onMove);
    cv.addEventListener('pointerup', this.onUp);
    cv.addEventListener('pointercancel', this.onUp);
  }

  start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.tok++;
    for (const t of this.tweens.values()) t.done();
    this.tweens.clear();
    const cv = this.gl.canvas;
    cv.removeEventListener('pointerdown', this.onDown);
    cv.removeEventListener('pointermove', this.onMove);
    cv.removeEventListener('pointerup', this.onUp);
    cv.removeEventListener('pointercancel', this.onUp);
    this.gl.dispose();
  }

  // ---- 补间 ----

  /** 一个数从现在的值补到 to,dur 毫秒;"减少动态效果"时最多 120 毫秒 */
  tween(key: Num, to: number, dur: number, ease = easeInOut): Promise<void> {
    return new Promise((done) => {
      const prev = this.tweens.get(key);
      prev?.done();
      const d = this.reduce ? Math.min(dur, 120) : dur;
      this.tweens.set(key, { from: this.get(key), to, t0: performance.now(), dur: Math.max(1, d), ease, done });
    });
  }

  private get(k: Num): number {
    if (k === 'drift') return this.drift ?? 1;
    if (k === 'boxT') return this.boxT;
    return this[k];
  }
  private put(k: Num, v: number) {
    if (k === 'drift') this.drift = v;
    else if (k === 'boxT') this.boxT = v;
    else this[k] = v;
  }

  private step(now: number) {
    for (const [k, t] of this.tweens) {
      const u = Math.min(1, (now - t.t0) / t.dur);
      this.put(k, t.from + (t.to - t.from) * t.ease(u));
      if (u >= 1) {
        this.tweens.delete(k);
        t.done();
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, this.reduce ? 0 : ms));
  }

  // ---- 摆放 ----

  /** 窗口大小变了 */
  setViewport(w: number, h: number, dpr: number): void {
    this.vw = Math.max(1, w);
    this.vh = Math.max(1, h);
    this.gl.resize(this.vw, this.vh, dpr);
    this.relayout(false);
  }

  /** 两边面板、底部卡片让出多少;intro = 开场占满窗口。animate = 星球跟着面板滑过去(约 0.36 秒) */
  setLayout(o: { l: number; r: number; b: number; intro: boolean; phone: boolean }, animate: boolean): void {
    const same = o.l === this.insets.l && o.r === this.insets.r && o.b === this.insets.b && o.intro === this.intro && o.phone === this.phone;
    this.insets = { l: o.l, r: o.r, b: o.b };
    this.intro = o.intro;
    this.phone = o.phone;
    if (!same) this.relayout(animate);
  }

  private targetBox(): Box {
    if (this.intro) return { x: 0, y: 0, w: this.vw, h: this.vh };
    const { l, r, b } = this.insets;
    return { x: l, y: 0, w: Math.max(1, this.vw - l - r), h: Math.max(1, this.vh - b) };
  }

  private curBox(): Box {
    const f = this.boxFrom;
    if (this.boxT >= 1 || !f) return this.box;
    const t = easeInOut(this.boxT);
    const to = this.box;
    return { x: f.x + (to.x - f.x) * t, y: f.y + (to.y - f.y) * t, w: f.w + (to.w - f.w) * t, h: f.h + (to.h - f.h) * t };
  }

  private relayout(animate: boolean) {
    const to = this.targetBox();
    if (animate && !this.reduce) {
      this.boxFrom = this.curBox();
      this.box = to;
      this.boxT = 0;
      void this.tween('boxT', 1, 360);
    } else {
      this.box = to;
      this.boxT = 1;
      this.boxFrom = null;
    }
    if (this.flatOn) this.hooks.flat(this.flatRect());
  }

  private fitOpts() {
    return { phone: this.phone, intro: this.intro };
  }

  /** 平面模式时平常的地图铺在哪(等距圆柱在现在这块地方里的位置) */
  flatRect(): Box {
    return flatRect(this.targetBox(), this.fitOpts());
  }

  /** 现在这一帧:星球摆在哪、多大 */
  private pose(): { k: number; cx: number; cy: number; m: number; hh: number } {
    const b = this.curBox();
    const o = this.fitOpts();
    const pa = this.poseA ?? fitPose(this.projA, b, o);
    const pb = this.poseB ?? fitPose(this.projB, b, o);
    const s = this.s;
    const p = lerpPose(pa, pb, s);
    const m = (this.projA === 'globe' ? 1 - s : 0) + (this.projB === 'globe' ? s : 0);
    const ha = (projExtent(this.projA).h / 2) * pa.k;
    const hb = (projExtent(this.projB).h / 2) * pb.k;
    return { ...p, m, hh: ha + (hb - ha) * s };
  }

  // ---- 每帧 ----

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.last ? Math.min(100, now - this.last) : 0;
    this.last = now;
    this.step(now);
    if (this.spin && !this.reduce && !this.drag && this.projB === 'globe' && this.s >= 1) this.lon -= dt * SPIN;
    if (this.drift !== null) this.hooks.caption(this.drift);
    this.reportStill();
    if (this.flatOn) return;
    this.draw();
  };

  /** 停住没有(换样式的淡入淡出不算动);停住了且样子变了才告诉界面 */
  private reportStill() {
    const moving =
      this.flatOn ||
      !!this.drag ||
      this.drift !== null ||
      this.s < 1 ||
      (this.spin && !this.reduce && this.projB === 'globe') ||
      this.tweens.has('s') ||
      this.tweens.has('lon') ||
      this.tweens.has('tilt') ||
      this.tweens.has('boxT');
    if (moving) {
      if (this.stillKey) {
        this.stillKey = '';
        this.hooks.still(null);
      }
      return;
    }
    const p = this.pose();
    const globe = this.projB === 'globe';
    const pose: StillPose = { proj: this.projB, lon: this.lon, lat: globe ? TILT + this.tilt : 0, k: p.k, cx: p.cx, cy: p.cy, w: this.vw, h: this.vh };
    const key = `${pose.proj}|${pose.lon.toFixed(5)}|${pose.lat.toFixed(5)}|${pose.k.toFixed(2)}|${pose.cx.toFixed(1)}|${pose.cy.toFixed(1)}|${pose.w}|${pose.h}`;
    if (key === this.stillKey) return;
    this.stillKey = key;
    this.hooks.still(pose);
  }

  /** 转到正对着某处(经度、纬度,弧度;只在停着的地球仪上转),约 0.9 秒;转过去以后不再自转 */
  face(lon: number, lat: number): Promise<void> {
    if (this.projB !== 'globe' || this.s < 1 || this.flatOn || this.drift !== null || this.drag) return Promise.resolve();
    this.spin = false;
    const d = lon - this.lon;
    const to = this.lon + d - 2 * Math.PI * Math.round(d / (2 * Math.PI));
    const tilt = Math.max(-1.1, Math.min(0.9, lat - TILT));
    return Promise.all([this.tween('lon', to, 900), this.tween('tilt', tilt, 900)]).then(() => undefined);
  }

  /** 马上画一帧(从平常的地图接回来时,要先画好再露出来) */
  draw(): void {
    const p = this.pose();
    const f: PlanetFrame = {
      projA: this.projA,
      projB: this.projB,
      s: this.s,
      m: p.m,
      k: p.k,
      cx: p.cx,
      cy: p.cy,
      tilt: (TILT + this.tilt) * tiltIn(p.m),
      lon: this.lon,
      a: this.a,
      b: this.b || this.a,
      mix: this.mix,
      drift: this.drift,
      real: this.real,
      markA: this.markA,
    };
    this.gl.draw(f);
    this.hooks.frame({ cx: p.cx, cy: p.cy, r: p.k * p.m, m: p.m, hh: p.hh });
  }

  // ---- 样式、投影 ----

  /** 换样式:从现在这张淡到 key(贴图要先放好);dur 毫秒 */
  setStyle(key: string, dur = 450): Promise<void> {
    if (!this.a) {
      this.a = this.b = key;
      this.mix = 1;
      return Promise.resolve();
    }
    if (key === this.a && this.mix >= 1) return Promise.resolve();
    this.b = this.mix >= 0.5 ? this.a : this.b;
    this.a = key;
    this.mix = 0;
    return this.tween('mix', 1, dur);
  }

  /** 马上换成这张(不淡入) */
  showStyle(key: string): void {
    this.tweens.get('mix')?.done();
    this.tweens.delete('mix');
    this.a = this.b = key;
    this.mix = 1;
  }

  /** 换投影:从现在的样子变形过去;dur 毫秒 */
  setProj(id: PlanetProjection, dur = 900): Promise<void> {
    if (id === this.projB && this.s >= 1 && !this.poseB) return Promise.resolve();
    // 正变到一半又换:从变到一半的样子接着变(按现在的位置记成 A 的姿势)
    if (this.s < 1) {
      const p = this.pose();
      this.poseA = { k: p.k, cx: p.cx, cy: p.cy };
      this.projA = this.s < 0.5 ? this.projA : this.projB;
    } else {
      this.poseA = this.poseB;
      this.projA = this.projB;
    }
    this.projB = id;
    this.poseB = null;
    this.s = 0;
    return this.tween('s', 1, dur).then(() => {
      if (this.s >= 1) this.poseA = null;
    });
  }

  /** 马上摆成这种投影 */
  showProj(id: PlanetProjection): void {
    this.tweens.get('s')?.done();
    this.tweens.delete('s');
    this.projA = this.projB = id;
    this.poseA = this.poseB = null;
    this.s = 1;
  }

  // ---- 开场、漂移 ----

  /** 放一遍板块漂移(从约 1.8 亿年前到今天);放不了(没有板块、显卡不支持)直接返回 false */
  async playDrift(dur: number, tok: number): Promise<boolean> {
    if (!this.gl.canDrift() || this.reduce) return false;
    this.drift = 0;
    // 看门狗:补间按帧走(step 里的时间戳),帧停了(后台、驱动重置、CI 的无头 shell)它永远走不完,
    // 字幕和「换一颗 / 重看 / 创建」就锁死在那里。超过时长一点就强制收尾,锁的时间有个上界
    await Promise.race([this.tween('drift', 1, dur, linear), this.wait(dur + 1200)]);
    if (tok !== this.tok) return false; // 被顶掉:drift、字幕归接手的管(重放/换一颗自己放新的,跳过/创建/摊平自己收)
    this.tweens.get('drift')?.done(); // 看门狗赢的这场:把还挂着的补间拔掉(自然走完时它已经被 step 删了)
    this.tweens.delete('drift');
    this.drift = null;
    this.hooks.caption(1);
    return true;
  }

  /**
   * 开场:平面实景放板块漂移 → 停一下 → 卷成地球仪 → onSettled(两边面板滑进来、开始自转)。
   * fromStart = 刚进新建(直接从平面开始);否则(重看星球形成)先从现在的样子变回平面。
   * real = 实景贴图键;lon = 正中摆哪条经线。返回 false = 中途被跳过 / 作废
   */
  async playIntro(o: { fromStart: boolean; real: string; lon: number; onFlat?: () => void }): Promise<boolean> {
    const tok = ++this.tok;
    this.spin = false;
    this.real = o.real;
    if (this.reduce) {
      this.showStyle(o.real);
      this.lon = o.lon;
      this.tilt = 0;
      this.showProj('globe');
      return true;
    }
    if (o.fromStart) {
      this.showStyle(o.real);
      this.showProj('equirect');
      this.lon = o.lon;
      this.tilt = 0;
    } else {
      void this.setStyle(o.real, 300);
      if (this.projB !== 'equirect') await this.setProj('equirect', 800);
      if (tok !== this.tok) return false;
    }
    o.onFlat?.();
    const drifted = await this.playDrift(4800, tok);
    if (tok !== this.tok) return false;
    if (drifted) await this.wait(700);
    if (tok !== this.tok) return false;
    this.hooks.caption(null);
    await this.setProj('globe', 1900);
    return tok === this.tok;
  }

  /** 跳过开场:漂移停下,直接卷成地球仪 */
  async skip(): Promise<void> {
    const tok = ++this.tok;
    this.tweens.get('drift')?.done();
    this.tweens.delete('drift');
    this.drift = null;
    this.hooks.caption(null);
    if (this.projB !== 'globe' || this.s < 1) await this.setProj('globe', 700);
    if (tok !== this.tok) return;
  }

  /** 换了一颗星球:在现在的视图上放一遍漂移(约 2.6 秒),放之前换成实景,放完换回 keep */
  async rerollDrift(real: string, keep: () => string): Promise<void> {
    const tok = ++this.tok;
    this.real = real;
    this.showStyle(real);
    const ok = await this.playDrift(2600, tok);
    if (tok !== this.tok) return;
    if (ok) this.hooks.caption(null);
    const k = keep();
    if (k !== real) void this.setStyle(k);
  }

  /** 正在放开场 / 漂移(跳过按钮、提示用) */
  get drifting(): boolean {
    return this.drift !== null;
  }

  // ---- 摊平(改地形)----

  /** 摊成等距圆柱,摊好以后让平常的地图铺在那里(hooks.flat) */
  async enterFlat(): Promise<void> {
    const tok = ++this.tok;
    this.spin = false;
    this.drag = null;
    // 正在漂移(换了一颗):停掉、字幕收掉 —— 被顶掉的 playDrift 自己不收尾(这里不是再放一场新的)
    this.tweens.get('drift')?.done();
    this.tweens.delete('drift');
    this.drift = null;
    this.hooks.caption(null);
    this.flatBack = this.projB === 'equirect' && this.flatBack !== 'equirect' ? this.flatBack : this.projB;
    if (this.projB !== 'equirect' || this.s < 1 || this.poseB) await this.setProj('equirect', 900);
    if (tok !== this.tok) return;
    this.flatOn = true;
    this.hooks.flat(this.flatRect(), wrapDeg((this.lon * 180) / Math.PI));
  }

  /** 收起平面地图:从平常的地图现在的样子(geom)接着变回原来的投影 */
  exitFlat(geom: FlatGeom | null): Promise<void> {
    ++this.tok;
    const back = this.flatBack;
    if (!this.flatOn) return this.setProj(back);
    this.flatOn = false;
    this.tweens.get('s')?.done();
    this.tweens.delete('s');
    this.projA = 'equirect';
    this.projB = back;
    this.s = 0;
    if (geom) {
      this.lon = (geom.lon * Math.PI) / 180;
      this.poseA = { k: geom.kpx, cx: geom.cx, cy: geom.cy };
    } else this.poseA = null;
    this.poseB = null;
    this.draw();
    this.hooks.flat(null);
    return this.tween('s', 1, 900).then(() => {
      if (this.s >= 1) this.poseA = null;
    });
  }

  /** 没摊平、但已经在等距圆柱上(比如开场时刚好停在平面):记住改完要回哪 */
  setFlatBack(p: PlanetProjection): void {
    this.flatBack = p;
  }

  // ---- 创建以后 ----

  /** 展开成平常页面的地图:proj 投影、pose 的位置,lon = 同时转到正中是这条经线(弧度);返回变完的时候 */
  leave(proj: PlanetProjection, pose: Pose, lon = this.lon): Promise<void> {
    ++this.tok;
    this.spin = false;
    this.drag = null;
    this.tweens.get('drift')?.done();
    this.tweens.delete('drift');
    this.drift = null;
    this.hooks.caption(null);
    if (this.flatOn) {
      this.flatOn = false;
      this.showProj('equirect');
    }
    const p = this.pose();
    this.poseA = { k: p.k, cx: p.cx, cy: p.cy };
    this.projA = this.s < 0.5 ? this.projA : this.projB;
    this.projB = proj;
    this.poseB = pose;
    this.s = 0;
    if (lon !== this.lon) void this.tween('lon', lon, 900);
    return this.tween('s', 1, 900);
  }

  // ---- 拖动 ----

  private onDown = (e: PointerEvent) => {
    if (this.flatOn || e.button > 0) return;
    this.drag = { x: e.clientX, y: e.clientY, lon: this.lon, tilt: this.tilt, id: e.pointerId };
    try {
      this.gl.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 有的浏览器在合成事件上不让捕获 */
    }
    this.gl.canvas.classList.add('dragging');
    this.spin = false;
    this.hooks.touched();
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this.pose();
    const k = Math.max(1, p.k);
    this.lon = d.lon - (e.clientX - d.x) / k;
    if (this.projB === 'globe' && this.s >= 1) this.tilt = Math.max(-1.1, Math.min(0.9, d.tilt + (e.clientY - d.y) / k));
  };

  private onUp = (e: PointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = null;
    this.gl.canvas.classList.remove('dragging');
  };
}

/** 度挪到 [−180, 180) */
function wrapDeg(d: number): number {
  const t = (d + 180) / 360;
  return (t - Math.floor(t)) * 360 - 180;
}
