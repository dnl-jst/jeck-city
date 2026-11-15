/**
 * Keyboard and mouse state. WASD/arrows move, Shift runs, Space jumps (on foot) or is the handbrake (in the car),
 * E gets in/out, R and the mouse wheel change the radio station (in the car), N mutes.
 * Keys pressed together with ctrl/meta/alt are ignored (browser shortcuts such as Cmd+W, Ctrl+E).
 * The DOM is attached separately (attachInput) so the state logic runs in tests.
 */
export type KeyEventLike = { code: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

const FORWARD = ['KeyW', 'ArrowUp'];
const BACK = ['KeyS', 'ArrowDown'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];

export class Input {
  private readonly down = new Set<string>();
  /** Initial presses not yet consumed (key repeat never adds one). */
  private readonly pressed = new Set<string>();
  private blurred = false;
  private dx = 0;
  private dy = 0;
  private notches = 0;

  /** Returns true if the key was taken (the caller may then preventDefault). */
  keyDown(e: KeyEventLike): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!e.repeat && !this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
    return true;
  }

  keyUp(e: Pick<KeyEventLike, 'code'>): void {
    this.down.delete(e.code);
  }

  /** Window lost focus: key-ups would never arrive, so let go of everything. */
  releaseAll(): void {
    this.down.clear();
    this.pressed.clear();
    this.blurred = true;
  }

  /** True once after releaseAll() (window blur): a held-key gesture in progress was interrupted, not finished. */
  takeBlur(): boolean {
    const b = this.blurred;
    this.blurred = false;
    return b;
  }

  /** True once per initial press of `code`. */
  consume(code: string): boolean {
    return this.pressed.delete(code);
  }

  /** Drops unconsumed presses (e.g. after switching modes). */
  clearPresses(): void {
    this.pressed.clear();
  }

  held(code: string): boolean {
    return this.down.has(code);
  }

  /** forward/right in −1..1 (opposite keys cancel). */
  axes(): { forward: number; right: number } {
    const any = (codes: string[]) => (codes.some((c) => this.down.has(c)) ? 1 : 0);
    return { forward: any(FORWARD) - any(BACK), right: any(RIGHT) - any(LEFT) };
  }

  run(): boolean {
    return this.down.has('ShiftLeft') || this.down.has('ShiftRight');
  }

  brake(): boolean {
    return this.down.has('Space');
  }

  mouseMove(dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
  }

  /** Mouse movement (px) since the last call. */
  takeMouse(): { dx: number; dy: number } {
    const m = { dx: this.dx, dy: this.dy };
    this.dx = this.dy = 0;
    return m;
  }

  /** One wheel event: a notch forward (deltaY > 0) or back (< 0). */
  wheel(deltaY: number): void {
    this.notches += Math.sign(deltaY);
  }

  /** Wheel notches (+1 per forward, −1 per back) since the last call. */
  takeWheel(): number {
    const n = this.notches;
    this.notches = 0;
    return n;
  }
}

const GAME_KEYS = new Set([...FORWARD, ...BACK, ...LEFT, ...RIGHT, 'Space']);

/**
 * Wires `input` to the window and canvas: keys, blur, pointer lock on click (Esc releases, handled by the
 * browser), mouse look and the wheel while locked. `onLock(locked)` reports lock changes (for the hint).
 */
export function attachInput(input: Input, canvas: HTMLCanvasElement, onLock: (locked: boolean) => void): void {
  window.addEventListener('keydown', (e) => {
    if (input.keyDown(e) && GAME_KEYS.has(e.code)) e.preventDefault(); // no page scrolling on arrows/space
  });
  window.addEventListener('keyup', (e) => input.keyUp(e));
  window.addEventListener('blur', () => input.releaseAll());
  canvas.addEventListener('click', () => {
    if (document.pointerLockElement !== canvas) void canvas.requestPointerLock()?.catch?.(() => {});
  });
  document.addEventListener('pointerlockchange', () => onLock(document.pointerLockElement === canvas));
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) input.mouseMove(e.movementX, e.movementY);
  });
  window.addEventListener('wheel', (e) => {
    if (document.pointerLockElement === canvas) input.wheel(e.deltaY);
  }, { passive: true });
}
