import { mkdirSync, writeFileSync } from 'node:fs';
import { buildDataset } from './build-tree.ts';
import { releaseGraph } from './release-graph.ts';

console.log('Building complete OpenTree publication…');
const result = buildDataset(releaseGraph(), 'public/data/life');
mkdirSync('benchmarks/results', { recursive: true });
writeFileSync('benchmarks/results/life-build.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ version: result.manifest.version, nodes: result.manifest.nodeCount,
  tips: result.manifest.leafCount, maxChildren: result.manifest.maxChildren, maxDepth: result.manifest.maxDepth,
  buildMs: result.buildMs, diskBytes: result.diskBytes, peakRssMB: result.peakRssMB }));
