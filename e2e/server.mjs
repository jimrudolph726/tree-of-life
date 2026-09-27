import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { build } from 'vite';

const port = 4173;
const outputRoot = resolve('.e2e-dist');
const avesRoot = resolve('public', 'data', 'aves');
const profilesRoot = resolve('public', 'data', 'profiles');
const contentTypes = new Map([
  ['.bin', 'application/octet-stream'], ['.css', 'text/css'], ['.html', 'text/html'],
  ['.js', 'text/javascript'], ['.json', 'application/json'], ['.map', 'application/json'],
]);

await build({ configFile: 'vite.e2e.config.ts', build: { outDir: outputRoot, emptyOutDir: true } });

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${request.headers.host}`).pathname);
  const data = pathname.startsWith('/data/aves/') ? { root: avesRoot, prefix: '/data/aves/' }
    : pathname.startsWith('/data/profiles/') ? { root: profilesRoot, prefix: '/data/profiles/' } : null;
  const root = data?.root ?? outputRoot;
  const relative = data ? pathname.slice(data.prefix.length) : pathname.slice(1);
  let file = resolve(root, relative || 'index.html');
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end(); return;
  }
  try {
    if (statSync(file).isDirectory()) file = resolve(file, 'index.html');
    const stat = statSync(file);
    response.setHeader('Content-Type', contentTypes.get(extname(file)) ?? 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    response.setHeader('Cache-Control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(file).pipe(response);
  } catch {
    if (!pathname.includes('.')) {
      const index = resolve(outputRoot, 'index.html');
      response.setHeader('Content-Type', 'text/html');
      createReadStream(index).pipe(response);
    } else response.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`E2E server listening on http://127.0.0.1:${port}`));
