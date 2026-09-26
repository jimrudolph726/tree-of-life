import type { MapTreeNode, Bounds } from './layoutTreeV3.ts';
import type { Position } from './types.ts';

export interface Camera {
  target: [number, number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
}
export interface Size { width: number; height: number }
export interface Insets { top: number; right: number; bottom: number; left: number }

export function mapInsets(size: Size, hasSelection = false): Insets {
  return size.width < 700
    ? { top: 160, left: 54, right: 24, bottom: hasSelection ? size.height * 0.4 + 20 : 60 }
    : { top: 145, left: 80, right: hasSelection ? 370 : 80, bottom: 70 };
}

export function fitBounds(bounds: Bounds, size: Size, insets: Insets, minZoom = -12, maxZoom = 32): Camera {
  const width = Math.max(40, size.width - insets.left - insets.right);
  const height = Math.max(40, size.height - insets.top - insets.bottom);
  const scale = Math.min(width / Math.max(1e-12, bounds[2] - bounds[0]), height / Math.max(1e-12, bounds[3] - bounds[1]));
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.log2(scale)));
  const actualScale = 2 ** zoom;
  return {
    target: [
      (bounds[0] + bounds[2]) / 2 - (insets.left - insets.right) / (2 * actualScale),
      (bounds[1] + bounds[3]) / 2 - (insets.top - insets.bottom) / (2 * actualScale), 0,
    ], zoom, minZoom, maxZoom,
  };
}

export function focusBounds(node: MapTreeNode): Bounds {
  if (node.depth === 1 && ['ott304358', 'ott996421', 'ott844192'].includes(node.id)) {
    const r = node.radius * 1.06;
    return [node.position[0] - r, node.position[1] - r, node.position[0] + r, node.position[1] + r];
  }
  const padding = node.radius * (node.isTerminal ? 1.5 : 0.12);
  return [node.bounds[0] - padding, node.bounds[1] - padding, node.bounds[2] + padding, node.bounds[3] + padding];
}

export function getLineage(node: MapTreeNode, nodeMap: Map<string, MapTreeNode>): MapTreeNode[] {
  const result: MapTreeNode[] = [];
  let current: MapTreeNode | undefined = node;
  while (current) {
    result.push(current);
    current = current.parentId === null ? undefined : nodeMap.get(current.parentId);
  }
  return result.reverse();
}

export function project(position: Position, camera: Camera, size: Size): Position {
  const scale = 2 ** camera.zoom;
  return [(position[0] - camera.target[0]) * scale + size.width / 2,
    (position[1] - camera.target[1]) * scale + size.height / 2];
}

export function searchTaxa(nodes: MapTreeNode[], query: string): MapTreeNode[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const score = (node: MapTreeNode) => {
    const name = node.scientificName.toLocaleLowerCase();
    return name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
  };
  return nodes.filter(node => !node.isSyntheticNode &&
    `${node.scientificName} ${node.commonName ?? ''} ${node.ottId ?? ''} ${node.id}`.toLocaleLowerCase().includes(needle))
    .sort((a, b) => score(a) - score(b) || a.scientificName.localeCompare(b.scientificName)).slice(0, 12);
}

export function labelSize(node: MapTreeNode): number {
  if (['Eukaryota', 'Archaea', 'Bacteria'].includes(node.scientificName)) return 22;
  return node.depth === 0 ? 20 : node.isTerminal ? 12 : 15;
}

export function labelText(node: MapTreeNode, size: Size): string {
  const maxCharacters = Math.max(8, Math.floor((size.width - 32) / (labelSize(node) * 0.64)));
  return node.scientificName.length > maxCharacters
    ? `${node.scientificName.slice(0, maxCharacters - 1)}…` : node.scientificName;
}

function labelHalfWidth(node: MapTreeNode, size: Size): number {
  return labelText(node, size).length * labelSize(node) * 0.32 + 8;
}

export function labelOffset(node: MapTreeNode, camera: Camera, size: Size): Position {
  const placed = node as MapTreeNode & { labelPlacement?: Position };
  if (placed.labelPlacement) return placed.labelPlacement;
  const [x] = project(node.position, camera, size);
  const halfWidth = labelHalfWidth(node, size);
  const center = Math.max(halfWidth + 4, Math.min(size.width - halfWidth - 4, x));
  return [center - x, -12];
}

/** Screen-space collision filtering, recalculated for both pan and zoom. */
export function visibleLabels(nodes: MapTreeNode[], camera: Camera, size: Size, selectedId?: string): MapTreeNode[] {
  const scale = 2 ** camera.zoom;
  const candidates = nodes.filter(node => !node.isSyntheticNode &&
    (node.id === selectedId || node.depth === 0 || node.radius * scale >= (labelPriority(node) > 0 ? 3 : node.isTerminal ? 18 : 12)))
    .sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || labelPriority(b) - labelPriority(a) || b.radius - a.radius);
  const cells = new Map<string, Bounds[]>();
  return candidates.flatMap(node => {
    const [x, y] = project(node.position, camera, size);
    const fontSize = labelSize(node);
    if (x < -8 || x > size.width + 8) return [];
    const center = x + labelOffset(node, camera, size)[0];
    const halfWidth = labelHalfWidth(node, size);
    for (const dy of labelPriority(node) > 0 ? [-12, fontSize + 12] : [-12]) {
      const box: Bounds = [center - halfWidth, y + dy - fontSize - 6, center + halfWidth, y + dy + 4];
      if (box[2] < 0 || box[0] > size.width || box[1] < 0 || box[3] > size.height) continue;
      const keys: string[] = []; let collision = false;
      for (let gx = Math.floor(box[0] / 64); gx <= Math.floor(box[2] / 64); gx++) {
        for (let gy = Math.floor(box[1] / 32); gy <= Math.floor(box[3] / 32); gy++) {
          const key = `${gx},${gy}`;
          if (cells.get(key)?.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) collision = true;
          keys.push(key);
        }
      }
      if (collision) continue;
      for (const key of keys) {
        const bucket = cells.get(key);
        if (bucket) bucket.push(box); else cells.set(key, [box]);
      }
      return [{ ...node, labelPlacement: [center - x, dy] as Position }];
    }
    return [];
  });
}

function labelPriority(node: MapTreeNode) {
  return ['Eukaryota', 'Archaea', 'Bacteria'].includes(node.scientificName) ? 4
    : ['Opisthokonta', 'Fungi'].includes(node.scientificName) ? 3
    : ['Metazoa', 'Archaeplastida', 'Chloroplastida', 'Actinobacteria', 'Cyanobacteria', 'Methanobacteria', 'Thermoprotei'].includes(node.scientificName) ? 2 : 0;
}
