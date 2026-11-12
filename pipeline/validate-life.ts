import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { releaseGraph } from './release-graph.ts';
import { decodePage, NONE, readRecord } from '../src/stream/format.ts';
import type { FanoutEntry, Manifest } from '../src/stream/format.ts';
import { INDEX_PAGE_SIZE } from '../src/stream/format.ts';

const graph = releaseGraph(), folder = 'public/data/life';
const manifest: Manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
assert.deepEqual(manifest.provenance, graph.provenance);
assert.equal(manifest.nodeCount, graph.parents.length);
const source = new Map<string, number>();
for (let i = 0; i < graph.parents.length; i++) source.set(graph.metadata(i).id, i);
assert.equal(source.size, graph.parents.length);
const ids: string[] = [], parents = new Uint32Array(manifest.nodeCount), depth = new Uint32Array(manifest.nodeCount),
  leafCount = new Uint32Array(manifest.nodeCount), totals = new Uint32Array(manifest.nodeCount),
  first = new Uint32Array(manifest.nodeCount), next = new Uint32Array(manifest.nodeCount), children = new Uint32Array(manifest.nodeCount);
const routes = new Uint32Array(manifest.nodeCount).fill(NONE), structural = new Uint8Array(manifest.nodeCount);
const fingerprints = Buffer.alloc(manifest.nodeCount * 32);
const summaryFingerprints = Buffer.alloc(manifest.nodeCount * 32);
let tips = 0, named = 0, maxDepth = 0;
for (let pageIndex = 0; pageIndex < manifest.pageCount; pageIndex++) {
  const buffer = readFileSync(join(folder, manifest.version, 'pages', `${pageIndex}.bin`));
  const page = decodePage(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  for (let offset = 0; offset < page.count; offset++) {
    const i = pageIndex * manifest.pageSize + offset, n = page.names[offset], r = readRecord(page, offset);
    const originalIndex = source.get(n.id); assert.notEqual(originalIndex, undefined, `Unknown or duplicate ID ${n.id}`);
    source.delete(n.id);
    const original = graph.metadata(originalIndex!);
    assert.deepEqual(n, original, `Source metadata changed: ${n.id}`);
    assert.equal(n.parentId, r.parent === NONE ? null : ids[r.parent], `Parent changed: ${n.id}`);
    assert.equal(r.depth, r.parent === NONE ? 0 : depth[r.parent] + 1);
    assert.ok([r.dx, r.dy, r.ratio, r.heading, ...r.bounds].every(Number.isFinite));
    assert.ok(r.ratio > 0 && r.ratio <= 1);
    ids.push(n.id); parents[i] = r.parent; depth[i] = r.depth; first[i] = r.firstChild; next[i] = r.nextSibling;
    leafCount[i] = r.leafCount; children[i] = r.childCount; maxDepth = Math.max(maxDepth, r.depth);
    routes[i] = r.fanoutRoot; structural[i] = Number(!!n.isSyntheticNode);
    const summary = { ...n, index: i, depth: r.depth, leafCount: r.leafCount,
      isTerminal: r.firstChild === NONE, isSyntheticNode: !!n.isSyntheticNode };
    createHash('sha256').update(JSON.stringify({ summary, record: r })).digest().copy(fingerprints, i * 32);
    createHash('sha256').update(JSON.stringify(summary)).digest().copy(summaryFingerprints, i * 32);
    if (n.isSyntheticNode) assert.deepEqual([r.dx, r.dy, r.ratio], [0, 0, 1]);
    if (r.firstChild === NONE) { tips++; totals[i] = 1; }
    if (!n.isSyntheticNode) named++;
  }
  if (pageIndex % 1000 === 0) console.log(`Checked ${ids.length.toLocaleString()} published records`);
}
assert.equal(source.size, 0);
for (let i = manifest.nodeCount - 1; i >= 0; i--) {
  assert.equal(totals[i], leafCount[i]);
  if (parents[i] !== NONE) totals[parents[i]] += totals[i];
  let count = 0;
  for (let child = first[i]; child !== NONE; child = next[child]) {
    assert.equal(parents[child], i); assert.ok(++count <= children[i], 'Cycle or duplicate child link');
  }
  assert.equal(count, children[i]);
}
assert.equal(tips, manifest.leafCount); assert.equal(named, manifest.namedCount); assert.equal(maxDepth, manifest.maxDepth);
const pageSize = manifest.indexPageSize ?? INDEX_PAGE_SIZE;
const routingPages = new Map<number, FanoutEntry[]>();
const route = (id: number) => {
  const page = Math.floor(id / pageSize);
  if (!routingPages.has(page)) {
    routingPages.set(page, JSON.parse(readFileSync(join(folder, manifest.version, 'fanout', `${page}.json`), 'utf8')));
    if (routingPages.size > 8) routingPages.delete(routingPages.keys().next().value!);
  }
  return routingPages.get(page)![id % pageSize];
};
const expectedFrontier = new Uint32Array(manifest.nodeCount);
for (let i = 1; i < manifest.nodeCount; i++) {
  if (structural[i]) continue;
  let parent = parents[i];
  while (structural[parent]) parent = parents[parent];
  expectedFrontier[parent]++;
}
let routedEdges = 0;
for (let i = 0; i < routes.length; i++) {
  if (routes[i] === NONE) continue;
  const pending = [routes[i]], seen = new Set<number>(), targets = new Set<number>();
  while (pending.length) {
    const id = pending.pop()!; assert.ok(!seen.has(id)); seen.add(id);
    const entry = route(id); assert.ok(entry);
    if (entry.left !== NONE) { pending.push(entry.left, entry.right); continue; }
    if (!entry.indices) continue;
    assert.equal(entry.indices.length, entry.count); assert.equal(entry.circles?.length, entry.count);
    assert.equal(entry.nodes?.length, entry.count);
    for (let at = 0; at < entry.indices.length; at++) {
      const child: number = entry.indices[at];
      const snapshot: NonNullable<FanoutEntry['nodes']>[number] = entry.nodes![at];
      assert.equal(snapshot.summary.index, child); assert.ok(!targets.has(child)); targets.add(child);
      assert.deepEqual(createHash('sha256').update(JSON.stringify(snapshot)).digest(), fingerprints.subarray(child * 32, (child + 1) * 32));
      assert.deepEqual(entry.circles![at], [snapshot.record.dx, snapshot.record.dy, snapshot.record.ratio]);
      assert.equal(structural[child], 0);
      let parent: number = parents[child];
      while (parent !== i) { assert.notEqual(parent, NONE); assert.equal(structural[parent], 1); parent = parents[parent]; }
      routedEdges++;
    }
  }
  if (targets.size) assert.equal(targets.size, expectedFrontier[i], 'Incomplete visible frontier');
}
assert.ok(manifest.tiles, 'Spatial tile publication is missing');
assert.ok(manifest.tiles.maxCompressedTileBytes <= 256 * 1024);
assert.ok(manifest.tiles.compressedBytes <= 32 * 1024 * 1024);
const tileIndexBytes = readFileSync(join(folder, manifest.version, manifest.tiles.indexFile));
const tileIndex = JSON.parse(tileIndexBytes.toString('utf8'));
assert.equal(tileIndex.format, 1);
assert.equal(tileIndex.levels.length, manifest.tiles.maxLevel + 1);
let tileFiles = 0, tileCompressedBytes = gzipSync(tileIndexBytes, { level: 6 }).byteLength;
let maxCompressedTileBytes = tileCompressedBytes, tiledNodes = 0, tiledLines = 0;
for (let z = 0; z <= manifest.tiles.maxLevel; z++) {
  const level = tileIndex.levels[z];
  assert.equal(level.z, z); assert.ok(Number.isInteger(level.side) && level.side > 0);
  const levelNodes = new Set<number>();
  for (const key of level.tiles) {
    assert.match(key, /^\d+\/\d+$/);
    const [x, y] = key.split('/').map(Number);
    assert.ok(x >= 0 && x < level.side && y >= 0 && y < level.side);
    const raw = readFileSync(join(folder, manifest.version, `tiles/${z}/${key}.json`));
    const compressed = gzipSync(raw, { level: 6 }).byteLength;
    assert.ok(compressed <= 256 * 1024, `Spatial tile ${z}/${key} exceeds its compressed budget`);
    tileCompressedBytes += compressed; maxCompressedTileBytes = Math.max(maxCompressedTileBytes, compressed); tileFiles++;
    const tile = JSON.parse(raw.toString('utf8'));
    assert.ok(Array.isArray(tile.nodes) && Array.isArray(tile.lines) && Array.isArray(tile.lineTargets));
    assert.equal(tile.lines.length % 4, 0); assert.equal(tile.lines.length / 4, tile.lineTargets.length);
    assert.ok(tile.lines.every(Number.isFinite));
    for (const target of tile.lineTargets) assert.ok(Number.isInteger(target) && target > 0 && target < manifest.nodeCount);
    tiledLines += tile.lineTargets.length;
    for (const node of tile.nodes) {
      const index = node.summary?.index;
      assert.ok(Number.isInteger(index) && index >= 0 && index < manifest.nodeCount);
      assert.ok(!levelNodes.has(index), `Duplicate spatial tile node ${index} at level ${z}`); levelNodes.add(index);
      assert.equal(node.summary.id, ids[index]);
      assert.deepEqual(createHash('sha256').update(JSON.stringify(node.summary)).digest(),
        summaryFingerprints.subarray(index * 32, (index + 1) * 32));
      assert.ok([...(node.position ?? []), node.radius, node.heading, node.group, ...(node.bounds ?? []), node.maxChildRatio].every(Number.isFinite));
      assert.ok(node.radius > 0 && Number.isInteger(node.childCount) && node.childCount >= 0);
      tiledNodes++;
    }
  }
}
assert.equal(tileFiles, manifest.tiles.tileCount);
assert.equal(tileCompressedBytes, manifest.tiles.compressedBytes);
assert.equal(maxCompressedTileBytes, manifest.tiles.maxCompressedTileBytes);
const report = { version: manifest.version, synthId: manifest.provenance?.synthId, nodeCount: ids.length,
  edgeCount: ids.length - 1, tips, named, maxDepth,
  everySourceIdNameLabelAndParentMatched: true, everyChildLinkAndTerminalCountMatched: true, allGeometryFinite: true,
  routedEdges, displayRoutingPreservesSourceAncestry: true, everyRoutingSnapshotMatched: true,
  spatialTiles: { tileFiles, tiledNodes, tiledLines, compressedBytes: tileCompressedBytes,
    maxCompressedTileBytes, everyTileSummaryMatched: true } };
writeFileSync('benchmarks/results/life-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
