/** Dev camera from `?cam=x,y,z,yawDeg,pitchDeg`; yaw uses the manifest heading convention (forward = (sin, cos) in x/z, 180 = north). */
export type DevCam = { x: number; y: number; z: number; yawDeg: number; pitchDeg: number };

export function parseCamParam(s: string | null): DevCam | null {
  if (s === null) return null;
  const parts = s.split(',');
  if (parts.length < 3 || parts.length > 5) return null;
  const v = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
  if (v.some((x) => !Number.isFinite(x))) return null;
  return { x: v[0]!, y: v[1]!, z: v[2]!, yawDeg: v[3] ?? 0, pitchDeg: v[4] ?? 0 };
}
