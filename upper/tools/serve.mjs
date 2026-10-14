// Local verification server: executes the same Worker fetch handler for /healthz and assets.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const env = { ASSETS: { async fetch(req) {
  try {
    const url = new URL(req.url), name = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = resolve(root, '.' + name);
    if (!path.startsWith(resolve(root) + sep)) return new Response('Forbidden', { status: 403 });
    return new Response(await readFile(path), { headers: { 'content-type': mime[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' } });
  } catch { return new Response('Not found', { status: 404 }); }
} } };
http.createServer(async (req, res) => {
  try { const reply = await worker.fetch(new Request(`http://127.0.0.1:${process.env.PORT || 8765}${req.url}`), env); res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(Buffer.from(await reply.arrayBuffer())); }
  catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(Number(process.env.PORT || 8765), '127.0.0.1', () => console.log('Local app: http://127.0.0.1:' + (process.env.PORT || 8765)));
