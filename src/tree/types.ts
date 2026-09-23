export type Position = [number, number];

export interface TreeNodeInput {
  id: string;
  parentId: string | null;

  scientificName: string;
  commonName?: string;
  rank?: string;
}

export interface LayoutTreeNode extends TreeNodeInput {
  position: Position;

  depth: number;
  leafCount: number;
}

export interface TreeBranch {
  sourceId: string;
  targetId: string;

  source: Position;
  target: Position;
}