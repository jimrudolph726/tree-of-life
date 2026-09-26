import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TreeStore } from '../src/stream/store.ts';
import type { Manifest } from '../src/stream/format.ts';
import { fitBounds, focusBounds, mapInsets } from '../src/tree/navigation.ts';

const folder = 'public/data/aves';
const manifest: Manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
const results = [];
for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  const store = new TreeStore(manifest, async path => {
    const b = readFileSync(join(folder, path));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  });
  const cases = [];
  for (const query of ['Aves', 'Camarhynchus psittacula', 'Passeriformes']) {
    const started = performance.now();
    const matches = await store.search(query);
    const result = matches.find(n => n.scientificName === query)!;
    assert.ok(result);
    const detail = await store.details(result.index);
    const camera = fitBounds(focusBounds(detail.focus), size, mapInsets(size, true));
    const first = await store.view({ anchor: detail.anchor, camera, size });
    const selectionMs = performance.now() - started;
    assert.ok(first.nodes.some(n => n.index === result.index));
    const timings = [];
    for (let i = 0; i < 120; i++) {
      const wave = Math.sin(i / 119 * Math.PI);
      const scene = await store.view({ anchor: detail.anchor, camera: { ...camera, zoom: camera.zoom + wave * 3,
        target: [camera.target[0] + Math.sin(i / 10) * 100 / 2 ** camera.zoom, camera.target[1], 0] }, size });
      assert.ok(scene.lines.every(Number.isFinite));
      assert.ok(scene.stats.cacheBytes <= 24 * 1024 * 1024);
      assert.equal(scene.stats.limited, false);
      timings.push(scene.stats.queryMs);
    }
    timings.sort((a, b) => a - b);
    cases.push({ query, selectionMs, depth: detail.node.depth, stats: first.stats, warmP95Ms: timings[Math.floor(timings.length * .95)] });
  }
  results.push({ size, cases, totalRequests: store.requests, payloadBytes: store.transferredBytes });
}
const report = { dataset: manifest.title, version: manifest.version, synthesis: manifest.provenance?.synthId,
  measuredAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform },
  methodology: 'Filesystem-backed store: three sequential clade selections, 120 camera queries each, both viewports. Not network/GPU timings.', results };
writeFileSync('benchmarks/results/aves-store.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
