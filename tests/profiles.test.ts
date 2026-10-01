import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { searchProfiles } from '../src/profiles/search.ts';
import { profileContentCache } from '../src/profiles/client.ts';

const root = 'public/data/profiles';
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('scientific profiles are complete, correctly routed, and within the payload budget', () => {
  const published = readFileSync(join(root, manifest.version, 'manifest.json'), 'utf8');
  assert.deepEqual(JSON.parse(published), manifest);
  assert.equal(manifest.profileCount, 50000);
  assert.equal(manifest.format, 3);
  assert.equal(manifest.shardCount, 256);
  assert.ok(manifest.maxCompressedShardBytes <= 64 * 1024);
  assert.ok(manifest.compressedPublicationBytes <= 16 * 1024 * 1024);
  assert.equal(manifest.searchFile, 'search.json');
  assert.ok(manifest.compressedSearchBytes <= 2 * 1024 * 1024);
  const searchRaw = readFileSync(join(root, manifest.version, manifest.searchFile));
  assert.ok(gzipSync(searchRaw, { level: 9 }).byteLength <= manifest.compressedSearchBytes);
  const search = JSON.parse(searchRaw.toString('utf8'));
  assert.equal(search.profiles.length, manifest.profileCount);
  assert.equal(manifest.crosswalkFile, 'crosswalk.json');
  assert.equal(manifest.crosswalkCount, manifest.profileCount);
  const crosswalkRaw = readFileSync(join(root, manifest.version, manifest.crosswalkFile));
  assert.ok(gzipSync(crosswalkRaw, { level: 9 }).byteLength <= 1024 * 1024);
  const crosswalk = JSON.parse(crosswalkRaw.toString('utf8'));
  assert.equal(crosswalk.format, 1);
  assert.deepEqual(crosswalk.fields, ['ottId', 'gbifUsageKey', 'wikidataItemId', 'wikipediaTitle']);
  assert.equal(crosswalk.records.length, manifest.profileCount);
  assert.equal(new Set(crosswalk.records.map((record: unknown[]) => record[0])).size, manifest.profileCount);
  assert.equal(manifest.identityCoverage.openTree, 50000);
  assert.equal(manifest.identityCoverage.gbifIdentifierCollisions, 0);

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
      if (profile.wikidata) {
        assert.match(profile.wikidata.itemId, /^Q\d+$/);
        assert.match(profile.wikidata.articleUrl, /^https:\/\/en\.wikipedia\.org\/wiki\//);
      }
      if (profile.conservation) {
        assert.match(profile.conservation.code, /^(EX|EW|CR|EN|VU|NT|LC|DD)$/);
        assert.equal(profile.conservation.system, 'IUCN Red List');
        assert.match(profile.conservation.source.url, /^https:\/\/api\.gbif\.org\//);
      }
      if (profile.image) {
        assert.match(profile.image.src, /^images\//);
        assert.match(profile.image.sourceUrl, /^https:\/\//);
        assert.ok(readFileSync(join('public', profile.image.src)).byteLength <= 512 * 1024);
      }
      for (const fact of profile.facts ?? []) {
        assert.ok(['status', 'age', 'trait', 'habitat', 'range'].includes(fact.kind));
        assert.ok(fact.value.length > 0);
        assert.match(fact.source.url, /^https:\/\//);
      }
      profiles.push(profile);
    }
  }
  assert.equal(profiles.length, 50000);
  assert.equal(new Set(profiles.map(profile => profile.ottId)).size, 50000);
  assert.ok(compressedMaximum <= 64 * 1024);
  assert.ok(compressedTotal <= 16 * 1024 * 1024);
  const names = new Set(profiles.map(profile => profile.scientificName));
  for (const required of ['Eukaryota', 'Archaea', 'Bacteria', 'Fungi', 'Opisthokonta', 'Bilateria',
    'Primates', 'Aves', 'Homo sapiens', 'Camarhynchus psittacula']) assert.ok(names.has(required), required);
});

test('profile provenance matches the normalized source snapshot', () => {
  const snapshot = readFileSync('data/processed/profiles/source-snapshot.json');
  assert.equal(createHash('sha256').update(snapshot).digest('hex'), manifest.sourceSnapshotSha256);
  assert.equal(manifest.openTree.synthId, 'opentree16.1');
  assert.equal(manifest.openTree.taxonomyVersion, '3.7draft3');
  assert.equal(manifest.coverage.profiles, 50000);
  assert.ok(manifest.coverage.enriched >= 9990);
  assert.equal(manifest.coverage.externallyEnriched, 10000);
  assert.equal(manifest.coverage.openTreeOnly, 40000);
  assert.equal(manifest.coverage.treeWideClades, 24000);
  assert.equal(manifest.coverage.treeWideTerminals, 16000);
  assert.ok(manifest.coverage.descriptions >= 900);
  assert.ok(manifest.coverage.commonNames >= 1000);
  assert.ok(manifest.coverage.fieldNotes >= 15);
  assert.ok(manifest.coverage.media >= 15);
  assert.equal(manifest.coverage.primates, 400);
  assert.equal(manifest.coverage.aves, 505);
  assert.equal(manifest.coverage.essential, 95);
});

test('profile search tolerates punctuation and small spelling errors while preserving provenance kinds', () => {
  const records = [
    [770315, 'Homo sapiens', 'species', ['human'], ['Homo sapiens sapiens']],
    [81461, 'Aves', 'class', ['birds'], []],
  ] as Parameters<typeof searchProfiles>[0];
  assert.equal(searchProfiles(records, 'homo-sapiens')[0]?.scientificName, 'Homo sapiens');
  assert.equal(searchProfiles(records, 'humna')[0]?.matchedName, 'human');
  assert.equal(searchProfiles(records, 'brids')[0]?.scientificName, 'Aves');
});

test('local profile publications bypass stale browser caches while deployed versions remain immutable', () => {
  assert.equal(profileContentCache('http://localhost:5173/data/profiles/manifest.json'), 'reload');
  assert.equal(profileContentCache('http://127.0.0.1:5173/data/profiles/manifest.json'), 'reload');
  assert.equal(profileContentCache('https://dgilsep5ai167.cloudfront.net/data/profiles/manifest.json'), 'force-cache');
});
