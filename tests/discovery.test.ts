import assert from 'node:assert/strict';
import { test } from 'node:test';
import { birdsFlight } from '../src/journeys/birdsFlight.ts';
import { searchProfiles } from '../src/profiles/search.ts';
import type { ProfileSearchRecord } from '../src/profiles/types.ts';

const records: ProfileSearchRecord[] = [
  [153563, 'Gallus gallus', 'species', ['Red junglefowl'], ['Gallus domesticus']],
  [81461, 'Aves', 'class', ['Birds'], []],
];

test('scientific discovery ranks common names, synonyms, and scientific names', () => {
  assert.deepEqual(searchProfiles(records, 'red jungle')[0], {
    ottId: 153563, scientificName: 'Gallus gallus', rank: 'species', commonName: 'Red junglefowl',
    matchedName: 'Red junglefowl', matchKind: 'common name',
  });
  assert.equal(searchProfiles(records, 'domesticus')[0].matchKind, 'synonym');
  assert.equal(searchProfiles(records, 'gallus')[0].matchKind, 'scientific name');
  assert.equal(searchProfiles(records, 'birds')[0].scientificName, 'Aves');
  assert.deepEqual(searchProfiles(records, 'no match'), []);
});

test('bird-flight pilot is a complete, sourced journey through validated OpenTree targets', () => {
  assert.equal(birdsFlight.id, 'birds-flight');
  assert.ok(birdsFlight.steps.length >= 8 && birdsFlight.steps.length <= 10);
  assert.equal(birdsFlight.steps.at(-1)?.kind, 'living lineage');
  assert.equal(new Set(birdsFlight.steps.map(step => step.ottId)).size, birdsFlight.steps.length - 1,
    'Only the explicitly explained Archaeopteryx map fallback may repeat a target');
  for (const step of birdsFlight.steps) {
    assert.ok(step.summary.length > 80, step.title);
    assert.ok(step.evidence.length > 60, step.title);
    assert.ok(step.uncertainty.length > 40, step.title);
    assert.ok(step.sources.length > 0 && step.sources.every(source => source.url.startsWith('https://')));
  }
});
