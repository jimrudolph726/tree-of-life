import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'public/data/life';
if (!existsSync(join(root, 'manifest.json'))) {
  throw new Error('The complete tree has not been prepared. Install pipeline/requirements.txt, then run npm run data:life once.');
}
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const source = JSON.parse(readFileSync('data/processed/opentree/life/provenance.json', 'utf8'));
if (manifest.nodeCount !== source.counts.nodes || JSON.stringify(manifest.provenance) !== JSON.stringify(source)) {
  throw new Error('The full-tree publication is stale. Run npm run data:life:build.');
}
for (const file of ['manifest.json', 'overview.json', 'pages/0.bin', 'search-top.json']) {
  if (!existsSync(join(root, manifest.version, file))) throw new Error(`Incomplete publication: ${file}. Run npm run data:life:build.`);
}
