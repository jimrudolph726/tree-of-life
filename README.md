# Tree of Life — OpenTree Explorer

A React + TypeScript + deck.gl explorer inspired by [Lifemap](https://lifemap.cnrs.fr/). The default is the **complete OpenTree cellular-life synthesis**: **2,725,682 nodes, 2,599,664 named taxa and 2,385,875 tips**, from **opentree16.1**, taxonomy **3.7draft3**. Eukaryota, Archaea and Bacteria open together with visible subclades inviting exploration. Birds (32,055 nodes) and Primates (1,333 nodes) remain available in the dataset selector. Viruses are outside this source release.

## Run

Use **Node.js 24 LTS** (the data builder and tests use native TypeScript support).

```sh
npm ci
python -m pip install -r pipeline/requirements.txt
npm run data:life
npm run dev
```

The one-time `data:life` command downloads a pinned 40 MiB release archive, verifies its two complete Newick representations, and builds approximately 2.1 GiB of static assets. Allow several minutes and about 5 GiB of free disk space for source, staging and output; a production build needs another 2.1 GiB for `dist/`. Large source and generated files are ignored by Git. Their checksums and the importer are tracked. Subsequent development starts reuse the full publication; small datasets build automatically. After changing the full-tree layout, run `npm run data:life:build` again. Missing or stale source provenance stops development/production startup with a preparation command.

Open Vite's local URL. Drag to pan, scroll or pinch to zoom, and select a region, node or label to inspect it. Search accepts scientific names, word prefixes, common names when present, and OTT IDs. Arrow keys and Enter select a result. Back and Forward restore earlier selected views and camera positions; Home fits the tree. Breadcrumbs and descendants navigate between clades. The previous map remains visible while a selected destination loads.

```sh
npm test
npm run lint
npm run build
npm run preview
```

GitHub Actions runs unit tests, smaller-source audits, lint and app compilation on pushes and pull requests. A separate manually dispatched **Validate complete OpenTree release** workflow downloads, builds, exhaustively validates and benchmarks the full release. `npm run build:app` compiles the frontend without requiring the full publication; use `npm run build` for a complete runnable production artifact. Tests include topology, geometry, label collisions, mobile camera fitting, serialization, indexed search, deep coordinate frames, bounded caching, cancellation and corrupt-data recovery.

The Aves checks exhaustively compare every published ID, name, source label, parent edge, child link, depth and terminal count to the imported records. They also verify every ancestry-bundle entry. Python revalidates the original Newick edges and labels and three archived OpenTree API lineages. These checks establish faithful representation of the snapshot, not independent confirmation that every biological relationship is correct.

## Streaming architecture

1. **Python ingestion** converts the OpenTree Newick snapshot into node/parent records. Biopython remains the ingestion dependency.
2. **Offline TypeScript layout** (`pipeline/build-tree.ts`) computes nested half-disc geometry and subtree bounds. Keeping this numerical stage in TypeScript shares the binary contract and navigation types with the client. No layout computation runs in React.
3. **Versioned static pages** contain 512 nodes each, with fixed-width binary geometry and UTF-8 metadata. Breadth-first ordering groups overview levels together. A manifest points to a content-addressed dataset version; partitioned, sorted search blocks load when queried.
4. **A Web Worker** fetches, decodes, searches and traverses visible clades. An LRU accounting budget bounds retained decoded pages: 64 MiB for the full release, 24 MiB for smaller datasets. Subtree bounds, projected size and a viewport margin prune invisible or subpixel content. Each dynamically assembled scene is capped at 12,000 visits and 4,000 named nodes. Immutable versioned responses can also use the browser HTTP cache.
5. **React + deck.gl** draws the current scene using `OrthographicView`, transferable binary branch buffers, pickable nodes and a screen-space grid for label collisions. Scene requests are coalesced; camera animation does not rebuild the entire tree.

Clades with more than 64 immediate children have a paged spatial hierarchy over their child ranges. These index entries are routing data, never biological nodes. They prune offscreen and subpixel child circles without scanning all siblings. A 100,000-child regression verifies that late children are reachable and remain direct siblings. Collapsed broad clades retain a visible enclosing region. View budgets still limit the amount drawn in one frame.

Aves also includes compact ancestry and clade-summary bundles per node page. These carry the real ancestor IDs, metadata, local transforms and named descendant previews, avoiding serial geometry-page downloads to reconstruct deep lineages or populate a panel. All bundles and spatial indexes use the same bounded cache. Format 2 uses 88-byte geometry records; format 1 remains readable for older fixtures.

The full release adds a **78 KiB gzip opening overview**, a two-level search directory and spatial pages carrying ready-to-draw records. Up to eight spatial pages load concurrently. Unnamed branching points have zero-length display edges, exposing named groups without changing parent links or ancestry. Separate spatial routing can skip those zero-length vertices; exhaustive validation checks every routed child and every duplicated render record against the source-preserving geometry pages. Domain colors stay consistent through navigation. Display sizes and placement prioritize readability and are not measures of age or diversity.

Deep geometry uses **parent-relative translations and scales**. Search selects a nearby ancestor as the local coordinate frame. Zooming and panning can rebase that frame while preserving screen positions, avoiding the loss of precision caused by assigning every deep leaf one tiny global coordinate. The details panel retains the full ancestry independently of the visible scene.

The half-circle concept and square-root terminal-count weighting are described in [de Vienne, 2016, *Lifemap: Exploring the Entire Tree of Life*](https://doi.org/10.1371/journal.pbio.2001624). This implementation uses its own code and local OpenTree data, not Lifemap tiles or assets. Spatial distance represents navigation, not evolutionary time. Earlier layout experiments remain in `src/tree/`; they are not used for runtime layout.

## Data pipeline

The complete release uses `pipeline/import_release.py`, which compares all nodes and edges in the canonical-ID and name-bearing release Newicks with an iterative parser. Compact parent and UTF-8 label arrays keep millions of Python/JavaScript objects out of memory. The builder spills search entries into sorted disk partitions. Run these after preparing the full dataset:

```sh
npm run data:life:validate
npm run benchmark:life
```

Provenance is tracked in `data/processed/opentree/life/provenance.json`; large source/compact files live in `.opentree/opentree16.1/`. The complete publication lives in `public/data/life/<version>/`. The source retains official MRCA identifiers, unlike the smaller API exports. OpenTree does not use every name shown in Lifemap: the opening map uses real source clades such as Methanobacteria, Thermoprotei, Actinobacteria and Cyanobacteria, without substituting another taxonomy. See [the full-tree milestone report](benchmarks/life-milestone.md).

The smaller processed snapshots are included. To refresh Aves separately, or audit its archived source offline:

```sh
python -m pip install -r pipeline/requirements.txt
npm run data:import
npm run data:validate
npm run data:test
npm run data:build
```

`data:import` is the only command here requiring OpenTree network access. It checks the synthesis version before and after downloading, checks source tip counts and sample API lineages, and records checksums and supporting studies. The API's documented 25,000-tip ceiling is enforced; larger imports should use release downloads. Raw Aves responses and Newick live in `data/raw/opentree/aves/opentree16.1/`; processed nodes and provenance live in `data/processed/opentree/aves/`. The footer links to the published version/provenance manifest. LF line endings are pinned for checksummed scientific files.

The Newick `name_and_id` export omits IDs at many unnamed branching points. These retain snapshot-local anonymous IDs and their exact topology. API ancestry checks compare every named ancestor and every unnamed position in the path; they do not claim that local anonymous IDs are official OpenTree identifiers. Raw labels remain available as `sourceLabel`.

The original Primates commands remain available: `python pipeline/fetch_opentree_primates.py` and `python pipeline/process_opentree_primates.py`. That older snapshot has no verified synthesis-version provenance; the UI does not invent one.

For JSON imports, the ingestion contract is a flat array with unique `id`, `parentId` (null for the single root), and `scientificName`. Optional fields include `ottId`, `rank`, `commonName`, `isTerminal` and `isSyntheticNode`. The compact full-release input supplies the same metadata through an indexed reader. Terminal status is recomputed from edges. Invalid roots, duplicates, missing parents and disconnected cycles fail the build.

The browser opens `public/data/life/manifest.json` by default, then requests files under its immutable version directory. `?dataset=aves` and `?dataset=primates` select smaller snapshots. It does not download the complete original tree. Keep older deployed version directories available while clients may still reference them. Publish all version files before updating the manifest pointer; never overwrite an existing version's contents.

## Scale benchmarks

```sh
npm run benchmark:build
npm run dev
```

This generates balanced and deeply unbalanced trees at **10k, 100k and 1m nodes**, runs the shared data-store measurements, and saves reports in `benchmarks/results/`. The six generated datasets occupy about 560 MiB in ignored `.benchmarks/`; they are served only by the development server and excluded from production builds.

Open `/?dataset=balanced-1000000&bench=1` or `/?dataset=unbalanced-1000000&bench=1`. The same URL pattern supports 10000 and 100000. Search `test-0999999` to inspect a deep million-node target. `?bench=1` alone instruments the full release; add `dataset=aves` for the earlier bird benchmark. **Run motion benchmark** samples a five-second pan/zoom sequence; add `&duration=30` for sustained exploration. Search timing includes the input debounce; selection timing ends at the first scene paint containing the selected node, not the end of any camera animation.

For a reproducible slow HTTP connection, run `npm run build`, then `npm run preview:slow`. Open `http://127.0.0.1:4174/?bench=1&duration=30`. This localhost-only server gzip-compresses content, shares **1.6 Mbps** across concurrent responses, adds **150 ms response latency**, and disables the HTTP cache. It shapes the complete app including JavaScript, worker and dataset downloads. It does not emulate a phone CPU/GPU, radio or packet loss. Search `Camarhynchus psittacula` to exercise a real depth-60 lineage. See [the Aves milestone report](benchmarks/aves-milestone.md).

`npm run benchmark:real` separately measures the shared store against Aves at desktop and small-screen dimensions, with 720 camera queries across the root, a deep tip and Passeriformes. Its file-backed timings exclude HTTP and drawing; results are saved to `benchmarks/results/aves-store.json`.

See [the benchmark report](benchmarks/README.md) for measurements and limits. Scene-query timings measure worker/store work, not GPU rendering. Browser frame intervals measure animation cadence, not GPU time. Payload counters are decoded bytes, not compressed network transfer. Cache charge is a conservative size estimate, not a measured heap limit. Browser main-thread heap excludes the worker.

## Deployment and remaining limits

The S3 + CloudFront staging implementation, local delivery checks, manual deployment/rollback commands and GitHub OIDC workflow are documented in [infra/README.md](infra/README.md). Provisioning requires an authenticated AWS account plus a chosen budget-alert email and threshold. Preparing these files does not create a hosted site.

The staging site is live at https://dgilsep5ai167.cloudfront.net/. Commit and push to `main` from VS Code normally: GitHub automatically validates, builds and deploys the revision to AWS. The live site changes only after the deployment job's checks and upload verification pass. Other branches do not deploy. GitHub **Actions → Deploy or roll back staging → Run workflow** remains available for manual retry (leave the release field blank) or rollback (enter a retained release ID). Builds run in the background and can take several minutes; pushing does not update AWS instantly.

Build and serve `dist/` on a static host. Data requests respect Vite's `base`; configure it in `vite.config.ts` for a repository subpath. For CDN hosting, compress JSON and binary pages, cache versioned URLs as immutable, and revalidate the manifest. FastAPI and PostgreSQL are unnecessary for this static navigation milestone; they can support later annotations, accounts or live metadata.

The complete cellular-life release is available locally, with reproducible build and validation commands; this is not a hosted production deployment. The current full build peaks around 1.5 GiB process RSS, with search partitions sorted on disk. Search uses word-prefix matching, not fuzzy or arbitrary substring matching. Broad child lists use spatial partitions; one scene still has a bounded work budget. The descendants panel caps its initial list at 100 entries. Spatial distance and angular placement are display choices; they do not imply branch lengths or evolutionary time.

Scientific names and topology come from the pinned snapshots. There is no live taxonomy refresh, inferred rank or encyclopedia enrichment. Before public deployment, measure actual low-memory phones and worker heap, configure compression and immutable caching, and validate CDN behavior. Browser checks are presently manual; CI covers scientific and streaming regressions. The 64 MiB cache charge is a conservative accounting estimate, not a measured bound on total browser or worker heap.
