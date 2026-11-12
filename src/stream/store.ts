import { cacheBudget, decodePage, INDEX_PAGE_SIZE, readRecord, NONE, validateManifest } from './format.ts';
import type { AncestorEntry, ChildPreview, Details, FanoutEntry, Manifest, Page, PrefetchHint, RecordNode, Scene, SearchBlock, SearchEntry, SpatialTile, SpatialTileIndex, StreamNode, Summary, ViewRequest } from './format.ts';
import type { Position } from '../tree/types.ts';

export type ReadBytes = (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
interface Entry { value: unknown; bytes: number }

/** Shared by the browser worker and benchmarks: byte-bounded LRU, no complete-tree index in memory. */
export class TreeStore {
  readonly manifest: Manifest;
  private read: ReadBytes;
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<unknown>>();
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
    let request = this.inflight.get(path) as Promise<T> | undefined;
    if (!request) {
      request = this.read(`${this.manifest.version}/${path}`).then(buffer => {
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
      });
      this.inflight.set(path, request);
      request.then(() => { if (this.inflight.get(path) === request) this.inflight.delete(path); },
        () => { if (this.inflight.get(path) === request) this.inflight.delete(path); });
    }
    return this.withSignal(request, signal);
  }
  private withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Request cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
        signal.removeEventListener('abort', abort); reject(error);
      });
    });
  }
  private page(pageNumber: number, signal?: AbortSignal) {
    if (!Number.isInteger(pageNumber) || pageNumber < 0 || pageNumber >= this.manifest.pageCount) {
      throw new Error('Invalid tree page number.');
    }
    return this.load<Page>(`pages/${pageNumber}.bin`, decodePage, signal);
  }
  private async nodes(indices: number[], signal?: AbortSignal) {
    const pages = [...new Set(indices.map(index => {
      if (!Number.isInteger(index) || index < 0 || index >= this.manifest.nodeCount) throw new Error('Invalid node index.');
      return Math.floor(index / this.manifest.pageSize);
    }))];
    const loaded = new Map(await Promise.all(pages.map(async page => [page, await this.page(page, signal)] as const)));
    return new Map(indices.map(index => {
      const page = loaded.get(Math.floor(index / this.manifest.pageSize))!;
      const offset = index % this.manifest.pageSize;
      const record = readRecord(page, offset);
      return [index, { record, summary: { ...page.names[offset], index, depth: record.depth, leafCount: record.leafCount,
        isSyntheticNode: !!(record.flags & 1), isTerminal: !!(record.flags & 2) } }] as const;
    }));
  }
  async node(index: number, signal?: AbortSignal): Promise<{ record: RecordNode; summary: Summary }> {
    if (!Number.isInteger(index) || index < 0 || index >= this.manifest.nodeCount) throw new Error('Invalid node index.');
    const page = await this.page(Math.floor(index / this.manifest.pageSize), signal);
    const offset = index % this.manifest.pageSize;
    const record = readRecord(page, offset);
    return { record, summary: { ...page.names[offset], index, depth: record.depth, leafCount: record.leafCount,
      isSyntheticNode: !!(record.flags & 1), isTerminal: !!(record.flags & 2) } };
  }
  async prefetch(hint: PrefetchHint) {
    const nodePages = [...new Set(hint.nodes.filter(index => Number.isInteger(index) && index >= 0 && index < this.manifest.nodeCount)
      .map(index => Math.floor(index / this.manifest.pageSize)))];
    const indexPageSize = this.manifest.indexPageSize ?? INDEX_PAGE_SIZE;
    const fanoutPages = [...new Set(hint.fanoutPages.filter(page => Number.isInteger(page) && page >= 0 &&
      page * indexPageSize < (this.manifest.fanoutEntries ?? 0)))];
    await Promise.allSettled([
      ...nodePages.map(page => this.page(page)),
      ...fanoutPages.map(page => this.json<FanoutEntry[]>(`fanout/${page}.json`)),
      ...(hint.tiles ?? []).slice(0, 12).map(path => this.json<SpatialTile>(path)),
    ]);
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
      const found: number[] = [], seen = new Set<number>();
      searchDirectories:
      for (const directory of candidates) {
        blocks = await this.json<SearchBlock[]>(directory.file, signal);
        for (const block of blocks) {
          if (block.last < key || block.first > `${key}\uffff`) continue;
          const entries = await this.json<SearchEntry[]>(block.file, signal);
          for (const [term, index] of entries) {
            if (term.startsWith(key) && !seen.has(index)) {
              seen.add(index); found.push(index);
              if (found.length === 12) break searchDirectories;
            }
          }
        }
      }
      const loaded = await this.nodes(found, signal);
      return found.map(index => loaded.get(index)!.summary);
    }
    // Lower-bound lookup supports full-name, word-prefix and ID search without scanning all taxa.
    let lo = 0, hi = blocks.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (blocks[mid].last < key) lo = mid + 1; else hi = mid; }
    const found = new Set<number>();
    for (let i = lo; i < blocks.length && blocks[i].first <= `${key}\uffff` && found.size < 12; i++) {
      const entries = await this.json<SearchEntry[]>(blocks[i].file, signal);
      for (const [term, index] of entries) { if (term.startsWith(key)) found.add(index); if (found.size === 12) break; }
    }
    const indices = [...found];
    const loaded = await this.nodes(indices, signal);
    return indices.map(index => loaded.get(index)!.summary);
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
      // The publication is breadth-first, so every parent's immediate children
      // occupy one contiguous range. Build the range without fetching each child
      // merely to discover its next-sibling pointer; `view` loads their pages in
      // one parallel batch below.
      const count = Math.min(record.childCount, budget);
      for (let offset = 0; offset < count; offset++) indices.push({ index: record.firstChild + offset });
      limited = count < record.childCount;
    }
    return { indices, limited };
  }
  private async tileView(request: ViewRequest, signal?: AbortSignal): Promise<Scene> {
    const started = performance.now(), config = this.manifest.tiles!;
    const { camera, size } = request, scale = 2 ** camera.zoom;
    const margin = 160;
    const left = camera.target[0] - (size.width / 2 + margin) / scale;
    const right = camera.target[0] + (size.width / 2 + margin) / scale;
    const top = camera.target[1] - (size.height / 2 + margin) / scale;
    const bottom = camera.target[1] + (size.height / 2 + margin) / scale;
    const level = Math.max(0, Math.min(config.maxLevel, Math.floor(camera.zoom - config.baseZoom)));
    const index = await this.json<SpatialTileIndex>(config.indexFile, signal);
    if (index.format !== 1) throw new Error('Invalid spatial tile index.');
    const levelEntry = index.levels.find(item => item.z === level);
    if (!levelEntry || !Number.isInteger(levelEntry.side) || levelEntry.side < 1 || !Array.isArray(levelEntry.tiles)) {
      throw new Error('Invalid spatial tile level.');
    }
    const side = levelEntry.side, [minX, minY, maxX, maxY] = config.worldBounds;
    const tileWidth = (maxX - minX) / side, tileHeight = (maxY - minY) / side;
    const clamp = (value: number) => Math.max(0, Math.min(side - 1, value));
    const fromX = clamp(Math.floor((left - minX) / tileWidth)), toX = clamp(Math.floor((right - minX) / tileWidth));
    const fromY = clamp(Math.floor((top - minY) / tileHeight)), toY = clamp(Math.floor((bottom - minY) / tileHeight));
    const available = new Set(levelEntry.tiles);
    const selected: { key: string; path: string }[] = [];
    if (right >= minX && left <= maxX && bottom >= minY && top <= maxY) {
      for (let x = fromX; x <= toX; x++) for (let y = fromY; y <= toY; y++) {
        const key = `${x}/${y}`;
        if (available.has(key)) selected.push({ key, path: config.pattern.replace('{z}', String(level)).replace('{x}', String(x)).replace('{y}', String(y)) });
      }
    }
    const loaded = await Promise.all(selected.map(async item => ({ ...item, tile: await this.json<SpatialTile>(item.path, signal) })));
    const nodeMap = new Map<number, StreamNode>(), lineValues: number[] = [], lineTargets: number[] = [];
    let visited = 0;
    for (const { tile } of loaded) {
      if (!Array.isArray(tile.nodes) || !Array.isArray(tile.lines) || tile.lines.length % 4 ||
          !Array.isArray(tile.lineTargets) || tile.lineTargets.length * 4 !== tile.lines.length) {
        throw new Error('Invalid spatial tile payload.');
      }
      visited += tile.nodes.length;
      for (const item of tile.nodes) {
        if (!item?.summary || !Number.isInteger(item.summary.index) || !Array.isArray(item.position) || !Array.isArray(item.bounds)) {
          throw new Error('Invalid spatial tile node.');
        }
        const [x, y] = item.position;
        if (x + item.radius < left || x - item.radius > right || y + item.radius < top || y - item.radius > bottom) continue;
        const node: StreamNode = { ...item.summary, position: item.position, radius: item.radius,
          heading: item.heading, group: item.group, bounds: item.bounds, region: [] };
        if (item.childCount > 64 && item.radius * item.maxChildRatio * scale < 0.5) node.collapsedCount = item.childCount;
        if (!item.summary.isTerminal && item.radius * scale >= 24 && item.radius * scale <= 4000) {
          const span = item.summary.index === 0 || item.summary.depth === 1 ? Math.PI * 2 : Math.PI;
          node.region.push(node.position);
          for (let step = 0; step <= 32; step++) {
            const angle = item.heading - span / 2 + span * step / 32;
            node.region.push([x + item.radius * Math.cos(angle), y + item.radius * Math.sin(angle)] as Position);
          }
          node.region.push(node.position);
        }
        nodeMap.set(item.summary.index, node);
      }
      for (let at = 0; at < tile.lineTargets.length; at++) {
        const offset = at * 4, sx = tile.lines[offset], sy = tile.lines[offset + 1], tx = tile.lines[offset + 2], ty = tile.lines[offset + 3];
        if (Math.max(sx, tx) < left || Math.min(sx, tx) > right || Math.max(sy, ty) < top || Math.min(sy, ty) > bottom) continue;
        lineValues.push(sx, sy, tx, ty); lineTargets.push(tile.lineTargets[at]);
      }
    }
    const prefetchTiles: string[] = [];
    if (level < config.maxLevel) {
      const nextEntry = index.levels.find(item => item.z === level + 1);
      const nextAvailable = new Set(nextEntry?.tiles ?? []), factor = (nextEntry?.side ?? side) / side;
      for (const { key } of selected) {
        const [x, y] = key.split('/').map(Number);
        for (let childX = x * factor; childX < (x + 1) * factor; childX++) for (let childY = y * factor; childY < (y + 1) * factor; childY++) {
          const child = `${childX}/${childY}`;
          if (nextAvailable.has(child) && prefetchTiles.length < 12) {
            prefetchTiles.push(config.pattern.replace('{z}', String(level + 1)).replace('{x}', String(childX)).replace('{y}', String(childY)));
          }
        }
      }
    }
    const prefetch: PrefetchHint | undefined = prefetchTiles.length
      ? { nodes: [], fanoutPages: [], tiles: prefetchTiles }
      : level === config.maxLevel ? { nodes: [0], fanoutPages: [] } : undefined;
    return { anchor: 0, nodes: [...nodeMap.values()], lines: new Float64Array(lineValues), lineTargets: new Uint32Array(lineTargets), prefetch,
      stats: { requests: this.requests, transferredBytes: this.transferredBytes, cacheBytes: this.bytes,
        cacheEntries: this.cache.size, cacheHits: this.cacheHits, evictions: this.evictions,
        visited, queryMs: performance.now() - started, limited: false } };
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
    if (anchor === 0 && this.manifest.tiles && camera.zoom < this.manifest.tiles.baseZoom + this.manifest.tiles.maxLevel + 1) {
      return this.tileView(request, signal);
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
    const prefetchNodes = new Set<number>(), prefetchFanoutPages = new Set<number>();
    const hintNextLevel = (record: RecordNode) => {
      if (prefetchNodes.size + prefetchFanoutPages.size >= 12 || record.firstChild === NONE) return;
      if (record.fanoutRoot !== NONE) {
        prefetchFanoutPages.add(Math.floor(record.fanoutRoot / (this.manifest.indexPageSize ?? INDEX_PAGE_SIZE)));
      } else {
        prefetchNodes.add(record.firstChild);
        if (record.childCount > 1 && prefetchNodes.size + prefetchFanoutPages.size < 12) {
          prefetchNodes.add(record.firstChild + record.childCount - 1);
        }
      }
    };
    const initial = await this.node(anchor, signal);
    // Restore surrounding clades when panning beyond a local frame as well as zooming out.
    const escapesFrame = Math.max(Math.abs(left), Math.abs(right), Math.abs(top), Math.abs(bottom)) > 1000;
    if (anchor !== 0 && (camera.zoom < -1.5 || escapesFrame)) {
      let r = initial.record, factor = 1, tx = 0, ty = 0;
      let nextAnchor: number;
      // Resolve the whole outward move at once, including zero-length unnamed
      // ancestors. One frame per network round trip left large pans empty.
      do {
        tx = tx * r.ratio + r.dx * 1000; ty = ty * r.ratio + r.dy * 1000;
        factor *= r.ratio; nextAnchor = r.parent;
        const extent = Math.max(Math.abs(left * factor + tx), Math.abs(right * factor + tx),
          Math.abs(top * factor + ty), Math.abs(bottom * factor + ty));
        if (nextAnchor === 0 || (camera.zoom - Math.log2(factor) >= -1.5 && extent <= 1000)) break;
        r = (await this.node(nextAnchor, signal)).record;
      } while (nextAnchor !== 0);
      rebase = { anchor: nextAnchor, x: -tx / factor, y: -ty / factor, radius: 1000 / factor };
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
      if (!rebase && camera.zoom > 14 && p.index !== anchor && p.radius < 1 && p.radius * scale > Math.max(size.width, size.height) * 2 &&
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
      if (record.firstChild === NONE) continue;
      if (p.radius * record.maxChildRatio * scale < 0.5) { hintNextLevel(record); continue; }
      const children = await this.children(record,
        [(left - p.x) / p.radius, (top - p.y) / p.radius, (right - p.x) / p.radius, (bottom - p.y) / p.radius],
        0.5 / (p.radius * scale), Math.max(0, 12000 - visited - pending.length), signal);
      limited ||= children.limited;
      const missing = children.indices.filter(child => !child.item).map(child => child.index);
      const loaded = missing.length ? await this.nodes(missing, signal)
        : new Map<number, { summary: Summary; record: RecordNode }>();
      for (const child of children.indices) {
        const item = child.item ?? loaded.get(child.index)!; const r = item.record;
        pending.push({ index: child.index, item, x: p.x + r.dx * p.radius, y: p.y + r.dy * p.radius,
          radius: p.radius * r.ratio, px: p.x, py: p.y, incoming: true });
      }
    }
    const prefetch = prefetchNodes.size || prefetchFanoutPages.size
      ? { nodes: [...prefetchNodes], fanoutPages: [...prefetchFanoutPages] } : undefined;
    return { anchor, nodes, lines: new Float64Array(lineValues), lineTargets: new Uint32Array(targets), rebase, prefetch,
      stats: { requests: this.requests, transferredBytes: this.transferredBytes, cacheBytes: this.bytes,
        cacheEntries: this.cache.size, cacheHits: this.cacheHits, evictions: this.evictions,
        visited, queryMs: performance.now() - started, limited: limited || pending.length > 0 } };
  }
}
