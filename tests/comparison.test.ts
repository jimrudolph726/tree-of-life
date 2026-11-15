import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTaxa, parseTaxonSelection, taxonSelectionUrl } from '../src/tree/comparison.ts';
import type { Details, Summary } from '../src/stream/format.ts';

const node = (index: number, scientificName: string, ottId = index + 100): Summary => ({
  index, id: `ott${ottId}`, parentId: index ? `ott${ottId - 1}` : null,
  ottId, scientificName, depth: index, leafCount: 1, isTerminal: index > 3,
});
const root = node(0, 'Life'), mammal = node(1, 'Mammalia'), primate = node(2, 'Primates');
const human = node(3, 'Homo sapiens', 770315), chimp = node(4, 'Pan troglodytes', 417950);
const details = (target: Summary, lineage: Summary[]): Details => ({
  node: target, lineage, children: [], childrenTruncated: false, anchor: 0,
  focus: { ...target, position: [0, 0], radius: 1, heading: 0, bounds: [-1, -1, 1, 1], region: [] },
});

test('taxon comparison identifies the MRCA and divergent lineages', () => {
  const comparison = compareTaxa(details(human, [root, mammal, primate, human]),
    details(chimp, [root, mammal, primate, chimp]));
  assert.equal(comparison.mrca.scientificName, 'Primates');
  assert.deepEqual(comparison.shared.map(item => item.scientificName), ['Life', 'Mammalia', 'Primates']);
  assert.deepEqual(comparison.firstBranch, [human]);
  assert.deepEqual(comparison.secondBranch, [chimp]);
});

test('taxon permalinks preserve dataset context and round trip', () => {
  const url = taxonSelectionUrl('https://example.test/?dataset=life&journey=birds-flight&step=2', 770315, 417950);
  assert.equal(url.searchParams.get('dataset'), 'life');
  assert.equal(url.searchParams.get('journey'), null);
  assert.deepEqual(parseTaxonSelection(url.search), { taxon: 770315, compare: 417950 });
  assert.deepEqual(parseTaxonSelection('?taxon=invalid&compare=ott417950'), { taxon: undefined, compare: undefined });
});
