import type { LayoutTreeNode, Position, TreeBranch, TreeNodeInput } from './types.ts';

export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];
export interface MapTreeNode extends LayoutTreeNode {
  radius: number;
  heading: number;
  bounds: Bounds;
  region: Position[];
}
export interface LayoutResult { nodes: MapTreeNode[]; branches: TreeBranch[] }

/** Validate the flat JSON contract before using it as a graph. */
export function parseTreeData(value: unknown): TreeNodeInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('The tree must contain at least one node.');
  }
  for (const node of value) {
    if (!node || typeof node.id !== 'string' || !node.id ||
        (node.parentId !== null && typeof node.parentId !== 'string') ||
        typeof node.scientificName !== 'string' || !node.scientificName.trim() ||
        (node.isSyntheticNode !== undefined && typeof node.isSyntheticNode !== 'boolean') ||
        (node.isTerminal !== undefined && typeof node.isTerminal !== 'boolean') ||
        (node.commonName !== undefined && typeof node.commonName !== 'string') ||
        (node.rank !== undefined && typeof node.rank !== 'string') ||
        (node.ottId !== undefined && node.ottId !== null && !Number.isFinite(node.ottId))) {
      throw new Error('The tree contains an invalid node.');
    }
  }
  return value as TreeNodeInput[];
}

/**
 * Top-down, Lifemap-inspired layout. Each clade owns a forward half-disc.
 * Siblings receive disjoint sectors, weighted by sqrt(terminal count).
 * A child's enclosing disc fits its sector and parent using:
 * r = R sin(a) / (1 + sin(a)), d = R - r.
 * Unlike bottom-up circle packing, unbalanced trees cannot explode in size.
 * Unary nodes retain topology and extend along their parent's heading.
 */
export function layoutTreeV3(inputNodes: TreeNodeInput[], rootId: string): LayoutResult {
  const inputs = parseTreeData(inputNodes);
  const inputMap = new Map(inputs.map(node => [node.id, node]));
  if (inputMap.size !== inputs.length) throw new Error('Duplicate node IDs in tree.');
  const roots = inputs.filter(node => node.parentId === null);
  if (roots.length !== 1 || roots[0].id !== rootId) {
    throw new Error('The tree must have exactly one matching root.');
  }
  const children = new Map(inputs.map(node => [node.id, [] as TreeNodeInput[]]));
  for (const node of inputs) {
    if (node.parentId !== null) {
      const siblings = children.get(node.parentId);
      if (!siblings) throw new Error(`Missing parent for ${node.id}.`);
      siblings.push(node);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  // Iterative traversal avoids call-stack limits on deep trees.
  const order: TreeNodeInput[] = [];
  const pending = [roots[0]];
  const visited = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    if (visited.has(node.id)) throw new Error('Cycle detected in tree.');
    visited.add(node.id);
    order.push(node);
    for (const child of children.get(node.id)!) pending.push(child);
  }
  if (order.length !== inputs.length) throw new Error('The tree contains a disconnected cycle.');
  const counts = new Map<string, number>();
  for (const node of order.toReversed()) {
    const kids = children.get(node.id)!;
    counts.set(node.id, kids.length ? kids.reduce((sum, child) => sum + counts.get(child.id)!, 0) : 1);
  }

  const nodes: MapTreeNode[] = [];
  const positions = new Map<string, MapTreeNode>();
  const queue = [{ input: roots[0], position: [0, 0] as Position, radius: 1000, heading: -Math.PI / 2, depth: 0 }];
  while (queue.length) {
    const { input, position, radius, heading, depth } = queue.pop()!;
    if (radius < 1e-12) throw new Error('This tree exceeds the supported layout precision.');
    const kids = children.get(input.id)!;
    const span = depth === 0 ? Math.PI * 2 : Math.PI;
    const region: Position[] = [position];
    for (let i = 0; i <= 48; i++) {
      const angle = heading - span / 2 + span * i / 48;
      region.push([position[0] + radius * Math.cos(angle), position[1] + radius * Math.sin(angle)]);
    }
    region.push(position);
    const node: MapTreeNode = {
      ...input, position, radius, heading, depth, region,
      isTerminal: kids.length === 0,
      leafCount: counts.get(input.id)!,
      bounds: [position[0], position[1], position[0], position[1]],
    };
    nodes.push(node);
    positions.set(node.id, node);
    const weights = kids.map(child => Math.sqrt(counts.get(child.id)!));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = heading - span / 2;
    kids.forEach((child, index) => {
      const sector = span * weights[index] / total;
      const childHeading = kids.length === 1 ? heading : cursor + sector / 2;
      const sine = Math.sin(Math.min(Math.PI, sector) / 2);
      const childRadius = kids.length === 1 ? radius * 0.82 : radius * sine / (1 + sine) * 0.96;
      const distance = radius - childRadius;
      queue.push({
        input: child,
        position: [position[0] + distance * Math.cos(childHeading), position[1] + distance * Math.sin(childHeading)],
        radius: childRadius, heading: childHeading, depth: depth + 1,
      });
      cursor += sector;
    });
  }
  const branches: TreeBranch[] = [];
  for (const node of nodes.toReversed()) {
    if (node.parentId === null) continue;
    const parent = positions.get(node.parentId)!;
    parent.bounds = [
      Math.min(parent.bounds[0], node.bounds[0]), Math.min(parent.bounds[1], node.bounds[1]),
      Math.max(parent.bounds[2], node.bounds[2]), Math.max(parent.bounds[3], node.bounds[3]),
    ];
    branches.push({ sourceId: parent.id, targetId: node.id, source: parent.position, target: node.position });
  }
  return { nodes, branches };
}
