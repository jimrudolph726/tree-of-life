// Production static preview with a shared bandwidth cap and response latency.
// This shapes real HTTP delivery (including JS and workers), not just fetch timers.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const root = resolve(option('root', 'dist'));
const upstream = option('upstream', '');
if (upstream && new URL(upstream).protocol !== 'https:') throw new Error('Upstream must use HTTPS.');
const port = Number(option('port', '4174'));
const kbps = Number(option('kbps', '1600'));
const latencyMs = Number(option('latency', '150'));
if (!(kbps > 0 && latencyMs >= 0 && port > 0)) throw new Error('Invalid network profile.');
const queue = [];
const tickMs = 20;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
setInterval(() => {
  const active = queue.filter(item => !item.response.destroyed && !item.response.writableEnded);
  queue.splice(0, queue.length, ...active);
  if (!active.length) return;
  const allowance = Math.max(1, Math.floor(kbps * 1000 / 8 * tickMs / 1000 / active.length));
  for (const item of active) {
    const end = Math.min(item.offset + allowance, item.body.length);
    item.response.write(item.body.subarray(item.offset, end)); item.offset = end;
    if (end === item.body.length) item.response.end();
  }
}, tickMs);

createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    let body;
    if (upstream) {
      const target = new URL(upstream);
      target.pathname = pathname; target.search = new URL(request.url, 'http://localhost').search;
      const remote = await fetch(target, { signal: AbortSignal.timeout(60000) });
      if (!remote.ok) { response.writeHead(remote.status).end('Upstream unavailable'); return; }
      body = Buffer.from(await remote.arrayBuffer());
    } else body = await readFile(file);
    const gzip = request.headers['accept-encoding']?.includes('gzip');
    if (gzip) body = gzipSync(body);
    response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Accept-Encoding');
    response.setHeader('X-Test-Network', `${kbps} kbps shared; ${latencyMs} ms latency`);
    if (gzip) response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Length', body.length);
    setTimeout(() => {
      if (response.destroyed) return;
      if (request.method === 'HEAD') response.end();
      else queue.push({ response, body, offset: 0 });
    }, latencyMs);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${port}/ — ${kbps} kbps shared bandwidth, ${latencyMs} ms latency, no HTTP cache\n`);
});
