import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, PointLight, SRGBColorSpace, Vector3,
  type Material, type Scene,
} from 'three';
import type { CharacterModels } from './characters';
import { PlayerFigure } from './player';
import { BENCH, benchPlace, departure, nextArrivals, sectionAt, sectionBenches, STATION, SECTION_STRIDE, type Seated, sectionQuat, sectionStates, TRAIN, TRAIN_SECTIONS, transitModel, type Transit, type TransitModel } from '@nn/shared';

/** Trains further than this from the camera are not drawn (m). */
const DRAW_DIST = 600;
const L = TRAIN.sectionLength / 2, W = TRAIN.halfWidth, DOOR = TRAIN.doorWidth / 2;
/** Heights above the rail top: the red skirt's top, window band, the red band under the roof, top of the body. */
const SKIRT = 0.62, SILL = 1.22, HEAD = 2.22, BAND = 2.48, TOP = 2.95;

type RGB = [number, number, number];
// the look of Köln's Stadtbahn cars: white body, red skirt and roof band, red seats, bare metal poles
const WHITE: RGB = [0.93, 0.92, 0.88], RED: RGB = [0.85, 0.13, 0.1], DARK: RGB = [0.12, 0.12, 0.13], FLOOR: RGB = [0.52, 0.53, 0.52];
const ROOF: RGB = [0.6, 0.61, 0.62], FRAME: RGB = [0.2, 0.2, 0.22], BASE: RGB = [0.42, 0.45, 0.48], PANEL: RGB = [0.9, 0.9, 0.87];
const SEAT: RGB = [0.8, 0.1, 0.1], POLE: RGB = [0.74, 0.75, 0.77], CEILING: RGB = [0.88, 0.88, 0.84], LAMP: RGB = [1, 0.96, 0.62];

/** The driver's cab: its back wall this far in from the train's end (m), and the seat this far left of the middle. */
const CAB = TRAIN.cab, DRIVER_X = 0.3;

/** Boxes with a colour per vertex and the shading baked in (the trains run underground: drawn unlit, like the tunnel). */
class Boxes {
  private pos: number[] = [];
  private col: number[] = [];
  /** A box from (x0, y0, z0) to (x1, y1, z1); `faces`: which to draw (default all), e.g. '-y' only for a ceiling. */
  add(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: RGB, only?: string): this {
    const f: [string, number, number[][]][] = [
      ['+x', 0.82, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
      ['-x', 0.82, [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
      ['+y', 1, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
      ['-y', 0.9, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
      ['+z', 0.7, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
      ['-z', 0.7, [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
    ];
    for (const [name, shade, q] of f) {
      if (only && only !== name) continue;
      for (const i of [0, 1, 2, 0, 2, 3]) {
        this.pos.push(...q[i]!);
        // (colours as seen: vertex colours are linear)
        this.col.push((c[0] * shade) ** 2.2, (c[1] * shade) ** 2.2, (c[2] * shade) ** 2.2);
      }
    }
    return this;
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(Float32Array.from(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(Float32Array.from(this.col), 3));
    return g;
  }
}

/** A section's body. `rear`/`front`: a closed end with a driver's windscreen there (a unit's ends); lights: 1 head, −1 tail lights at that end. */
function sectionGeometry(unitIndex: number, lights: number, pantograph: boolean): { body: BufferGeometry; glass: BufferGeometry } {
  const b = new Boxes(), g = new Boxes();
  const t = TRAIN.wall, F = TRAIN.floor, C = TRAIN.ceiling, rear = unitIndex === 0, front = unitIndex === TRAIN.sections - 1;
  // underframe (its top is the floor) and bogies
  // (a little inside the body's faces: two surfaces in one plane flicker)
  b.add(-W + 0.03, 0.16, -L + 0.03, W - 0.03, F, L - 0.03, FLOOR);
  for (const z of [-TRAIN.bogie, TRAIN.bogie]) b.add(-1.1, 0.02, z - 0.95, 1.1, 0.3, z + 0.95, DARK);
  for (const s of [1, -1]) {
    const x0 = s > 0 ? W - t : -W, x1 = s > 0 ? W : -W + t;
    /** A box reaching `d` m in from the side wall, between heights and along z. */
    const inner = (d0: number, d1: number, y0: number, y1: number, z0: number, z1: number, c: RGB) =>
      b.add(Math.min(s * (W - t - d0), s * (W - t - d1)), y0, z0, Math.max(s * (W - t - d0), s * (W - t - d1)), y1, z1, c);
    for (const [z0, z1] of [[-L, -DOOR], [DOOR, L]] as const) {
      // the side: red skirt, white body, windows between dark posts, white, the red band, the roof's edge
      b.add(x0, 0.16, z0, x1, SKIRT, z1, RED).add(x0, SKIRT, z0, x1, SILL, z1, WHITE).add(x0, HEAD, z0, x1, BAND, z1, WHITE);
      b.add(x0, BAND, z0, x1, TOP, z1, RED);
      g.add(x0 + 0.02, SILL, z0, x1 - 0.02, HEAD, z1, [1, 1, 1]);
      const span = z1 - z0, panes = 3;
      for (let k = 0; k <= panes; k++) {
        const z = z0 + (span * k) / panes;
        b.add(x0, SILL, Math.max(z0, z - 0.06), x1, HEAD, Math.min(z1, z + 0.06), FRAME);
      }
      // a partition beside the door: white panel on a grey base, a pole at its end
      const pz = z0 < 0 ? z1 - 0.14 : z0 + 0.1;
      inner(0, 0.95, F, F + 0.4, pz, pz + 0.04, BASE);
      inner(0, 0.95, F + 0.4, F + 1.3, pz, pz + 0.04, PANEL);
      inner(0.93, 0.97, F, C, pz, pz + 0.04, POLE);
      // the light band over the windows
      inner(0.08, 0.5, C - 0.05, C - 0.02, z0 + 0.15, z1 - 0.15, LAMP);
    }
    // over the door, the handrail along the car
    b.add(x0, HEAD, -DOOR, x1, BAND, DOOR, WHITE).add(x0, BAND, -DOOR, x1, TOP, DOOR, RED);
    inner(0.93, 0.96, C - 0.32, C - 0.29, -L + 0.2, L - 0.2, POLE);
  }
  // benches across the car in pairs back to back (the layout the physics uses): red cushions and backs on a grey
  // base, a white wall between the two backs with a pole at its aisle end
  for (const bn of sectionBenches(unitIndex)) {
    const back = bn.facing > 0 ? bn.z0 : bn.z1, aisle = Math.abs(bn.x0) < Math.abs(bn.x1) ? bn.x0 : bn.x1;
    b.add(bn.x0 + 0.02, F + 0.18, bn.z0 + 0.06, bn.x1 - 0.02, F + BENCH.seat - 0.08, bn.z1 - 0.06, BASE);
    b.add(bn.x0, F + BENCH.seat - 0.08, bn.z0, bn.x1, F + BENCH.seat, bn.z1, SEAT);
    b.add(bn.x0, F + BENCH.seat, Math.min(back, back - bn.facing * -0.07), bn.x1, F + BENCH.back, Math.max(back, back - bn.facing * -0.07), SEAT);
    if (bn.facing > 0) {
      b.add(bn.x0, F + 0.42, back - BENCH.backThick, bn.x1, F + BENCH.back + 0.04, back, PANEL);
      b.add(aisle - 0.015, F + 0.9, back - BENCH.backThick / 2 - 0.015, aisle + 0.015, C, back - BENCH.backThick / 2 + 0.015, POLE);
    }
  }
  // the ceiling, and the roof (rounded off: a narrower box on top)
  b.add(-W, C, -L, W, C + 0.02, L, CEILING, '-y');
  b.add(-W + 0.01, TOP, -L + 0.01, W - 0.01, TOP + 0.12, L - 0.01, ROOF);
  b.add(-W + 0.22, TOP + 0.12, -L, W - 0.22, TRAIN.roof, L, ROOF);
  if (pantograph) {
    const y = TRAIN.roof;
    b.add(-0.5, y, -0.9, 0.5, y + 0.08, 0.9, DARK);
    for (const x of [-0.42, 0.42]) b.add(x - 0.02, y + 0.08, -0.03, x + 0.02, y + 0.95, 0.03, DARK);
    b.add(-0.8, y + 0.95, -0.2, 0.8, y + 0.99, 0.2, DARK);
  }
  for (const [closed, z, dir] of [[rear, -L, -1], [front, L, 1]] as const) {
    if (!closed) continue;
    // (the end wall stands a centimetre proud of the side walls all round, for the same reason)
    const z0 = Math.min(z + dir * 0.01, z - dir * t), z1 = Math.max(z + dir * 0.01, z - dir * t), E = W + 0.01;
    // the end: red face with a wide windscreen, a white panel with the lamps below it, the display above, a coupler
    b.add(-E, 0.15, z0, E, SKIRT, z1, RED).add(-E, SKIRT, z0, E, SILL, z1, WHITE).add(-E, HEAD + 0.08, z0, E, TOP + 0.01, z1, RED);
    b.add(-E, SILL, z0, -W + 0.14, HEAD + 0.08, z1, RED).add(W - 0.14, SILL, z0, E, HEAD + 0.08, z1, RED);
    g.add(-W + 0.14, SILL, z0 + 0.02, W - 0.14, HEAD + 0.08, z1 - 0.02, [1, 1, 1]);
    b.add(-0.25, 0.3, z, 0.25, 0.55, z + dir * 0.35, DARK);
    // the desk under the windscreen; at the train's head the driver on their seat, hands on the desk
    const zi = (d: number) => z - dir * d; // d metres in from the end
    const span = (d0: number, d1: number): [number, number] => [Math.min(zi(d0), zi(d1)), Math.max(zi(d0), zi(d1))];
    const put = (x0: number, x1: number, y0: number, y1: number, d0: number, d1: number, c: RGB) => b.add(x0, y0, span(d0, d1)[0], x1, y1, span(d0, d1)[1], c);
    put(-W + 0.15, W - 0.15, F + 0.68, F + 0.84, 0.1, 0.5, FRAME);
    put(0.05, 0.65, F, F + 0.68, 0.12, 0.3, FRAME);
    // the driver's seat, and the cab's back wall with a window and a door (closed: nobody walks into the cab)
    put(DRIVER_X - 0.27, DRIVER_X + 0.27, F + 0.22, F + 0.5, 0.72, 1.18, DARK);
    put(DRIVER_X - 0.27, DRIVER_X + 0.27, F + 0.5, F + 1.2, 1.12, 1.2, DARK);
    put(-W + t, W - t, F, SILL, CAB - 0.03, CAB + 0.03, PANEL);
    put(-W + t, W - t, HEAD, C, CAB - 0.03, CAB + 0.03, PANEL);
    for (const x of [-W + t, -0.42, 0.38, W - t - 0.08]) put(x, x + 0.08, SILL, HEAD, CAB - 0.03, CAB + 0.03, FRAME);
    g.add(-W + t, SILL, Math.min(zi(CAB - 0.01), zi(CAB + 0.01)), W - t, HEAD, Math.max(zi(CAB - 0.01), zi(CAB + 0.01)), [1, 1, 1]);
    put(-0.36, -0.33, F + 0.95, F + 1.07, CAB + 0.03, CAB + 0.07, POLE); // the door's handle
    const out = z + dir * 0.025;
    if (lights !== 0 && Math.sign(dir) === Math.sign(lights)) {
      const c: RGB = lights > 0 ? [1, 0.97, 0.82] : [1, 0.1, 0.05];
      for (const x of [-0.95, -0.68, 0.68, 0.95]) b.add(x - 0.1, 0.78, Math.min(z, out), x + 0.1, 0.98, Math.max(z, out), c);
    }
  }
  return { body: b.geometry(), glass: g.geometry() };
}

/** A door leaf (half a door): white with a red foot and a tall window. */
function doorGeometry(): { body: BufferGeometry; glass: BufferGeometry } {
  const b = new Boxes(), g = new Boxes(), w = DOOR;
  b.add(-0.025, TRAIN.floor, 0, 0.025, SKIRT, w, RED).add(-0.025, SKIRT, 0, 0.025, SILL - 0.25, w, WHITE).add(-0.025, HEAD, 0, 0.025, HEAD + 0.1, w, WHITE);
  b.add(-0.025, SILL - 0.25, 0, 0.025, HEAD, 0.07, WHITE).add(-0.025, SILL - 0.25, w - 0.07, 0.025, HEAD, w, WHITE);
  g.add(-0.01, SILL - 0.25, 0.07, 0.01, HEAD, w - 0.07, [1, 1, 1]);
  return { body: b.geometry(), glass: g.geometry() };
}

/** Departure signals: this far ahead of a stop (m; beyond the platform's end), green this long before a train leaves and after (s). */
const SIGNAL_AHEAD = 45, GREEN_BEFORE = 12, GREEN_AFTER = 7;
/** The "next stop" display in a section: width, height and thickness of its case's face (m), its middle above the rail top; and "dark". */
const NEXT_W = 1.2, NEXT_H = 0.15, NEXT_T = 0.12, NEXT_Y = TRAIN.ceiling - 0.11, NEXT_DARK = -3;
/** Door sounds are played for trains within this distance of the camera (m). */
const DOOR_SOUND_DIST = 40;
/** The closing sound starts this long before the doors move (s): its warning beeps (train-sound.ts synthTrainDoorClose). */
const BEEP_LEAD = 0.9;
/** At least this long between two door sounds (s). */
const DOOR_SOUND_GAP = 3;
/** The cabin light: on within this distance of the camera (m), and its strength. */
const CABIN_DIST = 25, CABIN_LIGHT = 3.5;
/** Departure boards are redrawn within this distance of the camera (m). */
const BOARD_DIST = 160;
const BOARD_ROWS = 3;

/** A departure board over a platform; `from`: the line paths that stop there (several lines share a platform). */
type Board = { from: { track: number; stop: number }[]; x: number; z: number; canvas: HTMLCanvasElement; tex: CanvasTexture; shown: string };

type SectionView = {
  group: Group; doors: { mesh: Group; side: 1 | -1; dir: 1 | -1 }[];
  /** The "next stop" display inside (both faces) and the station it shows (−2: nothing yet). */
  nextStop: { faces: Mesh[]; shown: number };
  /** The destination display at a train's end and the texts it can show (the line and where it goes). */
  display?: { mesh: Mesh; texts: MeshBasicMaterial[] };
};

/** The trains and the station signs, drawn from the tick alone (see sectionStates). */
export class TransitView {
  private readonly model: TransitModel;
  private readonly sections: SectionView[] = [];
  private readonly state: Float64Array;
  private readonly root = new Group();
  private readonly owned: (BufferGeometry | Material | CanvasTexture)[] = [];
  private readonly boards: Board[] = [];
  private readonly nextTexts = new Map<number, MeshBasicMaterial>();
  /** The "next stop" display switched off. */
  private nextOff!: MeshBasicMaterial;
  /** Departure signals: red, green shortly before a train leaves and until it has gone by. */
  private readonly signals: { from: { track: number; stop: number }[]; lamp: Mesh }[] = [];
  private readonly signalPost = new BoxGeometry(0.1, 3.2, 0.1);
  private readonly signalLamp = new BoxGeometry(0.2, 0.2, 0.12);
  private readonly signalDark = new MeshBasicMaterial({ color: 0x1a1c1f });
  private readonly signalRed = new MeshBasicMaterial({ color: 0xff2412 });
  private readonly signalGreen = new MeshBasicMaterial({ color: 0x2bff5a });
  /** Per train (track, slot): how far its doors were open at the last update (0..1), and the door sounds due since. */
  private readonly doorsOpen: number[] = [];
  /** The same a moment ahead (BEEP_LEAD), and the states computed for it. */
  private readonly doorsAhead: number[] = [];
  private readonly stateSoon: Float64Array;
  private readonly stateThen: Float64Array;
  /** Seconds until the next door sound may play, and the tick of the last update. */
  private doorQuiet = 0;
  private lastTick = 0;
  private doorEvents: { opening: boolean; x: number; z: number }[] = [];
  /**
   * The cabin light of the section nearest to the camera (the trains themselves are drawn unlit, as if lit from
   * inside; this lights the people in and beside it). One light that is always there: no shader recompiles.
   */
  private readonly cabin = new PointLight(0xfff4e0, 0, 14, 1.2);

  /** The drivers: one figure per train, sitting in the cab at its head. */
  private readonly drivers: PlayerFigure[] = [];

  constructor(scene: Scene, private readonly transit: Transit, characters?: CharacterModels, model?: TransitModel) {
    // (the simulation's own model where there is one: both run on its clock)
    this.model = model ?? transitModel(transit);
    this.state = new Float64Array(this.model.count * SECTION_STRIDE);
    this.stateSoon = new Float64Array(this.model.count * SECTION_STRIDE);
    this.stateThen = new Float64Array(this.model.count * SECTION_STRIDE);
    const paint = new MeshBasicMaterial({ vertexColors: true });
    const glass = new MeshBasicMaterial({ color: 0x9fc4d8, transparent: true, opacity: 0.28, depthWrite: false, side: DoubleSide });
    this.owned.push(paint, glass);
    const door = doorGeometry();
    this.owned.push(door.body, door.glass);
    const variants = new Map<string, { body: BufferGeometry; glass: BufferGeometry }>();
    const displayGeo = new PlaneGeometry(1.9, 0.34);
    // (a flat strip close under the ceiling, clear of the handrails below it, in a case a hand thick)
    const nextGeo = new PlaneGeometry(NEXT_W, NEXT_H), nextCase = new BoxGeometry(NEXT_W + 0.08, NEXT_H + 0.05, NEXT_T), nextDark = new MeshBasicMaterial({ color: 0x101214 });
    this.nextOff = nextDark;
    this.owned.push(nextGeo, nextCase, nextDark);
    const displays = transit.tracks.map((tr) => {
      const tex = displayTexture(`${tr.line ?? ''} ${tr.to ?? ''}`.trim()), mat = new MeshBasicMaterial({ map: tex });
      this.owned.push(tex, mat);
      return [mat];
    });
    this.owned.push(displayGeo);
    const trackOf: number[] = [];
    this.model.tracks.forEach((tr, k) => { for (let n = 0; n < tr.slots * TRAIN_SECTIONS; n++) trackOf.push(k); });
    for (let i = 0; i < this.model.count; i++) {
      const k = i % TRAIN_SECTIONS, inUnit = k % TRAIN.sections;
      const rear = inUnit === 0, front = inUnit === TRAIN.sections - 1;
      const lights = k === 0 ? -1 : k === TRAIN_SECTIONS - 1 ? 1 : 0;
      const pantograph = inUnit === 1;
      const key = `${rear}${front}${lights}`;
      let geo = variants.get(key);
      if (!geo) {
        variants.set(key, (geo = sectionGeometry(inUnit, lights, pantograph)));
        this.owned.push(geo.body, geo.glass);
      }
      const group = new Group();
      group.add(new Mesh(geo.body, paint), new Mesh(geo.glass, glass));
      const doors: SectionView['doors'] = [];
      for (const side of [1, -1] as const) {
        for (const dir of [1, -1] as const) {
          const leaf = new Group();
          leaf.add(new Mesh(door.body, paint), new Mesh(door.glass, glass));
          leaf.scale.z = dir; // the leaf spans 0..DOOR along +z: mirrored for the other half
          group.add(leaf);
          doors.push({ mesh: leaf, side, dir });
        }
      }
      group.visible = false;
      this.root.add(group);
      // the next stop, on a display across the aisle under the ceiling, read from both ways
      const faces = [0, Math.PI].map((turn) => {
        const m = new Mesh(nextGeo, nextDark);
        m.position.set(0, NEXT_Y, (turn === 0 ? 1 : -1) * (NEXT_T / 2 + 0.003));
        m.rotation.y = turn;
        group.add(m);
        return m;
      });
      group.add(new Mesh(nextCase, nextDark).translateY(NEXT_Y));
      const view: SectionView = { group, doors, nextStop: { faces, shown: -2 } };
      if (lights !== 0) {
        // line and terminus over the windscreen at both ends of the train
        const mesh = new Mesh(displayGeo, displays[trackOf[i]! % displays.length]![0]);
        mesh.position.set(0, HEAD + 0.36, lights * (L + 0.025));
        mesh.rotation.y = lights > 0 ? 0 : Math.PI;
        group.add(mesh);
        view.display = { mesh, texts: displays[trackOf[i]! % displays.length]! };
      }
      if (lights > 0) {
        // the driver: a player figure (one of the character models, a different one from train to train) on the seat,
        // hands on the desk
        const driver = new PlayerFigure(scene);
        group.add(driver.group);
        const F = TRAIN.floor, zi = (d: number) => L - d, vec = (x: number, y: number, d: number) => new Vector3(x, y, zi(d));
        const seat = (): void => driver.sit(vec(DRIVER_X, F + 0.56, 0.98), [vec(DRIVER_X + 0.12, F + 0.09, 0.5), vec(DRIVER_X - 0.12, F + 0.09, 0.5)],
          [vec(DRIVER_X + 0.2, F + 0.9, 0.46), vec(DRIVER_X - 0.2, F + 0.9, 0.46)], 0.12);
        seat();
        const variants = characters?.variants ?? [];
        if (characters && variants.length) {
          const pick = variants[Math.floor(Math.abs(Math.sin((this.drivers.length + 1) * 12.9898) * 43758.5453) % 1 * variants.length)]!;
          characters.load(pick).then((model) => { driver.setModel(model); seat(); }, () => { /* stays the stand-in figure */ });
        }
        this.drivers.push(driver);
      }
      this.sections.push(view);
    }
    this.addSigns();
    this.root.add(this.cabin);
    scene.add(this.root);
  }

  /** Name signs on the wall facing every platform, and a departure board over it. */
  private addSigns(): void {
    const platformsSeen = new Map<string, { board: Board; signal: { from: { track: number; stop: number }[] }; station: number; side: number; x: number; z: number }>();
    let platformKey = '';
    const edges: { station: number; from: { track: number; stop: number }[]; tr: Transit['tracks'][number]; cum: number[]; stop: Transit['tracks'][number]['stops'][number]; x: number; y: number; z: number; yaw: number; rail: number }[] = [];
    for (const [trackIndex, tr] of this.transit.tracks.entries()) {
      const n = tr.pts.length / 3;
      const cum = [0];
      for (let i = 1; i < n; i++) cum.push(cum[i - 1]! + Math.hypot(tr.pts[i * 3]! - tr.pts[i * 3 - 3]!, tr.pts[i * 3 + 2]! - tr.pts[i * 3 - 1]!));
      for (const [stopIndex, stop] of tr.stops.entries()) {
        // signs, board and signal belong to an underground platform; lines sharing one share them
        if (!stop.under) continue;
        {
          const at = Math.max(1, Math.min(n - 1, cum.findIndex((c) => c >= stop.s)));
          // (lines on one track may stop some metres apart along it; the next track lies a few metres across)
          const sx = tr.pts[at * 3]!, sz = tr.pts[at * 3 + 2]!;
          const dx = sx - tr.pts[at * 3 - 3]!, dz = sz - tr.pts[at * 3 - 1]!, dl = Math.hypot(dx, dz) || 1;
          let k = `${stop.station}_${stop.side}_${Math.round(sx)}_${Math.round(sz)}`;
          for (const [key, p] of platformsSeen) {
            const ox = p.x - sx, oz = p.z - sz;
            if (p.station === stop.station && p.side === stop.side && Math.abs(ox * dz - oz * dx) / dl < 2 && Math.abs(ox * dx + oz * dz) / dl < 70) k = key;
          }
          const have = platformsSeen.get(k);
          if (have) {
            have.board.from.push({ track: trackIndex, stop: stopIndex });
            have.signal.from.push({ track: trackIndex, stop: stopIndex });
            continue;
          }
          platformKey = k;
        }
        const name = this.transit.stations[stop.station]?.name ?? '';
        const tex = signTexture(name);
        const mat = new MeshBasicMaterial({ map: tex });
        const geo = new PlaneGeometry(2.6, 0.8);
        this.owned.push(tex, mat, geo);
        const island = this.platformBetweenTracks(trackIndex, tr, cum, stop);
        let signal: { from: { track: number; stop: number }[]; lamp: Mesh } | null = null;
        for (const off of [-18, 0, 18]) {
          let i = cum.findIndex((c) => c >= stop.s + off);
          i = Math.max(1, i < 0 ? n - 1 : i);
          const x = tr.pts[i * 3]!, y = tr.pts[i * 3 + 1]!, z = tr.pts[i * 3 + 2]!;
          const fx = x - tr.pts[i * 3 - 3]!, fz = z - tr.pts[i * 3 - 1]!, len = Math.hypot(fx, fz) || 1;
          // to the platform's side of the track: left = (cos h, −sin h) for forward (sin h, cos h)
          const lx = (fz / len) * stop.side, lz = (-fx / len) * stop.side, yaw = Math.atan2(fx, fz);
          {
            // on the wall: behind a side platform; across the track from an island (the other track lies beyond the platform)
            const wall = island ? -STATION.wallClear : STATION.edge + STATION.platformWidth, d = wall - Math.sign(wall) * 0.03;
            const m = new Mesh(geo, mat);
            m.position.set(x + lx * d, y + TRAIN.floor + 2.2, z + lz * d);
            m.rotation.y = Math.atan2(-lx * Math.sign(wall), -lz * Math.sign(wall)); // facing the platform
            this.root.add(m);
          }
          if (off !== 0) continue;
          {
            // the departure signal: on a post to the right of the track, beyond the platform's end
            const k = Math.max(1, Math.min(n - 1, cum.findIndex((c) => c >= stop.s + SIGNAL_AHEAD)));
            const px = tr.pts[k * 3]!, py = tr.pts[k * 3 + 1]!, pz = tr.pts[k * 3 + 2]!;
            const dx = px - tr.pts[k * 3 - 3]!, dz = pz - tr.pts[k * 3 - 1]!, dl = Math.hypot(dx, dz) || 1;
            const sx = px - (dz / dl) * 1.75, sz = pz + (dx / dl) * 1.75; // right = −left = (−cos h, sin h)
            const post = new Mesh(this.signalPost, this.signalDark), lamp = new Mesh(this.signalLamp, this.signalRed);
            post.position.set(sx, py + 1.6, sz);
            lamp.position.set(sx - (dx / dl) * 0.05, py + 2.7, sz - (dz / dl) * 0.05);
            this.root.add(post, lamp);
            signal = { from: [{ track: trackIndex, stop: stopIndex }], lamp };
            this.signals.push(signal);
          }
          // the departure board: between the name signs, across the platform, read from both directions
          const j = Math.max(1, Math.min(n - 1, cum.findIndex((c) => c >= stop.s - 9)));
          const bx = tr.pts[j * 3]! + lx * 3.2, by = tr.pts[j * 3 + 1]! + TRAIN.floor + 2.9, bz = tr.pts[j * 3 + 2]! + lz * 3.2;
          const canvas = document.createElement('canvas');
          canvas.width = 960;
          canvas.height = 336;
          const btex = new CanvasTexture(canvas);
          btex.colorSpace = SRGBColorSpace;
          btex.anisotropy = 4;
          // a dark case a hand thick with the display on both faces, hung from the ceiling on two rods
          const BW = 2.5, BH = 0.94, BT = 0.14, top = y + STATION.ceiling;
          const bmat = new MeshBasicMaterial({ map: btex }), bgeo = new PlaneGeometry(BW - 0.1, BH - 0.1), box = new BoxGeometry(BW, BH, BT);
          const dark = new MeshBasicMaterial({ color: 0x15181c }), rod = new BoxGeometry(0.05, Math.max(0.05, top - (by + BH / 2)), 0.05);
          this.owned.push(btex, bmat, bgeo, box, dark, rod);
          const body = new Mesh(box, dark);
          body.position.set(bx, by, bz);
          body.rotation.y = yaw;
          this.root.add(body);
          for (const side of [-1, 1]) {
            // (the case's width runs across the track: its local x, turned by yaw)
            const m = new Mesh(rod, dark), off = side * (BW / 2 - 0.35);
            m.position.set(bx + Math.cos(yaw) * off, (top + by + BH / 2) / 2, bz - Math.sin(yaw) * off);
            m.rotation.y = yaw;
            this.root.add(m);
          }
          for (const back of [0, Math.PI]) {
            const fwd = back === 0 ? 1 : -1, m = new Mesh(bgeo, bmat);
            m.position.set(bx + (fx / len) * (BT / 2 + 0.004) * fwd, by, bz + (fz / len) * (BT / 2 + 0.004) * fwd);
            m.rotation.y = yaw + back;
            this.root.add(m);
          }
          const board: Board = { from: [{ track: trackIndex, stop: stopIndex }], x: bx, z: bz, canvas, tex: btex, shown: '' };
          this.boards.push(board);
          edges.push({ station: stop.station, from: board.from, tr, cum, stop, x: bx, y: by + BH / 2, z: bz, yaw, rail: y });
          if (signal) platformsSeen.set(platformKey, { board, signal, station: stop.station, side: stop.side, x, z });
        }
      }
    }
    // where a station has more than two tracks: which lines leave from each, on its board and along its platform edge
    const count = new Map<number, number>();
    for (const e of edges) count.set(e.station, (count.get(e.station) ?? 0) + 1);
    const PW = 2.5, PH = 0.36, PT = 0.05;
    const plate = new BoxGeometry(PW, PH, PT), face = new PlaneGeometry(PW - 0.04, PH - 0.04), rodMat = new MeshBasicMaterial({ color: 0x15181c });
    this.owned.push(plate, face, rodMat);
    for (const e of edges) {
      if ((count.get(e.station) ?? 0) <= 2) continue;
      const lines = [...new Set(e.from.map((f) => this.transit.tracks[f.track]!.line ?? ''))].filter(Boolean).sort((a, b) => Number(a) - Number(b));
      const to = [...new Set(e.from.map((f) => this.transit.tracks[f.track]!.to ?? ''))].filter(Boolean);
      if (lines.length === 0) continue;
      const tex = lineSignTexture(lines, to), mat = new MeshBasicMaterial({ map: tex });
      this.owned.push(tex, mat);
      const put = (x: number, y: number, z: number, yaw: number): void => {
        const body = new Mesh(plate, rodMat);
        body.position.set(x, y, z);
        body.rotation.y = yaw;
        this.root.add(body);
        for (const back of [0, Math.PI]) {
          const m = new Mesh(face, mat), a = yaw + back;
          m.position.set(x + Math.sin(a) * (PT / 2 + 0.003), y, z + Math.cos(a) * (PT / 2 + 0.003));
          m.rotation.y = a;
          this.root.add(m);
        }
      };
      // on top of the departure board, read along the platform …
      put(e.x, e.y + PH / 2, e.z, e.yaw);
      // … and hung over the platform's edge, read across it
      const n = e.tr.pts.length / 3, top = STATION.ceiling;
      for (const off of [-15, 15]) {
        const i = Math.max(1, Math.min(n - 1, e.cum.findIndex((c) => c >= e.stop.s + off)));
        const x = e.tr.pts[i * 3]!, y = e.tr.pts[i * 3 + 1]!, z = e.tr.pts[i * 3 + 2]!;
        const fx = x - e.tr.pts[i * 3 - 3]!, fz = z - e.tr.pts[i * 3 - 1]!, len = Math.hypot(fx, fz) || 1;
        const lx = (fz / len) * e.stop.side, lz = (-fx / len) * e.stop.side;
        const px = x + lx * (STATION.edge + 0.5), pz = z + lz * (STATION.edge + 0.5), py = y + TRAIN.floor + 2.75;
        put(px, py, pz, Math.atan2(lx, lz));
        const rod = new BoxGeometry(0.05, Math.max(0.05, y + top - (py + PH / 2)), 0.05);
        this.owned.push(rod);
        for (const side of [-1, 1]) {
          const m = new Mesh(rod, rodMat), o = side * (PW / 2 - 0.3);
          m.position.set(px + (fx / len) * o, (y + top + py + PH / 2) / 2, pz + (fz / len) * o);
          this.root.add(m);
        }
      }
    }
  }

  /** Draws the trains as of `tick` (fractional: the tick of the last step plus the frame's share of the next). */
  update(tick: number, camX: number, camZ: number): void {
    this.updateBoards(tick, camX, camZ);
    for (const sg of this.signals) {
      const green = sg.from.some((f) => {
        const d = departure(this.model, f.track, f.stop, tick);
        return d.standing ? d.seconds <= GREEN_BEFORE : d.seconds <= GREEN_AFTER;
      });
      sg.lamp.material = green ? this.signalGreen : this.signalRed;
    }
    const s = sectionStates(this.model, tick, this.state);
    let nearest = CABIN_DIST;
    this.cabin.intensity = 0;
    // doors that start to move, heard from the section of that train nearest to the camera
    const soon = sectionStates(this.model, tick + BEEP_LEAD * 60, this.stateSoon);
    let heard = DOOR_SOUND_DIST, event: { opening: boolean; x: number; z: number } | null = null;
    for (let t = 0; t * TRAIN_SECTIONS < this.sections.length; t++) {
      let open = 0, x = 0, z = 0, best = Infinity;
      for (let k = 0; k < TRAIN_SECTIONS; k++) {
        const o = (t * TRAIN_SECTIONS + k) * SECTION_STRIDE;
        if (s[o] !== 1) continue;
        open = Math.max(open, s[o + 6]!, s[o + 7]!);
        const d = Math.hypot(s[o + 1]! - camX, s[o + 3]! - camZ);
        if (d < best) [best, x, z] = [d, s[o + 1]!, s[o + 3]!];
      }
      // once per movement: opening when they leave the closed position, closing when they leave the open one
      // (closing is heard BEEP_LEAD early: the warning beeps come before the doors move)
      let ahead = 0;
      for (let k = 0; k < TRAIN_SECTIONS; k++) {
        const o = (t * TRAIN_SECTIONS + k) * SECTION_STRIDE;
        if (soon[o] === 1) ahead = Math.max(ahead, soon[o + 6]!, soon[o + 7]!);
      }
      const before = this.doorsOpen[t] ?? 0, beforeAhead = this.doorsAhead[t] ?? 0;
      this.doorsOpen[t] = open;
      this.doorsAhead[t] = ahead;
      const opening = before <= 0.001 && open > 0.001, closing = beforeAhead >= 0.999 && ahead < 0.999;
      if ((opening || closing) && best < heard) {
        heard = best;
        event = { opening, x, z };
      }
    }
    // one door sound at a time: the nearest train's, and none while the last one still plays
    this.doorQuiet = Math.max(0, this.doorQuiet - (tick - this.lastTick) / 60);
    this.lastTick = tick;
    if (event && this.doorQuiet === 0) {
      this.doorEvents.push(event);
      this.doorQuiet = DOOR_SOUND_GAP;
    }
    for (let i = 0; i < this.sections.length; i++) {
      const v = this.sections[i]!, o = i * SECTION_STRIDE;
      const x = s[o + 1]!, z = s[o + 3]!, dist = Math.hypot(x - camX, z - camZ);
      const on = s[o] === 1 && dist < DRAW_DIST;
      v.group.visible = on;
      if (!on) continue;
      if (dist < nearest) {
        nearest = dist;
        this.cabin.position.set(x, s[o + 2]! + TRAIN.ceiling - 0.3, z);
        this.cabin.intensity = CABIN_LIGHT;
      }
      v.group.position.set(x, s[o + 2]!, z);
      const q = sectionQuat(s[o + 4]!, s[o + 5]!);
      v.group.quaternion.set(q.x, q.y, q.z, q.w);
      // the next stop: dark until it is announced (half way there), then lit until the train leaves that stop
      const next = s[o + 9]! >= 0 || (s[o + 12]! >= 0.5 && s[o + 8]! > 0) ? s[o + 11]! : NEXT_DARK;
      if (v.nextStop.shown !== next) {
        v.nextStop.shown = next;
        for (const f of v.nextStop.faces) f.material = next === NEXT_DARK ? this.nextOff : this.nextStopText(next);
      }
      if (v.display) {
        const texts = v.display.texts, trip = s[o + 10]!;
        v.display.mesh.material = texts[((trip % texts.length) + texts.length) % texts.length]!;
      }
      for (const d of v.doors) {
        const open = d.side === 1 ? s[o + 6]! : s[o + 7]!;
        // sliding doors: out a little, then along the body
        d.mesh.position.set(d.side * (W - TRAIN.wall / 2 + 0.06 * Math.min(1, open * 4)), 0, d.dir * open * (DOOR - 0.04));
      }
    }
  }

  /** Whether the platform of `stop` lies between this track and another one (an island platform). */
  private platformBetweenTracks(trackIndex: number, tr: Transit['tracks'][number], cum: number[], stop: Transit['tracks'][number]['stops'][number]): boolean {
    const n = tr.pts.length / 3, i = Math.max(1, Math.min(n - 1, cum.findIndex((c) => c >= stop.s)));
    const x = tr.pts[i * 3]!, z = tr.pts[i * 3 + 2]!, fx = x - tr.pts[i * 3 - 3]!, fz = z - tr.pts[i * 3 - 1]!, len = Math.hypot(fx, fz) || 1;
    const lx = (fz / len) * stop.side, lz = (-fx / len) * stop.side;
    for (const [k, other] of this.transit.tracks.entries()) {
      if (k === trackIndex) continue;
      let best = Infinity, side = 0;
      for (let j = 0; j < other.pts.length; j += 3) {
        const dx = other.pts[j]! - x, dz = other.pts[j + 2]! - z, d = Math.hypot(dx, dz);
        if (d < best) { best = d; side = dx * lx + dz * lz; }
      }
      if (best < 40 && side > 0) return true;
    }
    return false;
  }

  /** The boards near the camera: the next trains with line, terminus and minutes (redrawn only when a row changes). */
  private updateBoards(tick: number, camX: number, camZ: number): void {
    for (const b of this.boards) {
      if (Math.hypot(b.x - camX, b.z - camZ) > BOARD_DIST) continue;
      // the next trains of every line that stops here, soonest first
      const rows_ = b.from.flatMap((f) => {
        const tr = this.transit.tracks[f.track]!;
        return nextArrivals(this.model, f.track, f.stop, tick, BOARD_ROWS).map((a) => ({ line: tr.line ?? '', to: tr.to ?? '', wait: a.wait }));
      }).sort((x, y) => x.wait - y.wait).slice(0, BOARD_ROWS).map((r) => ({ ...r, when: r.wait < 60 ? 'sofort' : `${Math.floor(r.wait / 60)} min` }));
      const key = rows_.map((r) => `${r.line}${r.to}${r.when}`).join('|');
      if (key === b.shown) continue;
      b.shown = key;
      // an LED matrix, as the boards on the platforms are: line, where to, and when, a row each
      ledMatrix(b.canvas, (g, cols, rows) => {
        // (as large as the rows allow, smaller if the longest row would not fit)
        const longest = Math.max(...rows_.map((r) => r.to.length), 1) + 3 + 8;
        let size = Math.round(rows / BOARD_ROWS * 0.72);
        do {
          g.font = `700 ${size}px ${LED_FONT}`;
          size -= 1;
        } while (g.measureText('0').width * longest > cols - 4 && size > 9);
        const ch = g.measureText('0').width, toX = 2 + ch * 3;
        rows_.forEach((r, i) => {
          const y = (rows / BOARD_ROWS) * (i + 0.5) + 0.5;
          g.textAlign = 'left';
          g.fillText(r.line, 2, y);
          const room = cols - 2 - toX - g.measureText(r.when).width - ch;
          let to = r.to;
          while (to.length > 3 && g.measureText(to).width > room) to = `${to.slice(0, -2)}.`;
          g.fillText(to, toX, y);
          g.textAlign = 'right';
          g.fillText(r.when, cols - 2, y);
        });
      }, 3);
      b.tex.needsUpdate = true;
    }
  }

  /** The display text for the next stop (one material per station, made on first use); −1: the end of the line. */
  private nextStopText(station: number): MeshBasicMaterial {
    let m = this.nextTexts.get(station);
    if (!m) {
      const tex = displayTexture(station < 0 ? 'Endstation' : this.transit.stations[station]?.name ?? '', undefined, 76);
      m = new MeshBasicMaterial({ map: tex });
      this.owned.push(tex, m);
      this.nextTexts.set(station, m);
    }
    return m;
  }

  /** Where someone at (x, y, z) (feet) sits, if they are on a bench of a train as drawn (see benchPlace); else null. */
  seated(x: number, y: number, z: number): Seated | null {
    const p = benchPlace(this.state, x, y, z);
    return p?.on ? p.seat : null;
  }

  /**
   * A remote person sampled at server tick `then`: if they were in a train then, where that puts them in the train
   * as drawn now (the trains run on the tick, a little ahead of the remote samples), and their seat if they sit.
   */
  aboard(x: number, y: number, z: number, then: number): { x: number; y: number; z: number; seat: Seated | null } | null {
    const old = sectionStates(this.model, then, this.stateThen), at = sectionAt(old, x, y, z);
    if (!at || this.state[at.o] !== 1) return null;
    const s = this.state, o = at.o, yaw = s[o + 4]!, sn = Math.sin(yaw), cs = Math.cos(yaw);
    const now = { x: s[o + 1]! + at.local.x * cs + at.local.z * sn, y: s[o + 2]! + at.local.y, z: s[o + 3]! - at.local.x * sn + at.local.z * cs };
    return { ...now, seat: this.seated(now.x, now.y, now.z) };
  }

  /** A station's name. */
  stationName(i: number): string {
    return this.transit.stations[i]?.name ?? '';
  }

  /** The door sounds due since the last call (see update()). */
  takeDoorEvents(): { opening: boolean; x: number; z: number }[] {
    const e = this.doorEvents;
    this.doorEvents = [];
    return e;
  }

  /**
   * The train section nearest to (x, y, z) as of the last update(): its distance, its speed (m/s) and whether the
   * point lies inside it the next station it stops at (−1: none) and how far it is
   * on the way there (0..1); null if no train is out.
   */
  nearest(x: number, y: number, z: number): { dist: number; speed: number; inside: boolean; next: number; way: number } | null {
    const s = this.state;
    let best: { dist: number; speed: number; inside: boolean; next: number; way: number } | null = null;
    for (let o = 0; o < s.length; o += SECTION_STRIDE) {
      if (s[o] !== 1) continue;
      const dx = x - s[o + 1]!, dz = z - s[o + 3]!, dist = Math.hypot(dx, dz);
      if (best && dist >= best.dist) continue;
      const yaw = s[o + 4]!, along = dx * Math.sin(yaw) + dz * Math.cos(yaw), across = dx * Math.cos(yaw) - dz * Math.sin(yaw), up = y - s[o + 2]!;
      best = { dist, speed: s[o + 8]!, inside: Math.abs(along) < L + 0.1 && Math.abs(across) < W && up > 0 && up < TRAIN.roof, next: s[o + 11]!, way: s[o + 12]! };
    }
    return best;
  }

  dispose(scene: Scene): void {
    scene.remove(this.root);
    for (const o of this.owned) o.dispose();
    for (const o of [this.signalPost, this.signalLamp, this.signalDark, this.signalRed, this.signalGreen]) o.dispose();
  }
}

/** A station's name as on Köln's Stadtbahn platforms: white on a red band, a white strip for directions below. */
function signTexture(name: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 832;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f2ee';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#b3161c';
  g.fillRect(0, 0, c.width, 168);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 104;
  do {
    g.font = `500 ${size}px "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif`;
    size -= 4;
  } while (g.measureText(name).width > c.width - 70 && size > 30);
  g.fillText(name, c.width / 2, 88);
  // the strip below: the way out, both ways
  g.fillStyle = '#b9b9b4';
  g.fillRect(0, 168, c.width, 4);
  g.fillStyle = '#1c1c1c';
  g.font = '500 44px "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillText('\u2190 Ausgang', 28, 216);
  g.textAlign = 'right';
  g.fillText('Ausgang \u2192', c.width - 28, 216);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A printed sign for a track: its lines in white boxes, then where they go, on blue. */
function lineSignTexture(lines: string[], to: string[]): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 800;
  c.height = 112;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16407a';
  g.fillRect(0, 0, c.width, c.height);
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.font = '700 58px system-ui, "Helvetica Neue", Arial, sans-serif';
  let x = 18;
  for (const l of lines) {
    const w = Math.max(70, g.measureText(l).width + 26);
    g.fillStyle = '#ffffff';
    g.fillRect(x, 16, w, 80);
    g.fillStyle = '#16407a';
    g.fillText(l, x + w / 2, 59);
    x += w + 12;
  }
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  // where to: one below the other if there are several
  const half = Math.ceil(to.length / 2);
  const rows = to.length > 1 ? [to.slice(0, half).join(' · '), to.slice(half).join(' · ')] : to;
  let size = rows.length > 1 ? 40 : 48;
  do {
    g.font = `600 ${size}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    size -= 2;
  } while (Math.max(...rows.map((r) => g.measureText(r).width)) > c.width - x - 24 && size > 18);
  rows.forEach((r, i) => g.fillText(r, x + 10, rows.length > 1 ? 34 + i * 46 : 58));
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const LED_FONT = '"DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace';
/** Distance between two LEDs of a display, in canvas pixels. */
const LED_PITCH = 4;

/**
 * Fills a canvas with a matrix of round amber LEDs: `paint` draws the picture small, one pixel per LED (white on
 * nothing, text baseline in the middle); every pixel more lit than not becomes a bright dot, the others a faint grid.
 */
function ledMatrix(c: HTMLCanvasElement, paint: (g: CanvasRenderingContext2D, cols: number, rows: number) => void, pitch = LED_PITCH): void {
  const g = c.getContext('2d')!;
  g.fillStyle = '#070707';
  g.fillRect(0, 0, c.width, c.height);
  const cols = Math.floor(c.width / pitch), rows = Math.floor(c.height / pitch);
  const low = document.createElement('canvas');
  low.width = cols;
  low.height = rows;
  const lg = low.getContext('2d', { willReadFrequently: true })!;
  lg.fillStyle = '#fff';
  lg.textBaseline = 'middle';
  paint(lg, cols, rows);
  const lit = lg.getImageData(0, 0, cols, rows).data;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const on = lit[(y * cols + x) * 4 + 3]! > 110;
      g.fillStyle = on ? '#ffb400' : '#1c1505';
      g.beginPath();
      g.arc(x * pitch + pitch / 2, y * pitch + pitch / 2, pitch * (on ? 0.44 : 0.3), 0, Math.PI * 2);
      g.fill();
    }
  }
}

/**
 * Amber text as on a train's display: a matrix of round LEDs (lit ones bright, the others a faint grid), not a
 * printed font. `small`: a line of small print above it; height: the canvas's (a flatter display).
 */
function displayTexture(text: string, small?: string, height?: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 608;
  c.height = height ?? (small ? 132 : 108);
  ledMatrix(c, (lg, cols, rows) => {
    lg.textAlign = 'center';
    const line = (str: string, most: number, y: number): void => {
      let size = most;
      do {
        lg.font = `700 ${size}px ${LED_FONT}`;
        size -= 1;
      } while (lg.measureText(str).width > cols - 4 && size > 7);
      lg.fillText(str, cols / 2, y);
    };
    if (small) {
      line(small, Math.round(rows * 0.3), rows * 0.2);
      line(text, Math.round(rows * 0.56), rows * 0.66);
    } else line(text, Math.round(rows * 0.82), rows / 2 + 0.5);
  });
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Poses a figure (its group in the scene) sitting on a bench: hips on the cushion, feet on the floor, hands on the thighs. */
export function sitOnBench(fig: PlayerFigure, seat: Seated): void {
  const fx = Math.sin(seat.yaw), fz = Math.cos(seat.yaw), lx = Math.cos(seat.yaw), lz = -Math.sin(seat.yaw);
  const at = (ahead: number, left: number, up: number) => new Vector3(seat.x + fx * ahead + lx * left, seat.y + up, seat.z + fz * ahead + lz * left);
  fig.pose(at(-0.14, 0, 0.1), seat.yaw, -0.1, [at(0.3, 0.11, 0.09 - BENCH.seat), at(0.3, -0.11, 0.09 - BENCH.seat)], [at(0.16, 0.15, 0.2), at(0.16, -0.15, 0.2)], 0, 0.2);
}
