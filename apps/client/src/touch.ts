import type { Input } from './input';

/**
 * Touch controls for phones and tablets: a move stick bottom left, a look stick bottom right (plus swipe-to-look on
 * the free screen), round action buttons arced around the look stick and a small system bar under the weather badge.
 * Everything is fed into the same Input the keyboard uses (virtual key presses, the analog stick, mouse deltas), so
 * the game itself does not know about touch.
 */

/** Stick travel (px) from the centre to the rim. */
export const STICK_RADIUS = 56;
/** Inner part of the travel that counts as nothing (thumb rest). */
export const DEAD_ZONE = 0.12;
/** Pushed this far (0..1) the move stick runs (on foot) or sprints (on the bike). */
export const RUN_AT = 0.92;
/** Full look-stick deflection turns this fast (rad/s); in "mouse px" via the camera's 0.0025 rad/px. */
const LOOK_YAW_PX_S = 1000;
const LOOK_PITCH_PX_S = 520;
/** Swipe-look: screen px → mouse px. */
const SWIPE_GAIN = 1.5;

/** Stick offset (px from its centre) → direction in −1..1 (x right, y up) with dead zone; magnitude 0..1. */
export function stickVector(dx: number, dy: number, radius = STICK_RADIUS): { x: number; y: number; mag: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0, mag: 0 };
  const raw = Math.min(len / radius, 1);
  const mag = raw <= DEAD_ZONE ? 0 : (raw - DEAD_ZONE) / (1 - DEAD_ZONE);
  return { x: (dx / len) * mag, y: (-dy / len) * mag, mag };
}

/** Look-stick deflection → mouse px this frame: squared response, fine aiming near the centre. */
export function lookDelta(v: { x: number; y: number; mag: number }, dt: number): { dx: number; dy: number } {
  if (v.mag === 0) return { dx: 0, dy: 0 };
  const k = v.mag; // |v| · mag = mag² along the stick's direction
  return { dx: v.x * k * LOOK_YAW_PX_S * dt, dy: -v.y * k * LOOK_PITCH_PX_S * dt };
}

/**
 * Whether to start with the touch overlay: `?touch=1|0` forces it, else a primary coarse pointer (phones, tablets).
 * A touchscreen laptop starts without it and switches it on with its first touch.
 */
export function touchPreferred(param: string | null, coarse: boolean): boolean {
  if (param === '1') return true;
  if (param === '0') return false;
  return coarse;
}

/** What the overlay shows: from the game every frame. */
export type TouchState = {
  /** Game running (the loading screen and the name dialog have no overlay). */
  playing: boolean;
  mode: 'walk' | 'drive' | 'ride';
  bikeType: string | null;
  radio: boolean;
  disco: boolean;
  mapOpen: boolean;
  muted: boolean;
  flying: boolean;
};

type Btn = { el: HTMLButtonElement; label: HTMLSpanElement; icon: HTMLSpanElement };

const ICON = {
  enter: '<path d="M10 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8"/><path d="M3 12h11M10 8l4 4-4 4"/>',
  exit: '<path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8"/><path d="M10 12h11M17 8l4 4-4 4"/>',
  jump: '<path d="M12 20V5M6 11l6-6 6 6"/><path d="M5 21h14"/>',
  brake: '<circle cx="12" cy="12" r="8"/><path d="M12 7v6"/><circle cx="12" cy="16.5" r=".6"/>',
  horn: '<path d="M3 10v4h4l6 4V6L7 10H3z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M7 8l10-5"/><circle cx="15.5" cy="14" r="2.5"/><path d="M6 12h4M6 16h4"/>',
  disco: '<circle cx="12" cy="13" r="7"/><path d="M5 13h14M12 6v14M7 8.5c3 2 7 2 10 0M7 17.5c3-2 7-2 10 0M12 2v4"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  sound: '<path d="M3 10v4h4l6 4V6L7 10H3z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M3 10v4h4l6 4V6L7 10H3z"/><path d="M16 9l5 6M21 9l-5 6"/>',
  gfx: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  figure: '<circle cx="12" cy="6" r="3"/><path d="M12 9v7M8 21l4-5 4 5M6 12h12"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6M16 16l5 5"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="M8 11h6M16 16l5 5"/>',
} as const;

const svg = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const TOUCH_CSS = `
  body.nn-touch, body.nn-touch canvas { touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  /* the keyboard hints mean nothing on a touchscreen */
  body.nn-touch .nn-hint, body.nn-touch .nn-loading-controls, body.nn-touch .nn-bigmap-hint { display: none; }
  body.nn-touch .nn-note { bottom: auto; top: 22%; }
  body.nn-touch .nn-attribution { left: 50%; right: auto; transform: translateX(-50%); bottom: calc(2px + env(safe-area-inset-bottom)); font-size: 9px; opacity: 0.7; }
  body.nn-touch .nn-minimap { top: calc(10px + env(safe-area-inset-top)); right: calc(10px + env(safe-area-inset-right)); }
  body.nn-touch .nn-weather { top: calc(10px + env(safe-area-inset-top)); left: calc(10px + env(safe-area-inset-left)); }
  @media (max-height: 520px), (max-width: 520px) {
    body.nn-touch .nn-minimap, body.nn-touch .nn-minimap-disc, body.nn-touch .nn-minimap-canvas { width: 112px; }
    body.nn-touch .nn-minimap-disc, body.nn-touch .nn-minimap-canvas { height: 112px; }
    body.nn-touch .nn-minimap-street { font-size: 11px; }
  }
  .nn-tc { position: fixed; inset: 0; z-index: 3; pointer-events: none; display: none;
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; font: 600 10px/1 system-ui, sans-serif; color: #fff; }
  body.nn-touch .nn-tc.nn-on { display: block; }
  .nn-tc-safe { position: absolute; visibility: hidden; padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  .nn-tc-zone { position: absolute; bottom: 0; height: 75%; pointer-events: auto; touch-action: none; }
  .nn-tc-zone-l { left: 0; width: 45%; }
  .nn-tc-zone-r { right: 0; width: 55%; }
  .nn-tc-stick { position: absolute; width: ${STICK_RADIUS * 2}px; height: ${STICK_RADIUS * 2}px; margin: -${STICK_RADIUS}px 0 0 -${STICK_RADIUS}px;
    border-radius: 50%; background: radial-gradient(circle, rgba(10,12,20,0.18), rgba(10,12,20,0.38)); border: 2px solid rgba(255,255,255,0.28);
    box-shadow: 0 4px 18px rgba(0,0,0,0.35); pointer-events: none; transition: opacity 0.2s; opacity: 0.55; }
  .nn-tc-stick.nn-active { opacity: 1; border-color: rgba(242,196,107,0.65); }
  .nn-tc-knob { position: absolute; left: 50%; top: 50%; width: 50px; height: 50px; margin: -25px 0 0 -25px; border-radius: 50%;
    background: radial-gradient(circle at 40% 35%, rgba(255,255,255,0.75), rgba(200,206,226,0.45)); box-shadow: 0 2px 8px rgba(0,0,0,0.45); }
  .nn-tc-stick.nn-run .nn-tc-knob { background: radial-gradient(circle at 40% 35%, #ffe6b0, #f2c46b); }
  .nn-tc-cap { position: absolute; left: 50%; top: calc(100% + 6px); transform: translateX(-50%); white-space: nowrap; opacity: 0.7;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9); letter-spacing: 0.04em; }
  .nn-tc-btn { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    width: 58px; height: 58px; margin: -29px 0 0 -29px; padding: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3);
    background: rgba(10,12,20,0.48); color: #fff; font: inherit; pointer-events: auto; touch-action: none; cursor: pointer;
    -webkit-tap-highlight-color: transparent; backdrop-filter: blur(4px); box-shadow: 0 3px 12px rgba(0,0,0,0.4); transition: transform 0.08s, background 0.08s; }
  .nn-tc-btn svg { width: 24px; height: 24px; }
  .nn-tc-btn span { pointer-events: none; }
  .nn-tc-btn .nn-tc-label { font-size: 9px; letter-spacing: 0.02em; text-shadow: 0 1px 2px rgba(0,0,0,0.9); white-space: nowrap; }
  .nn-tc-btn.nn-down { transform: scale(0.9); background: rgba(242,196,107,0.55); border-color: #f2c46b; }
  .nn-tc-btn.nn-main { width: 70px; height: 70px; margin: -35px 0 0 -35px; border-color: rgba(242,196,107,0.7); }
  .nn-tc-btn.nn-main svg { width: 28px; height: 28px; }
  .nn-tc-btn[hidden] { display: none; }
  .nn-tc-sys { position: absolute; left: calc(10px + env(safe-area-inset-left)); top: calc(48px + env(safe-area-inset-top)); display: flex; gap: 8px; pointer-events: none; }
  .nn-tc-sys .nn-tc-btn { position: relative; width: 40px; height: 40px; margin: 0; border-width: 1px; }
  .nn-tc-sys .nn-tc-btn svg { width: 20px; height: 20px; }
  .nn-tc-sys .nn-tc-label { display: none; }
  .nn-tc-zoom { position: absolute; right: calc(16px + env(safe-area-inset-right)); top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 12px; pointer-events: none; }
  .nn-tc-zoom .nn-tc-btn { position: relative; margin: 0; }
  .nn-tc-zoom[hidden] { display: none; }
  .nn-tc-rotate { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%); padding: 10px 16px; border-radius: 12px;
    background: rgba(10,12,20,0.7); font-size: 13px; font-weight: 500; text-align: center; display: none; }
  @media (orientation: portrait) and (max-width: 600px) { .nn-tc-rotate { display: block; } }
`;

/** The on-screen controls; `update(state)` and `tick(dt)` every frame from the render loop. */
export class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly moveStick: HTMLDivElement;
  private readonly lookStick: HTMLDivElement;
  private readonly moveCap: HTMLDivElement;
  /** Pointer driving each stick, the stick's centre and the finger's offset from it. */
  private move: { id: number; cx: number; cy: number; dx: number; dy: number } | null = null;
  private look: { id: number; dx: number; dy: number } | null = null;
  /** Swipes on the free screen that look around: last position per pointer. */
  private readonly swipes = new Map<number, { x: number; y: number }>();
  private readonly btns: Record<'use' | 'jump' | 'horn' | 'radio' | 'disco', Btn>;
  private readonly sysBtns: Record<'map' | 'sound' | 'gfx' | 'figure' | 'full', Btn>;
  private readonly zoom: HTMLDivElement;
  private readonly rotate: HTMLDivElement;
  /** Reads the safe-area insets (notch, home bar) in px. */
  private readonly safe: HTMLDivElement;
  private shown = false;
  private last = '';
  private walk = true;

  constructor(parent: HTMLElement, private readonly input: Input, on: boolean) {
    const style = document.createElement('style');
    style.textContent = TOUCH_CSS;
    document.head.append(style);
    this.root = div('nn-tc', parent);
    this.safe = div('nn-tc-safe', this.root);
    const zl = div('nn-tc-zone nn-tc-zone-l', this.root);
    const zr = div('nn-tc-zone nn-tc-zone-r', this.root);
    this.moveStick = div('nn-tc-stick', this.root);
    div('nn-tc-knob', this.moveStick);
    this.moveCap = div('nn-tc-cap', this.moveStick);
    this.lookStick = div('nn-tc-stick', this.root);
    div('nn-tc-knob', this.lookStick);
    div('nn-tc-cap', this.lookStick).textContent = 'Umsehen';
    const btn = (cls: string, parentEl: HTMLElement, code: string | null, onTap?: () => void): Btn => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `nn-tc-btn ${cls}`;
      const icon = document.createElement('span');
      const label = document.createElement('span');
      label.className = 'nn-tc-label';
      el.append(icon, label);
      parentEl.append(el);
      this.bindButton(el, code, onTap);
      return { el, icon, label };
    };
    this.btns = {
      use: btn('nn-main', this.root, 'KeyE'),
      jump: btn('', this.root, 'Space'),
      horn: btn('', this.root, 'KeyH'),
      radio: btn('', this.root, 'KeyR'),
      disco: btn('', this.root, 'KeyL'),
    };
    const sys = div('nn-tc-sys', this.root);
    const full = document.documentElement;
    this.sysBtns = {
      map: btn('', sys, 'KeyM'),
      sound: btn('', sys, 'KeyN'),
      gfx: btn('', sys, 'KeyG'),
      figure: btn('', sys, 'KeyC'),
      full: btn('', sys, null, () => {
        if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
        else void full.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
      }),
    };
    setBtn(this.sysBtns.map, ICON.map, 'Karte');
    setBtn(this.sysBtns.gfx, ICON.gfx, 'Grafik');
    setBtn(this.sysBtns.figure, ICON.figure, 'Figur');
    setBtn(this.sysBtns.full, ICON.full, 'Vollbild');
    // iPhone Safari has no element fullscreen (Add to Home Screen opens the game without browser bars)
    this.sysBtns.full.el.hidden = typeof full.requestFullscreen !== 'function';
    this.zoom = div('nn-tc-zoom', this.root);
    const zin = btn('', this.zoom, null, () => this.input.wheel(-1));
    const zout = btn('', this.zoom, null, () => this.input.wheel(1));
    setBtn(zin, ICON.zoomIn, '');
    setBtn(zout, ICON.zoomOut, '');
    this.rotate = div('nn-tc-rotate', this.root);
    this.rotate.textContent = 'Dreh dein Handy quer – so spielt es sich besser.';

    zl.addEventListener('pointerdown', (e) => this.moveDown(e));
    zr.addEventListener('pointerdown', (e) => this.lookDown(e));
    for (const z of [zl, zr]) {
      z.addEventListener('pointermove', (e) => this.pointerMove(e));
      z.addEventListener('pointerup', (e) => this.pointerUp(e));
      z.addEventListener('pointercancel', (e) => this.pointerUp(e));
    }
    // swiping on the open screen above the zones looks around, too
    const canvas = document.getElementById('game');
    canvas?.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !this.shown) return;
      canvas.setPointerCapture(e.pointerId);
      this.swipes.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    canvas?.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas?.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas?.addEventListener('pointercancel', (e) => this.pointerUp(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    // a touchscreen laptop: the first touch brings the overlay up
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !document.body.classList.contains('nn-touch')) this.enable();
    }, { capture: true });
    if (on) this.enable();
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('blur', () => this.releaseAll());
    this.layout();
  }

  private enable(): void {
    document.body.classList.add('nn-touch');
    this.layout();
  }

  get enabled(): boolean {
    return document.body.classList.contains('nn-touch');
  }

  /** Stick rest positions and the button arc round the look stick (safe areas included). */
  private layout(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const cs = getComputedStyle(this.safe);
    const l = parseFloat(cs.paddingLeft) || 0, r = parseFloat(cs.paddingRight) || 0, b = parseFloat(cs.paddingBottom) || 0;
    // bigger screens (tablets) keep the sticks a little further in from the edge
    const edge = Math.min(w, h) > 600 ? 56 : 30;
    // portrait: the attribution wraps to three lines under the sticks, so they sit higher
    const lift = h > w ? 44 : 0;
    const lx = l + edge + STICK_RADIUS, ly = h - b - edge - STICK_RADIUS + 8 - lift;
    const rx = w - r - edge - STICK_RADIUS, ry = ly;
    if (!this.move) place(this.moveStick, lx, ly);
    place(this.lookStick, rx, ry);
    // buttons on an arc to the upper left of the look stick: left (main) … up
    const rad = Math.min(w, h) > 600 ? 128 : 112;
    const at = (deg: number, k = 1): [number, number] => [rx + Math.cos((deg * Math.PI) / 180) * rad * k, ry - Math.sin((deg * Math.PI) / 180) * rad * k];
    place(this.btns.use.el, ...at(180, 1.05));
    place(this.btns.jump.el, ...at(145));
    place(this.btns.horn.el, ...at(112));
    place(this.btns.radio.el, ...at(80));
    place(this.btns.disco.el, ...at(162, 1.75));
  }

  /** Buttons: a press while the finger is down, a key release when it lifts (or leaves for good). */
  private bindButton(el: HTMLButtonElement, code: string | null, onTap?: () => void): void {
    let pid: number | null = null;
    const release = (): void => {
      if (pid === null) return;
      pid = null;
      el.classList.remove('nn-down');
      if (code) this.input.keyUp({ code });
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (pid !== null) return;
      pid = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add('nn-down');
      if (code) this.input.keyDown({ code, repeat: false, ctrlKey: false, metaKey: false, altKey: false });
      onTap?.();
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('click', (e) => e.preventDefault());
  }

  private moveDown(e: PointerEvent): void {
    if (this.move) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // the stick jumps to where the thumb lands
    this.move = { id: e.pointerId, cx: e.clientX, cy: e.clientY, dx: 0, dy: 0 };
    place(this.moveStick, e.clientX, e.clientY);
    this.moveStick.classList.add('nn-active');
  }

  private lookDown(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = this.lookStick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    // near the look stick: the stick; anywhere else in the zone: swipe-look
    if (!this.look && Math.hypot(e.clientX - cx, e.clientY - cy) < STICK_RADIUS * 1.7) {
      this.look = { id: e.pointerId, dx: e.clientX - cx, dy: e.clientY - cy };
      this.lookStick.classList.add('nn-active');
      this.knob(this.lookStick, this.look.dx, this.look.dy);
    } else this.swipes.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private pointerMove(e: PointerEvent): void {
    if (this.move?.id === e.pointerId) {
      this.move.dx = e.clientX - this.move.cx;
      this.move.dy = e.clientY - this.move.cy;
      this.knob(this.moveStick, this.move.dx, this.move.dy);
      return;
    }
    if (this.look?.id === e.pointerId) {
      const rect = this.lookStick.getBoundingClientRect();
      this.look.dx = e.clientX - (rect.left + rect.width / 2);
      this.look.dy = e.clientY - (rect.top + rect.height / 2);
      this.knob(this.lookStick, this.look.dx, this.look.dy);
      return;
    }
    const s = this.swipes.get(e.pointerId);
    if (s) {
      this.input.mouseMove((e.clientX - s.x) * SWIPE_GAIN, (e.clientY - s.y) * SWIPE_GAIN);
      s.x = e.clientX;
      s.y = e.clientY;
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (this.move?.id === e.pointerId) {
      this.move = null;
      this.moveStick.classList.remove('nn-active', 'nn-run');
      this.knob(this.moveStick, 0, 0);
      this.input.setStick(0, 0, false);
      this.layout();
    } else if (this.look?.id === e.pointerId) {
      this.look = null;
      this.lookStick.classList.remove('nn-active');
      this.knob(this.lookStick, 0, 0);
    }
    this.swipes.delete(e.pointerId);
  }

  private releaseAll(): void {
    this.move = this.look = null;
    this.swipes.clear();
    this.moveStick.classList.remove('nn-active', 'nn-run');
    this.lookStick.classList.remove('nn-active');
    this.knob(this.moveStick, 0, 0);
    this.knob(this.lookStick, 0, 0);
    this.layout();
  }

  private knob(stick: HTMLDivElement, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy), k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    (stick.firstElementChild as HTMLElement).style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  /** Every frame before the game reads its input: the move stick's axes and the look stick's turn. */
  tick(dt: number): void {
    if (!this.shown) return;
    if (this.move) {
      const v = stickVector(this.move.dx, this.move.dy);
      // on foot or on the bike, pushing all the way runs/sprints; the car only cares about the axes
      const run = this.walk && v.mag >= RUN_AT;
      this.input.setStick(v.y, v.x, run);
      this.moveStick.classList.toggle('nn-run', run);
    }
    if (this.look) {
      const d = lookDelta(stickVector(this.look.dx, this.look.dy), dt);
      if (d.dx !== 0 || d.dy !== 0) this.input.mouseMove(d.dx, d.dy);
    }
  }

  /** Shows the controls that make sense right now (labels, icons, which buttons). Cheap when nothing changed. */
  update(s: TouchState): void {
    const shown = this.enabled && s.playing;
    if (shown !== this.shown) {
      this.shown = shown;
      this.root.classList.toggle('nn-on', shown);
      if (!shown) this.releaseAll();
    }
    if (!shown) return;
    const key = `${s.mode}|${s.bikeType}|${s.radio}|${s.disco}|${s.mapOpen}|${s.muted}|${s.flying}`;
    if (key === this.last) return;
    this.last = key;
    this.walk = s.mode !== 'drive';
    const { use, jump, horn, radio, disco } = this.btns;
    const drive = s.mode === 'drive', ride = s.mode === 'ride';
    if (s.mode === 'walk') setBtn(use, ICON.enter, 'Einsteigen');
    else setBtn(use, ICON.exit, drive ? 'Aussteigen' : 'Absteigen');
    if (drive) setBtn(jump, ICON.brake, 'Handbremse');
    else setBtn(jump, ICON.jump, ride ? 'Hüpfen' : 'Springen');
    setBtn(horn, drive ? ICON.horn : ICON.bell, drive ? 'Hupe' : 'Klingel');
    setBtn(radio, ICON.radio, 'Radio');
    setBtn(disco, ICON.disco, 'Disco');
    use.el.hidden = jump.el.hidden = false;
    horn.el.hidden = s.mode === 'walk';
    radio.el.hidden = !s.radio;
    disco.el.hidden = !s.disco;
    this.moveCap.textContent = drive ? 'Gas · Lenken' : ride ? (s.bikeType === 'escooter' ? 'Fahren' : 'Treten') : 'Laufen';
    setBtn(this.sysBtns.sound, s.muted ? ICON.mute : ICON.sound, s.muted ? 'Ton an' : 'Ton aus');
    // the open map: sticks and action buttons rest, swipes pan, + and − zoom
    for (const b of Object.values(this.btns)) if (s.mapOpen || s.flying) b.el.hidden = true;
    this.moveStick.hidden = s.mapOpen;
    this.lookStick.hidden = s.mapOpen;
    this.zoom.hidden = !s.mapOpen;
    this.sysBtns.map.el.classList.toggle('nn-down', s.mapOpen);
    this.sysBtns.figure.el.hidden = s.mode !== 'walk';
  }
}

function setBtn(b: Btn, icon: string, label: string): void {
  if (b.icon.dataset.icon !== icon) {
    b.icon.dataset.icon = icon;
    b.icon.innerHTML = svg(icon);
  }
  b.label.textContent = label;
  b.el.setAttribute('aria-label', label);
}

function place(el: HTMLElement, x: number, y: number): void {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const e = document.createElement('div');
  e.className = cls;
  parent.append(e);
  return e;
}
