import {
  useCallback,
  useMemo,
  useState,
} from 'react';

import { DeckGL } from '@deck.gl/react';

import {
  LinearInterpolator,
  OrthographicView,
} from '@deck.gl/core';

import type {
  OrthographicViewState,
  PickingInfo,
} from '@deck.gl/core';

import {
  LineLayer,
  ScatterplotLayer,
  TextLayer,
} from '@deck.gl/layers';

import { primateNodes } from './data/primates';

import { layoutTree } from './tree/layoutTree';

import type {
  LayoutTreeNode,
  TreeBranch,
} from './tree/types';

import './App.css';


type CameraState =
  OrthographicViewState & {
    transitionDuration?: number;
    transitionInterpolator?: LinearInterpolator;
    transitionEasing?: (
      t: number
    ) => number;
  };


const {
  nodes,
  branches,
} = layoutTree(
  primateNodes,
  'primates'
);


const nodeMap = new Map(
  nodes.map((node) => [
    node.id,
    node,
  ])
);


const INITIAL_CAMERA: CameraState = {
  target: [0, 0, 0],

  zoom: -1.3,

  minZoom: -2.5,
  maxZoom: 7,
};


function getLineage(
  node: LayoutTreeNode
): LayoutTreeNode[] {

  const lineage:
    LayoutTreeNode[] = [];

  let current:
    LayoutTreeNode | undefined =
      node;


  while (current) {

    lineage.unshift(current);

    current =
      current.parentId
        ? nodeMap.get(
            current.parentId
          )
        : undefined;
  }


  return lineage;
}


/*
  Automatically decide how closely we
  should focus a taxon.

  Deeper taxa require progressively
  greater zoom.
*/
function getFocusZoom(
  node: LayoutTreeNode
): number {

  if (node.depth === 0) {
    return -1.2;
  }


  return Math.min(
    4.5,
    -0.5 +
      node.depth * 0.5
  );
}


/*
  Determines when a label becomes
  useful enough to display.

  Deep taxa aren't shown while looking
  at the entire primate tree.
*/
function getLabelMinZoom(
  node: LayoutTreeNode
): number {

  if (node.depth <= 1) {
    return -2;
  }


  return (
    -1 +
    (node.depth - 1) * 0.55
  );
}


function easeOutCubic(
  t: number
): number {

  return (
    1 -
    Math.pow(
      1 - t,
      3
    )
  );
}


function App() {

  const [
    selectedNode,
    setSelectedNode,
  ] =
    useState<
      LayoutTreeNode | null
    >(null);


  const [
    camera,
    setCamera,
  ] =
    useState<CameraState>(
      INITIAL_CAMERA
    );


  const lineage =
    selectedNode
      ? getLineage(
          selectedNode
        )
      : [];


  const lineageIds =
    useMemo(
      () =>
        new Set(
          lineage.map(
            (node) =>
              node.id
          )
        ),
      [lineage]
    );


  const focusNode =
    useCallback(
      (
        node:
          LayoutTreeNode
      ) => {

        setSelectedNode(
          node
        );


        setCamera(
          (current) => ({
            ...current,

            target: [
              node.position[0],
              node.position[1],
              0,
            ],

            zoom:
              getFocusZoom(
                node
              ),

            transitionDuration:
              700,

            transitionInterpolator:
              new LinearInterpolator([
                'target',
                'zoom',
              ]),

            transitionEasing:
              easeOutCubic,
          })
        );
      },
      []
    );


  const goHome =
    useCallback(
      () => {

        setSelectedNode(
          null
        );


        setCamera({
          ...INITIAL_CAMERA,

          transitionDuration:
            800,

          transitionInterpolator:
            new LinearInterpolator([
              'target',
              'zoom',
            ]),

          transitionEasing:
            easeOutCubic,
        });
      },
      []
    );


  /*
    This is our first form of
    SEMANTIC ZOOM.

    Deep labels are not merely made
    smaller.

    They don't exist visually until
    we're close enough for them to
    be meaningful.
  */
  const visibleLabelNodes =
    useMemo(
      () =>
        nodes.filter(
          (node) => {

            if (
              node.id ===
              selectedNode?.id
            ) {
              return true;
            }


            if (
              lineageIds.has(
                node.id
              )
            ) {
              return true;
            }


            return (
              camera.zoom >=
              getLabelMinZoom(
                node
              )
            );
          }
        ),

      [
        camera.zoom,
        selectedNode,
        lineageIds,
      ]
    );


  const layers =
    useMemo(
      () => [

        new LineLayer<TreeBranch>({
          id: 'branches',

          data: branches,

          getSourcePosition:
            (d) =>
              d.source,

          getTargetPosition:
            (d) =>
              d.target,

          getColor:
            (d) =>
              lineageIds.has(
                d.targetId
              )
                ? [
                    70,
                    105,
                    145,
                  ]
                : [
                    145,
                    148,
                    150,
                  ],

          getWidth:
            (d) =>
              lineageIds.has(
                d.targetId
              )
                ? 3
                : 1.5,

          widthUnits:
            'pixels',

          updateTriggers: {
            getColor:
              lineageIds,

            getWidth:
              lineageIds,
          },
        }),


        new ScatterplotLayer<
          LayoutTreeNode
        >({
          id: 'nodes',

          data: nodes,

          pickable: true,

          radiusUnits:
            'pixels',

          getPosition:
            (d) =>
              d.position,

          getRadius:
            (d) => {

              if (
                d.id ===
                selectedNode?.id
              ) {
                return 10;
              }


              if (
                lineageIds.has(
                  d.id
                )
              ) {
                return 7;
              }


              return 5;
            },

          getFillColor:
            (d) => {

              if (
                d.id ===
                selectedNode?.id
              ) {
                return [
                  46,
                  105,
                  190,
                ];
              }


              if (
                lineageIds.has(
                  d.id
                )
              ) {
                return [
                  90,
                  115,
                  145,
                ];
              }


              return [
                55,
                60,
                65,
              ];
            },

          onClick:
            (
              info:
                PickingInfo<
                  LayoutTreeNode
                >
            ) => {

              if (
                info.object
              ) {
                focusNode(
                  info.object
                );
              }
            },
        }),


        new TextLayer<
          LayoutTreeNode
        >({
          id: 'labels',

          data:
            visibleLabelNodes,

          pickable: true,

          getPosition:
            (d) =>
              d.position,

          getText:
            (d) =>
              d.scientificName,

          getSize: 15,

          sizeUnits:
            'pixels',

          getColor: [
            35,
            38,
            42,
          ],

          getPixelOffset: [
            0,
            -16,
          ],

          getTextAnchor:
            'middle',

          getAlignmentBaseline:
            'bottom',

          onClick:
            (
              info:
                PickingInfo<
                  LayoutTreeNode
                >
            ) => {

              if (
                info.object
              ) {
                focusNode(
                  info.object
                );
              }
            },
        }),
      ],

      [
        selectedNode,
        visibleLabelNodes,
        lineageIds,
        focusNode,
      ]
    );


  return (
    <main className="app">

      <DeckGL
        views={
          new OrthographicView({
            id: 'tree',
          })
        }

        viewState={
          camera
        }

        controller={{
          dragPan: true,

          scrollZoom: {
            speed: 0.01,
            smooth: true,
          },

          doubleClickZoom:
            false,

          touchZoom: true,

          touchRotate: false,

          inertia: true,
        }}

        layers={
          layers
        }

        onViewStateChange={(
          event
        ) => {

          setCamera(
            event.viewState as CameraState
          );
        }}

        onClick={(
          info
        ) => {

          if (
            !info.object
          ) {
            setSelectedNode(
              null
            );
          }
        }}
      />


      <header className="top-bar">

        <div className="brand">

          <span className="brand-mark">
            ●
          </span>

          Tree of Life

        </div>


        <button
          type="button"
          className="home-button"
          onClick={
            goHome
          }
        >
          Home
        </button>

      </header>


      {selectedNode && (

        <nav
          className="breadcrumbs"
          aria-label="Taxon lineage"
        >

          {lineage.map(
            (
              node,
              index
            ) => (

              <span
                key={
                  node.id
                }
              >

                {index >
                  0 && (

                  <span className="separator">
                    ›
                  </span>
                )}


                <button
                  type="button"
                  onClick={() =>
                    focusNode(
                      node
                    )
                  }
                >
                  {
                    node.scientificName
                  }
                </button>

              </span>
            )
          )}

        </nav>
      )}


      <div className="instructions">
        Drag to explore ·
        Scroll to zoom ·
        Click a taxon
      </div>


      {selectedNode && (

        <aside className="detail-panel">

          <button
            type="button"
            className="close-button"
            onClick={() =>
              setSelectedNode(
                null
              )
            }
            aria-label="Close details"
          >
            ×
          </button>


          <div className="rank">
            {
              selectedNode.rank ??
              'Taxon'
            }
          </div>


          <h1>
            {
              selectedNode.scientificName
            }
          </h1>


          {selectedNode.commonName && (

            <div className="common-name">
              {
                selectedNode.commonName
              }
            </div>

          )}


          <section>

            <h2>
              Tree
            </h2>

            <p>
              {
                selectedNode.leafCount
              }{' '}
              terminal{' '}
              {
                selectedNode.leafCount === 1
                  ? 'taxon'
                  : 'taxa'
              }{' '}
              in this prototype subtree
            </p>

          </section>


          <section>

            <h2>
              Lineage
            </h2>


            <div className="lineage">

              {lineage.map(
                (node) => (

                  <button
                    type="button"
                    key={
                      node.id
                    }
                    onClick={() =>
                      focusNode(
                        node
                      )
                    }
                  >
                    {
                      node.scientificName
                    }
                  </button>

                )
              )}

            </div>

          </section>

        </aside>
      )}

    </main>
  );
}


export default App;