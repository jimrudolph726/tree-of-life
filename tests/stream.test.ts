import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { buildDataset, fixtureGraph, graphFromJson } from '../pipeline/build-tree.ts';
import { decodePage, NONE, validateManifest } from '../src/stream/format.ts';
import type { Scene } from '../src/stream/format.ts';
import { TreeStore } from '../src/stream/store.ts';
import { fitBounds, focusBounds, mapInsets, project } from '../src/tree/navigation.ts';
import type { Camera } from '../src/tree/navigation.ts';

const directory = mkdtempSync(join(tmpdir(), 'tree-tests-'));
after(() => {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(directory.startsWith(join(tmpdir(), 'tree-tests-')));
  rmSync(directory, { recursive: true, force: true });
});
const balanced = buildDataset(fixtureGraph(10000), join(directory, 'balanced')).manifest;
const deep = buildDataset(fixtureGraph(10000, 'unbalanced'), join(directory, 'deep')).manifest;
const reader = (folder: string) => async (path: string, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const b = readFileSync(join(directory, folder, path));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const size = { width: 1280, height: 720 };
const camera: Camera = { target: [0, 0, 0], zoom: -2, minZoom: -12, maxZoom: 32 };
const rebaseCamera = (camera: Camera, frame: NonNullable<Scene['rebase']>): Camera => {
  const factor = 1000 / frame.radius;
  return { ...camera, zoom: camera.zoom - Math.log2(factor),
    target: [(camera.target[0] - frame.x) * factor, (camera.target[1] - frame.y) * factor, 0] };
};

test('published pages preserve topology and geometry, and rebuild deterministically', async () => {
  const graph = fixtureGraph(10000);
  const rebuilt = buildDataset(graph, join(directory, 'balanced'));
  assert.deepEqual(rebuilt.manifest, balanced);
  const store = new TreeStore(balanced, reader('balanced'));
  let edges = 0, leaves = 0;
  for (let i = 0; i < balanced.nodeCount; i++) {
    const { record: r, summary: n } = await store.node(i);
    assert.equal(n.parentId, graph.metadata(i).parentId);
    if (r.parent !== NONE) { assert.ok(r.parent < i); edges++; }
    if (r.firstChild === NONE) leaves++;
    assert.ok(r.ratio > 0 && r.ratio <= 1);
    assert.ok([r.dx, r.dy, r.heading, ...r.bounds].every(Number.isFinite));
    assert.ok(Math.hypot(r.dx, r.dy) + r.ratio <= 1 + 1e-12);
  }
  assert.equal(edges, balanced.nodeCount - 1);
  assert.equal(leaves, balanced.leafCount);
});

test('overview reads a small prefix of pages and repeated views reuse them', async () => {
  const store = new TreeStore(balanced, reader('balanced'));
  const first = await store.view({ anchor: 0, camera, size });
  assert.ok(first.stats.requests < balanced.pageCount / 4);
  assert.ok(first.nodes.length < 200);
  assert.equal(first.stats.limited, false);
  const next = await store.view({ anchor: 0, camera, size });
  assert.equal(next.stats.requests, first.stats.requests);
  assert.deepEqual(next.lines, first.lines);
});

test('single-node publication recomputes terminal status from edges', async () => {
  const graph = graphFromJson([{ id: 'only', parentId: null, scientificName: 'Only node', isTerminal: false }]);
  const { manifest } = buildDataset(graph, join(directory, 'single'));
  assert.equal(manifest.root.isTerminal, true);
  const store = new TreeStore(manifest, reader('single'));
  assert.equal((await store.node(0)).summary.isTerminal, true);
  const scene = await store.view({ anchor: 0, camera, size });
  assert.equal(scene.nodes.length, 1);
  assert.equal(scene.lines.length, 0);
});

test('indexed search finds IDs and word prefixes across pages; deep targets remain distinct', async () => {
  const store = new TreeStore(deep, reader('deep'));
  const results = await store.search('test-0009999');
  assert.equal(results.length, 1);
  assert.ok(results[0].depth > 256);
  assert.equal((await store.search('taxon 0009999'))[0].id, results[0].id);
  assert.deepEqual(await store.search('not a taxon'), []);
  const details = await store.details(results[0].index);
  assert.equal(details.lineage.length, results[0].depth + 1);
  assert.ok(details.anchor > 0);
  assert.ok(details.focus.radius > 0.001);
  const focusedCamera = fitBounds(focusBounds(details.focus), size, mapInsets(size, true));
  const scene = await store.view({ anchor: details.anchor, camera: focusedCamera, size });
  assert.ok(scene.nodes.some(n => n.id === results[0].id));
  assert.ok(scene.lines.every(Number.isFinite));
  assert.equal(scene.stats.limited, false);
});

test('zooming out and panning beyond a local frame preserve screen positions when rebased', async () => {
  const store = new TreeStore(deep, reader('deep'));
  const found = (await store.search('test-0009999'))[0];
  const details = await store.details(found.index);
  for (const oldCamera of [camera, { ...camera, zoom: 4, target: [1600, 0, 0] as Camera['target'] }]) {
    const scene = await store.view({ anchor: details.anchor, camera: oldCamera, size });
    assert.ok(scene.rebase);
    assert.equal(scene.rebase.anchor, (await store.node(details.anchor)).record.parent);
    const nextCamera = rebaseCamera(oldCamera, scene.rebase);
    const oldPoint: [number, number] = [12, 34];
    const factor = 1000 / scene.rebase.radius;
    const nextPoint: [number, number] = [(12 - scene.rebase.x) * factor, (34 - scene.rebase.y) * factor];
    const a = project(oldPoint, oldCamera, size), b = project(nextPoint, nextCamera, size);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-8);
  }
});

test('bounded cache evicts old pages and reloads them correctly', async () => {
  const store = new TreeStore(balanced, reader('balanced'), 400000);
  for (const i of [0, 512, 1024, 1536, 0]) assert.equal((await store.node(i)).summary.id, fixtureGraph(10000).metadata(i).id);
  assert.equal(store.requests, 5);
  assert.ok(store.evictions >= 4);
  const scene = await store.view({ anchor: 0, camera, size });
  assert.ok(scene.stats.cacheBytes <= 400000);
});

test('zooming deeply into a clade produces a stable local frame', async () => {
  const store = new TreeStore(deep, reader('deep'));
  let index = 0, x = 0, y = 0, radius = 1000;
  for (let depth = 0; depth < 20; depth++) {
    const parent = await store.node(index);
    const first = await store.node(parent.record.firstChild);
    index = first.record.nextSibling;
    const child = (await store.node(index)).record;
    x += child.dx * radius; y += child.dy * radius; radius *= child.ratio;
  }
  const before: Camera = { ...camera, target: [x, y, 0], zoom: Math.log2(5000 / radius) };
  const scene = await store.view({ anchor: 0, camera: before, size });
  assert.ok(scene.rebase);
  assert.ok(scene.rebase.anchor > 0);
  const after = rebaseCamera(before, scene.rebase);
  const next = await store.view({ anchor: scene.rebase.anchor, camera: after, size });
  assert.ok(next.nodes.length > 0);
  assert.ok(next.lines.every(Number.isFinite));
  assert.ok(after.zoom < before.zoom);
});

test('aborted and failed reads do not poison retries or cache', async () => {
  let fail = true;
  const read = reader('balanced');
  const store = new TreeStore(balanced, async (path, signal) => {
    if (fail) throw new Error('temporary page failure');
    return read(path, signal);
  });
  await assert.rejects(store.node(0), /temporary page failure/);
  fail = false;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.node(0, abort.signal), { name: 'AbortError' });
  assert.equal(store.requests, 0);
  assert.equal((await store.node(0)).summary.id, 'test-0000000');
  assert.equal(store.requests, 1);
});

test('corrupt pages, incompatible manifests and invalid graphs are rejected', async () => {
  assert.throws(() => decodePage(new ArrayBuffer(4)), /Truncated/);
  const buffer = await reader('balanced')(`${balanced.version}/pages/0.bin`);
  new DataView(buffer).setUint32(4, 123456, true);
  assert.throws(() => decodePage(buffer), /Invalid/);
  assert.throws(() => validateManifest({ ...balanced, format: 999 }), /invalid/);
  assert.throws(() => validateManifest({ ...balanced, rootBounds: [] }), /invalid/);
  assert.throws(() => graphFromJson([{ id: 'a', parentId: 'missing', scientificName: 'A' }]), /Missing parent/);
  const cyclic = fixtureGraph(3); cyclic.parents.set([-1, 2, 1]);
  assert.throws(() => buildDataset(cyclic, join(directory, 'invalid')), /cycle/);
});

test('100,000 immediate children remain biological siblings and late children are spatially reachable', async () => {
  const graph = fixtureGraph(100001);
  graph.parents.fill(0); graph.parents[0] = -1;
  const { manifest } = buildDataset(graph, join(directory, 'wide'));
  assert.equal(manifest.nodeCount, 100001);
  assert.equal(manifest.maxChildren, 100000);
  assert.ok(manifest.fanoutEntries! > 0);
  const store = new TreeStore(manifest, reader('wide'));
  const detail = await store.details(100000);
  assert.deepEqual(detail.lineage.map(n => n.index), [0, 100000]);
  assert.equal((await store.node(100000)).record.parent, 0);
  const scene = await store.view({ anchor: detail.anchor,
    camera: fitBounds(focusBounds(detail.focus), size, mapInsets(size, true)), size });
  assert.ok(scene.nodes.some(n => n.index === 100000));
  assert.equal(scene.stats.limited, false);
  assert.ok(scene.stats.requests < 25, `Loaded ${scene.stats.requests} pages`);
  assert.ok(scene.stats.visited < 200);
  const home = await store.view({ anchor: 0, camera, size });
  assert.equal(home.stats.limited, false);
  assert.equal(home.nodes[0].collapsedCount, 100000);
  assert.ok(home.nodes[0].region.length > 0);
});
