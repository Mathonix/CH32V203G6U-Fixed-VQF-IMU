// CH32 板卡三维姿态预览（沿用 AT32 gyro src/pcb-view.js 的渲染器与轴约定；esbuild 打包为 public/pcb-view.js）
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const MODEL_URL = '/models/ch32.glb?v=20261003m1';
// U5 LSM6DSV 贴装：芯片 +X = CAD −X，芯片 +Y = CAD −Y，Z 同向（Pin1 在 CAD (+x,−y) 角，datasheet 顶视图 Pin1 在 (−X,+Y)）。
// 即绕 Z 转 180°：真旋转，欧拉/四元数路径一致。
export const CAD_TO_BODY = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];

export async function createPCBView(stage, onChange, onAvailability) {
  const canvas = document.createElement('canvas');
  canvas.id = 'pcbModel'; canvas.setAttribute('aria-label', 'CH32 板卡三维模型，可拖动视角和缩放');
  stage.prepend(canvas);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false }); }
  catch (error) { canvas.remove(); throw error; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x0d1623);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(2 * Math.atan(1 / 3.1) * 180 / Math.PI, 720 / 410, .1, 40);
  camera.up.set(0, 0, 1); // 世界系 ENU，Z 向上（VQF）
  const az = -125 * Math.PI / 180, el = 32 * Math.PI / 180;
  const dist = 5.2; // 侧栏舞台比 AT32 小，镜头略近
  const home = new THREE.Vector3(dist * Math.cos(el) * Math.cos(az), dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el));
  camera.position.copy(home); camera.lookAt(0, 0, 0);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false; controls.minDistance = 3.3; controls.maxDistance = 11;
  controls.addEventListener('change', onChange);
  scene.add(new THREE.HemisphereLight(0xe7f2ff, 0x607080, 2.6));
  for (const [position, color, intensity] of [[[2, -4, 6], 0xffffff, 3], [[-4, 3, 2], 0x8cbcff, 2], [[1, 4, -3], 0xffffff, 1.4]]) {
    const light = new THREE.DirectionalLight(color, intensity); light.position.set(...position); scene.add(light);
  }
  const grid = new THREE.GridHelper(4, 10, 0x30455e, 0x1f3350);
  grid.rotation.x = Math.PI / 2; grid.position.z = -1.3; scene.add(grid);
  const board = new THREE.Group(); board.matrixAutoUpdate = false; scene.add(board);
  // 机体轴箭头（X 红 / Y 绿 / Z 蓝），随板子转动，便于对照实物
  const axes = new THREE.Group(); axes.position.z = .42; board.add(axes); // 抬到元件顶面之上，避免被板子遮住
  for (const [dir, color] of [[[1, 0, 0], 0xe5484d], [[0, 1, 0], 0x30a46c], [[0, 0, 1], 0x3e63dd]])
    axes.add(new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(0, 0, 0), dir[2] ? .8 : 1.6, color, .2, .11));
  let metadata, lost = false;
  try {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    gltf.scene.rotation.z = Math.PI; // CAD → 机体（见 CAD_TO_BODY）
    board.add(gltf.scene); metadata = gltf.parser.json.extras;
    if (!metadata?.bounds || metadata.triangles < 1) throw new Error('PCB metadata missing');
  } catch (error) { controls.dispose(); renderer.dispose(); canvas.remove(); throw error; }
  let w = 0, h = 0;
  const resize = () => {
    const r = stage.getBoundingClientRect(), nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
    if (nw === w && nh === h) return; w = nw; h = nh;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); onChange();
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; ro?.observe(stage); resize();
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); lost = true; canvas.hidden = true; stage.classList.remove('model-ready'); onAvailability(false);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false; canvas.hidden = false; stage.classList.add('model-ready'); onAvailability(true);
  });
  return {
    get ready() { return !lost; },
    // R：机体 → 世界（ZYX：Rz(yaw)·Ry(pitch)·Rx(roll)），与 AT32 app.js eulerToMatrix 同式
    render(R, stale) {
      resize();
      board.matrix.set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1);
      board.matrixWorldNeedsUpdate = true;
      renderer.toneMappingExposure = stale ? .65 : 1.35;
      renderer.render(scene, camera);
    },
    reset() { controls.target.set(0, 0, 0); camera.position.copy(home); controls.update(); onChange(); },
    state() {
      const m = board.children[1].matrixWorld.elements;
      return { ready: !lost, source: metadata.source, sourceSha256: metadata.sourceSha256,
        componentMeshes: metadata.componentMeshes, triangles: metadata.triangles, materials: metadata.materialCount,
        boardDimensionsMm: metadata.boardDimensionsMm, imu: metadata.imu, drawCalls: renderer.info.render.calls, renderedTriangles: renderer.info.render.triangles,
        cadToBody: CAD_TO_BODY, cadWorldMatrix: Array.from(m), matrix: board.matrix.elements.slice(), camera: camera.position.toArray(), size: [w, h] };
    },
  };
}
