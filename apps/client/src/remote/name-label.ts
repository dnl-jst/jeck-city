import { CanvasTexture, Sprite, SpriteMaterial, SRGBColorSpace } from 'three';

/** Labels are fully visible up to this distance (m), fade out until LABEL_GONE (beyond: not drawn). */
export const LABEL_FADE_FROM = 35;
export const LABEL_GONE = 50;
/** Gap between the top of the head (or the car roof) and the label's lower edge (m). */
export const LABEL_GAP = 0.35;

/** Label opacity at distance d (m): 1 up to 35 m, linear to 0 at 50 m. */
export function labelOpacity(d: number): number {
  if (d <= LABEL_FADE_FROM) return 1;
  if (d >= LABEL_GONE) return 0;
  return (LABEL_GONE - d) / (LABEL_GONE - LABEL_FADE_FROM);
}

type Parent = { add(o: Sprite): unknown; remove(o: Sprite): unknown };

/** What RemotePlayers needs of a name label (tests replace it, there is no canvas in node). */
export interface Label {
  readonly name: string;
  /** Places the label with its lower edge at (x, y, z); `dist` to the camera sets the opacity. */
  place(x: number, y: number, z: number, dist: number): void;
  attach(parent: Parent): void;
  dispose(): void;
}

export const W = 384, H = 96, WORLD_H = 0.55;

/** A player's name as a sprite (CanvasTexture, depth-tested so walls hide it), 0.55 m high, anchored at its lower edge. */
export class NameLabel implements Label {
  private readonly sprite: Sprite;
  private readonly tex: CanvasTexture;
  private parent: Parent | null = null;

  constructor(readonly name: string) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.font = 'bold 54px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const tw = Math.min(W - 40, g.measureText(name).width);
    g.fillStyle = 'rgba(12,14,18,0.55)';
    g.beginPath();
    g.roundRect((W - tw) / 2 - 16, 8, tw + 32, H - 16, 24);
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText(name, W / 2, H / 2 + 3, W - 40);
    g.fillStyle = '#fff';
    g.fillText(name, W / 2, H / 2 + 3, W - 40);
    this.tex = new CanvasTexture(c);
    this.tex.colorSpace = SRGBColorSpace;
    this.sprite = new Sprite(new SpriteMaterial({ map: this.tex, transparent: true, depthTest: true, depthWrite: false, fog: false }));
    this.sprite.center.set(0.5, 0);
    this.sprite.scale.set(WORLD_H * (W / H), WORLD_H, 1);
    this.sprite.renderOrder = 10;
    this.sprite.visible = false;
  }

  attach(parent: Parent): void {
    parent.add(this.sprite);
    this.parent = parent;
  }

  place(x: number, y: number, z: number, dist: number): void {
    const o = labelOpacity(dist);
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
