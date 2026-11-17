import { TICK_HZ } from '../net/constants';

/**
 * A lane arriving at a junction: its drive edge, its signal group (0/1), where to stop on it (m from the edge's
 * start; the stop line), and its priority rank (road class; give_way/stop lowers it, priority_road raises it).
 */
export type Approach = { edge: number; group: 0 | 1; stopS: number; rank: number };
/** A walk crossing edge at a signalled junction and the signal group its pedestrians follow. */
export type PedSignal = { walkEdge: number; group: 0 | 1 };
/**
 * A signal pole: position (on the sidewalk), heading (the lights face along it: forward = (sin h, cos h)), kind.
 * approach / ped: index into the junction's approaches / peds whose signal it shows.
 */
export type Pole = { x: number; z: number; heading: number; kind: 'car' | 'ped' | 'car+ped'; approach?: number; ped?: number };
/**
 * A junction of the drive graph (three or more arms) or a signalled pedestrian crossing on a way (midblock).
 * x/z: centre. signal: null = no traffic lights (right of way); offsetTicks shifts its cycle. turns: the drive edges
 * across it (arcs from approach to exit). cycleApproaches / cycleTurns: the same on the cycle graph. stopLines:
 * segments to paint.
 */
export type JunctionInfo = {
  x: number; z: number;
  signal: { id: number; offsetTicks: number; midblock: boolean } | null;
  approaches: Approach[];
  turns: number[];
  cycleApproaches: Approach[];
  cycleTurns: number[];
  peds: PedSignal[];
  poles: Pole[];
  stopLines: { x0: number; z0: number; x1: number; z1: number }[];
};

/** Anything with a junction's signal (JunctionInfo, SignalJunction). */
export type HasSignal = { signal: JunctionInfo['signal'] };
export type Light = 'red' | 'redAmber' | 'green' | 'amber';

/** Signal timing (s). Junction: two groups alternate. Midblock: pedestrians (group 1) and cars (group 0). */
export const SIGNAL_TIMING = { green: 20, amber: 3, redAmber: 1, allRed: 2, pedEarlyEnd: 5, midblockCycle: 40, midblockPedGreen: 12 } as const;
const T = SIGNAL_TIMING;
const HALF = T.green + T.amber + T.allRed + T.redAmber;
const CYCLE = 2 * HALF;

/** Seconds into the junction's cycle at tick (the offset shifts it). */
function phase(j: HasSignal, tick: number, cycle: number): number {
  const t = (tick + j.signal!.offsetTicks) / TICK_HZ;
  return ((t % cycle) + cycle) % cycle;
}

/** The light group `group` of junction j shows at tick (always green without traffic lights). */
export function signalAt(j: HasSignal, group: 0 | 1, tick: number): Light {
  if (!j.signal) return 'green';
  if (j.signal.midblock) {
    // pedestrians [0, 12), all red [12, 15), red-amber [15, 16), cars green [16, 35), amber [35, 38), all red [38, 40)
    const u = phase(j, tick, T.midblockCycle);
    const g0 = T.midblockPedGreen + 3 + T.redAmber, g1 = T.midblockCycle - T.allRed - T.amber;
    if (u >= g0 - T.redAmber && u < g0) return 'redAmber';
    if (u >= g0 && u < g1) return 'green';
    if (u >= g1 && u < g1 + T.amber) return 'amber';
    return 'red';
  }
  const u = (phase(j, tick, CYCLE) - group * HALF + CYCLE) % CYCLE;
  if (u < T.green) return 'green';
  if (u < T.green + T.amber) return 'amber';
  if (u >= CYCLE - T.redAmber) return 'redAmber';
  return 'red';
}

/** The pedestrian light of group `group` at tick: green with the parallel cars, ending pedEarlyEnd s before their amber. */
export function pedSignalAt(j: HasSignal, group: 0 | 1, tick: number): 'red' | 'green' {
  if (!j.signal) return 'green';
  if (j.signal.midblock) return phase(j, tick, T.midblockCycle) < T.midblockPedGreen ? 'green' : 'red';
  const u = (phase(j, tick, CYCLE) - group * HALF + CYCLE) % CYCLE;
  return u < T.green - T.pedEarlyEnd ? 'green' : 'red';
}

/**
 * What the client needs of a signalled junction (signals.json): its cycle and its poles, each with the signal group its
 * car head shows (-1: none) and that of its pedestrian head (-1: none).
 */
export type SignalPole = { x: number; z: number; heading: number; kind: Pole['kind']; group: -1 | 0 | 1; ped: -1 | 0 | 1 };
export type SignalJunction = { x: number; z: number; signal: NonNullable<JunctionInfo['signal']>; poles: SignalPole[] };

/** The signalled junctions with their poles' groups resolved. */
export function signalJunctionsOf(junctions: readonly JunctionInfo[]): SignalJunction[] {
  return junctions.filter((j) => j.signal).map((j) => ({
    x: j.x, z: j.z, signal: j.signal!,
    poles: j.poles.map((p) => ({
      x: p.x, z: p.z, heading: p.heading, kind: p.kind,
      group: (p.approach !== undefined ? j.approaches[p.approach]?.group ?? -1 : -1) as -1 | 0 | 1,
      ped: (p.ped !== undefined ? j.peds[p.ped]?.group ?? -1 : -1) as -1 | 0 | 1,
    })),
  }));
}

/** signals.json; throws on anything malformed. */
export function parseSignals(json: unknown): SignalJunction[] {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!Array.isArray(json)) throw new Error('signals.json: not an array');
  (json as SignalJunction[]).forEach((j, i) => {
    const ok = j && num(j.x) && num(j.z) && j.signal && num(j.signal.offsetTicks) && typeof j.signal.midblock === 'boolean' && Array.isArray(j.poles)
      && j.poles.every((p) => num(p.x) && num(p.z) && num(p.heading) && [-1, 0, 1].includes(p.group) && [-1, 0, 1].includes(p.ped));
    if (!ok) throw new Error(`signals.json: junction ${i}`);
  });
  return json as SignalJunction[];
}
