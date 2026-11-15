import { describe, expect, it } from 'vitest';
import { parseCamParam } from './devparams';

describe('parseCamParam', () => {
  it('parses x,y,z,yawDeg,pitchDeg', () => {
    expect(parseCamParam('132.5,121.7,-17,180,-45')).toEqual({ x: 132.5, y: 121.7, z: -17, yawDeg: 180, pitchDeg: -45 });
  });
  it('defaults yaw and pitch to 0', () => {
    expect(parseCamParam('1,2,3')).toEqual({ x: 1, y: 2, z: 3, yawDeg: 0, pitchDeg: 0 });
  });
  it('rejects missing or malformed values', () => {
    expect(parseCamParam(null)).toBeNull();
    expect(parseCamParam('1,2')).toBeNull();
    expect(parseCamParam('1,x,3')).toBeNull();
    expect(parseCamParam('1,2,3,4,5,6')).toBeNull();
  });
});
