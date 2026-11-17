import { expect, test } from 'vitest';
import { TICK_HZ } from '../net/constants';
import { parseSignals, pedSignalAt, signalAt, signalJunctionsOf, SIGNAL_TIMING as T, type JunctionInfo } from './signals';

test('signalJunctionsOf keeps the signalled junctions and gives each pole the groups of its heads', () => {
  const j: JunctionInfo = {
    ...junction(77), approaches: [{ edge: 5, group: 1, stopS: 10, rank: 2 }], peds: [{ walkEdge: 9, group: 0 }],
    poles: [{ x: 1, z: 2, heading: 0.5, kind: 'car+ped', approach: 0, ped: 0 }, { x: 3, z: 4, heading: 1, kind: 'ped', ped: 0 }],
    stopLines: [{ x0: 1, z0: 1, x1: 2, z1: 1 }],
  };
  const out = signalJunctionsOf([j, { ...junction(), signal: null }]);
  expect(out).toEqual([{ x: 0, z: 0, signal: j.signal, poles: [
    { x: 1, z: 2, heading: 0.5, kind: 'car+ped', group: 1, ped: 0 },
    { x: 3, z: 4, heading: 1, kind: 'ped', group: -1, ped: 0 },
  ], stopLines: [{ x0: 1, z0: 1, x1: 2, z1: 1 }] }]);
  expect(parseSignals(JSON.parse(JSON.stringify(out)))).toEqual(out);
  expect(() => parseSignals([{ x: 0 }])).toThrow();
});

const junction = (offsetTicks = 0, midblock = false): JunctionInfo => ({
  x: 0, z: 0, signal: { id: 1, offsetTicks, midblock }, approaches: [], turns: [], cycleApproaches: [], cycleTurns: [], peds: [], poles: [], stopLines: [],
});
const CYCLE = 2 * (T.green + T.amber + T.allRed + T.redAmber);

test('phases cycle green, amber, all-red, red-amber in the right order and length', () => {
  const j = junction();
  const seq: [string, number][] = [];
  for (let t = 0; t < CYCLE * TICK_HZ; t++) {
    const l = signalAt(j, 0, t);
    if (seq.length && seq[seq.length - 1]![0] === l) seq[seq.length - 1]![1]++;
    else seq.push([l, 1]);
  }
  expect(seq.map((s) => s[0])).toEqual(['green', 'amber', 'red', 'redAmber']);
  expect(seq.map((s) => s[1] / TICK_HZ)).toEqual([T.green, T.amber, CYCLE - T.green - T.amber - T.redAmber, T.redAmber]);
});

test('the two groups are never green at once, and never both moving', () => {
  const j = junction(1234);
  for (let t = 0; t < 3 * CYCLE * TICK_HZ; t++) {
    const a = signalAt(j, 0, t), b = signalAt(j, 1, t);
    expect(a === 'green' && b === 'green').toBe(false);
    expect(a !== 'red' && b !== 'red').toBe(false);
  }
});

test('pedestrians are green only while their parallel cars are and end 5 s early', () => {
  const j = junction();
  let pedGreen = 0;
  for (let t = 0; t < CYCLE * TICK_HZ; t++) {
    if (pedSignalAt(j, 0, t) !== 'green') continue;
    pedGreen++;
    expect(signalAt(j, 0, t)).toBe('green');
    expect(signalAt(j, 0, t + T.pedEarlyEnd * TICK_HZ - 1)).toBe('green');
  }
  expect(pedGreen / TICK_HZ).toBe(T.green - T.pedEarlyEnd);
});

test('a midblock signal: cars never green while pedestrians are, 12 s pedestrian green per 40 s', () => {
  const j = junction(0, true);
  let ped = 0;
  for (let t = 0; t < T.midblockCycle * TICK_HZ; t++) {
    const p = pedSignalAt(j, 1, t), c = signalAt(j, 0, t);
    if (p === 'green') {
      ped++;
      expect(c).toBe('red');
    }
  }
  expect(ped / TICK_HZ).toBe(T.midblockPedGreen);
});

test('junctions with different offsets switch at different times', () => {
  const a = junction(0), b = junction(17 * TICK_HZ);
  let differ = 0;
  for (let t = 0; t < CYCLE * TICK_HZ; t += 30) if (signalAt(a, 0, t) !== signalAt(b, 0, t)) differ++;
  expect(differ).toBeGreaterThan(10);
});

test('an unsignalled junction is always green (right of way decides)', () => {
  const j: JunctionInfo = { ...junction(), signal: null };
  expect(signalAt(j, 0, 99)).toBe('green');
  expect(pedSignalAt(j, 1, 99)).toBe('green');
});
