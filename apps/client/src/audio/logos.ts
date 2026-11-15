import type { StationId } from './stations';

/** Round badge every logo sits on (same size and rim, so the four read as one set). */
const badge = (fill: string): string =>
  `<circle cx="50" cy="50" r="47" fill="${fill}"/><circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="2"/>`;
const svg = (defs: string, body: string): string =>
  `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>${defs}</defs>${body}</svg>`;

/**
 * Made-up station logos (inline SVG, viewBox 0 0 100 100), deliberately unlike the real stations' marks:
 * Köllefornia = palm and cathedral against a sunset, Radio Köln = red/white spires over the Rhine with
 * broadcast arcs, 1LIVE = a neon "1" between radio waves, off = a crossed-out speaker.
 */
export const LOGOS: Record<StationId | 'off', string> = {
  koellefornia: svg(
    `<linearGradient id="nnl-k-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1b5c"/>`
      + `<stop offset="0.5" stop-color="#d9446e"/><stop offset="0.78" stop-color="#ffa64d"/></linearGradient>`
      + `<clipPath id="nnl-k-clip"><circle cx="50" cy="50" r="47"/></clipPath>`,
    `${badge('url(#nnl-k-sky)')}<g clip-path="url(#nnl-k-clip)">`
      + `<circle cx="50" cy="70" r="20" fill="#ffd36b"/>`
      + `<path d="M0 72h100v28H0z" fill="#2a1438"/>`
      + `<path d="M48 73V48l2-3v-4l4-16 4 16v4l2 3v6h4v-6l2-3v-4l4-16 4 16v4l2 3v12h6v-6l3-4 3 4v19z" fill="#2a1438"/>`
      + `<path d="M29 73c1-11 2-21 6-31" fill="none" stroke="#2a1438" stroke-width="3.6" stroke-linecap="round"/>`
      + `<path d="M35 42c-6-6-14-6-20-2 7-1 13 0 20 2zM35 42c-2-8-9-12-16-12 6 3 11 7 16 12zM35 42c3-8 10-11 17-9-7 1-12 4-17 9z`
      + `M35 42c6-4 14-3 18 3-6-2-12-3-18-3zM35 42c-7-1-13 3-15 9 4-4 9-7 15-9z" fill="#2a1438" stroke="#2a1438" stroke-width="1.6" stroke-linejoin="round"/>`
      + `</g>`,
  ),
  radiokoeln: svg(
    `<radialGradient id="nnl-r-bg" cx="0.5" cy="0.35" r="0.7"><stop offset="0" stop-color="#e8384f"/><stop offset="1" stop-color="#8e1023"/></radialGradient>`,
    `${badge('url(#nnl-r-bg)')}`
      + `<path d="M36 68V44l3-3v-5l5-18 5 18v5l1 1 1-1v-5l5-18 5 18v5l3 3v24z" fill="#fff"/>`
      + `<path d="M42 68v-9a2 2 0 0 1 4 0v9zM54 68v-9a2 2 0 0 1 4 0v9z" fill="#b51a30"/>`
      + `<path d="M24 75q6.5-5 13 0t13 0 13 0 13 0M28 83q5.5-4 11 0t11 0 11 0 11 0" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>`
      + `<path d="M28 28a26 26 0 0 0 0 26M72 28a26 26 0 0 1 0 26M21 22a35 35 0 0 0 0 38M79 22a35 35 0 0 1 0 38" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" opacity="0.9"/>`,
  ),
  einslive: svg(
    `<radialGradient id="nnl-e-bg" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#241a52"/><stop offset="1" stop-color="#0b0820"/></radialGradient>`
      + `<filter id="nnl-e-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.4" result="b"/>`
      + `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    `${badge('url(#nnl-e-bg)')}<g filter="url(#nnl-e-glow)" fill="none" stroke-linecap="round" stroke-linejoin="round">`
      + `<path d="M40 35l13-10v50M40 75h26" stroke="#5ff4ff" stroke-width="8"/>`
      + `<path d="M30 36a22 22 0 0 0 0 28M70 36a22 22 0 0 1 0 28M22 29a32 32 0 0 0 0 42M78 29a32 32 0 0 1 0 42" stroke="#ff4fd8" stroke-width="3.6"/>`
      + `</g>`,
  ),
  off: svg(
    '',
    `${badge('#2b2f3b')}`
      + `<path d="M27 41h11l15-12v42L38 59H27z" fill="#c8ccd8" stroke="#c8ccd8" stroke-width="3" stroke-linejoin="round"/>`
      + `<path d="M61 40a13 13 0 0 1 0 20M67 33a22 22 0 0 1 0 34" fill="none" stroke="#c8ccd8" stroke-width="3.6" stroke-linecap="round"/>`
      + `<path d="M26 74L74 26" stroke="#2b2f3b" stroke-width="11" stroke-linecap="round"/>`
      + `<path d="M26 74L74 26" stroke="#ff6b6b" stroke-width="6" stroke-linecap="round"/>`,
  ),
};
