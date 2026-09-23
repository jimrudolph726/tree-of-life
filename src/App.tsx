import { useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import type { PickingInfo } from '@deck.gl/core';
import {
  LineLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';

import './App.css';

type Position = [number, number];

interface TreeNode {
  id: string;
  parentId: string | null;
  scientificName: string;
  commonName?: string;
  rank?: string;
  position: Position;
}

interface TreeBranch {
  source: Position;
  target: Position;
}

const nodes: TreeNode[] = [
  {
    id: 'primates',
    parentId: null,
    scientificName: 'Primates',
    commonName: 'Primates',
    rank: 'Order',
    position: [0, -260],
  },
  {
    id: 'hominidae',
    parentId: 'primates',
    scientificName: 'Hominidae',
    commonName: 'Great apes',
    rank: 'Family',
    position: [0, -140],
  },
  {
    id: 'hominini',
    parentId: 'hominidae',
    scientificName: 'Hominini',
    commonName: 'African apes and humans',
    rank: 'Tribe',
    position: [0, -20],
  },
  {
    id: 'homo',
    parentId: 'hominini',
    scientificName: 'Homo',
    commonName: 'Humans',
    rank: 'Genus',
    position: [-120, 100],
  },
  {
    id: 'pan',
    parentId: 'hominini',
    scientificName: 'Pan',
    commonName: 'Chimpanzees and bonobos',
    rank: 'Genus',
    position: [120, 100],
  },
  {
    id: 'homo-sapiens',
    parentId: 'homo',
    scientificName: 'Homo sapiens',
    commonName: 'Human',
    rank: 'Species',
    position: [-120, 220],
  },
];

const nodeMap = new Map(nodes.map((node) => [node.id, node]));

const branches: TreeBranch[] = nodes
  .filter((node) => node.parentId !== null)
  .map((node) => ({
    source: nodeMap.get(node.parentId!)!.position,
    target: node.position,
  }));

function getLineage(node: TreeNode): TreeNode[] {
  const lineage: TreeNode[] = [];
  let current: TreeNode | undefined = node;

  while (current) {
    lineage.unshift(current);

    current = current.parentId
      ? nodeMap.get(current.parentId)
      : undefined;
  }

  return lineage;
}

function App() {
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);

  const lineage = selectedNode ? getLineage(selectedNode) : [];

  const layers = useMemo(
    () => [
      new LineLayer<TreeBranch>({
        id: 'branches',
        data: branches,
        getSourcePosition: (d) => d.source,
        getTargetPosition: (d) => d.target,
        getColor: [120, 125, 130],
        getWidth: 2,
        widthUnits: 'pixels',
      }),

      new ScatterplotLayer<TreeNode>({
        id: 'nodes',
        data: nodes,
        pickable: true,
        radiusUnits: 'pixels',
        getPosition: (d) => d.position,
        getRadius: (d) => (d.id === selectedNode?.id ? 9 : 6),
        getFillColor: (d) =>
          d.id === selectedNode?.id
            ? [46, 105, 190]
            : [55, 60, 65],
        onClick: (info: PickingInfo<TreeNode>) => {
          if (info.object) {
            setSelectedNode(info.object);
          }
        },
      }),

      new TextLayer<TreeNode>({
        id: 'labels',
        data: nodes,
        pickable: true,
        getPosition: (d) => d.position,
        getText: (d) => d.scientificName,
        getSize: 16,
        sizeUnits: 'pixels',
        getColor: [35, 38, 42],
        getPixelOffset: [0, -18],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'bottom',
        onClick: (info: PickingInfo<TreeNode>) => {
          if (info.object) {
            setSelectedNode(info.object);
          }
        },
      }),
    ],
    [selectedNode]
  );

  return (
    <main className="app">
      <DeckGL
        views={
          new OrthographicView({
            id: 'tree',
          })
        }
        initialViewState={{
          target: [0, 0, 0],
          zoom: 0,
          minZoom: -2,
          maxZoom: 8,
        }}
        controller={{
          dragPan: true,
          scrollZoom: true,
          doubleClickZoom: true,
          touchZoom: true,
          touchRotate: false,
          inertia: true,
        }}
        layers={layers}
        onClick={(info) => {
          if (!info.object) {
            setSelectedNode(null);
          }
        }}
      />

      <header className="top-bar">
        <div className="brand">
          <span className="brand-mark">●</span>
          Tree of Life
        </div>
      </header>

      {selectedNode && (
        <nav className="breadcrumbs" aria-label="Taxon lineage">
          {lineage.map((node, index) => (
            <span key={node.id}>
              {index > 0 && <span className="separator">›</span>}

              <button
                type="button"
                onClick={() => setSelectedNode(node)}
              >
                {node.scientificName}
              </button>
            </span>
          ))}
        </nav>
      )}

      <div className="instructions">
        Drag to explore · Scroll to zoom · Click a taxon
      </div>

      {selectedNode && (
        <aside className="detail-panel">
          <button
            type="button"
            className="close-button"
            onClick={() => setSelectedNode(null)}
            aria-label="Close details"
          >
            ×
          </button>

          <div className="rank">
            {selectedNode.rank ?? 'Taxon'}
          </div>

          <h1>{selectedNode.scientificName}</h1>

          {selectedNode.commonName && (
            <div className="common-name">
              {selectedNode.commonName}
            </div>
          )}

          <section>
            <h2>Lineage</h2>

            <div className="lineage">
              {lineage.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  onClick={() => setSelectedNode(node)}
                >
                  {node.scientificName}
                </button>
              ))}
            </div>
          </section>
        </aside>
      )}
    </main>
  );
}

export default App;