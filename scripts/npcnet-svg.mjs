// Draws the NPC network around a point as SVG (and PNG if rsvg-convert exists) for a visual check.
//   node scripts/npcnet-svg.mjs [x z [size]]      default: the spawn, 400 m
// Buildings grey, sidewalks/paths green (crossings dark green), car lanes blue, cycle lanes orange, seat rings red,
// stop lines black, signal poles yellow.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const WORLD = process.env.NN_WORLD_DIR ?? 'apps/client/public/world';
const manifest = JSON.parse(readFileSync(`${WORLD}/manifest.json`, 'utf8'));
const net = JSON.parse(readFileSync(`${WORLD}/npc.json`, 'utf8'));
const map = JSON.parse(readFileSync(`${WORLD}/map.json`, 'utf8'));
const [ax, az, as] = process.argv.slice(2).map(Number);
const cx = Number.isFinite(ax) ? ax : manifest.spawn.x;
const cz = Number.isFinite(az) ? az : manifest.spawn.z;
const size = Number.isFinite(as) ? as : 400;
const x0 = cx - size / 2, z0 = cz - size / 2;
const S = 2000 / size; // px per m
const px = (x, z) => `${((x - x0) * S).toFixed(1)},${((z - z0) * S).toFixed(1)}`;
const inside = (x, z) => x > x0 - 20 && x < x0 + size + 20 && z > z0 - 20 && z < z0 + size + 20;

const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="2000" viewBox="0 0 2000 2000"><rect width="2000" height="2000" fill="#f4f1ea"/>`];
for (const t of map.buildings) {
  for (let i = 0; i + 5 < t.length; i += 6) {
    if (!inside(t[i], t[i + 1])) continue;
    out.push(`<polygon points="${px(t[i], t[i + 1])} ${px(t[i + 2], t[i + 3])} ${px(t[i + 4], t[i + 5])}" fill="#bbb" stroke="#bbb" stroke-width="0.5"/>`);
  }
}
const lines = (g, color, w, crossingColor) => {
  for (const e of g.edges) {
    if (!e.pts.some(([x, z]) => inside(x, z))) continue;
    const c = e.crossing && crossingColor ? crossingColor : color;
    out.push(`<polyline points="${e.pts.map(([x, z]) => px(x, z)).join(' ')}" fill="none" stroke="${c}" stroke-width="${w}"${e.oneway ? ' marker-mid="url(#a)"' : ''}/>`);
  }
};
out.push('<defs><marker id="a" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#226"/></marker></defs>');
lines(net.walk, '#3a9a3a', 2, '#0b4f0b');
lines(net.cycle, '#e08a1e', 1.5);
lines(net.drive, '#2b5fd9', 2);
for (const r of net.seats) {
  if (!inside(r.x, r.z)) continue;
  for (const q of r.seats) out.push(`<circle cx="${((q.x - x0) * S).toFixed(1)}" cy="${((q.z - z0) * S).toFixed(1)}" r="${Math.max(2, 0.3 * S)}" fill="#d22"/>`);
}
for (const j of net.junctions ?? []) {
  for (const l of j.stopLines ?? []) if (inside(l.x0, l.z0)) out.push(`<line x1="${((l.x0 - x0) * S).toFixed(1)}" y1="${((l.z0 - z0) * S).toFixed(1)}" x2="${((l.x1 - x0) * S).toFixed(1)}" y2="${((l.z1 - z0) * S).toFixed(1)}" stroke="#000" stroke-width="3"/>`);
  for (const p of j.poles ?? []) if (inside(p.x, p.z)) out.push(`<circle cx="${((p.x - x0) * S).toFixed(1)}" cy="${((p.z - z0) * S).toFixed(1)}" r="5" fill="#f2c400" stroke="#000"/>`);
}
out.push('</svg>');
mkdirSync('shots', { recursive: true });
const name = `shots/npcnet-${Math.round(cx)}_${Math.round(cz)}`;
writeFileSync(`${name}.svg`, out.join('\n'));
try {
  execFileSync('rsvg-convert', ['-o', `${name}.png`, `${name}.svg`]);
  console.log(`${name}.svg, ${name}.png`);
} catch {
  console.log(`${name}.svg (no rsvg-convert for a PNG)`);
}
