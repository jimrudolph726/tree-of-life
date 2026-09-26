import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { TreeStore } from '../src/stream/store.ts';
import type { Manifest } from '../src/stream/format.ts';
import { cacheBudget } from '../src/stream/format.ts';
import { fitBounds, focusBounds, mapInsets, visibleLabels } from '../src/tree/navigation.ts';

const folder = 'public/data/life', manifest: Manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
const results = [];
for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  const store = new TreeStore(manifest, async path => {
    const b = readFileSync(join(folder, path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
  const insets = size.width < 700 ? { top: 145, left: 50, right: 14, bottom: 100 } : { top: 90, left: 90, right: 90, bottom: 55 };
  const home = fitBounds(manifest.rootBounds.map(n => n * 1000) as [number, number, number, number], size, insets);
  const overview = await store.view({ anchor: 0, camera: home, size });
  assert.equal(overview.stats.requests, 1);
  const labels = visibleLabels(overview.nodes.filter(n => n.index !== 0), home, size).map(n => n.scientificName);
  for (const name of ['Eukaryota', 'Archaea', 'Bacteria']) assert.ok(labels.includes(name), `Missing home label ${name}`);
  if (size.width > 700) for (const name of ['Fungi', 'Opisthokonta', 'Methanobacteria', 'Thermoprotei', 'Actinobacteria', 'Cyanobacteria']) assert.ok(labels.includes(name), `Missing home invitation ${name}`);
  const cases = [];
  for (const query of ['Bacteria', 'Fungi', 'Homo sapiens', 'Chloroplastida', 'Methanobacteria']) {
    const start = performance.now(), before = store.requests;
    const matches = (await store.search(query)).filter(n => n.scientificName === query).sort((a, b) => b.leafCount - a.leafCount);
    assert.ok(matches.length, query);
    const detail = await store.details(matches[0].index);
    const camera = fitBounds(focusBounds(detail.focus), size, mapInsets(size, true));
    const first = await store.view({ anchor: detail.anchor, camera, size });
    assert.ok(first.nodes.some(n => n.id === matches[0].id), query);
    const selectionMs = performance.now() - start, selectionRequests = store.requests - before;
    assert.ok(selectionRequests < 100, `${query} fetched ${selectionRequests} pages`);
    const times = []; let limitedViews = 0;
    for (let i = 0; i < 60; i++) {
      const wave = Math.sin(i / 59 * Math.PI);
      const scene = await store.view({ anchor: detail.anchor, camera: { ...camera, zoom: camera.zoom + wave * 2,
        target: [camera.target[0] + Math.sin(i / 6) * 80 / 2 ** camera.zoom, camera.target[1], 0] }, size });
      assert.ok(scene.lines.every(Number.isFinite)); assert.ok(scene.stats.cacheBytes <= cacheBudget(manifest));
      limitedViews += Number(scene.stats.limited); times.push(scene.stats.queryMs);
    }
    times.sort((a, b) => a - b);
    cases.push({ query, depth: detail.node.depth, selectionMs, selectionRequests, first: first.stats, limitedViews, warmP95Ms: times[Math.floor(times.length * .95)] });
    console.log(`${size.width}px ${query}: ${selectionMs.toFixed(1)}ms, ${selectionRequests} requests`);
  }
  results.push({ size, overview: overview.stats, homeLabels: labels, cases, requests: store.requests, decodedBytes: store.transferredBytes });
}
const overview = readFileSync(join(folder, manifest.version, 'overview.json'));
const report = { version: manifest.version, measuredAt: new Date().toISOString(), node: process.version,
  cacheBudgetMiB: cacheBudget(manifest) / 1048576,
  methodology: 'Filesystem-backed shared worker store. 600 camera queries, two viewports, five cross-domain selections. Timings exclude network and GPU.',
  overviewBytes: overview.byteLength, overviewGzipBytes: gzipSync(overview).byteLength, results };
writeFileSync('benchmarks/results/life-store.json', JSON.stringify(report, null, 2));
