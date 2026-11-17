/**
 * Keeps phones and tablets from zooming the page: iOS Safari ignores `user-scalable=no` and zooms on a quick double
 * tap or a pinch. A second tap within DOUBLE_TAP_MS has its touchend cancelled (form fields keep theirs, so text
 * editing works), and Safari's pinch gesture events are cancelled. The game's own buttons act on pointerdown and
 * do not need the click the cancelled touchend would have made.
 */
const DOUBLE_TAP_MS = 350;

export function preventPageZoom(doc: Document = document): void {
  let lastTap = 0;
  doc.addEventListener('touchend', (e) => {
    const now = performance.now();
    const quick = now - lastTap < DOUBLE_TAP_MS;
    lastTap = now;
    if (!quick || e.touches.length > 0) return;
    const t = e.target as Element | null;
    if (t?.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
  }, { passive: false });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) doc.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  // a pinch with two fingers on the page (non-Safari browsers that ignore the viewport tag)
  doc.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1 && (e as TouchEvent & { scale?: number }).scale !== undefined && (e as TouchEvent & { scale?: number }).scale !== 1) e.preventDefault();
  }, { passive: false });
}
