import type {
  LayoutTreeNode,
  TreeBranch,
  TreeNodeInput,
} from './types';


interface LayoutResult {
  nodes: LayoutTreeNode[];
  branches: TreeBranch[];
}


/*
  ---------------------------------------------------------
  LAYOUT CONSTANTS
  ---------------------------------------------------------

  These are intentionally grouped here because we'll
  tune them visually as the project evolves.
*/


/*
  The root is allowed to distribute its children around
  almost an entire circle.

  This makes the overall tree feel like a map rather than
  a top-to-bottom dendrogram.
*/
const ROOT_SPAN =
  Math.PI * 2 * 0.94;


/*
  Every internal clade distributes its children across
  approximately one half-circle.

  Lifemap's published representation is based on
  recursively nested half-circles.
*/
const CLADE_SPAN =
  Math.PI * 0.92;


/*
  Minimum visual arc length given to one child.

  This prevents small sibling groups and species from
  being packed directly on top of one another.
*/
const MIN_CHILD_ARC = 72;


/*
  Additional territory allocated according to:

      sqrt(descendant terminal taxa)

  This is the important Lifemap-inspired component.

  A clade with 100 descendants gets more room than one
  with 4 descendants, but not 25x more room.
*/
const DESCENDANT_ARC_SCALE = 38;


/*
  Desired empty arc distance between sibling territories.
*/
const SIBLING_GAP = 24;


/*
  Even tiny two-child clades should have branches long
  enough to remain visually distinguishable.
*/
const MIN_BRANCH_LENGTH = 48;


/*
  Small deterministic orientation variation.

  Lifemap distributes half-circles within their parent
  regions. We introduce a small stable variation so the
  tree doesn't become mechanically repetitive while
  preserving exactly the same geometry between renders.
*/
const MAX_ROTATION_JITTER =
  Math.PI * 0.10;


/*
  ---------------------------------------------------------
  DETERMINISTIC HASH
  ---------------------------------------------------------

  We want layout decisions to remain stable.

  Reloading the website should NOT cause clades to move
  somewhere else.

  Eventually this stability becomes extremely important
  for spatial memory.
*/

function stableHash(
  value: string
): number {

  let hash = 2166136261;

  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {

    hash ^= value.charCodeAt(index);

    hash = Math.imul(
      hash,
      16777619
    );
  }

  return hash >>> 0;
}


/*
  Return a stable value between -1 and +1.
*/
function stableUnitValue(
  value: string
): number {

  const hash =
    stableHash(value);

  const normalized =
    hash / 0xffffffff;

  return (
    normalized * 2 - 1
  );
}


/*
  ---------------------------------------------------------
  MAIN LAYOUT
  ---------------------------------------------------------
*/

export function layoutTreeV2(
  inputNodes: TreeNodeInput[],
  rootId: string
): LayoutResult {

  /*
    Quick lookup:

        node ID -> biological node
  */
  const inputMap =
    new Map(
      inputNodes.map(
        (node) => [
          node.id,
          node,
        ]
      )
    );


  if (!inputMap.has(rootId)) {

    throw new Error(
      `Unknown root node: ${rootId}`
    );
  }


  /*
    Convert the flat parentId representation into:

        parent ID -> children[]
  */
  const childrenMap =
    new Map<
      string,
      TreeNodeInput[]
    >();


  for (
    const node
    of inputNodes
  ) {

    if (!node.parentId) {
      continue;
    }


    const children =
      childrenMap.get(
        node.parentId
      ) ?? [];


    children.push(node);


    childrenMap.set(
      node.parentId,
      children
    );
  }


  /*
    -------------------------------------------------------
    TERMINAL DESCENDANT COUNTS
    -------------------------------------------------------

    Count how many terminal nodes exist beneath each
    node.

    This becomes our measure of clade size.
  */

  const terminalCounts =
    new Map<
      string,
      number
    >();


  function countTerminals(
    nodeId: string
  ): number {

    const cached =
      terminalCounts.get(
        nodeId
      );


    if (
      cached !== undefined
    ) {

      return cached;
    }


    const children =
      childrenMap.get(
        nodeId
      ) ?? [];


    /*
      No children means terminal in this tree.

      This is deliberately structural and does NOT mean:

          "this taxon is a species"
    */
    if (
      children.length === 0
    ) {

      terminalCounts.set(
        nodeId,
        1
      );

      return 1;
    }


    const count =
      children.reduce(
        (
          total,
          child
        ) =>
          total +
          countTerminals(
            child.id
          ),
        0
      );


    terminalCounts.set(
      nodeId,
      count
    );


    return count;
  }


  countTerminals(rootId);


  /*
    -------------------------------------------------------
    STABLE CHILD ORDERING
    -------------------------------------------------------

    OpenTree does not promise that the order in which
    children appear is meaningful visually.

    We give them a deterministic order so the tree stays
    spatially stable between reloads.
  */

  function getOrderedChildren(
    nodeId: string
  ): TreeNodeInput[] {

    const children =
      childrenMap.get(
        nodeId
      ) ?? [];


    return [
      ...children,
    ].sort(
      (a, b) =>
        stableHash(a.id) -
        stableHash(b.id)
    );
  }


  /*
    -------------------------------------------------------
    TERRITORY WIDTH
    -------------------------------------------------------

    This is the key idea.

    Every child asks for some amount of arc space.

    More descendant-rich clades get more room using:

        sqrt(descendant count)

    rather than raw descendant count.
  */

  function getDesiredArc(
    nodeId: string
  ): number {

    const terminalCount =
      terminalCounts.get(
        nodeId
      ) ?? 1;


    return Math.max(
      MIN_CHILD_ARC,

      Math.sqrt(
        terminalCount
      ) *
        DESCENDANT_ARC_SCALE
    );
  }


  /*
    Final positioned nodes.
  */
  const layoutNodes =
    new Map<
      string,
      LayoutTreeNode
    >();


  /*
    -------------------------------------------------------
    RECURSIVE PLACEMENT
    -------------------------------------------------------
  */

  function placeNode(
    nodeId: string,

    x: number,
    y: number,

    /*
      Direction this clade is traveling away from its
      parent.
    */
    heading: number,

    depth: number
  ) {

    const input =
      inputMap.get(
        nodeId
      );


    if (!input) {

      throw new Error(
        `Unknown tree node: ${nodeId}`
      );
    }


    const terminalCount =
      terminalCounts.get(
        nodeId
      ) ?? 1;


    layoutNodes.set(
      nodeId,
      {
        ...input,

        position: [
          x,
          y,
        ],

        depth,

        leafCount:
          terminalCount,
      }
    );


    const children =
      getOrderedChildren(
        nodeId
      );


    if (
      children.length === 0
    ) {

      return;
    }


    /*
      Root gets nearly a full circle.

      Every other clade gets its own half-circle.
    */
    const availableSpan =
      depth === 0
        ? ROOT_SPAN
        : CLADE_SPAN;


    /*
      Determine how much physical arc length every child
      wants.
    */
    const childArcWidths =
      children.map(
        (child) =>
          getDesiredArc(
            child.id
          )
      );


    const totalChildArc =
      childArcWidths.reduce(
        (
          total,
          width
        ) =>
          total + width,
        0
      );


    const totalGapArc =
      Math.max(
        0,
        children.length - 1
      ) *
      SIBLING_GAP;


    const totalRequiredArc =
      totalChildArc +
      totalGapArc;


    /*
      Arc length relation:

          arcLength = radius * angle

      Therefore:

          radius = arcLength / angle

      This is the important improvement over V1.

      If a clade contains many children, its branch radius
      automatically expands until there is enough arc
      length available to separate them.
    */
    const branchRadius =
      Math.max(
        MIN_BRANCH_LENGTH,

        totalRequiredArc /
          availableSpan
      );


    /*
      Add a small deterministic rotation.

      We don't use Math.random(), because that would move
      taxa around every time the layout is recomputed.
    */
    const rotationJitter =
      depth === 0
        ? 0
        : stableUnitValue(
            nodeId
          ) *
          MAX_ROTATION_JITTER;


    const localHeading =
      heading +
      rotationJitter;


    let angleCursor =
      localHeading -
      availableSpan / 2;


    /*
      Convert our desired physical gap into an angle for
      this particular half-circle.
    */
    const gapAngle =
      SIBLING_GAP /
      branchRadius;


    children.forEach(
      (
        child,
        index
      ) => {

        const desiredArc =
          childArcWidths[
            index
          ];


        /*
          Because:

              angle = arcLength / radius
        */
        const childAngle =
          desiredArc /
          branchRadius;


        /*
          Position the child in the center of its allocated
          arc territory.
        */
        const childHeading =
          angleCursor +
          childAngle / 2;


        const childX =
          x +
          Math.cos(
            childHeading
          ) *
          branchRadius;


        const childY =
          y +
          Math.sin(
            childHeading
          ) *
          branchRadius;


        placeNode(
          child.id,

          childX,
          childY,

          childHeading,

          depth + 1
        );


        angleCursor +=
          childAngle;


        if (
          index <
          children.length - 1
        ) {

          angleCursor +=
            gapAngle;
        }
      }
    );
  }


  /*
    Start Primates in the center.

    The initial direction points upward, though the root
    itself uses almost a complete circle.
  */
  placeNode(
    rootId,

    0,
    0,

    -Math.PI / 2,

    0
  );


  /*
    -------------------------------------------------------
    CREATE BRANCH GEOMETRY
    -------------------------------------------------------
  */

  const nodes =
    Array.from(
      layoutNodes.values()
    );


  const branches:
    TreeBranch[] = [];


  for (
    const node
    of nodes
  ) {

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