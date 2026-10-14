// 打包 three.js + 渲染器为单个 ES 模块 public/pcb-view.js（无外部 CDN）
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
buildSync({ entryPoints: [fileURLToPath(new URL('./pcb-view.src.js', import.meta.url))], outfile: fileURLToPath(new URL('../public/pcb-view.js', import.meta.url)),
  bundle: true, format: 'esm', minify: true, target: 'es2022', legalComments: 'none' });
