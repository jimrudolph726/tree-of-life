import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';
import { get as httpsGet } from 'node:https';

const publicRoot = resolve('public');

function copyFile(source: string, destination: string) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function copyPublication(name: 'profiles' | 'journeys', outDir: string) {
  const source = resolve(publicRoot, 'data', name);
  const pointer = resolve(source, 'manifest.json');
  if (!existsSync(pointer)) return;
  const version = JSON.parse(readFileSync(pointer, 'utf8')).version;
  if (!/^[a-f0-9]{16}$/.test(version)) throw new Error(`Invalid ${name} publication version`);
  copyFile(pointer, resolve(outDir, 'data', name, 'manifest.json'));
  copyFile(resolve(source, version), resolve(outDir, 'data', name, version));
}

function appPublicAssets(treeDataUpstream?: string, treeDataBaseUrl?: string): Plugin {
  const localRoots = ['data/profiles', 'data/journeys', 'images/journeys'];
  return {
    name: 'app-public-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent((request.url ?? '').split('?')[0]);
        if (pathname.startsWith('/__tree-data__/') && treeDataUpstream) {
          const target = new URL(pathname.slice('/__tree-data__/'.length), `${treeDataUpstream.replace(/\/+$/, '')}/`);
          const upstream = httpsGet(target, { headers: { 'User-Agent': 'TreeOfLifeLocalDev/1.0' } }, incoming => {
            response.statusCode = incoming.statusCode ?? 502;
            for (const header of ['content-type', 'content-encoding', 'content-length', 'cache-control', 'etag']) {
              const value = incoming.headers[header]; if (value !== undefined) response.setHeader(header, value);
            }
            incoming.pipe(response);
          });
          upstream.on('error', error => { response.statusCode = 502; response.end(`Hosted tree unavailable: ${error.message}`); });
          request.on('aborted', () => upstream.destroy());
          response.on('close', () => { if (!response.writableEnded) upstream.destroy(); });
          return;
        }
        const relative = pathname.replace(/^\/+/, '');
        const localTree = treeDataBaseUrl === '/' || treeDataBaseUrl === './';
        const allowed = localRoots.some(root => relative === root || relative.startsWith(`${root}/`)) ||
          ['favicon.svg', 'icons.svg', 'DATA_SOURCES.txt'].includes(relative) ||
          (localTree && ['data/life/', 'data/aves/', 'data/primates/'].some(root => relative.startsWith(root)));
        if (!allowed) return next();
        const file = resolve(publicRoot, relative);
        if (!file.startsWith(`${publicRoot}${sep}`)) { response.statusCode = 404; response.end(); return; }
        try {
          const stat = statSync(file);
          response.setHeader('Content-Type', extname(file) === '.json' ? 'application/json' :
            extname(file) === '.webp' ? 'image/webp' : extname(file) === '.svg' ? 'image/svg+xml' : 'application/octet-stream');
          response.setHeader('Content-Length', stat.size);
          response.setHeader('Cache-Control', 'no-cache');
          if (request.method === 'HEAD') { response.end(); return; }
          createReadStream(file).pipe(response);
        } catch { response.statusCode = 404; response.end(); }
      });
    },
    closeBundle() {
      const outDir = resolve('dist');
      for (const file of ['favicon.svg', 'icons.svg', 'DATA_SOURCES.txt'])
        copyFile(resolve(publicRoot, file), resolve(outDir, file));
      copyPublication('profiles', outDir);
      copyPublication('journeys', outDir);
      copyFile(resolve(publicRoot, 'images', 'journeys'), resolve(outDir, 'images', 'journeys'));
      // Dataset releases need only these pointers in the app release. The
      // immutable version directories upload directly from public/.
      for (const dataset of ['life', 'aves', 'primates'])
        copyFile(resolve(publicRoot, 'data', dataset, 'manifest.json'), resolve(outDir, 'data', dataset, 'manifest.json'));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const treeDataUpstream = env.TREE_DATA_UPSTREAM ||
    (mode === 'development' ? 'https://dgilsep5ai167.cloudfront.net/' : undefined);
  return {
  publicDir: false,
  server: { watch: { ignored: ['**/public/data/**', '**/data/processed/**', '**/.benchmarks/**'] } },
  plugins: [react(), appPublicAssets(treeDataUpstream, env.VITE_TREE_DATA_BASE_URL), {
    name: 'local-benchmark-datasets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0];
        if (!path.startsWith('/benchmarks/')) return next();
        const match = /^\/benchmarks\/((?:balanced|unbalanced)-(?:10000|100000|1000000))\/(manifest\.json|[a-f0-9]{16}\/(?:pages\/\d+\.bin|search(?:\/\d+)?\.json))$/.exec(path);
        if (!match || !['GET', 'HEAD'].includes(request.method ?? '')) { response.statusCode = 404; response.end(); return; }
        const file = resolve('.benchmarks', match[1], match[2]);
        try {
          const stat = statSync(file);
          response.setHeader('Content-Type', file.endsWith('.bin') ? 'application/octet-stream' : 'application/json');
          response.setHeader('Cache-Control', match[2] === 'manifest.json' ? 'no-cache' : 'public, max-age=31536000, immutable');
          response.setHeader('Vary', 'Accept-Encoding');
          const gzip = request.headers['accept-encoding']?.includes('gzip');
          if (gzip) response.setHeader('Content-Encoding', 'gzip'); else response.setHeader('Content-Length', stat.size);
          if (request.method === 'HEAD') { response.end(); return; }
          const stream = createReadStream(file);
          stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy());
          if (gzip) stream.pipe(createGzip()).pipe(response); else stream.pipe(response);
        } catch { response.statusCode = 404; response.end('Run npm run benchmark:build first.'); }
      });
    },
  }],
  };
});
