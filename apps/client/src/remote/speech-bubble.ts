import { CanvasTexture, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';
import { H as LABEL_PX_H, labelOpacity, WORLD_H as LABEL_H } from './name-label';

type Vec3 = { x: number; y: number; z: number };
type Parent = { add(o: Sprite): unknown; remove(o: Sprite): unknown };

/** Fade-out at the end of a bubble's lifetime (s). */
export const BUBBLE_FADE_S = 0.5;
/** Height of a name label (m) and the gap between it and a bubble (m): the bubble sits above the label. */
const BUBBLE_GAP = 0.1;
export const BUBBLE_LIFT = LABEL_H + BUBBLE_GAP;

/** How long a bubble with `text` stays (s), the fade-out not included. */
export function bubbleSeconds(text: string): number {
  return Math.min(10, 6 + 0.05 * [...text].length);
}

/** Word-wraps `text` to at most `maxLines` lines of `maxChars`; too long words are split, overflow ends the last line on an ellipsis. */
export function wrapBubble(text: string, maxChars = 28, maxLines = 3): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    let w = [...word];
    while (w.length > maxChars) {
      if (cur !== '') { lines.push(cur); cur = ''; }
      lines.push(w.slice(0, maxChars).join(''));
      w = w.slice(maxChars);
    }
    const piece = w.join('');
    if (cur === '') cur = piece;
    else if ([...cur].length + 1 + w.length <= maxChars) cur += ' ' + piece;
    else { lines.push(cur); cur = piece; }
  }
  if (cur !== '') lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = [...kept[maxLines - 1]!].slice(0, maxChars - 1).join('').trimEnd() + '…';
  return kept;
}

/** What SpeechBubbles needs of a bubble (tests replace it, there is no canvas in node). */
export interface Bubble {
  /** Places the bubble with its lower edge (the tail) at (x, y, z); `dist` to the camera is for the caller's opacity. */
  place(x: number, y: number, z: number, dist: number): void;
  setOpacity(o: number): void;
  attach(p: Parent): void;
  dispose(): void;
}

const PX = 40, PAD = 18, TAIL = 22, LINE = 52, WORLD_PER_PX = LABEL_H / LABEL_PX_H;

/** A chat line as a white speech bubble sprite (depth-tested like NameLabel), anchored at the tip of its tail. */
export class BubbleSprite implements Bubble {
  private readonly sprite: Sprite;
  private readonly tex: CanvasTexture;
  private parent: Parent | null = null;

  constructor(lines: string[]) {
    const font = `bold ${PX}px system-ui, sans-serif`;
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = font;
    const tw = Math.max(40, ...lines.map((l) => g.measureText(l).width));
    const bw = Math.ceil(tw + 2 * PAD), bh = lines.length * LINE + 2 * PAD;
    c.width = bw + 8;
    c.height = bh + TAIL + 8;
    const h = c.getContext('2d')!;
    h.font = font;
    h.textAlign = 'center';
    h.textBaseline = 'middle';
    h.fillStyle = '#fff';
    h.strokeStyle = 'rgba(0,0,0,0.35)';
    h.lineWidth = 3;
    // one outline round body and tail (a separate tail path would draw the outline across the tail's base)
    const x0 = 4, y0 = 4, x1 = 4 + bw, y1 = 4 + bh, r = 22, cx = c.width / 2;
    h.beginPath();
    h.moveTo(x0 + r, y0);
    h.arcTo(x1, y0, x1, y1, r);
    h.arcTo(x1, y1, x0, y1, r);
    h.lineTo(cx + 14, y1);
    h.lineTo(cx, y1 + TAIL);
    h.lineTo(cx - 14, y1);
    h.arcTo(x0, y1, x0, y0, r);
    h.arcTo(x0, y0, x1, y0, r);
    h.closePath();
    h.fill();
    h.stroke();
    h.fillStyle = '#16181d';
    lines.forEach((l, i) => h.fillText(l, c.width / 2, 4 + PAD + LINE * (i + 0.5)));
    this.tex = new CanvasTexture(c);
    this.tex.colorSpace = SRGBColorSpace;
    this.sprite = new Sprite(new SpriteMaterial({ map: this.tex, transparent: true, depthTest: true, depthWrite: false, fog: false }));
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set(c.width * WORLD_PER_PX, c.height * WORLD_PER_PX, 1);
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
  }

  attach(p: Parent): void {
    p.add(this.sprite);
    this.parent = p;
  }

  place(x: number, y: number, z: number, _dist: number): void {
    this.sprite.position.set(x, y, z);
  }

  setOpacity(o: number): void {
    this.sprite.visible = o > 0.01;
    this.sprite.material.opacity = o;
  }

  dispose(): void {
    this.parent?.remove(this.sprite);
    this.parent = null;
    this.tex.dispose();
    this.sprite.material.dispose();
  }
}

type Live = { bubble: Bubble; end: number };

/** At most one bubble per player slot, above their name label; it fades out and goes when its time is up. */
export class SpeechBubbles {
  private readonly live = new Map<number, Live>();

  constructor(private readonly scene: Parent, private readonly make: (lines: string[]) => Bubble = (l) => new BubbleSprite(l)) {}

  /** Bubbles currently shown or fading. */
  get size(): number {
    return this.live.size;
  }

  /** `slot` says `text` (replaces their bubble). `now` in ms. */
  say(slot: number, text: string, now: number): void {
    this.live.get(slot)?.bubble.dispose();
    const bubble = this.make(wrapBubble(text));
    bubble.attach(this.scene);
    this.live.set(slot, { bubble, end: now + bubbleSeconds(text) * 1000 + BUBBLE_FADE_S * 1000 });
  }

  /** `anchorOf(slot)`: the lower edge of the slot's name label, or null (hidden). `now` in ms. */
  update(now: number, anchorOf: (slot: number) => Vec3 | null, cam: Vec3): void {
    for (const [slot, b] of this.live) {
      if (now >= b.end) {
        b.bubble.dispose();
        this.live.delete(slot);
        continue;
      }
      const a = anchorOf(slot);
      if (!a) {
        b.bubble.setOpacity(0);
        continue;
      }
      const y = a.y + BUBBLE_LIFT;
      const fade = Math.min(1, (b.end - now) / (BUBBLE_FADE_S * 1000));
      b.bubble.place(a.x, y, a.z, Math.hypot(a.x - cam.x, y - cam.y, a.z - cam.z));
      b.bubble.setOpacity(fade * labelOpacity(Math.hypot(a.x - cam.x, a.y - cam.y, a.z - cam.z)));
    }
  }

  dispose(): void {
    for (const b of this.live.values()) b.bubble.dispose();
    this.live.clear();
  }
}
