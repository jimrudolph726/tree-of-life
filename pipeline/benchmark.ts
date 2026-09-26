import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildDataset, fixtureGraph } from './build-tree.ts';
import { TreeStore } from '../src/stream/store.ts';
import { fitBounds, focusBounds, mapInsets } from '../src/tree/navigation.ts';
import type { Manifest, StreamNode } from '../src/stream/format.ts';
import { platform, release, cpus, totalmem } from 'node:os';

const size = Number(process.argv[2] ?? 10000);
const shape = process.argv[3] === 'unbalanced' ? 'unbalanced' : 'balanced';
if (![10000, 100000, 1000000].includes(size)) throw new Error('Choose 10000, 100000, or 1000000 nodes.');
const directory = resolve('.benchmarks', `${shape}-${size}`);
const build = buildDataset(fixtureGraph(size, shape), directory);
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Manifest;
const reader = async (path: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const bytes = await readFile(join(directory, path));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const store = new TreeStore(manifest, reader);
const viewport = { width: 1280, height: 720 };
const root: StreamNode = { ...manifest.root, position: [0, 0], radius: 1000, heading: -Math.PI / 2, region: [],
  bounds: manifest.rootBounds.map(v => v * 1000) as StreamNode['bounds'] };
const home = fitBounds(focusBounds(root), viewport, mapInsets(viewport));
const first = await store.view({ anchor: 0, camera: home, size: viewport });
const searchStart = performance.now();
const result = await store.search(`test-${String(size - 1).padStart(7, '0')}`);
if (result.length !== 1) throw new Error('Search failed to find the last fixture node.');
const detail = await store.details(result[0].index);
const focus = fitBounds(focusBounds(detail.focus), viewport, mapInsets(viewport, true));
const focused = await store.view({ anchor: detail.anchor, camera: focus, size: viewport });
const searchFocusMs = performance.now() - searchStart;
if (!focused.nodes.some(n => n.index === result[0].index)) throw new Error('Deep search target not rendered.');
const queryTimes: number[] = [];
let last = focused;
for (let i = 0; i < 24; i++) {
  const wave = Math.sin(i / 23 * Math.PI);
  const camera = { ...focus, zoom: focus.zoom + wave,
    target: [focus.target[0] + Math.sin(i) * 40 / 2 ** focus.zoom, focus.target[1], 0] as [number, number, number] };
  last = await store.view({ anchor: detail.anchor, camera, size: viewport });
  queryTimes.push(last.stats.queryMs);
}
queryTimes.sort((a, b) => a - b);
const report = {
  dataset: `${shape}-${size}`, generated: true, timestamp: new Date().toISOString(),
  environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, memoryGiB: totalmem() / 2 ** 30 },
  nodeCount: size, maxDepth: manifest.maxDepth, buildMs: build.buildMs, artifactBytes: build.diskBytes, peakProcessRssMB: build.peakRssMB,
  initial: { queryMs: first.stats.queryMs, payloadBytes: first.stats.transferredBytes, requests: first.stats.requests,
    visited: first.stats.visited, renderedNodes: first.nodes.length, branches: first.lineTargets.length, limited: first.stats.limited },
  searchFocusMs, selectedDepth: detail.node.depth, focusFrame: detail.anchor,
  warmQueryP50Ms: queryTimes[Math.floor(queryTimes.length * .5)], warmQueryP95Ms: queryTimes[Math.floor(queryTimes.length * .95)],
  final: last.stats,
  notes: 'Filesystem-backed TreeStore measurements, not network latency or GPU frame time. Cache bytes are conservative accounting, not measured worker heap. RSS is the build-process peak.',
};
if (first.stats.limited || focused.stats.limited || first.nodes.length >= size || last.stats.cacheBytes > 24 * 1024 * 1024) throw new Error('Scale budget failed.');
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync(`benchmarks/results/${shape}-${size}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
