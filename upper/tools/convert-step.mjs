// 离线 STEP -> glTF 2.0 (GLB)。浏览器不下载 CAD 解析器或 STEP（沿用 AT32 scripts/convert-pcb.mjs 流程）。
// 用法：node tools/convert-step.mjs board.step   → public/models/ch32.glb + ch32-source.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const input = process.argv[2];
if (!input) throw new Error('Usage: node tools/convert-step.mjs model.step');
const source = readFileSync(input);
const params = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: .01, angularDeflection: .2 };
const result = (await require('occt-import-js')()).ReadStepFile(source, params);
if (!result.success || !result.meshes.length) throw new Error('STEP contains no imported meshes');
const board = result.meshes.find((m) => m.name === 'PCB_FR4');
const imu = result.meshes.find((m) => m.name === 'U5_LSM6DSVTR_body'), pin1 = result.meshes.find((m) => m.name === 'U5_LSM6DSVTR_Pin1');
if (!board || !imu || !pin1) throw new Error('PCB_FR4 / U5_LSM6DSVTR body / Pin1 not found');
function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  mesh.attributes.position.array.forEach((x, i) => { if (!Number.isFinite(x)) throw new Error('Invalid vertex'); min[i % 3] = Math.min(min[i % 3], x); max[i % 3] = Math.max(max[i % 3], x); });
  return { min, max };
}
const mid = (b) => b.min.map((v, i) => (v + b.max[i]) / 2);
const boardBounds = bounds(board);
// 以 PCB 板中心为旋转原点（不受元件/邮票孔偏置影响），保留 STEP X/Y/Z；机体系旋转在 pcb-view.js 中做。
const center = mid(boardBounds);
const scale = 2.6 / Math.max(boardBounds.max[0] - boardBounds.min[0], boardBounds.max[1] - boardBounds.min[1]);
// IMU 朝向推断：LSM6DSV 顶视图 Pin1 在芯片 (-X,+Y) 角（DS13476 Figure 4）。
const imuC = mid(bounds(imu)), pinC = mid(bounds(pin1));
const pinDir = [Math.sign(pinC[0] - imuC[0]), Math.sign(pinC[1] - imuC[1])];
// 芯片 X = -pinDir.x 方向，芯片 Y = +pinDir.y 方向（CAD 坐标）
const imuAxesCad = { X: [-pinDir[0], 0, 0], Y: [0, pinDir[1], 0], Z: [0, 0, 1] };
const vertices = result.meshes.reduce((n, m) => n + m.attributes.position.array.length / 3, 0);
const positions = new Float32Array(vertices * 3), normals = new Float32Array(vertices * 3);
const colorGroups = new Map();
let offset = 0, triangles = 0;
for (const mesh of result.meshes) {
  const p = mesh.attributes.position.array, n = mesh.attributes.normal?.array;
  if (!n || n.length !== p.length) throw new Error('STEP normals missing');
  for (let i = 0; i < p.length; i++) { positions[offset * 3 + i] = (p[i] - center[i % 3]) * scale; normals[offset * 3 + i] = n[i]; }
  const colors = new Array(mesh.index.array.length / 3).fill(mesh.color || [.6, .6, .6]);
  for (const face of mesh.brep_faces) if (face.color) for (let t = face.first; t <= face.last; t++) colors[t] = face.color;
  for (let t = 0; t < colors.length; t++) {
    const rgb = colors[t], key = rgb.map((x) => x.toFixed(6)).join(',');
    if (!colorGroups.has(key)) colorGroups.set(key, { rgb, indices: [] });
    const group = colorGroups.get(key);
    for (let j = 0; j < 3; j++) {
      const index = mesh.index.array[t * 3 + j];
      if (index < 0 || index >= p.length / 3) throw new Error('Invalid mesh index');
      group.indices.push(index + offset);
    }
  }
  offset += p.length / 3; triangles += mesh.index.array.length / 3;
}
const gltf = { asset: { version: '2.0', generator: 'gyroc / occt-import-js 0.0.23' }, scene: 0,
  scenes: [{ nodes: [0] }], nodes: [{ name: 'CH32 PCB', mesh: 0 }], meshes: [{ name: basename(input), primitives: [] }],
  materials: [], accessors: [], bufferViews: [], buffers: [] };
const chunks = []; let byteLength = 0;
function accessor(array, componentType, type, target, extra = {}) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const view = gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target }) - 1;
  chunks.push(bytes, Buffer.alloc((4 - bytes.length % 4) % 4)); byteLength += bytes.length + (4 - bytes.length % 4) % 4;
  return gltf.accessors.push({ bufferView: view, componentType, count: array.length / (type === 'VEC3' ? 3 : 1), type, ...extra }) - 1;
}
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
positions.forEach((v, i) => { min[i % 3] = Math.min(min[i % 3], v); max[i % 3] = Math.max(max[i % 3], v); });
const position = accessor(positions, 5126, 'VEC3', 34962, { min, max });
const normal = accessor(normals, 5126, 'VEC3', 34962);
const small = vertices < 65536;
// occt-import-js 输出的 STEP 颜色已是线性值（COLOUR_RGB 0.38 → 0.119），直接作为 glTF 线性 baseColorFactor，不再二次转换。
for (const { rgb, indices } of colorGroups.values()) {
  const grey = Math.max(...rgb) - Math.min(...rgb) < .08 && rgb[0] > .2, gold = rgb[0] > .3 && rgb[1] > .15 && rgb[2] < .1;
  const metallic = grey || gold;
  const material = gltf.materials.push({ name: `STEP RGB ${rgb.map((x) => x.toFixed(3)).join(' ')}`,
    pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: metallic ? .5 : .05, roughnessFactor: metallic ? .4 : .7 }, doubleSided: true }) - 1;
  gltf.meshes[0].primitives.push({ attributes: { POSITION: position, NORMAL: normal }, indices: accessor(small ? new Uint16Array(indices) : new Uint32Array(indices), small ? 5123 : 5125, 'SCALAR', 34963), material });
}
gltf.buffers.push({ byteLength });
const provenance = { source: basename(input), sourceSha256: createHash('sha256').update(source).digest('hex'), sourceBytes: source.length,
  converter: 'occt-import-js 0.0.23', tessellation: params, componentMeshes: result.meshes.length, triangles, vertices,
  materialCount: colorGroups.size, boardDimensionsMm: boardBounds.max.map((v, i) => v - boardBounds.min[i]),
  bodyAxes: 'STEP X / Y / Z preserved; PCB_FR4 center is rotation origin; cadToBody applied in pcb-view.js',
  imu: { part: 'U5 LSM6DSVTR', centerMm: imuC, pin1Mm: pinC, pin1Corner: pinDir, axesInCad: imuAxesCad },
  centerMm: center, displayScale: scale, bounds: { min, max },
  componentNames: result.meshes.map((m) => m.name).filter(Boolean).filter((n) => /_body$|^PCB|Soldermask|_lens$/.test(n)) };
gltf.extras = provenance;
let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
const binary = Buffer.concat(chunks);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binary.length, 8);
const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(json.length); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
const glb = Buffer.concat([header, jsonHeader, json, binHeader, binary]);
const out = new URL('../public/models/', import.meta.url); mkdirSync(out, { recursive: true });
writeFileSync(new URL('ch32.glb', out), glb);
writeFileSync(new URL('ch32-source.json', out), JSON.stringify({ ...provenance, glbBytes: glb.length, glbSha256: createHash('sha256').update(glb).digest('hex') }, null, 2));
console.log(JSON.stringify({ meshes: result.meshes.length, triangles, vertices, materials: colorGroups.size, glbBytes: glb.length, boardDimensionsMm: provenance.boardDimensionsMm, imu: provenance.imu }));
