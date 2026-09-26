import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from './build-tree.ts';
import type { Provenance } from '../src/stream/format.ts';

export function releaseGraph(): Graph {
  const provenance = JSON.parse(readFileSync('data/processed/opentree/life/provenance.json', 'utf8')) as Provenance & {
    artifactHashes: Record<string, string>;
  };
  const buffers = ['parents.i32', 'labels.u32', 'labels.utf8'].map(name => {
    const b = readFileSync(join(provenance.snapshotPath, name));
    if (createHash('sha256').update(b).digest('hex') !== provenance.artifactHashes[name]) throw new Error(`Release artifact changed: ${name}`);
    return b;
  });
  const [parentBytes, offsetBytes, labels] = buffers;
  const parents = new Int32Array(parentBytes.buffer, parentBytes.byteOffset, parentBytes.byteLength / 4);
  const offsets = new Uint32Array(offsetBytes.buffer, offsetBytes.byteOffset, offsetBytes.byteLength / 4);
  const label = (i: number) => labels.toString('utf8', offsets[i * 2], offsets[i * 2] + offsets[i * 2 + 1]);
  const id = (text: string) => { const match = /[_ ]ott(\d+)$/.exec(text); return match ? `ott${match[1]}` : text; };
  return { parents, title: 'Tree of Life', source: `Open Tree of Life — ${provenance.synthId}`, synthetic: false,
    provenance, presentation: 'life', metadata: i => {
      const sourceLabel = label(i), match = /^(.*)[_ ]ott(\d+)$/.exec(sourceLabel);
      return { id: id(sourceLabel), parentId: parents[i] < 0 ? null : id(label(parents[i])), sourceLabel,
        scientificName: match ? match[1].replaceAll('_', ' ') : 'Unnamed clade',
        ottId: match ? Number(match[2]) : null, isSyntheticNode: !match };
    } };
}
