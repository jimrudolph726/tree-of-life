import type { MapTreeNode } from '../tree/layoutTreeV3.ts';
import type { TreeNodeInput } from '../tree/types.ts';
import type { Camera, Size } from '../tree/navigation.ts';

export const FORMAT_VERSION = 2;
export const RECORD_BYTES = 88;
export const INDEX_PAGE_SIZE = 256;
export const PAGE_SIZE = 512;
export const NONE = 0xffffffff;
export const MAGIC = 0x544f4c31;
export type Summary = TreeNodeInput & { index: number; depth: number; leafCount: number };
export type StreamNode = MapTreeNode & { index: number; collapsedCount?: number; group?: number };
export interface Provenance {
  provider: string; sourceUrl: string; synthId: string; taxonomyVersion: string;
  synthesisCreated: string; rootOttId: number; title: string; fetchedAt: string;
  snapshotPath: string; newickSha256: string; nodesSha256: string; supportingStudies: string[];
}
// Spatial routing only: these entries are never part of scientific ancestry.
export interface FanoutEntry {
  bounds: [number, number, number, number]; maxRadius: number;
  start: number; count: number; left: number; right: number;
  indices?: number[];
  circles?: [number, number, number][];
  nodes?: { summary: Summary; record: RecordNode }[];
}
export interface AncestorEntry { summary: Summary; parent: number; dx: number; dy: number; ratio: number }
export interface ChildPreview { index: number; children: Summary[]; truncated: boolean }
export interface Manifest {
  format: number;
  version: string;
  title: string;
  source: string;
  synthetic: boolean;
  nodeCount: number;
  namedCount: number;
  leafCount: number;
  pageSize: number;
  pageCount: number;
  root: Summary;
  rootBounds: [number, number, number, number];
  maxDepth: number;
  builtAt: string;
  provenance?: Provenance;
  maxChildren?: number;
  fanoutEntries?: number;
  ancestryPages?: boolean;
  detailPages?: boolean;
  presentation?: 'life';
  overview?: { file: string; maxScale: number };
  searchDirectory?: string;
  indexPageSize?: number;
}
export const cacheBudget = (manifest: Manifest) => (manifest.presentation === 'life' ? 64 : 24) * 1024 * 1024;
export interface RecordNode {
  parent: number; firstChild: number; nextSibling: number; leafCount: number;
  depth: number; flags: number; dx: number; dy: number; ratio: number; heading: number;
  bounds: [number, number, number, number]; childCount: number; maxChildRatio: number; fanoutRoot: number;
  group: number;
}
export interface Page { records: DataView; names: TreeNodeInput[]; count: number; bytes: number }
export interface SearchBlock { first: string; last: string; file: string }
export type SearchEntry = [key: string, index: number];
export interface ViewRequest { anchor: number; camera: Camera; size: Size }
export interface StreamStats {
  requests: number; transferredBytes: number; cacheBytes: number; cacheEntries: number;
  cacheHits: number; evictions: number; visited: number; queryMs: number; limited: boolean;
}
export interface Scene {
  anchor: number; nodes: StreamNode[];
  // source XY, target XY: prepacked attributes, transferred from the worker.
  lines: Float64Array; lineTargets: Uint32Array;
  stats: StreamStats;
  rebase?: { anchor: number; x: number; y: number; radius: number };
}
export interface Details { node: Summary; lineage: Summary[]; children: Summary[]; childrenTruncated: boolean; anchor: number; focus: StreamNode }

export function encodePage(records: ArrayBuffer, names: TreeNodeInput[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(names));
  const output = new Uint8Array(16 + records.byteLength + json.byteLength);
  const header = new DataView(output.buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, names.length, true);
  header.setUint32(8, records.byteLength, true);
  header.setUint32(12, json.byteLength, true);
  output.set(new Uint8Array(records), 16);
  output.set(json, 16 + records.byteLength);
  return output;
}

export function decodePage(buffer: ArrayBuffer): Page {
  if (buffer.byteLength < 16) throw new Error('Truncated tree page.');
  const header = new DataView(buffer);
  const count = header.getUint32(4, true);
  const recordBytes = header.getUint32(8, true);
  const jsonBytes = header.getUint32(12, true);
  if (header.getUint32(0, true) !== MAGIC || count === 0 || count > PAGE_SIZE ||
      (recordBytes !== count * RECORD_BYTES && recordBytes !== count * 80) || buffer.byteLength !== 16 + recordBytes + jsonBytes) {
    throw new Error('Invalid tree page header.');
  }
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16 + recordBytes, jsonBytes)));
  if (!Array.isArray(names) || names.length !== count || names.some(n => !n || typeof n.id !== 'string' || typeof n.scientificName !== 'string')) {
    throw new Error('Invalid tree page metadata.');
  }
  return { records: new DataView(buffer, 16, recordBytes), names, count, bytes: buffer.byteLength };
}

export function readRecord(page: Page, offset: number): RecordNode {
  if (offset < 0 || offset >= page.count) throw new Error('Node is outside its page.');
  const v = page.records;
  const stride = page.records.byteLength / page.count;
  const b = offset * stride;
  return {
    parent: v.getUint32(b, true), firstChild: v.getUint32(b + 4, true), nextSibling: v.getUint32(b + 8, true),
    leafCount: v.getUint32(b + 12, true), depth: v.getUint32(b + 16, true), flags: v.getUint32(b + 20, true),
    dx: v.getFloat64(b + 24, true), dy: v.getFloat64(b + 32, true), ratio: v.getFloat64(b + 40, true),
    heading: v.getFloat64(b + 48, true),
    bounds: [v.getFloat32(b + 56, true), v.getFloat32(b + 60, true), v.getFloat32(b + 64, true), v.getFloat32(b + 68, true)],
    childCount: v.getUint32(b + 72, true), maxChildRatio: v.getFloat32(b + 76, true),
    fanoutRoot: stride >= 88 ? v.getUint32(b + 80, true) : NONE,
    group: stride >= 88 ? v.getUint32(b + 84, true) : 0,
  };
}

export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (!m || ![1, FORMAT_VERSION].includes(m.format) || m.pageSize !== PAGE_SIZE || !Number.isInteger(m.nodeCount) || m.nodeCount < 1 ||
      m.pageCount !== Math.ceil(m.nodeCount / PAGE_SIZE) || !/^[a-f0-9]{16}$/.test(m.version) ||
      !m.root || m.root.index !== 0 || !Array.isArray(m.rootBounds) || m.rootBounds.length !== 4 || !m.rootBounds.every(Number.isFinite) ||
      m.rootBounds[0] > m.rootBounds[2] || m.rootBounds[1] > m.rootBounds[3]) {
    throw new Error('Unsupported or invalid tree manifest. Rebuild the dataset.');
  }
  return m;
}
