import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hash } from 'node:crypto';
import type { SearchBlock, SearchEntry } from '../src/stream/format.ts';

/** Spill search entries to prefix buckets; only one bucket is sorted in memory.
 * Prefixes are prefix-free, preserving global lexical order across buckets.
 */
export class SearchWriter {
  private buckets = new Map<string, { path: string; pending: SearchEntry[] }>();
  private pending = 0;
  private folder: string;
  constructor(folder: string) { this.folder = folder; mkdirSync(join(folder, 'sort')); }
  add(entry: SearchEntry) {
    const key = entry[0].slice(0, entry[0].startsWith('ot') ? 6 : /^\d/.test(entry[0]) ? 3 : 2);
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = { path: join(this.folder, 'sort', `${this.buckets.size}.jsonl`), pending: [] }; this.buckets.set(key, bucket); }
    bucket.pending.push(entry);
    if (++this.pending >= 50000) this.flush();
  }
  private flush() {
    for (const bucket of this.buckets.values()) {
      if (bucket.pending.length) appendFileSync(bucket.path, bucket.pending.map(r => JSON.stringify(r)).join('\n') + '\n');
      bucket.pending = [];
    }
    this.pending = 0;
  }
  finish(hash: Hash): { blocks: SearchBlock[]; bytes: number } {
    this.flush();
    const blocks: SearchBlock[] = []; let bytes = 0;
    let part: SearchEntry[] = [];
    const publish = () => {
      const file = `search/${blocks.length}.json`, text = JSON.stringify(part);
      hash.update(text); bytes += Buffer.byteLength(text); writeFileSync(join(this.folder, file), text);
      blocks.push({ first: part[0][0], last: part.at(-1)![0], file }); part = [];
    };
    // Shorter prefixes contain only complete terms and sort before extensions.
    for (const [, bucket] of [...this.buckets].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
      const rows: SearchEntry[] = readFileSync(bucket.path, 'utf8').trimEnd().split('\n').map(s => JSON.parse(s));
      rows.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]);
      for (const row of rows) { part.push(row); if (part.length === 1024) publish(); }
    }
    if (part.length) publish();
    return { blocks, bytes };
  }
}
