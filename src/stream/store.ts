import { cacheBudget, decodePage, INDEX_PAGE_SIZE, readRecord, NONE, validateManifest } from './format.ts';
import type { AncestorEntry, ChildPreview, Details, FanoutEntry, Manifest, Page, RecordNode, Scene, SearchBlock, SearchEntry, StreamNode, Summary, ViewRequest } from './format.ts';
import type { Position } from '../tree/types.ts';

export type ReadBytes = (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
interface Entry { value: unknown; bytes: number }

/** Shared by the browser worker and benchmarks: byte-bounded LRU, no complete-tree index in memory. */
export class TreeStore {
  readonly manifest: Manifest;
  private read: ReadBytes;
  private cache = new Map<string, Entry>();
  private maxBytes: number;
  private bytes = 0;
  requests = 0;
  transferredBytes = 0;
  cacheHits = 0;
  evictions = 0;
  constructor(manifest: Manifest, read: ReadBytes, maxBytes = cacheBudget(manifest)) {
    this.manifest = validateManifest(manifest); this.read = read; this.maxBytes = maxBytes;
  }
  private async load<T>(path: string, decode: (b: ArrayBuffer) => T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const hit = this.cache.get(path);
    if (hit) {
      this.cache.delete(path); this.cache.set(path, hit); this.cacheHits++;
      return hit.value as T;
    }
    const buffer = await this.read(`${this.manifest.version}/${path}`, signal);
    signal?.throwIfAborted();
    this.requests++; this.transferredBytes += buffer.byteLength;
    const value = decode(buffer);
    // Charge decoded strings/objects as well as binary payload, conservatively.
    const cost = buffer.byteLength * 4;
    const previous = this.cache.get(path);
    if (previous) this.bytes -= previous.bytes;
    if (cost <= this.maxBytes) { this.cache.set(path, { value, bytes: cost }); this.bytes += cost; }
    while (this.bytes > this.maxBytes && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest); this.evictions++;
    }
    return value;
  }
  async node(index: number, signal?: AbortSignal): Promise<{ record: RecordNode; summary: Summary }> {
    if (!Number.isInteger(index) || index < 0 || index >= this.manifest.nodeCount) throw new Error('Invalid node index.');
    const page = await this.load<Page>(`pages/${Math.floor(index / this.manifest.pageSize)}.bin`, decodePage, signal);
    const offset = index % this.manifest.pageSize;
    const record = readRecord(page, offset);
    return { record, summary: { ...page.names[offset], index, depth: record.depth, leafCount: record.leafCount,
      isSyntheticNode: !!(record.flags & 1), isTerminal: !!(record.flags & 2) } };
  }
  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.load<T>(path, b => JSON.parse(new TextDecoder().decode(b)), signal);
  }
  async search(query: string, signal?: AbortSignal): Promise<Summary[]> {
    const key = query.trim().toLocaleLowerCase();
    if (!key) return [];
    let blocks = await this.json<SearchBlock[]>(this.manifest.searchDirectory ?? 'search.json', signal);
    if (this.manifest.searchDirectory) {
      const candidates = blocks.filter(b => b.last >= key && b.first <= `${key}\uffff`);
      // Prefixes spanning multiple directory pages are read only as far as needed.
      const result: Summary[] = [], seen = new Set<number>();
      for (const directory of candidates) {
        blocks = await this.json<SearchBlock[]>(directory.file, signal);
        for (const block of blocks) {
          if (block.last < key || block.first > `${key}\uffff`) continue;
          const entries = await this.json<SearchEntry[]>(block.file, signal);
          for (const [term, index] of entries) {
            if (term.startsWith(key) && !seen.has(index)) {
              seen.add(index); result.push((await this.node(index, signal)).summary);
              if (result.length === 12) return result;
            }
          }
        }
      }
      return result;
    }
    // Lower-bound lookup supports full-name, word-prefix and ID search without scanning all taxa.
    let lo = 0, hi = blocks.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (blocks[mid].last < key) lo = mid + 1; else hi = mid; }
    const found = new Set<number>();
    for (let i = lo; i < blocks.length && blocks[i].first <= `${key}\uffff` && found.size < 12; i++) {
      const entries = await this.json<SearchEntry[]>(blocks[i].file, signal);
      for (const [term, index] of entries) { if (term.startsWith(key)) found.add(index); if (found.size === 12) break; }
    }
    const result: Summary[] = [];
    for (const index of found) result.push((await this.node(index, signal)).summary);
    return result;
  }
  async details(index: number, signal?: AbortSignal): Promise<Details> {
    const item = await this.node(index, signal);
    const chain: AncestorEntry[] = [{ summary: item.summary, ...item.record }];
    const pageNumber = Math.floor(index / this.manifest.pageSize);
    const [entries, previews] = await Promise.all([
      this.manifest.ancestryPages ? this.json<AncestorEntry[]>(`ancestry/${pageNumber}.json`, signal) : null,
      this.manifest.detailPages && !item.summary.isSyntheticNode && item.record.firstChild !== NONE
        ? this.json<ChildPreview[]>(`details/${pageNumber}.json`, signal) : null,
    ]);
    const ancestry = entries ? new Map(entries.map(n => [n.summary.index, n])) : null;
    let current = item.record.parent;
    while (current !== NONE) {
      if (chain.length > this.manifest.nodeCount) throw new Error('Cycle in published ancestry.');
      let ancestor = ancestry?.get(current);
      if (!ancestor) {
        if (ancestry) throw new Error('Incomplete ancestry bundle.');
        const fetched = await this.node(current, signal); ancestor = { summary: fetched.summary, ...fetched.record };
      }
      chain.push(ancestor); current = ancestor.parent;
    }
    chain.reverse();
    // A nearby frame keeps arbitrary-depth search targets representable. Ancestors remain available in the panel.
    const anchorAt = Math.max(0, chain.length - 5);
    let x = 0, y = 0, radius = 1000;
    for (let i = anchorAt + 1; i < chain.length; i++) {
      const r = chain[i]; x += r.dx * radius; y += r.dy * radius; radius *= r.ratio;
    }
    const children: Summary[] = [];
    const preview = previews?.find(p => p.index === index);
    if (previews && !preview) throw new Error('Incomplete clade summary bundle.');
    if (preview) children.push(...preview.children);
    const pending: number[] = preview || item.record.firstChild === NONE ? [] : [item.record.firstChild];
    let examined = 0;
    while (pending.length && children.length < 100 && examined++ < 2000) {
      const child = await this.node(pending.pop()!, signal);
      if (child.record.nextSibling !== NONE) pending.push(child.record.nextSibling);
      if (child.summary.isSyntheticNode) {
        if (child.record.firstChild !== NONE) pending.push(child.record.firstChild);
      } else children.push(child.summary);
    }
    return { node: item.summary, lineage: chain.map(n => n.summary), children,
      childrenTruncated: preview ? preview.truncated : pending.length > 0, anchor: chain[anchorAt].summary.index,
      focus: this.positioned(item.summary, item.record, x, y, radius) };
  }
  private positioned(summary: Summary, record: RecordNode, x: number, y: number, radius: number): StreamNode {
    return { ...summary, position: [x, y], radius, heading: record.heading, group: record.group,
      bounds: [x + record.bounds[0] * radius, y + record.bounds[1] * radius,
        x + record.bounds[2] * radius, y + record.bounds[3] * radius], region: [] };
  }
  private async children(record: RecordNode, box: number[], minimumRadius: number, budget: number, signal?: AbortSignal) {
    const indices: { index: number; item?: { summary: Summary; record: RecordNode } }[] = [];
    let limited = false;
    if (record.fanoutRoot !== NONE) {
      const pending = [record.fanoutRoot];
      let visited = 0, lastYield = 0;
      while (pending.length && indices.length < budget && visited < 12000) {
        signal?.throwIfAborted();
        if (visited - lastYield >= 128) { lastYield = visited; await new Promise<void>(resolve => setTimeout(resolve, 0)); }
        const pageSize = this.manifest.indexPageSize ?? INDEX_PAGE_SIZE;
        const batch: number[] = [], pages = new Set<number>();
        while (pending.length && batch.length < 64 && visited + batch.length < 12000) {
          const id = pending.at(-1)!, page = Math.floor(id / pageSize);
          if (!pages.has(page) && pages.size === 8) break;
          batch.push(pending.pop()!); pages.add(page);
        }
        const loaded = new Map(await Promise.all([...pages].map(async page =>
          [page, await this.json<FanoutEntry[]>(`fanout/${page}.json`, signal)] as const)));
        for (const id of batch) {
        visited++;
        const entry = loaded.get(Math.floor(id / pageSize))![id % pageSize];
        if (!entry) throw new Error('Invalid child spatial index.');
        const b = entry.bounds;
        if (entry.maxRadius < minimumRadius || b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) continue;
        if (entry.left !== NONE) pending.push(entry.right, entry.left);
        else {
          for (let child = entry.start; child < entry.start + entry.count; child++) {
            const circle = entry.circles?.[child - entry.start];
            if (circle && (circle[2] < minimumRadius || circle[0] + circle[2] < box[0] || circle[0] - circle[2] > box[2] ||
                circle[1] + circle[2] < box[1] || circle[1] - circle[2] > box[3])) continue;
            if (indices.length === budget) { limited = true; break; }
            indices.push({ index: entry.indices ? entry.indices[child - entry.start] : child, item: entry.nodes?.[child - entry.start] });
          }
        }
        }
      }
      limited ||= pending.length > 0;
    } else {
      let child = record.firstChild;
      while (child !== NONE && indices.length < budget) {
        indices.push({ index: child }); child = (await this.node(child, signal)).record.nextSibling;
      }
      limited = child !== NONE;
    }
    return { indices, limited };
  }
  async view(request: ViewRequest, signal?: AbortSignal): Promise<Scene> {
    const started = performance.now();
    const { anchor, camera, size } = request;
    const scale = 2 ** camera.zoom;
    if (anchor === 0 && this.manifest.overview && scale <= this.manifest.overview.maxScale) {
      const overview = await this.json<{ nodes: StreamNode[]; lines: number[]; lineTargets: number[]; visits: number }>(this.manifest.overview.file, signal);
      return { anchor, nodes: overview.nodes, lines: new Float64Array(overview.lines), lineTargets: new Uint32Array(overview.lineTargets),
        stats: { requests: this.requests, transferredBytes: this.transferredBytes, cacheBytes: this.bytes,
          cacheEntries: this.cache.size, cacheHits: this.cacheHits, evictions: this.evictions,
          visited: overview.visits, queryMs: performance.now() - started, limited: false } };
    }
    const margin = 160;
    const left = camera.target[0] - (size.width / 2 + margin) / scale;
    const right = camera.target[0] + (size.width / 2 + margin) / scale;
    const top = camera.target[1] - (size.height / 2 + margin) / scale;
    const bottom = camera.target[1] + (size.height / 2 + margin) / scale;
    const nodes: StreamNode[] = [];
    const lineValues: number[] = [], targets: number[] = [];
    const pending: { index: number; x: number; y: number; radius: number; px: number; py: number; incoming: boolean;
      item?: { summary: Summary; record: RecordNode } }[] = [{ index: anchor, x: 0, y: 0, radius: 1000, px: 0, py: 0, incoming: false }];
    let visited = 0;
    let limited = false;
    let rebase: Scene['rebase'];
    const initial = await this.node(anchor, signal);
    // Restore surrounding clades when panning beyond a local frame as well as zooming out.
    const escapesFrame = Math.max(Math.abs(left), Math.abs(right), Math.abs(top), Math.abs(bottom)) > 1000;
    if (anchor !== 0 && (camera.zoom < -1.5 || escapesFrame)) {
      const r = initial.record;
      // Convert current-frame coordinates into its parent frame without a global coordinate.
      rebase = { anchor: r.parent, x: -r.dx * 1000 / r.ratio, y: -r.dy * 1000 / r.ratio, radius: 1000 / r.ratio };
    }
    while (pending.length && visited < 12000 && nodes.length < 4000) {
      if (visited % 128 === 0) {
        signal?.throwIfAborted();
        // Yield to worker messages, allowing obsolete requests to be cancelled.
        if (visited) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      const p = pending.pop()!;
      const item = p.item ?? await this.node(p.index, signal); visited++;
      const record = item.record;
      const onScreen = record.flags & 1
        ? p.x + record.bounds[2] * p.radius >= left && p.x + record.bounds[0] * p.radius <= right &&
          p.y + record.bounds[3] * p.radius >= top && p.y + record.bounds[1] * p.radius <= bottom
        : p.x + p.radius >= left && p.x - p.radius <= right && p.y + p.radius >= top && p.y - p.radius <= bottom;
      if (p.incoming) {
        const minX = Math.min(p.x, p.px), maxX = Math.max(p.x, p.px), minY = Math.min(p.y, p.py), maxY = Math.max(p.y, p.py);
        if (maxX >= left && minX <= right && maxY >= top && minY <= bottom && Math.hypot(p.x - p.px, p.y - p.py) * scale >= 0.7) {
          lineValues.push(p.px, p.py, p.x, p.y); targets.push(p.index);
        }
      }
      if (!onScreen) continue;
      if (camera.zoom > 14 && p.index !== anchor && p.radius < 1 && p.radius * scale > Math.max(size.width, size.height) * 2 &&
          Math.hypot(camera.target[0] - p.x, camera.target[1] - p.y) < p.radius * 0.7) {
        rebase = { anchor: p.index, x: p.x, y: p.y, radius: p.radius };
      }
      if (!(record.flags & 1) && p.radius * scale >= 3) {
        const n = this.positioned(item.summary, record, p.x, p.y, p.radius);
        if (record.childCount > 64 && p.radius * record.maxChildRatio * scale < 0.5) n.collapsedCount = record.childCount;
        if (!(record.flags & 2) && p.radius * scale >= 24 && p.radius * scale <= 4000) {
          const span = p.index === 0 || (this.manifest.presentation === 'life' && item.summary.depth === 1) ? Math.PI * 2 : Math.PI;
          n.region.push(n.position);
          for (let s = 0; s <= 32; s++) {
            const a = record.heading - span / 2 + span * s / 32;
            n.region.push([p.x + p.radius * Math.cos(a), p.y + p.radius * Math.sin(a)] as Position);
          }
          n.region.push(n.position);
        }
        nodes.push(n);
      }
      // Parent nodes summarize everything below this projected resolution.
      if (record.firstChild === NONE || p.radius * record.maxChildRatio * scale < 0.5) continue;
      const children = await this.children(record,
        [(left - p.x) / p.radius, (top - p.y) / p.radius, (right - p.x) / p.radius, (bottom - p.y) / p.radius],
        0.5 / (p.radius * scale), Math.max(0, 12000 - visited - pending.length), signal);
      limited ||= children.limited;
      for (const child of children.indices) {
        const item = child.item ?? await this.node(child.index, signal), r = item.record;
        pending.push({ index: child.index, item, x: p.x + r.dx * p.radius, y: p.y + r.dy * p.radius,
          radius: p.radius * r.ratio, px: p.x, py: p.y, incoming: true });
      }
    }
    return { anchor, nodes, lines: new Float64Array(lineValues), lineTargets: new Uint32Array(targets), rebase,
      stats: { requests: this.requests, transferredBytes: this.transferredBytes, cacheBytes: this.bytes,
        cacheEntries: this.cache.size, cacheHits: this.cacheHits, evictions: this.evictions,
        visited, queryMs: performance.now() - started, limited: limited || pending.length > 0 } };
  }
}
