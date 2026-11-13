export interface PruneOptions {
  apply?: boolean;
  allLife?: boolean;
  sourceCache?: boolean;
}

export interface PruneTarget {
  path: string;
  relative: string;
  reason: string;
}

export interface MeasuredPruneTarget extends PruneTarget {
  files: number;
  bytes: number;
}

export function planLocalPrune(root: string, options?: PruneOptions): PruneTarget[];
export function pruneLocal(root: string, options?: PruneOptions): {
  applied: boolean;
  targets: MeasuredPruneTarget[];
  files: number;
  bytes: number;
};
