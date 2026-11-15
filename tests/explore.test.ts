import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeTreeExploreUrl, EXPLORE_DESTINATIONS, EXPLORE_SECTIONS } from '../src/tree/explore.ts';

test('Explore destinations use unique stable OpenTree identities and camera presets', () => {
  assert.deepEqual(EXPLORE_SECTIONS.map(section => section.label), ['Domains', 'Major branches', 'Familiar branches']);
  assert.equal(new Set(EXPLORE_DESTINATIONS.map(item => item.id)).size, EXPLORE_DESTINATIONS.length);
  assert.equal(new Set(EXPLORE_DESTINATIONS.map(item => item.ottId)).size, EXPLORE_DESTINATIONS.length);
  assert.ok(EXPLORE_DESTINATIONS.every(item => item.ottId > 0 && item.zoomOut >= 0 && item.maximumZoom > 0));
  assert.deepEqual(Object.fromEntries(EXPLORE_DESTINATIONS.map(item => [item.scientificName, item.ottId])), {
    Eukaryota: 304358, Bacteria: 844192, Archaea: 996421, Metazoa: 691846, Chloroplastida: 361838,
    Fungi: 352914, Aves: 81461, Mammalia: 244265, Primates: 913935,
  });
  assert.deepEqual(EXPLORE_DESTINATIONS.filter(item => ['birds', 'mammals', 'primates'].includes(item.id))
    .map(item => item.scientificName), ['Aves', 'Mammalia', 'Primates']);
});

test('legacy datasets can return to a shareable destination in the complete tree', () => {
  const birds = EXPLORE_DESTINATIONS.find(item => item.id === 'birds');
  assert.ok(birds);
  const destination = completeTreeExploreUrl('https://example.test/?dataset=aves&journey=birds-flight&step=4&compare=ott1', birds);
  assert.equal(destination.searchParams.get('dataset'), 'life');
  assert.equal(destination.searchParams.get('taxon'), 'ott81461');
  assert.equal(destination.searchParams.get('journey'), null);
  assert.equal(destination.searchParams.get('compare'), null);
  const home = completeTreeExploreUrl(destination.href);
  assert.equal(home.searchParams.get('taxon'), null);
});
