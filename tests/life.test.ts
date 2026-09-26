import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { buildDataset, graphFromJson } from '../pipeline/build-tree.ts';
import { SearchWriter } from '../pipeline/search-writer.ts';
import { TreeStore } from '../src/stream/store.ts';
import type { SearchEntry } from '../src/stream/format.ts';
import { fitBounds } from '../src/tree/navigation.ts';

const folder = mkdtempSync(join(tmpdir(), 'life-tests-'));
after(() => {
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(folder.startsWith(join(tmpdir(), 'life-tests-')));
  rmSync(folder, { recursive: true, force: true });
});

test('whole-tree presentation preserves source ancestors and supplies one overview packet', async () => {
  const graph = graphFromJson([
    { id: 'ott93302', parentId: null, scientificName: 'cellular organisms' },
    { id: 'ott304358', parentId: 'ott93302', scientificName: 'Eukaryota' },
    { id: 'ott996421', parentId: 'ott93302', scientificName: 'Archaea' },
    { id: 'ott844192', parentId: 'ott93302', scientificName: 'Bacteria' },
    { id: 'mrcaott10ott11', parentId: 'ott304358', scientificName: 'Unnamed clade', isSyntheticNode: true },
    { id: 'ott10', parentId: 'mrcaott10ott11', scientificName: 'Fungi' },
    { id: 'ott11', parentId: 'mrcaott10ott11', scientificName: 'Metazoa' },
  ]);
  graph.presentation = 'life';
  const { manifest } = buildDataset(graph, join(folder, 'tree'));
  const read = async (path: string) => { const b = readFileSync(join(folder, 'tree', path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const store = new TreeStore(manifest, read);
  const camera = fitBounds([-930, -790, 930, 970], { width: 1280, height: 720 }, { top: 90, right: 90, bottom: 55, left: 90 });
  const scene = await store.view({ anchor: 0, camera, size: { width: 1280, height: 720 } });
  assert.equal(scene.stats.requests, 1);
  for (const name of ['Eukaryota', 'Archaea', 'Bacteria', 'Fungi']) assert.ok(scene.nodes.some(n => n.scientificName === name));
  const [fungi] = await store.search('Fungi'), detail = await store.details(fungi.index);
  assert.deepEqual(detail.lineage.map(n => n.id), ['ott93302', 'ott304358', 'mrcaott10ott11', 'ott10']);
  assert.equal(detail.node.parentId, 'mrcaott10ott11');
  const [structural] = await Promise.all([store.node(detail.lineage[2].index)]);
  assert.equal(structural.record.ratio, 1);
  assert.equal(structural.record.dx, 0);
  // Equal binary children use forward half discs: the original clade scale is
  // retained, while empty branch length is removed without crossing sectors.
  const fungiRecord = (await store.node(fungi.index)).record;
  const distance = Math.hypot(fungiRecord.dx, fungiRecord.dy);
  assert.ok(distance < 0.45);
  assert.ok(fungiRecord.ratio > 0.39 && fungiRecord.ratio < 0.41);
  assert.ok(Math.atan2(fungiRecord.ratio, distance) < Math.PI / 4);
  assert.ok(distance + fungiRecord.ratio <= 1 + 1e-12);
});

test('spilled search remains globally sorted across short, numeric and OTT prefixes', () => {
  const target = join(folder, 'search-test'); mkdirSync(target); mkdirSync(join(target, 'search'));
  const writer = new SearchWriter(target);
  const terms = ['ot', 'ott', 'ott1', 'ott1001', 'oth', 'other', 'ottoman', '01', '01a', '0', '01ab', 'Fungi', 'fu', 'fungi', 'z'];
  const entries: SearchEntry[] = [];
  for (let i = 0; i < 2400; i++) { const entry: SearchEntry = [terms[i % terms.length], i]; entries.push(entry); writer.add(entry); }
  const { blocks } = writer.finish(createHash('sha256'));
  const actual = blocks.flatMap(b => JSON.parse(readFileSync(join(target, b.file), 'utf8')) as SearchEntry[]);
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
  assert.deepEqual(actual, entries);
  assert.equal(blocks.length, 3);
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i - 1].last <= blocks[i].first);
});
