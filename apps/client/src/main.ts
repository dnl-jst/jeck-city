import {
  Color, DirectionalLight, Fog, HemisphereLight, Mesh, MeshStandardMaterial,
  PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer,
} from "three";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const sky = new Color(0x0b1a45);
const scene = new Scene();
scene.background = sky;
scene.fog = new Fog(sky, 60, 400);

scene.add(new HemisphereLight(0x6f86d6, 0x202030, 1.2));
const moon = new DirectionalLight(0xaab8ff, 1.0);
moon.position.set(-50, 80, 30);
scene.add(moon);

const ground = new Mesh(
  new PlaneGeometry(2000, 2000),
  new MeshStandardMaterial({ color: 0x555a63, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new PerspectiveCamera(60, 1, 0.1, 1000);

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop((t: number) => {
  const a = t * 0.0001;
  camera.position.set(Math.cos(a) * 40, 12, Math.sin(a) * 40);
  camera.lookAt(0, 2, 0);
  renderer.render(scene, camera);
});
