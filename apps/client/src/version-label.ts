/**
 * The version in the bottom left corner, from the intro on: `v1.2.3`. With `?debug=1` it names the client's and the
 * server's version (the server's arrives with its welcome; `–` until then and offline).
 */
export function versionText(client: string, server: string | null, debug: boolean): string {
  return debug ? `Client ${client} · Server ${server ?? '–'}` : `v${client}`;
}

const CSS = `
  .nn-version { position: fixed; z-index: 26; left: calc(8px + env(safe-area-inset-left)); bottom: calc(6px + env(safe-area-inset-bottom));
    color: rgba(255,255,255,0.6); font: 11px/1.3 system-ui, sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    pointer-events: none; user-select: none; }`;

let label: { el: HTMLDivElement; client: string; debug: boolean } | null = null;

export function showVersion(root: HTMLElement, client: string, debug: boolean): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.className = 'nn-version';
  el.textContent = versionText(client, null, debug);
  root.append(el);
  label = { el, client, debug };
}

/** The connected server's version (from its welcome); only shown with `?debug=1`. */
export function setServerVersion(server: string | null): void {
  if (label) label.el.textContent = versionText(label.client, server, label.debug);
}
