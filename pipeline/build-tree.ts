import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, cpSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { encodePage, FORMAT_VERSION, INDEX_PAGE_SIZE, NONE, PAGE_SIZE, RECORD_BYTES, readRecord } from '../src/stream/format.ts';
import type { AncestorEntry, ChildPreview, FanoutEntry, Manifest, Provenance, SearchBlock, SearchEntry, Summary } from '../src/stream/format.ts';
import type { TreeNodeInput } from '../src/tree/types.ts';
import { parseTreeData } from '../src/tree/layoutTreeV3.ts';
import { SearchWriter } from './search-writer.ts';
import { lifeGeometry, writeOverview } from './life-overview.ts';

export interface Graph {
  parents: Int32Array;
  metadata: (index: number) => TreeNodeInput;
  title: string;
  source: string;
  synthetic: boolean;
  provenance?: Provenance;
  presentation?: 'life';
}

export function graphFromJson(value: unknown): Graph {
  const nodes = parseTreeData(value);
  const ids = new Map(nodes.map((n, i) => [n.id, i]));
  if (ids.size !== nodes.length) throw new Error('Duplicate node IDs.');
  const parents = Int32Array.from(nodes, n => {
    if (n.parentId === null) return -1;
    const parent = ids.get(n.parentId);
    if (parent === undefined) throw new Error(`Missing parent of ${n.id}`);
    return parent;
  });
  return { parents, metadata: i => nodes[i], title: 'Primates', source: 'Open Tree of Life — local Primates snapshot', synthetic: false };
}

/** Deterministic scale fixtures. Names deliberately cannot be mistaken for biological taxa. */
export function fixtureGraph(count: number, shape: 'balanced' | 'unbalanced' = 'balanced'): Graph {
  if (!Number.isInteger(count) || count < 2 || count > 2_000_000) throw new Error('Fixture size must be 2–2,000,000.');
  const parents = new Int32Array(count);
  parents[0] = -1;
  const spine = shape === 'unbalanced' ? Math.min(256, Math.floor((count - 1) / 4)) : 0;
  for (let i = 1; i < count; i++) {
    if (i <= spine * 2) parents[i] = i % 2 ? i - 1 : i - 2;
    else parents[i] = spine * 2 + Math.floor((i - spine * 2 - 1) / 4);
  }
  return {
    parents, title: `${shape} ${count.toLocaleString()} — generated benchmark`,
    source: 'Generated benchmark fixture; not biological data', synthetic: true,
    metadata: i => ({ id: `test-${String(i).padStart(7, '0')}`, parentId: parents[i] < 0 ? null : `test-${String(parents[i]).padStart(7, '0')}`,
      scientificName: `Test taxon ${String(i).padStart(7, '0')}` }),
  };
}

export function buildDataset(graph: Graph, outputDirectory: string) {
  const started = performance.now();
  const count = graph.parents.length;
  const first = new Uint32Array(count).fill(NONE);
  const next = new Uint32Array(count).fill(NONE);
  let root = -1;
  for (let i = count - 1; i >= 0; i--) {
    const parent = graph.parents[i];
    if (parent === -1) {
      if (root !== -1) throw new Error('Multiple roots.');
      root = i;
    } else {
      if (parent < 0 || parent >= count || parent === i) throw new Error('Invalid parent index.');
      next[i] = first[parent]; first[parent] = i;
    }
  }
  if (root < 0) throw new Error('Missing root.');
  // Breadth-first pages keep overview levels together. DFS would scatter the
  // first few hundred visible ancestors across almost every page of a large tree.
  const order = new Uint32Array(count);
  const inverse = new Uint32Array(count);
  const seen = new Uint8Array(count);
  order[0] = root; seen[root] = 1;
  let used = 1;
  for (let cursor = 0; cursor < used; cursor++) {
    const i = order[cursor];
    for (let child = first[i]; child !== NONE; child = next[child]) {
      if (seen[child]) throw new Error('Cycle in input tree.');
      seen[child] = 1; inverse[child] = used; order[used++] = child;
    }
  }
  if (used !== count) throw new Error('Disconnected cycle in input tree.');
  const leaves = new Uint32Array(count);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k];
    if (first[i] === NONE) leaves[i] = 1;
    if (graph.parents[i] !== -1) leaves[graph.parents[i]] += leaves[i];
  }

  const records = new ArrayBuffer(count * RECORD_BYTES);
  const data = new DataView(records);
  let maxDepth = 0;
  let maxChildren = 0;
  for (let k = 0; k < count; k++) {
    const i = order[k]; const b = k * RECORD_BYTES;
    const parent = graph.parents[i];
    const depth = parent < 0 ? 0 : data.getUint32(inverse[parent] * RECORD_BYTES + 16, true) + 1;
    maxDepth = Math.max(maxDepth, depth);
    data.setUint32(b, parent < 0 ? NONE : inverse[parent], true);
    data.setUint32(b + 4, first[i] === NONE ? NONE : inverse[first[i]], true);
    data.setUint32(b + 8, next[i] === NONE ? NONE : inverse[next[i]], true);
    data.setUint32(b + 12, leaves[i], true);
    data.setUint32(b + 16, depth, true);
    if (k === 0) { data.setFloat64(b + 40, 1, true); data.setFloat64(b + 48, -Math.PI / 2, true); }
    let children = 0; let total = 0;
    for (let ch = first[i]; ch !== NONE; ch = next[ch]) { children++; total += Math.sqrt(leaves[ch]); }
    data.setUint32(b + 72, children, true);
    data.setUint32(b + 80, NONE, true);
    maxChildren = Math.max(maxChildren, children);
    const span = k === 0 ? Math.PI * 2 : Math.PI;
    const heading = data.getFloat64(b + 48, true);
    let cursor = heading - span / 2; let maxRatio = 0;
    for (let ch = first[i]; ch !== NONE; ch = next[ch]) {
      const sector = span * Math.sqrt(leaves[ch]) / total;
      const angle = children === 1 ? heading : cursor + sector / 2;
      const sine = Math.sin(Math.min(Math.PI, sector) / 2);
      const ratio = children === 1 ? 0.82 : sine / (1 + sine) * 0.96;
      const childOffset = inverse[ch] * RECORD_BYTES;
      data.setFloat64(childOffset + 24, (1 - ratio) * Math.cos(angle), true);
      data.setFloat64(childOffset + 32, (1 - ratio) * Math.sin(angle), true);
      data.setFloat64(childOffset + 40, ratio, true);
      data.setFloat64(childOffset + 48, angle % (2 * Math.PI), true);
      maxRatio = Math.max(maxRatio, ratio); cursor += sector;
    }
    data.setFloat32(b + 76, maxRatio, true);
  }
  const displayRouting = graph.presentation === 'life' ? lifeGeometry(graph, order, inverse, first, next, leaves, data) : null;
  // Bounds stay in each clade's own coordinate frame; no global tiny numbers.
  for (let k = count - 1; k > 0; k--) {
    const b = k * RECORD_BYTES;
    const parent = data.getUint32(b, true) * RECORD_BYTES;
    const dx = data.getFloat64(b + 24, true), dy = data.getFloat64(b + 32, true), r = data.getFloat64(b + 40, true);
    for (let dimension = 0; dimension < 4; dimension++) {
      const location = 56 + dimension * 4;
      const val = (dimension % 2 ? dy : dx) + r * data.getFloat32(b + location, true);
      const previous = data.getFloat32(parent + location, true);
      data.setFloat32(parent + location, dimension < 2 ? Math.min(previous, val) : Math.max(previous, val), true);
    }
  }

  const fanout: FanoutEntry[] = [];
  const partition = (start: number, length: number, indices?: number[]): number => {
    const index = fanout.length;
    const entry: FanoutEntry = { bounds: [Infinity, Infinity, -Infinity, -Infinity], maxRadius: 0,
      start, count: length, left: NONE, right: NONE };
    fanout.push(entry);
    if (length > (indices ? 8 : 32)) {
      const half = Math.floor(length / 2);
      entry.left = partition(start, half, indices); entry.right = partition(start + half, length - half, indices);
      const a = fanout[entry.left], b = fanout[entry.right];
      entry.bounds = [Math.min(a.bounds[0], b.bounds[0]), Math.min(a.bounds[1], b.bounds[1]),
        Math.max(a.bounds[2], b.bounds[2]), Math.max(a.bounds[3], b.bounds[3])];
      entry.maxRadius = Math.max(a.maxRadius, b.maxRadius);
    } else {
      if (indices) { entry.indices = indices.slice(start, start + length); entry.circles = []; }
      for (let i = start; i < start + length; i++) {
        const offset = (indices ? indices[i] : i) * RECORD_BYTES;
        const x = data.getFloat64(offset + 24, true), y = data.getFloat64(offset + 32, true), r = data.getFloat64(offset + 40, true);
        entry.circles?.push([x, y, r]);
        entry.bounds[0] = Math.min(entry.bounds[0], x - r); entry.bounds[1] = Math.min(entry.bounds[1], y - r);
        entry.bounds[2] = Math.max(entry.bounds[2], x + r); entry.bounds[3] = Math.max(entry.bounds[3], y + r);
        entry.maxRadius = Math.max(entry.maxRadius, r);
      }
    }
    return index;
  };
  for (let i = 0; i < count; i++) {
    const b = i * RECORD_BYTES, children = data.getUint32(b + 72, true);
    const routed = displayRouting?.get(i);
    // In breadth-first order, a parent's immediate children form a contiguous range.
    if (routed?.length) data.setUint32(b + 80, partition(0, routed.length, routed), true);
    else if (children > 64) data.setUint32(b + 80, partition(data.getUint32(b + 4, true), children), true);
  }
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'tree-build-'));
  mkdirSync(join(stage, 'pages')); mkdirSync(join(stage, 'search')); mkdirSync(join(stage, 'fanout'));
  const hash = createHash('sha256').update(JSON.stringify({ format: FORMAT_VERSION, source: graph.source, title: graph.title, synthetic: graph.synthetic, provenance: graph.provenance, presentation: graph.presentation, presentationRevision: graph.presentation ? 2 : undefined }));
  const search: SearchEntry[] = [];
  const externalSearch = graph.presentation === 'life' ? new SearchWriter(stage) : null;
  let namedCount = 0; let diskBytes = 0;
  const summary = (index: number): Summary => {
    const b = index * RECORD_BYTES, n = graph.metadata(order[index]);
    return { ...n, index, depth: data.getUint32(b + 16, true), leafCount: data.getUint32(b + 12, true),
      isTerminal: data.getUint32(b + 72, true) === 0, isSyntheticNode: !!n.isSyntheticNode };
  };
  const indexPageSize = graph.presentation ? 16 : INDEX_PAGE_SIZE;
  if (graph.provenance) {
    if (graph.presentation) console.log('Writing ancestry and clade previews…');
    mkdirSync(join(stage, 'ancestry')); mkdirSync(join(stage, 'details'));
    for (let start = 0; start < count; start += PAGE_SIZE) {
      const ancestors = new Set<number>();
      for (let i = start; i < Math.min(count, start + PAGE_SIZE); i++) {
        let parent = data.getUint32(i * RECORD_BYTES, true);
        while (parent !== NONE && !ancestors.has(parent)) {
          ancestors.add(parent); parent = data.getUint32(parent * RECORD_BYTES, true);
        }
      }
      const rows: AncestorEntry[] = [...ancestors].sort((a, b) => a - b).map(index => {
        const b = index * RECORD_BYTES;
        return { summary: summary(index),
          parent: data.getUint32(b, true), dx: data.getFloat64(b + 24, true), dy: data.getFloat64(b + 32, true), ratio: data.getFloat64(b + 40, true) };
      });
      const text = JSON.stringify(rows); hash.update(text); diskBytes += Buffer.byteLength(text);
      writeFileSync(join(stage, 'ancestry', `${start / PAGE_SIZE}.json`), text);
      const previews: ChildPreview[] = [];
      for (let i = start; i < Math.min(count, start + PAGE_SIZE); i++) {
        if (graph.metadata(order[i]).isSyntheticNode || data.getUint32(i * RECORD_BYTES + 4, true) === NONE) continue;
        const preview: ChildPreview = { index: i, children: [], truncated: false };
        const pending = [data.getUint32(i * RECORD_BYTES + 4, true)];
        let examined = 0;
        while (pending.length && preview.children.length < 100 && examined++ < 2000) {
          const child = pending.pop()!, b = child * RECORD_BYTES;
          const next = data.getUint32(b + 8, true), first = data.getUint32(b + 4, true);
          if (next !== NONE) pending.push(next);
          const node = summary(child);
          if (node.isSyntheticNode) { if (first !== NONE) pending.push(first); }
          else preview.children.push(node);
        }
        preview.truncated = pending.length > 0; previews.push(preview);
      }
      const previewText = JSON.stringify(previews); hash.update(previewText); diskBytes += Buffer.byteLength(previewText);
      writeFileSync(join(stage, 'details', `${start / PAGE_SIZE}.json`), previewText);
    }
  }
  for (let i = 0; i < fanout.length; i += indexPageSize) {
    const entries = fanout.slice(i, i + indexPageSize).map(entry => entry.indices ? {
      ...entry, nodes: entry.indices.map(index => {
        const node = summary(index), b = index * RECORD_BYTES;
        const record = readRecord({ records: new DataView(records, b, RECORD_BYTES), count: 1, names: [], bytes: RECORD_BYTES }, 0);
        record.flags = (node.isSyntheticNode ? 1 : 0) | (node.isTerminal ? 2 : 0);
        return { summary: node, record };
      }),
    } : entry);
    const text = JSON.stringify(entries);
    hash.update(text); diskBytes += Buffer.byteLength(text);
    writeFileSync(join(stage, 'fanout', `${i / indexPageSize}.json`), text);
  }
  for (let start = 0; start < count; start += PAGE_SIZE) {
    if (graph.presentation && start % (PAGE_SIZE * 1000) === 0) console.log(`Writing geometry: ${start.toLocaleString()} / ${count.toLocaleString()}`);
    const length = Math.min(PAGE_SIZE, count - start);
    const names: TreeNodeInput[] = [];
    for (let k = start; k < start + length; k++) {
      const n = graph.metadata(order[k]);
      const flags = (n.isSyntheticNode ? 1 : 0) | (data.getUint32(k * RECORD_BYTES + 72, true) === 0 ? 2 : 0);
      data.setUint32(k * RECORD_BYTES + 20, flags, true);
      names.push(n);
      if (!n.isSyntheticNode) {
        namedCount++;
        const keys = new Set([n.id.toLocaleLowerCase(), n.scientificName.toLocaleLowerCase()]);
        if (n.ottId) { keys.add(String(n.ottId)); keys.add(`ott${n.ottId}`); }
        if (n.commonName) keys.add(n.commonName.toLocaleLowerCase());
        for (const name of [n.scientificName, n.commonName ?? '']) {
          const words = name.toLocaleLowerCase().split(/\s+/);
          for (let w = 1; w < words.length; w++) keys.add(words.slice(w).join(' '));
        }
        for (const key of keys) {
          if (externalSearch) externalSearch.add([key, k]); else search.push([key, k]);
        }
      }
    }
    const buffer = encodePage(records.slice(start * RECORD_BYTES, (start + length) * RECORD_BYTES), names);
    hash.update(buffer); diskBytes += buffer.byteLength;
    writeFileSync(join(stage, 'pages', `${start / PAGE_SIZE}.bin`), buffer);
  }
  search.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
  if (externalSearch) console.log('Sorting partitioned search index…');
  const external = externalSearch?.finish(hash);
  const blocks: SearchBlock[] = external?.blocks ?? [];
  diskBytes += external?.bytes ?? 0;
  for (let start = 0; start < search.length; start += 1024) {
    const rows = search.slice(start, start + 1024);
    const file = `search/${start / 1024}.json`;
    const text = JSON.stringify(rows);
    hash.update(text);
    writeFileSync(join(stage, file), text); diskBytes += Buffer.byteLength(text);
    blocks.push({ first: rows[0][0], last: rows.at(-1)![0], file });
  }
  const directory = JSON.stringify(blocks);
  hash.update(directory);
  writeFileSync(join(stage, 'search.json'), directory); diskBytes += Buffer.byteLength(directory);
  // A small top directory avoids downloading the full search directory for each first search.
  if (externalSearch) {
    const top: SearchBlock[] = [];
    for (let i = 0; i < blocks.length; i += 256) {
      const part = blocks.slice(i, i + 256), file = `search-directory-${i / 256}.json`, text = JSON.stringify(part);
      hash.update(text); diskBytes += Buffer.byteLength(text); writeFileSync(join(stage, file), text);
      top.push({ first: part[0].first, last: part.at(-1)!.last, file });
    }
    const text = JSON.stringify(top); hash.update(text); diskBytes += Buffer.byteLength(text);
    writeFileSync(join(stage, 'search-top.json'), text);
    // Sorting runs are temporary and must never enter a publication.
    rmSync(join(stage, 'sort'), { recursive: true });
  }
  const overview = graph.presentation === 'life' ? writeOverview(data, count, summary, stage) : undefined;
  if (overview) { hash.update(overview.bytes); diskBytes += overview.bytes.byteLength; }
  const version = hash.digest('hex').slice(0, 16);
  const manifest: Manifest = {
    format: FORMAT_VERSION, version, title: graph.title, source: graph.source, synthetic: graph.synthetic,
    nodeCount: count, namedCount, leafCount: leaves[root], pageSize: PAGE_SIZE, pageCount: Math.ceil(count / PAGE_SIZE), maxDepth,
    root: { ...graph.metadata(root), index: 0, leafCount: leaves[root], depth: 0, isTerminal: first[root] === NONE },
    rootBounds: graph.presentation === 'life' ? [-0.93, -0.79, 0.93, 0.97] : [56, 60, 64, 68].map(offset => data.getFloat32(offset, true)) as Manifest['rootBounds'],
    builtAt: new Date().toISOString(), provenance: graph.provenance, maxChildren, fanoutEntries: fanout.length,
    ancestryPages: !!graph.provenance, detailPages: !!graph.provenance,
    presentation: graph.presentation, overview: overview ? { file: 'overview.json', maxScale: overview.maxScale } : undefined,
    searchDirectory: externalSearch ? 'search-top.json' : undefined,
    indexPageSize: graph.presentation ? indexPageSize : undefined,
  };
  const destination = join(output, version);
  if (existsSync(join(destination, 'manifest.json'))) {
    // Repeated builds retain the original publication timestamp.
    manifest.builtAt = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')).builtAt;
  } else {
    cpSync(stage, destination, { recursive: true });
    // The immutable version becomes complete before publishing the pointer.
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest));
  }
  if (dirname(resolve(stage)) !== resolve(tmpdir()) || !stage.startsWith(join(tmpdir(), 'tree-build-'))) throw new Error('Unsafe staging directory.');
  rmSync(stage, { recursive: true });
  const pointer = join(output, 'manifest.next.json');
  writeFileSync(pointer, JSON.stringify(manifest, null, 2));
  renameSync(pointer, join(output, 'manifest.json'));
  return { manifest, buildMs: performance.now() - started, diskBytes, peakRssMB: process.resourceUsage().maxRSS / 1024 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = resolve('public/data/primates.nodes.json');
  const result = buildDataset(graphFromJson(JSON.parse(readFileSync(input, 'utf8'))), 'public/data/primates');
  console.log(JSON.stringify(result, null, 2));
  const avesPath = resolve('data/processed/opentree/aves');
  if (existsSync(join(avesPath, 'provenance.json'))) {
    const bytes = readFileSync(join(avesPath, 'nodes.json'));
    const provenance: Provenance = JSON.parse(readFileSync(join(avesPath, 'provenance.json'), 'utf8'));
    if (createHash('sha256').update(bytes).digest('hex') !== provenance.nodesSha256) throw new Error('Aves export checksum mismatch. Re-run source validation.');
    const graph = graphFromJson(JSON.parse(bytes.toString('utf8')));
    graph.title = provenance.title; graph.source = `Open Tree of Life — ${provenance.title}, ${provenance.synthId}`; graph.provenance = provenance;
    const built = buildDataset(graph, 'public/data/aves');
    console.log(JSON.stringify({ dataset: 'aves', nodes: built.manifest.nodeCount, version: built.manifest.version, maxChildren: built.manifest.maxChildren, buildMs: built.buildMs }));
  }
}
