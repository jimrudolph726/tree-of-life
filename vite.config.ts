import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGzip } from 'node:zlib';

export default defineConfig({
  plugins: [react(), {
    name: 'local-benchmark-datasets',
    // Generated fixtures stay outside public/ and are never shipped in a normal production build.
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
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          if (gzip) stream.pipe(createGzip()).pipe(response); else stream.pipe(response);
        } catch { response.statusCode = 404; response.end('Run npm run benchmark:build first.'); }
      });
    },
  }],
});
