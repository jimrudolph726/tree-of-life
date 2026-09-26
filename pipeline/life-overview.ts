import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Graph } from './build-tree.ts';
import { NONE, RECORD_BYTES } from '../src/stream/format.ts';
import type { StreamNode, Summary } from '../src/stream/format.ts';

/** Collapse unnamed vertices geometrically, never topologically. Every original
 * edge and ancestor stays in the records; zero-length display edges are allowed.
 * This exposes named clades without shrinking them through unnamed binary chains.
 */
export function lifeGeometry(graph: Graph, order: Uint32Array, inverse: Uint32Array,
  first: Uint32Array, next: Uint32Array, leaves: Uint32Array, data: DataView) {
  const structural = new Uint8Array(order.length);
  for (let i = 0; i < order.length; i++) structural[i] = Number(!!graph.metadata(i).isSyntheticNode);
  const root = order[0];
  const routing = new Map<number, number[]>();
  for (let k = 0; k < order.length; k++) {
    const i = order[k], b = k * RECORD_BYTES;
    if (structural[i]) continue;
    const heading = data.getFloat64(b + 48, true), group = data.getUint32(b + 84, true);
    const frontier: number[] = [], pending: number[] = [];
    let folded = false;
    for (let child = first[i]; child !== NONE; child = next[child]) pending.push(child);
    while (pending.length) {
      const child = pending.pop()!, offset = inverse[child] * RECORD_BYTES;
      if (structural[child]) {
        folded = true;
        data.setFloat64(offset + 24, 0, true); data.setFloat64(offset + 32, 0, true);
        data.setFloat64(offset + 40, 1, true); data.setFloat64(offset + 48, heading, true);
        data.setUint32(offset + 84, group, true);
        for (let c = first[child]; c !== NONE; c = next[c]) pending.push(c);
      } else frontier.push(child);
    }
    // Stable source order; only angles and display distances are chosen here.
    frontier.sort((a, c) => a - c);
    if (folded) routing.set(k, frontier.map(child => inverse[child]));
    // Very broad frontiers otherwise let thousands of single-tip entries crowd
    // every substantial clade out of the opening view. Display area is not a
    // scientific measurement; reserve angle in proportion to tips at this scale.
    const weight = (child: number) => frontier.length > 64 ? leaves[child] : Math.sqrt(leaves[child]);
    const total = frontier.reduce((sum, child) => sum + weight(child), 0);
    let cursor = heading - Math.PI / 2;
    for (const child of frontier) {
      const offset = inverse[child] * RECORD_BYTES;
      const sector = Math.PI * weight(child) / total;
      const angle = frontier.length === 1 ? heading : cursor + sector / 2;
      const sine = Math.sin(sector / 2);
      let ratio = frontier.length === 1 ? 0.82 : sine / (1 + sine) * 0.96;
      // Descendants occupy forward half discs. Keep the proven subtree scale,
      // but place each disc near the point where it touches its sector edges.
      // This removes empty branch length without loading more detail per view.
      const tangent = Math.tan(Math.min(sector, Math.PI - 1e-8) / 2);
      const distance = frontier.length === 1 ? 0.10 : Math.min(1 - ratio, ratio / tangent * 1.10);
      let x = distance * Math.cos(angle), y = distance * Math.sin(angle), direction = angle, color = group;
      if (i === root) {
        const id = graph.metadata(child).id;
        if (id === 'ott304358') { x = -0.46; y = -0.31; direction = -Math.PI * 0.75; color = 1; }
        else if (id === 'ott996421') { x = 0.46; y = -0.31; direction = -Math.PI * 0.25; color = 2; }
        else if (id === 'ott844192') { x = 0; y = 0.50; direction = Math.PI * 0.5; color = 3; }
        else throw new Error('Whole-tree overview expects the three source domain children.');
        ratio = 0.43;
      }
      data.setFloat64(offset + 24, x, true); data.setFloat64(offset + 32, y, true);
      data.setFloat64(offset + 40, ratio, true); data.setFloat64(offset + 48, direction % (2 * Math.PI), true);
      data.setUint32(offset + 84, color, true); cursor += sector;
    }
  }
  for (let k = 0; k < order.length; k++) {
    let max = 0;
    for (let child = first[order[k]]; child !== NONE; child = next[child]) max = Math.max(max, data.getFloat64(inverse[child] * RECORD_BYTES + 40, true));
    data.setFloat32(k * RECORD_BYTES + 76, max, true);
  }
  // Only display routing skips zero-length unnamed vertices. Source firstChild,
  // nextSibling, parent, depth and terminal counts remain untouched.
  for (const [index, children] of routing) {
    let max = 0;
    for (const child of children) max = Math.max(max, data.getFloat64(child * RECORD_BYTES + 40, true));
    data.setFloat32(index * RECORD_BYTES + 76, max, true);
  }
  return routing;
}

export function region(x: number, y: number, radius: number, heading: number, full: boolean): [number, number][] {
  const span = full ? Math.PI * 2 : Math.PI, points: [number, number][] = [[x, y]];
  for (let s = 0; s <= 48; s++) {
    const angle = heading - span / 2 + span * s / 48;
    points.push([x + radius * Math.cos(angle), y + radius * Math.sin(angle)]);
  }
  points.push([x, y]); return points;
}

export function writeOverview(data: DataView, count: number, summary: (i: number) => Summary, folder: string) {
  const nodes: StreamNode[] = [], lines: number[] = [], lineTargets: number[] = [];
  const pending = [{ index: 0, x: 0, y: 0, radius: 1000, px: 0, py: 0 }];
  let visits = 0;
  while (pending.length) {
    const p = pending.pop()!, b = p.index * RECORD_BYTES; visits++;
    if (visits > count) throw new Error('Cycle in overview');
    const n = summary(p.index), heading = data.getFloat64(b + 48, true), group = data.getUint32(b + 84, true);
    if (Math.hypot(p.x - p.px, p.y - p.py) > 1) { lines.push(p.px, p.py, p.x, p.y); lineTargets.push(p.index); }
    if (!n.isSyntheticNode && p.radius >= 9) {
      nodes.push({ ...n, position: [p.x, p.y], radius: p.radius, heading, group,
        bounds: [56, 60, 64, 68].map((at, dim) => (dim % 2 ? p.y : p.x) + data.getFloat32(b + at, true) * p.radius) as StreamNode['bounds'],
        region: n.isTerminal || p.index === 0 ? [] : region(p.x, p.y, p.radius, heading, n.depth === 1) });
    }
    for (let child = data.getUint32(b + 4, true); child !== NONE; child = data.getUint32(child * RECORD_BYTES + 8, true)) {
      const c = child * RECORD_BYTES, r = p.radius * data.getFloat64(c + 40, true);
      if (r < 3) continue;
      pending.push({ index: child, x: p.x + p.radius * data.getFloat64(c + 24, true),
        y: p.y + p.radius * data.getFloat64(c + 32, true), radius: r, px: p.x, py: p.y });
    }
  }
  const bytes = Buffer.from(JSON.stringify({ nodes, lines, lineTargets, visits }));
  writeFileSync(join(folder, 'overview.json'), bytes);
  return { bytes, maxScale: 0.6 };
}
