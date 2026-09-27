import react from '@vitejs/plugin-react';
import { createReadStream, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { defineConfig } from 'vite';

const publicRoot = resolve('public');
const avesRoot = resolve(publicRoot, 'data', 'aves');
const profilesRoot = resolve(publicRoot, 'data', 'profiles');

export default defineConfig({
  publicDir: false,
  resolve: { alias: process.env.E2E_REAL_RUM ? {} : { '@aws-rum/web-slim': resolve('e2e/rum-stub.ts') } },
  plugins: [react(), {
    name: 'e2e-aves-data',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = decodeURIComponent((request.url ?? '').split('?')[0]);
        if (!pathname.startsWith('/data/aves/') && !pathname.startsWith('/data/profiles/')) return next();
        const file = resolve(publicRoot, pathname.slice(1));
        const allowed = [avesRoot, profilesRoot].some(root => file === root || file.startsWith(`${root}${sep}`));
        if (!allowed) {
          response.statusCode = 404; response.end(); return;
        }
        try {
          const stat = statSync(file);
          response.setHeader('Content-Type', extname(file) === '.json' ? 'application/json' : 'application/octet-stream');
          response.setHeader('Content-Length', stat.size);
          response.setHeader('Cache-Control', 'no-cache');
          if (request.method === 'HEAD') { response.end(); return; }
          createReadStream(file).pipe(response);
        } catch {
          response.statusCode = 404; response.end();
        }
      });
    },
  }],
});
