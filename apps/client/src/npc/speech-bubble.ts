import { CanvasTexture, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';

/** A bubble is fully visible up to BUBBLE_FULL m, fades out until BUBBLE_GONE. */
const BUBBLE_FULL = 20, BUBBLE_GONE = 30;
/** Fade in and out (s) and how long a line is shown (s). */
const FADE_IN = 0.2, FADE_OUT = 0.4, SHOW = 3;

/** Opacity of a speech bubble at distance d (m) and age (s) of its line. */
export function bubbleOpacity(d: number, age: number): number {
  if (age <= 0 || age >= SHOW || d >= BUBBLE_GONE) return 0;
  const t = Math.min(1, age / FADE_IN, (SHOW - age) / FADE_OUT);
  const r = d <= BUBBLE_FULL ? 1 : (BUBBLE_GONE - d) / (BUBBLE_GONE - BUBBLE_FULL);
  return t * r;
}

type Parent = { add(o: Sprite): unknown; remove(o: Sprite): unknown };

/** What NpcView needs of a bubble (tests replace it, there is no canvas in node). */
export interface Bubble {
  readonly text: string;
  /** Places the bubble's tip at (x, y, z); dist to the camera and the line's age set the opacity. */
  place(x: number, y: number, z: number, dist: number, age: number): void;
  attach(parent: Parent): void;
  dispose(): void;
}

const W = 640, H = 220, WORLD_W = 2.2, FONT = 46, LINE = 56, TIP = 26;

/** Splits text into at most two lines that fit `max` px. */
function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  if (g.measureText(text).width <= max) return [text];
  const words = text.split(' ');
  let best = [text];
  let bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(g.measureText(a).width, g.measureText(b).width);
    if (w < bestW) [best, bestW] = [[a, b], w];
  }
  return best;
}

/**
 * A speech bubble over an NPC: white rounded box with a tip pointing down, dark bold text in up to two lines, as a
 * sprite (depth-tested, like the name labels), anchored at the tip.
 */
export class SpeechBubble implements Bubble {
  private readonly sprite: Sprite;
  private readonly tex: CanvasTexture;
  private parent: Parent | null = null;

  constructor(readonly text: string) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.font = `bold ${FONT}px system-ui, sans-serif`;
    const lines = wrap(g, text, W - 80);
    const tw = Math.max(...lines.map((l) => g.measureText(l).width));
    const bw = Math.min(W - 8, tw + 56), bh = lines.length * LINE + 34;
    const x0 = (W - bw) / 2, y0 = H - TIP - bh - 4;
    g.fillStyle = 'rgba(255,255,255,0.96)';
    g.strokeStyle = 'rgba(30,32,38,0.85)';
    g.lineWidth = 5;
    g.beginPath();
    g.roundRect(x0, y0, bw, bh, 30);
    g.moveTo(W / 2 - 22, y0 + bh);
    g.lineTo(W / 2, H - 6);
    g.lineTo(W / 2 + 18, y0 + bh);
    g.fill();
    g.stroke();
    // cover the stroke where the tip joins the box
    g.fillRect(W / 2 - 19, y0 + bh - 6, 35, 9);
    g.fillStyle = '#1c1e24';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, W / 2, y0 + 17 + LINE * (i + 0.5)));
    this.tex = new CanvasTexture(c);
    this.tex.colorSpace = SRGBColorSpace;
    this.sprite = new Sprite(new SpriteMaterial({ map: this.tex, transparent: true, depthTest: true, depthWrite: false, fog: false }));
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set(WORLD_W, WORLD_W * (H / W), 1);
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
  }

  attach(parent: Parent): void {
    parent.add(this.sprite);
    this.parent = parent;
  }

  place(x: number, y: number, z: number, dist: number, age: number): void {
    const o = bubbleOpacity(dist, age);
    this.sprite.visible = o > 0.01;
    this.sprite.material.opacity = o;
    this.sprite.position.set(x, y, z);
  }

  dispose(): void {
    this.parent?.remove(this.sprite);
    this.parent = null;
    this.tex.dispose();
    this.sprite.material.dispose();
  }
}
