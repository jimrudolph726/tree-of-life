import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
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

const profileRoot = 'public/data/profiles';
const profilePointer = join(profileRoot, 'manifest.json');
if (!existsSync(profilePointer)) throw new Error('Scientific profiles have not been prepared. Run npm run data:profiles.');
const profiles = JSON.parse(readFileSync(profilePointer, 'utf8'));
if (profiles.format !== 3 || !/^[a-f0-9]{16}$/.test(profiles.version) || profiles.profileCount !== 50000 ||
    profiles.shardCount !== 256 || profiles.maxCompressedShardBytes > 64 * 1024 ||
    profiles.compressedPublicationBytes > 16 * 1024 * 1024 ||
    profiles.searchFile !== 'search.json' || profiles.compressedSearchBytes > 2 * 1024 * 1024 ||
    profiles.crosswalkFile !== 'crosswalk.json' || profiles.crosswalkCount !== 50000 ||
    profiles.compressedCrosswalkBytes > 1024 * 1024) {
  throw new Error('Invalid scientific-profile publication. Run npm run data:profiles.');
}
const searchPath = join(profileRoot, profiles.version, profiles.searchFile);
if (!existsSync(searchPath) || gzipSync(readFileSync(searchPath), { level: 9 }).byteLength > profiles.compressedSearchBytes) {
  throw new Error('Scientific-profile search index is missing or exceeds its published budget.');
}
const crosswalkPath = join(profileRoot, profiles.version, profiles.crosswalkFile);
if (!existsSync(crosswalkPath) || gzipSync(readFileSync(crosswalkPath), { level: 9 }).byteLength > profiles.compressedCrosswalkBytes) {
  throw new Error('Scientific identity crosswalk is missing or exceeds its published budget.');
}
const profileManifest = join(profileRoot, profiles.version, 'manifest.json');
if (!existsSync(profileManifest) || readFileSync(profileManifest, 'utf8') !== readFileSync(profilePointer, 'utf8')) {
  throw new Error('Scientific-profile pointer does not match its immutable version.');
}
let counted = 0;
let maxCompressed = 0;
for (let shard = 0; shard < profiles.shardCount; shard++) {
  const path = join(profileRoot, profiles.version, 'shards', `${String(shard).padStart(2, '0')}.json`);
  if (!existsSync(path)) throw new Error(`Missing scientific-profile shard ${shard}.`);
  const raw = readFileSync(path);
  maxCompressed = Math.max(maxCompressed, gzipSync(raw, { level: 9, mtime: 0 }).byteLength);
  const value = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(value.profiles) || value.profiles.some(profile => profile.ottId % profiles.shardCount !== shard)) {
    throw new Error(`Invalid scientific-profile shard ${shard}.`);
  }
  counted += value.profiles.length;
}
if (counted !== profiles.profileCount || maxCompressed > 64 * 1024) {
  throw new Error('Scientific-profile counts or compressed payload budget do not match the manifest.');
}

const journeyRoot = 'public/data/journeys';
const journeyPointer = join(journeyRoot, 'manifest.json');
if (!existsSync(journeyPointer)) throw new Error('Journeys have not been prepared. Run npm run data:journeys.');
const journeys = JSON.parse(readFileSync(journeyPointer, 'utf8'));
if (journeys.format !== 1 || !/^[a-f0-9]{16}$/.test(journeys.version) || journeys.journeyCount < 3 ||
    journeys.maxCompressedJourneyBytes > 20 * 1024 || journeys.compressedCatalogBytes > 8 * 1024) {
  throw new Error('Invalid Journey publication. Run npm run data:journeys.');
}
const journeyVersion = join(journeyRoot, journeys.version);
if (readFileSync(join(journeyVersion, 'manifest.json'), 'utf8') !== readFileSync(journeyPointer, 'utf8')) {
  throw new Error('Journey pointer does not match its immutable version.');
}
const catalog = JSON.parse(readFileSync(join(journeyVersion, journeys.catalogFile), 'utf8'));
if (!Array.isArray(catalog.journeys) || catalog.journeys.length !== journeys.journeyCount) {
  throw new Error('The Journey catalog is incomplete.');
}
for (const item of catalog.journeys) {
  const path = join(journeyVersion, journeys.journeyPattern.replace('{id}', item.id));
  if (!existsSync(path) || gzipSync(readFileSync(path), { level: 9 }).byteLength > 20 * 1024) {
    throw new Error(`Journey ${item.id} is missing or exceeds its payload budget.`);
  }
}
