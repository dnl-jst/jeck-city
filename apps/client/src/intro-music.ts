/**
 * The title song on the intro and loading screens. Browsers only play sound after a click, so the intro asks for one
 * (its start overlay); a key press or any later click also starts it. It fades out once the game really starts. A
 * small button mutes it; the choice is remembered.
 *
 * With the first gesture the song is routed through Web Audio: an analyser feeds the intro animation, a gain node
 * does mute and fade (the element's own volume is left at 1, so the analyser always sees the full signal).
 */

const SONG_URL = '/audio/intro-song.m4a';
const VOLUME = 0.6;
const MUTE_KEY = 'nn-intro-music-muted';

const MUSIC_CSS = `
  .nn-music { position: fixed; z-index: 30; right: 14px; top: 14px; width: 40px; height: 40px; padding: 0; border-radius: 50%;
    border: 1px solid rgba(242,196,107,0.5); background: rgba(10,12,20,0.55); color: #f2c46b; cursor: pointer;
    font: 18px/1 system-ui, sans-serif; transition: opacity 0.6s, background 0.15s; }
  .nn-music:hover { background: rgba(242,196,107,0.15); }
  .nn-music:focus-visible { outline: 2px solid #f2c46b; outline-offset: 3px; }
  .nn-music.nn-gone { opacity: 0; pointer-events: none; }
`;

function storedMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // private mode: only for this visit
  }
}

interface Music {
  audio: HTMLAudioElement;
  button: HTMLButtonElement;
  muted: boolean;
  /** 1 → 0 while fading out. */
  fade: number;
  graph: { ctx: AudioContext; analyser: AnalyserNode; gain: GainNode } | null;
}

let music: Music | null = null;
let stopGestures: (() => void) | null = null;

function applyLevel(m: Music): void {
  const level = m.muted ? 0 : VOLUME * m.fade;
  if (m.graph) m.graph.gain.gain.value = level;
  else m.audio.volume = level;
}

/** Inside a user gesture: route the song through Web Audio (once) and make sure the context runs. */
function connectGraph(m: Music): void {
  if (!m.graph) {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      // ≈ 47 Hz per bin and light smoothing: the kick drum stands out for the beat detection (intro-beat.ts)
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.3;
      const gain = ctx.createGain();
      ctx.createMediaElementSource(m.audio).connect(analyser);
      analyser.connect(gain).connect(ctx.destination);
      m.audio.volume = 1;
      m.graph = { ctx, analyser, gain };
      applyLevel(m);
    } catch {
      return; // without Web Audio the plain element plays (and the animation idles)
    }
  }
  if (m.graph.ctx.state !== 'running') void m.graph.ctx.resume().catch(() => undefined);
}

/** Sets up the song (once) and tries to play it; the first click or key press starts it if autoplay is blocked. */
export function startIntroMusic(root: HTMLElement): void {
  if (music) return;
  const audio = new Audio(SONG_URL);
  audio.loop = true;
  const style = document.createElement('style');
  style.textContent = MUSIC_CSS;
  document.head.append(style);
  const button = document.createElement('button');
  const m: Music = music = { audio, button, muted: storedMuted(), fade: 1, graph: null };
  applyLevel(m);
  button.type = 'button';
  button.className = 'nn-music';
  const label = (): void => {
    button.textContent = m.muted ? '🔇' : '🔊';
    button.title = button.ariaLabel = m.muted ? 'Musik an' : 'Musik aus';
  };
  label();
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    m.muted = !m.muted;
    storeMuted(m.muted);
    label();
    applyLevel(m);
    if (!m.muted) void audio.play().catch(() => undefined);
  });
  // the game's key handlers on window must not see a Space/Enter on the button
  for (const type of ['keydown', 'keyup'] as const) button.addEventListener(type, (e) => e.stopPropagation());
  root.append(button);
  const onGesture = (): void => {
    if (music !== m) return;
    connectGraph(m);
    audio.play().then(() => stopGestures?.(), () => undefined);
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
  stopGestures = () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    stopGestures = null;
  };
  // no gesture yet: plays only where autoplay is allowed (without Web Audio until the first click)
  autoplay = audio.play().then(() => true, () => false);
}

let autoplay: Promise<boolean> = Promise.resolve(false);

/** Whether the intro needs a click to start the song: false once it plays by itself, or when muted by choice. */
export function introMusicNeedsClick(): { now: boolean; settled: Promise<boolean> } {
  const m = music;
  if (!m || m.muted) return { now: false, settled: Promise.resolve(false) };
  return { now: true, settled: autoplay.then((playing) => !playing && music === m && !m.muted) };
}

/**
 * The song's spectrum now (0–255 per bin, low to high frequencies) into `out`; false while nothing can be measured
 * (not started, no Web Audio, paused).
 */
export function introMusicSpectrum(out: Uint8Array<ArrayBuffer>): boolean {
  const g = music?.graph;
  if (!g || music!.audio.paused) return false;
  g.analyser.getByteFrequencyData(out);
  return true;
}

/** Fades the song out over `ms` and removes it with its button; a no-op when it never started. */
export function fadeOutIntroMusic(ms = 2500): void {
  const m = music;
  if (!m) return;
  music = null;
  stopGestures?.();
  m.button.classList.add('nn-gone');
  const t0 = performance.now();
  // a timer, not requestAnimationFrame: the fade must also finish in a background tab
  const timer = window.setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    m.fade = (1 - k) * (1 - k);
    applyLevel(m);
    if (k < 1) return;
    window.clearInterval(timer);
    m.audio.pause();
    m.audio.removeAttribute('src');
    m.audio.load();
    void m.graph?.ctx.close().catch(() => undefined);
    m.button.remove();
  }, 40);
}
