import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { validateJourney, validateJourneyCatalog, validateJourneyManifest } from '../src/journeys/types.ts';
import { searchProfiles } from '../src/profiles/search.ts';
import type { ProfileSearchRecord } from '../src/profiles/types.ts';

const records: ProfileSearchRecord[] = [
  [153563, 'Gallus gallus', 'species', ['Red junglefowl'], ['Gallus domesticus']],
  [81461, 'Aves', 'class', ['Birds'], []],
  [463546, 'Aepyornis', 'genus', ['Elephant Bird'], []],
  [999001, 'Birdantis bloetei', null, [], []],
];

test('scientific discovery ranks common names, synonyms, and scientific names', () => {
  assert.deepEqual(searchProfiles(records, 'red jungle')[0], {
    ottId: 153563, scientificName: 'Gallus gallus', rank: 'species', commonName: 'Red junglefowl',
    matchedName: 'Red junglefowl', matchKind: 'common name',
  });
  assert.equal(searchProfiles(records, 'domesticus')[0].matchKind, 'synonym');
  assert.equal(searchProfiles(records, 'gallus')[0].matchKind, 'scientific name');
  assert.equal(searchProfiles(records, 'birds')[0].scientificName, 'Aves');
  assert.deepEqual(searchProfiles(records, 'bird').slice(0, 2).map(item => item.scientificName), ['Aves', 'Aepyornis']);
  assert.deepEqual(searchProfiles(records, 'no match'), []);
});

test('the versioned Journey library is complete, sourced, licensed, and within its lazy payload budget', () => {
  const root = join(process.cwd(), 'public', 'data', 'journeys');
  const manifest = validateJourneyManifest(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')));
  assert.equal(manifest.journeyCount, 3);
  assert.ok(manifest.compressedCatalogBytes <= 8 * 1024);
  assert.ok(manifest.maxCompressedJourneyBytes <= 20 * 1024);
  const folder = join(root, manifest.version);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')), manifest);
  const catalogRaw = readFileSync(join(folder, manifest.catalogFile));
  assert.ok(gzipSync(catalogRaw, { level: 9 }).byteLength <= 8 * 1024);
  const catalog = validateJourneyCatalog(JSON.parse(catalogRaw.toString('utf8')));
  assert.deepEqual(new Set(catalog.map(item => item.category)), new Set(['Flight', 'Vision', 'Bipedalism']));
  for (const summary of catalog) {
    const raw = readFileSync(join(folder, manifest.journeyPattern.replace('{id}', summary.id)));
    assert.ok(gzipSync(raw, { level: 9 }).byteLength <= 20 * 1024);
    const journey = validateJourney(JSON.parse(raw.toString('utf8')));
    assert.equal(journey.id, summary.id);
    assert.equal(journey.steps.length, summary.stepCount);
    assert.equal(journey.steps.at(-1)?.kind, 'living lineage');
    for (const step of journey.steps) {
      assert.ok(step.summary.length >= 80, step.title);
      assert.ok(step.evidence.length >= 60, step.title);
      assert.ok(step.uncertainty.length >= 40, step.title);
      assert.ok(existsSync(join(process.cwd(), 'public', step.image.src)), `${step.title} image is published`);
      assert.ok(step.image.alt.length >= 30 && step.image.caption.length >= 40, `${step.title} image is described`);
      assert.match(step.image.sourceUrl, /^https:\/\//);
      assert.match(step.image.license, /^(Public domain|CC0|CC BY)/i);
      assert.ok(step.sources.length > 0 && step.sources.every(source => source.url.startsWith('https://')));
    }
  }
});
