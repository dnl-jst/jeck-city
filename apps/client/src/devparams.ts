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

/** `now` moved to the local date from `?date=YYYY-MM-DD`, keeping its local wall-clock time; `now` itself if absent or invalid. */
export function withDateParam(now: Date, s: string | null): Date {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!r) return now;
  const y = Number(r[1]), m = Number(r[2]) - 1, d = Number(r[3]);
  const out = new Date(y, m, d, now.getHours(), now.getMinutes(), now.getSeconds());
  return out.getFullYear() === y && out.getMonth() === m && out.getDate() === d ? out : now;
}

export type DevAllowed = { cam: boolean; fly: boolean; writeHooks: boolean; weather: boolean };

/**
 * Which dev hooks apply. Offline: as before (`?cam` always, fly with `?debug=1`, write hooks in a dev build or with `?debug=1`). Online: everything
 * only when the server runs in dev mode (`?cam` then teleports the player there with `devTeleport`).
 */
export function devAllowed(
  mode: 'offline' | 'online', welcome: { devMode: boolean } | null, debug: boolean, devBuild = false,
): DevAllowed {
  if (mode === 'offline') return { cam: true, fly: debug, writeHooks: devBuild || debug, weather: true };
  const dev = welcome?.devMode === true;
  return { cam: dev, fly: dev, writeHooks: dev, weather: dev };
}
