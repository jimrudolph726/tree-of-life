import type {
  LayoutTreeNode,
  TreeBranch,
  TreeNodeInput,
} from './types';


interface LayoutResult {
  nodes: LayoutTreeNode[];
  branches: TreeBranch[];
}


const BASE_BRANCH_LENGTH = 360;

/*
  Every generation becomes geometrically smaller.

  This is what creates the "zoom into the tree"
  effect rather than an infinitely tall tree.
*/
const BRANCH_SHRINK_FACTOR = 0.72;


export function layoutTree(
  inputNodes: TreeNodeInput[],
  rootId: string
): LayoutResult {

  const inputMap = new Map(
    inputNodes.map((node) => [
      node.id,
      node,
    ])
  );


  const childrenMap = new Map<
    string,
    TreeNodeInput[]
  >();


  for (const node of inputNodes) {
    if (!node.parentId) {
      continue;
    }

    const children =
      childrenMap.get(node.parentId) ?? [];

    children.push(node);

    childrenMap.set(
      node.parentId,
      children
    );
  }


  /*
    Count the number of terminal taxa beneath
    every node.

    Large clades will receive more visual space.
  */
  const leafCounts =
    new Map<string, number>();


  function countLeaves(
    nodeId: string
  ): number {

    const cached =
      leafCounts.get(nodeId);

    if (cached !== undefined) {
      return cached;
    }


    const children =
      childrenMap.get(nodeId) ?? [];


    if (children.length === 0) {
      leafCounts.set(nodeId, 1);

      return 1;
    }


    const count =
      children.reduce(
        (total, child) =>
          total + countLeaves(child.id),
        0
      );


    leafCounts.set(
      nodeId,
      count
    );

    return count;
  }


  countLeaves(rootId);


  const layoutNodes =
    new Map<
      string,
      LayoutTreeNode
    >();


  /*
    Recursively assign every clade a sector.

    Children divide the parent's available
    angular space according to descendant
    richness.
  */
  function placeNode(
    nodeId: string,

    x: number,
    y: number,

    heading: number,
    span: number,

    depth: number
  ) {

    const input =
      inputMap.get(nodeId);


    if (!input) {
      throw new Error(
        `Unknown tree node: ${nodeId}`
      );
    }


    const leafCount =
      leafCounts.get(nodeId) ?? 1;


    layoutNodes.set(
      nodeId,
      {
        ...input,

        position: [x, y],

        depth,
        leafCount,
      }
    );


    const children =
      childrenMap.get(nodeId) ?? [];


    if (children.length === 0) {
      return;
    }


    /*
      Square-root weighting prevents extremely
      species-rich clades from completely
      dominating the available space.

      Lifemap uses a related square-root idea
      when allocating visual territory.
    */
    const childWeights =
      children.map((child) =>
        Math.sqrt(
          leafCounts.get(child.id) ?? 1
        )
      );


    const totalWeight =
      childWeights.reduce(
        (sum, value) =>
          sum + value,
        0
      );


    let angleCursor =
      heading - span / 2;


    children.forEach(
      (child, index) => {

        const weight =
          childWeights[index];


        const childSpan =
          span *
          (weight / totalWeight);


        const childHeading =
          angleCursor +
          childSpan / 2;


        /*
          Branches become shorter deeper in
          the tree.

          This produces nested geometry:
          Primates occupies a region;
          Hominidae occupies a smaller region
          within it;
          Homo occupies a still smaller one.
        */
        const branchLength =
          BASE_BRANCH_LENGTH *
          Math.pow(
            BRANCH_SHRINK_FACTOR,
            depth
          );


        const childX =
          x +
          Math.cos(childHeading) *
            branchLength;


        const childY =
          y +
          Math.sin(childHeading) *
            branchLength;


        placeNode(
          child.id,

          childX,
          childY,

          childHeading,

          childSpan * 0.9,

          depth + 1
        );


        angleCursor += childSpan;
      }
    );
  }


  /*
    The root owns a full 360° region.

    This immediately separates us from a
    top-to-bottom tree layout.
  */
  placeNode(
    rootId,

    0,
    0,

    -Math.PI / 2,

    Math.PI * 2,

    0
  );


  const nodes =
    Array.from(
      layoutNodes.values()
    );


  const branches:
    TreeBranch[] = [];


  for (const node of nodes) {

    if (!node.parentId) {
      continue;
    }


    const parent =
      layoutNodes.get(
        node.parentId
      );


    if (!parent) {
      continue;
    }


    branches.push({
      sourceId:
        parent.id,

      targetId:
        node.id,

      source:
        parent.position,

      target:
        node.position,
    });
  }


  return {
    nodes,
    branches,
  };
}