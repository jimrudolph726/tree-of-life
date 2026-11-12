import { mkdirSync, writeFileSync } from 'node:fs';
import type { Hash } from 'node:crypto';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { NONE, RECORD_BYTES } from '../src/stream/format.ts';
import type { SpatialTile, SpatialTileIndex, SpatialTileManifest, SpatialTileNode, Summary } from '../src/stream/format.ts';

const WORLD_BOUNDS: [number, number, number, number] = [-1024, -1024, 1024, 1024];
const BASE_ZOOM = 0;
const MAX_LEVEL = 8;
const PARTITION_OFFSET = 2;
const MIN_NODE_PIXELS = 3;
const MIN_LINE_PIXELS = 0.7;
const MAX_COMPRESSED_TILE_BYTES = 256 * 1024;
const DEPLOY_GZIP_LEVEL = 6;

interface MutableTile { nodes: SpatialTileNode[]; lines: number[]; lineTargets: number[] }

function cell(value: number, minimum: number, width: number, side: number) {
  return Math.max(0, Math.min(side - 1, Math.floor((value - minimum) / width)));
}

/** Split a branch at grid boundaries. Each tile receives only its own segment,
 * so long high-level branches do not get duplicated into large tile rectangles.
 */
function lineCells(sx: number, sy: number, tx: number, ty: number, width: number, side: number) {
  const times = [0, 1];
  const dx = tx - sx, dy = ty - sy;
  if (dx) {
    const from = Math.floor((Math.min(sx, tx) - WORLD_BOUNDS[0]) / width) + 1;
    const to = Math.floor((Math.max(sx, tx) - WORLD_BOUNDS[0]) / width);
    for (let boundary = from; boundary <= to; boundary++) {
      const t = (WORLD_BOUNDS[0] + boundary * width - sx) / dx;
      if (t > 0 && t < 1) times.push(t);
    }
  }
  if (dy) {
    const from = Math.floor((Math.min(sy, ty) - WORLD_BOUNDS[1]) / width) + 1;
    const to = Math.floor((Math.max(sy, ty) - WORLD_BOUNDS[1]) / width);
    for (let boundary = from; boundary <= to; boundary++) {
      const t = (WORLD_BOUNDS[1] + boundary * width - sy) / dy;
      if (t > 0 && t < 1) times.push(t);
    }
  }
  times.sort((a, b) => a - b);
  const segments: { x: number; y: number; values: [number, number, number, number] }[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i], b = times[i + 1];
    if (b - a < 1e-12) continue;
    const mid = (a + b) / 2;
    segments.push({
      x: cell(sx + dx * mid, WORLD_BOUNDS[0], width, side),
      y: cell(sy + dy * mid, WORLD_BOUNDS[1], width, side),
      values: [sx + dx * a, sy + dy * a, sx + dx * b, sy + dy * b],
    });
  }
  return segments;
}

export function writeSpatialTiles(data: DataView, count: number, summary: (index: number) => Summary,
  folder: string, hash: Hash) {
  console.log('Calculating root-frame spatial coordinates…');
  const xs = new Float64Array(count), ys = new Float64Array(count), radii = new Float64Array(count);
  radii[0] = 1000;
  for (let index = 1; index < count; index++) {
    const offset = index * RECORD_BYTES, parent = data.getUint32(offset, true);
    if (parent === NONE || parent >= index) throw new Error('Spatial tiles require breadth-first parent ordering.');
    xs[index] = xs[parent] + data.getFloat64(offset + 24, true) * radii[parent];
    ys[index] = ys[parent] + data.getFloat64(offset + 32, true) * radii[parent];
    radii[index] = radii[parent] * data.getFloat64(offset + 40, true);
  }
  mkdirSync(join(folder, 'tiles'), { recursive: true });
  const levels: SpatialTileIndex['levels'] = [];
  let bytes = 0, compressedBytes = 0, maxCompressedTileBytes = 0, tileCount = 0;
  for (let z = 0; z <= MAX_LEVEL; z++) {
    const scale = 2 ** (BASE_ZOOM + z), side = 2 ** Math.max(0, z - PARTITION_OFFSET);
    const width = (WORLD_BOUNDS[2] - WORLD_BOUNDS[0]) / side;
    const tiles = new Map<string, MutableTile>();
    const get = (x: number, y: number) => {
      const key = `${x}/${y}`;
      let tile = tiles.get(key);
      if (!tile) { tile = { nodes: [], lines: [], lineTargets: [] }; tiles.set(key, tile); }
      return tile;
    };
    for (let index = 0; index < count; index++) {
      const offset = index * RECORD_BYTES, radius = radii[index];
      const item = summary(index);
      if (!item.isSyntheticNode && radius * scale >= MIN_NODE_PIXELS) {
        const x = cell(xs[index], WORLD_BOUNDS[0], width, side);
        const y = cell(ys[index], WORLD_BOUNDS[1], width, side);
        get(x, y).nodes.push({
          summary: item, position: [xs[index], ys[index]], radius,
          heading: data.getFloat64(offset + 48, true), group: data.getUint32(offset + 84, true),
          bounds: [56, 60, 64, 68].map((at, dimension) =>
            (dimension % 2 ? ys[index] : xs[index]) + data.getFloat32(offset + at, true) * radius) as SpatialTileNode['bounds'],
          childCount: data.getUint32(offset + 72, true), maxChildRatio: data.getFloat32(offset + 76, true),
        });
      }
      if (!index) continue;
      const parent = data.getUint32(offset, true), length = Math.hypot(xs[index] - xs[parent], ys[index] - ys[parent]);
      // Match the live traversal's resolution stop: a branch is unreachable
      // once its target subtree projects below half a pixel, even if a very
      // elongated local edge would otherwise be measurable.
      if (radius * scale < 0.5 || length * scale < MIN_LINE_PIXELS) continue;
      for (const segment of lineCells(xs[parent], ys[parent], xs[index], ys[index], width, side)) {
        const tile = get(segment.x, segment.y);
        tile.lines.push(...segment.values); tile.lineTargets.push(index);
      }
    }
    const keys = [...tiles.keys()].sort((a, b) => {
      const [ax, ay] = a.split('/').map(Number), [bx, by] = b.split('/').map(Number);
      return ax - bx || ay - by;
    });
    for (const key of keys) {
      const [x] = key.split('/');
      const directory = join(folder, 'tiles', String(z), x); mkdirSync(directory, { recursive: true });
      const path = `tiles/${z}/${key}.json`, value: SpatialTile = tiles.get(key)!;
      const text = JSON.stringify(value), compressed = gzipSync(text, { level: DEPLOY_GZIP_LEVEL }).byteLength;
      if (compressed > MAX_COMPRESSED_TILE_BYTES) {
        throw new Error(`${path} is ${compressed.toLocaleString()} compressed bytes; spatial tile budget is ${MAX_COMPRESSED_TILE_BYTES.toLocaleString()}.`);
      }
      hash.update(path).update(text); writeFileSync(join(folder, path), text);
      bytes += Buffer.byteLength(text); compressedBytes += compressed;
      maxCompressedTileBytes = Math.max(maxCompressedTileBytes, compressed); tileCount++;
    }
    levels.push({ z, side, tiles: keys });
    console.log(`Spatial tiles z${z}: ${keys.length.toLocaleString()} files`);
  }
  const index: SpatialTileIndex = { format: 1, levels };
  const indexText = JSON.stringify(index), indexCompressed = gzipSync(indexText, { level: DEPLOY_GZIP_LEVEL }).byteLength;
  hash.update('tiles/index.json').update(indexText); writeFileSync(join(folder, 'tiles', 'index.json'), indexText);
  bytes += Buffer.byteLength(indexText); compressedBytes += indexCompressed;
  const manifest: SpatialTileManifest = {
    format: 1, indexFile: 'tiles/index.json', pattern: 'tiles/{z}/{x}/{y}.json', worldBounds: WORLD_BOUNDS,
    baseZoom: BASE_ZOOM, maxLevel: MAX_LEVEL, tileCount, compressedBytes,
    maxCompressedTileBytes: Math.max(maxCompressedTileBytes, indexCompressed),
  };
  console.log(`Spatial tile publication: ${tileCount.toLocaleString()} files, ${(compressedBytes / 1048576).toFixed(1)} MiB compressed`);
  return { manifest, bytes };
}
