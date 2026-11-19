/**
 * The intro's animation: Cologne Cathedral at night on the Domplatte, floodlit; a red-and-white equalizer ring
 * around it dances to the title song, every beat throws carnival confetti from the spires and brightens the windows,
 * two searchlights sweep the sky. Without the song (muted, not started yet) it idles on a soft synthetic pulse.
 */
import {
  AdditiveBlending, AmbientLight, BoxGeometry, CircleGeometry, Color, ConeGeometry, CylinderGeometry, DirectionalLight,
  DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Fog, Group, InstancedMesh, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, BufferGeometry, Scene, Shape,
  SpotLight, WebGLRenderer, type Material,
} from 'three';
import { BeatDetector } from './intro-beat';
import { introMusicSpectrum } from './intro-music';

const RING_BARS = 64;
const RING_RADIUS = 11.5;
const CONFETTI = 1400;
/** The cathedral's centre (the ring and the camera circle around it). */
const CENTRE = { x: 0, z: -4 };
const CONFETTI_COLORS = ['#e3262f', '#ffffff', '#f2c46b', '#2f6fe3', '#3cbf5a', '#e3262f', '#ffffff'];

interface Flake { x: number; y: number; z: number; vx: number; vy: number; vz: number; rx: number; ry: number; spin: number; life: number }

function stone(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: '#55545f', roughness: 0.85, metalness: 0.05 });
}

/** A gothic west front with two spires, the nave and the choir behind. */
function buildCathedral(windows: MeshBasicMaterial, finials: MeshBasicMaterial): Group {
  const g = new Group();
  const mat = stone();
  const add = (geo: BoxGeometry | CylinderGeometry | ConeGeometry | ExtrudeGeometry, x: number, y: number, z: number, m: Material = mat): Mesh => {
    const mesh = new Mesh(geo, m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  for (const side of [-1, 1]) {
    const x = side * 1.7;
    add(new BoxGeometry(1.9, 7.4, 1.9), x, 3.7, 0);
    add(new BoxGeometry(1.6, 1.4, 1.6), x, 8.1, 0);
    add(new CylinderGeometry(0.72, 0.9, 2.6, 8), x, 10.1, 0);
    add(new ConeGeometry(0.76, 5.6, 8), x, 14.2, 0);
    add(new ConeGeometry(0.13, 0.7, 6), x, 17.3, 0, finials);
    // corner pinnacles on the tower
    for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]] as const) {
      add(new ConeGeometry(0.17, 1.5, 6), x + dx, 8.2, dz);
      add(new ConeGeometry(0.1, 1.1, 6), x + dx * 0.7, 11.6, dz * 0.7);
    }
    // tall lancet windows on the front
    for (let i = 0; i < 2; i++) {
      const w = new Mesh(new PlaneGeometry(0.32, 2.4), windows);
      w.position.set(x + (i ? 0.38 : -0.38), 4.2, 0.96);
      g.add(w);
    }
    const w2 = new Mesh(new PlaneGeometry(0.4, 1.6), windows);
    w2.position.set(x, 10.1, 0.83);
    g.add(w2);
  }
  // centre front with portal and rose window, a gable on top
  add(new BoxGeometry(1.6, 6.2, 1.5), 0, 3.1, -0.1);
  const gable = new Shape();
  gable.moveTo(-0.8, 0);
  gable.lineTo(0.8, 0);
  gable.lineTo(0, 1.6);
  gable.closePath();
  add(new ExtrudeGeometry(gable, { depth: 1.5, bevelEnabled: false }), 0, 6.2, -0.85);
  const portal = new Mesh(new PlaneGeometry(0.75, 2.1), windows);
  portal.position.set(0, 1.05, 0.66);
  g.add(portal);
  const rose = new Mesh(new CircleGeometry(0.42, 16), windows);
  rose.position.set(0, 4.3, 0.66);
  g.add(rose);
  // nave with its steep roof, the choir with the apse
  add(new BoxGeometry(4.4, 6, 10), 0, 3, -6);
  const roof = new Shape();
  roof.moveTo(-2.3, 0);
  roof.lineTo(2.3, 0);
  roof.lineTo(0, 3);
  roof.closePath();
  add(new ExtrudeGeometry(roof, { depth: 10, bevelEnabled: false }), 0, 6, -11);
  add(new CylinderGeometry(2.2, 2.2, 6, 10, 1, false, Math.PI / 2, Math.PI), 0, 3, -11);
  add(new ConeGeometry(2.3, 2.6, 10, 1, false, Math.PI / 2, Math.PI), 0, 7.3, -11);
  // the ridge turret
  add(new ConeGeometry(0.28, 3, 6), 0, 10, -8);
  for (let i = 0; i < 5; i++) {
    for (const side of [-1, 1]) {
      const w = new Mesh(new PlaneGeometry(1, 3), windows);
      w.position.set(side * 2.21, 3.4, -2.6 - i * 1.8);
      w.rotation.y = side * Math.PI / 2;
      g.add(w);
    }
  }
  return g;
}

/** Starts the animation in `container` (a canvas filling it); returns the function that stops and frees it. */
export function startIntroScene(container: HTMLElement): () => void {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  container.append(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = renderer.domElement.style.height = '100%';

  const scene = new Scene();
  scene.fog = new Fog('#0b1230', 30, 85);
  const camera = new PerspectiveCamera(38, 1, 0.5, 200);

  scene.add(new AmbientLight('#5866a8', 0.55));
  const moon = new DirectionalLight('#9fb4ff', 0.5);
  moon.position.set(-20, 30, -10);
  scene.add(moon);
  // the floodlights that make the real cathedral glow warm at night
  const flood = new SpotLight('#ffc888', 700, 60, 0.55, 0.6, 1.6);
  flood.position.set(0, 0.5, 16);
  flood.target.position.set(0, 9, -2);
  scene.add(flood, flood.target);
  const floodSide = new SpotLight('#ffd6a0', 380, 60, 0.6, 0.7, 1.6);
  floodSide.position.set(14, 0.5, 6);
  floodSide.target.position.set(0, 6, -5);
  scene.add(floodSide, floodSide.target);

  const windows = new MeshBasicMaterial({ color: '#ffb54d' });
  const finials = new MeshBasicMaterial({ color: '#ffe0a0' });
  const cathedral = buildCathedral(windows, finials);
  scene.add(cathedral);

  const ground = new Mesh(new CircleGeometry(160, 48), new MeshStandardMaterial({ color: '#141a33', roughness: 0.55, metalness: 0.3 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // equalizer ring: alternating red and white bars (Cologne's colours)
  const barGeo = new BoxGeometry(0.34, 1, 0.34);
  barGeo.translate(0, 0.5, 0);
  const bars = new InstancedMesh(barGeo, new MeshBasicMaterial({ color: '#ffffff' }), RING_BARS);
  const red = new Color('#e3262f'), white = new Color('#f4f1ea');
  for (let i = 0; i < RING_BARS; i++) bars.setColorAt(i, i % 2 ? white : red);
  scene.add(bars);
  // a glowing disc under the ring that flares on the beat
  const glowMat = new MeshBasicMaterial({ color: '#f2c46b', transparent: true, opacity: 0.08, blending: AdditiveBlending, depthWrite: false });
  const glow = new Mesh(new CircleGeometry(RING_RADIUS + 1.5, 64), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(CENTRE.x, 0.02, CENTRE.z);
  scene.add(glow);

  // searchlights sweeping the sky behind the cathedral
  const beamMat = new MeshBasicMaterial({ color: '#cfe0ff', transparent: true, opacity: 0.07, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
  const beamGeo = new ConeGeometry(3.2, 70, 24, 1, true);
  beamGeo.translate(0, -35, 0);
  beamGeo.rotateX(Math.PI);
  const beams = [-1, 1].map((side) => {
    const pivot = new Object3D();
    pivot.position.set(side * 9, 0, -18);
    pivot.add(new Mesh(beamGeo, beamMat));
    scene.add(pivot);
    return pivot;
  });

  // stars
  const starPos: number[] = [];
  for (let i = 0; i < 700; i++) {
    const a = Math.random() * Math.PI * 2, h = 0.08 + Math.random() * 0.9;
    const r = 90;
    starPos.push(Math.cos(a) * r * Math.sqrt(1 - h * h), h * r, Math.sin(a) * r * Math.sqrt(1 - h * h));
  }
  const starGeo = new BufferGeometry();
  starGeo.setAttribute('position', new Float32BufferAttribute(starPos, 3));
  const stars = new Points(starGeo, new PointsMaterial({ color: '#dfe6ff', size: 0.35, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.8 }));
  scene.add(stars);

  // confetti (Kamelle weather)
  const flakeGeo = new PlaneGeometry(0.22, 0.13);
  const confetti = new InstancedMesh(flakeGeo, new MeshBasicMaterial({ side: DoubleSide }), CONFETTI);
  const flakes: Flake[] = [];
  for (let i = 0; i < CONFETTI; i++) {
    confetti.setColorAt(i, new Color(CONFETTI_COLORS[i % CONFETTI_COLORS.length]));
    flakes.push({ x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, spin: 0, life: 0 });
  }
  scene.add(confetti);
  let nextFlake = 0;
  const burst = (count: number, strength: number): void => {
    for (let n = 0; n < count; n++) {
      const f = flakes[nextFlake]!;
      nextFlake = (nextFlake + 1) % CONFETTI;
      const side = Math.random() < 0.5 ? -1 : 1;
      const a = Math.random() * Math.PI * 2;
      const s = (2 + Math.random() * 4) * strength;
      Object.assign(f, {
        x: side * 1.7, y: 17, z: 0, vx: Math.cos(a) * s, vy: 2 + Math.random() * 4 * strength, vz: Math.sin(a) * s,
        rx: Math.random() * 6, ry: Math.random() * 6, spin: 4 + Math.random() * 8, life: 7,
      });
    }
  };

  const resize = (): void => {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // narrow and tall: step back so the spires stay in the picture
    camera.userData.dist = w / h < 0.8 ? 50 : 40;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const spectrum = new Uint8Array(512) as Uint8Array<ArrayBuffer>;
  const beats = new BeatDetector();
  const levels = new Float32Array(RING_BARS);
  const dummy = new Object3D();
  let flash = 0, last = performance.now(), frame = 0, trickle = 0;

  const tick = (now: number): void => {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const live = introMusicSpectrum(spectrum);
    if (!live) {
      // idle: a slow synthetic pulse at ~100 bpm
      const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 1.67)), 8);
      for (let i = 0; i < spectrum.length; i++) spectrum[i] = 255 * (0.12 + 0.3 * beat * Math.exp(-i / 80) + 0.06 * Math.sin(t * 2 + i * 0.1));
    }
    // bass and beat
    let bass = 0;
    for (let i = 1; i <= 4; i++) bass += spectrum[i]! / 255;
    bass /= 4;
    if (beats.update(spectrum, now)) {
      flash = 1;
      burst(live ? 45 : 16, live ? 0.6 + bass : 0.6);
    }
    flash = Math.max(0, flash - dt * 3);

    // ring: the spectrum mirrored around the circle (low frequencies in front)
    for (let i = 0; i < RING_BARS; i++) {
      const k = i < RING_BARS / 2 ? i : RING_BARS - 1 - i;
      // logarithmic: ≈ 90 Hz in front up to ≈ 7 kHz at the back
      const bin = Math.round(2 * Math.pow(75, k / (RING_BARS / 2 - 1)));
      const v = spectrum[bin]! / 255;
      levels[i]! += (v - levels[i]!) * Math.min(1, dt * 10);
      const a = (i / RING_BARS) * Math.PI * 2 + Math.PI / 2;
      dummy.position.set(CENTRE.x + Math.cos(a) * RING_RADIUS, 0, CENTRE.z + Math.sin(a) * RING_RADIUS);
      dummy.rotation.set(0, -a, 0);
      dummy.scale.set(1, 0.1 + levels[i]! * levels[i]! * 3.4, 1);
      dummy.updateMatrix();
      bars.setMatrixAt(i, dummy.matrix);
    }
    bars.instanceMatrix.needsUpdate = true;
    glowMat.opacity = 0.05 + flash * 0.22;

    // windows and lights breathe with the mids, flare on the beat
    let mids = 0;
    for (let i = 40; i < 160; i++) mids += spectrum[i]! / 255;
    mids /= 120;
    // between the beats it keeps snowing confetti, the more the louder
    trickle += dt * (live ? 25 + 90 * mids : 10);
    if (trickle >= 1) {
      const n = Math.floor(trickle);
      trickle -= n;
      burst(n, 0.5);
    }
    windows.color.setRGB(1, 0.62 + 0.25 * flash, 0.25 + 0.2 * flash).multiplyScalar(0.55 + 0.6 * mids + 0.5 * flash);
    flood.intensity = 600 + 400 * flash;
    beamMat.opacity = 0.05 + 0.06 * mids + 0.06 * flash;
    beams.forEach((b, i) => {
      const s = i ? 1 : -1;
      b.rotation.set(0.25 * Math.sin(t * 0.37 + i), 0, s * (0.35 + 0.3 * Math.sin(t * 0.5 + i * 2)));
    });
    stars.rotation.y = t * 0.004;

    // confetti: a little gravity, a lot of air drag, fluttering
    for (let i = 0; i < CONFETTI; i++) {
      const f = flakes[i]!;
      if (f.life <= 0) {
        dummy.scale.setScalar(0);
      } else {
        f.life -= dt;
        f.vy -= 3.2 * dt;
        const drag = Math.exp(-1.6 * dt);
        f.vx *= drag; f.vz *= drag; f.vy = Math.max(f.vy * drag, -2.2);
        f.x += (f.vx + Math.sin(t * 3 + i) * 0.6) * dt;
        f.y += f.vy * dt;
        f.z += (f.vz + Math.cos(t * 2.6 + i) * 0.6) * dt;
        f.rx += f.spin * dt;
        f.ry += f.spin * 0.7 * dt;
        if (f.y < 0.05) { f.y = 0.05; f.vx = f.vz = f.vy = 0; f.spin = 0; }
        dummy.position.set(f.x, f.y, f.z);
        dummy.rotation.set(f.rx, f.ry, 0);
        dummy.scale.setScalar(Math.min(1, f.life * 2));
      }
      dummy.updateMatrix();
      confetti.setMatrixAt(i, dummy.matrix);
    }
    confetti.instanceMatrix.needsUpdate = true;

    // the camera swings slowly in front of the cathedral, a small nudge on each beat
    const dist = (camera.userData.dist as number) - flash * 0.8;
    const a = Math.sin(t * 0.09) * 0.75;
    camera.position.set(CENTRE.x + Math.sin(a) * dist, 9 + Math.sin(t * 0.13) * 1.5, CENTRE.z + Math.cos(a) * dist);
    camera.lookAt(CENTRE.x, 7.5, CENTRE.z);
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    scene.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mat = m.material as Material | Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    renderer.dispose();
    renderer.domElement.remove();
  };
}
