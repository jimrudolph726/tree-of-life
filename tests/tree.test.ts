import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { layoutTreeV3, parseTreeData } from '../src/tree/layoutTreeV3.ts';
import { fitBounds, focusBounds, getLineage, labelOffset, labelSize, labelText, mapInsets, project, searchTaxa, visibleLabels } from '../src/tree/navigation.ts';
import type { TreeNodeInput, Position } from '../src/tree/types.ts';

const input = parseTreeData(JSON.parse(readFileSync(new URL('../public/data/primates.nodes.json', import.meta.url), 'utf8')));
const rootId = input.find(node => node.parentId === null)!.id;
const tree = layoutTreeV3(input, rootId);
const nodeMap = new Map(tree.nodes.map(node => [node.id, node]));
const makeNode = (id: string, parentId: string | null): TreeNodeInput => ({ id, parentId, scientificName: id });

test('the real dataset retains every node, edge and terminal count in a bounded map', () => {
  assert.equal(tree.nodes.length, input.length);
  assert.equal(tree.branches.length, input.length - 1);
  assert.equal(tree.nodes[0].leafCount, input.filter(node => node.isTerminal).length);
  assert.equal(new Set(tree.nodes.map(node => node.id)).size, input.length);
  for (const node of tree.nodes) {
    assert.ok(node.position.every(Number.isFinite));
    assert.ok(Math.hypot(...node.position) <= 1000 + 1e-9);
    assert.ok(node.radius > 0);
    if (node.parentId !== null) {
      const parent = nodeMap.get(node.parentId)!;
      assert.equal(node.depth, parent.depth + 1);
      assert.ok(Math.hypot(node.position[0] - parent.position[0], node.position[1] - parent.position[1]) > 0);
      assert.ok(node.bounds[0] >= parent.bounds[0] && node.bounds[2] <= parent.bounds[2]);
      assert.ok(node.bounds[1] >= parent.bounds[1] && node.bounds[3] <= parent.bounds[3]);
    }
  }
});

test('layout is deterministic even when input ordering changes', () => {
  const shuffled = layoutTreeV3(input.toReversed(), rootId);
  assert.deepEqual(shuffled, tree);
});

test('branches never cross unrelated branches in the Primates map', () => {
  const orientation = (a: Position, b: Position, c: Position) => {
    const p = (b[0] - a[0]) * (c[1] - a[1]);
    const q = (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(p - q) <= (Math.abs(p) + Math.abs(q)) * 1e-10 ? 0 : Math.sign(p - q);
  };
  for (let i = 0; i < tree.branches.length; i++) {
    const a = tree.branches[i];
    for (let j = i + 1; j < tree.branches.length; j++) {
      const b = tree.branches[j];
      if ([a.sourceId, a.targetId].some(id => id === b.sourceId || id === b.targetId)) continue;
      const crosses = orientation(a.source, a.target, b.source) * orientation(a.source, a.target, b.target) < 0 &&
        orientation(b.source, b.target, a.source) * orientation(b.source, b.target, a.target) < 0;
      assert.ok(!crosses, `${a.targetId} crosses ${b.targetId}`);
    }
  }
});

test('malformed trees fail explicitly instead of crashing or silently dropping nodes', () => {
  assert.throws(() => parseTreeData([]), /at least one/);
  assert.throws(() => parseTreeData([{ id: 'r', parentId: null }]), /invalid/);
  assert.throws(() => parseTreeData([{ ...makeNode('r', null), commonName: {} }]), /invalid/);
  assert.throws(() => layoutTreeV3([makeNode('r', null), makeNode('r', 'r')], 'r'), /Duplicate/);
  assert.throws(() => layoutTreeV3([makeNode('r', null), makeNode('b', null)], 'r'), /exactly one/);
  assert.throws(() => layoutTreeV3([makeNode('r', null), makeNode('b', 'missing')], 'r'), /Missing parent/);
  assert.throws(() => layoutTreeV3([makeNode('r', null), makeNode('a', 'b'), makeNode('b', 'a')], 'r'), /cycle/);
});

test('single-node, unary and multifurcating trees infer terminal status from topology', () => {
  const single = layoutTreeV3([makeNode('r', null)], 'r');
  assert.equal(single.nodes[0].leafCount, 1);
  assert.equal(single.nodes[0].isTerminal, true);
  const chain = Array.from({ length: 80 }, (_, i) => makeNode(String(i), i ? String(i - 1) : null));
  const result = layoutTreeV3(chain, '0');
  assert.equal(result.nodes.length, 80);
  assert.equal(result.nodes[79].depth, 79);
  const fan = layoutTreeV3([makeNode('r', null), ...Array.from({ length: 100 }, (_, i) => makeNode(String(i), 'r'))], 'r');
  assert.equal(fan.nodes[0].leafCount, 100);
  assert.equal(new Set(fan.nodes.map(node => node.position.join(','))).size, 101);
});

test('search finds names and OTT IDs and preserves unnamed ancestors in lineage', () => {
  const human = searchTaxa(tree.nodes, '  HOMO SAPIENS  ')[0];
  assert.equal(human.scientificName, 'Homo sapiens');
  assert.equal(searchTaxa(tree.nodes, '770315')[0].id, human.id);
  assert.equal(searchTaxa(tree.nodes, 'ott770315')[0].id, human.id);
  assert.deepEqual(searchTaxa(tree.nodes, 'no-such-taxon'), []);
  assert.deepEqual(searchTaxa(tree.nodes, 'Unnamed clade'), []);
  const lineage = getLineage(human, nodeMap);
  assert.equal(lineage[0].id, rootId);
  assert.equal(lineage.at(-1)?.id, human.id);
  assert.ok(lineage.some(node => node.isSyntheticNode));
  // Quoted Newick labels use spaces before OTT IDs, not underscores.
  assert.equal(searchTaxa(tree.nodes, '266464')[0]?.scientificName, 'Pygathrix cinerea 1 RL-2012');
  assert.ok(input.filter(node => node.isSyntheticNode).every(node => node.scientificName === 'Unnamed clade'));
});

test('every clade fits into the unobscured map area at desktop and mobile sizes', () => {
  for (const size of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    for (const node of tree.nodes) {
      const insets = mapInsets(size, true);
      const bounds = focusBounds(node);
      const camera = fitBounds(bounds, size, insets);
      for (const point of [[bounds[0], bounds[1]], [bounds[2], bounds[3]]] as Position[]) {
        const [x, y] = project(point, camera, size);
        assert.ok(x >= insets.left - 0.001 && x <= size.width - insets.right + 0.001, node.id);
        assert.ok(y >= insets.top - 0.001 && y <= size.height - insets.bottom + 0.001, node.id);
      }
    }
  }
});

test('labels prefer selection, avoid collisions and respond to panning', () => {
  const size = { width: 1280, height: 720 };
  const human = searchTaxa(tree.nodes, 'Homo sapiens')[0];
  const camera = fitBounds(focusBounds(human), size, mapInsets(size, true));
  const labels = visibleLabels(tree.nodes, camera, size, human.id);
  assert.equal(labels[0].id, human.id);
  assert.ok(labels.every(node => !node.isSyntheticNode));
  const overlapped = [human, { ...human, id: 'collision', radius: human.radius / 2 }];
  assert.deepEqual(visibleLabels(overlapped, camera, size, human.id).map(node => node.id), [human.id]);
  const elsewhere = { ...camera, target: [1e6, 1e6, 0] as [number, number, number] };
  assert.deepEqual(visibleLabels(tree.nodes, elsewhere, size, human.id), []);
});

test('long labels remain inside the mobile viewport', () => {
  const size = { width: 390, height: 844 };
  const human = searchTaxa(tree.nodes, 'Homo sapiens')[0];
  const camera = fitBounds(focusBounds(human), size, mapInsets(size, true));
  for (const node of visibleLabels(tree.nodes, camera, size, human.id)) {
    const [x] = project(node.position, camera, size);
    const center = x + labelOffset(node, camera, size)[0];
    const halfWidth = labelText(node, size).length * labelSize(node) * 0.32 + 8;
    assert.ok(center - halfWidth >= 0 && center + halfWidth <= size.width);
  }
});
