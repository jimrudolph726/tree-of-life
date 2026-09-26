export type Position = [number, number];

export interface TreeNodeInput {
  id: string;
  parentId: string | null;

  scientificName: string;
  sourceLabel?: string;
  commonName?: string;
  rank?: string;

  ottId?: number | null;

  /*
    "Terminal" means this node has no
    children in this particular tree.

    It does NOT mean "species."
  */
  isTerminal?: boolean;

  /*
    OpenTree's synthetic phylogeny contains
    unnamed structural branching points.
  */
  isSyntheticNode?: boolean;
}

export interface LayoutTreeNode
  extends TreeNodeInput {

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
