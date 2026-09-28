import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const root = 'public/data/profiles';
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('scientific profiles are complete, correctly routed, and within the payload budget', () => {
  const published = readFileSync(join(root, manifest.version, 'manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(published), manifest);
  assert.equal(manifest.profileCount, 1000);
  assert.equal(manifest.shardCount, 64);
  assert.ok(manifest.maxCompressedShardBytes <= 24 * 1024);
  assert.equal(manifest.searchFile, 'search.json');
  assert.ok(manifest.compressedSearchBytes <= 64 * 1024);
  const searchRaw = readFileSync(join(root, manifest.version, manifest.searchFile));
  assert.ok(gzipSync(searchRaw, { level: 9 }).byteLength <= manifest.compressedSearchBytes);
  const search = JSON.parse(searchRaw.toString('utf8'));
  assert.equal(search.profiles.length, manifest.profileCount);

  const profiles: Record<string, unknown>[] = [];
  let compressedTotal = 0;
  let compressedMaximum = 0;
  for (let shard = 0; shard < manifest.shardCount; shard++) {
    const raw = readFileSync(join(root, manifest.version, 'shards', `${String(shard).padStart(2, '0')}.json`));
    const compressed = gzipSync(raw, { level: 9 }).byteLength;
    compressedTotal += compressed;
    compressedMaximum = Math.max(compressedMaximum, compressed);
    const value = JSON.parse(raw.toString('utf8'));
    assert.ok(Array.isArray(value.profiles));
    for (const profile of value.profiles) {
      assert.equal(profile.ottId % manifest.shardCount, shard);
      assert.equal(typeof profile.scientificName, 'string');
      assert.ok(profile.commonNames.length <= 6);
      assert.ok(profile.synonyms.length <= 8);
      if (profile.wikipedia) {
        assert.match(profile.wikipedia.url, /^https:\/\/en\.wikipedia\.org\/wiki\//);
        assert.match(profile.wikipedia.wikidataId, /^Q\d+$/);
        assert.ok(Number.isInteger(profile.wikipedia.revisionId));
        assert.ok(profile.wikipedia.extract.length > 20);
      }
      profiles.push(profile);
    }
  }
  assert.equal(profiles.length, 1000);
  assert.equal(new Set(profiles.map(profile => profile.ottId)).size, 1000);
  assert.ok(compressedMaximum <= 24 * 1024);
  assert.ok(compressedTotal <= 256 * 1024);
  assert.ok(manifest.compressedPublicationBytes <= 256 * 1024);
  const names = new Set(profiles.map(profile => profile.scientificName));
  for (const required of ['Eukaryota', 'Archaea', 'Bacteria', 'Fungi', 'Opisthokonta', 'Bilateria',
    'Primates', 'Aves', 'Homo sapiens', 'Camarhynchus psittacula']) assert.ok(names.has(required), required);
});

test('profile provenance matches the normalized source snapshot', () => {
  const snapshot = readFileSync('data/processed/profiles/source-snapshot.json');
  assert.equal(createHash('sha256').update(snapshot).digest('hex'), manifest.sourceSnapshotSha256);
  assert.equal(manifest.openTree.synthId, 'opentree16.1');
  assert.equal(manifest.openTree.taxonomyVersion, '3.7draft3');
  assert.equal(manifest.coverage.profiles, 1000);
  assert.ok(manifest.coverage.descriptions >= 900);
  assert.ok(manifest.coverage.commonNames >= 800);
  assert.equal(manifest.coverage.primates, 400);
  assert.equal(manifest.coverage.aves, 505);
  assert.equal(manifest.coverage.essential, 95);
});
