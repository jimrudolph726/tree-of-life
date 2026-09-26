# Larger OpenTree milestone

Measured locally on 24 September 2026 (some report timestamps are 25 September UTC), Windows 11, Intel Core i5-10500, about 32 GiB RAM, Node 24.15.0, Python 3.13.9 and the Codex in-app Chromium browser. Dataset version: `c55fd05c37ffd490`.

## Dataset and scientific checks

The default dataset is the complete **Aves** subtree, OTT **81461**, from synthesis **opentree16.1** and taxonomy **3.7draft3**: **32,055 nodes, 23,125 named taxa, 18,988 tips and 32,054 edges**. This is about **24 times** the original 1,333-node Primates snapshot. Maximum depth is 60; the broadest real node has 123 immediate children.

Raw Newick, source metadata and three API lineage responses are archived under `data/raw/opentree/aves/opentree16.1/`. Processed provenance records retrieval time, checksums, source URLs, supporting studies and versions. The importer checks that synthesis metadata is unchanged across retrieval. The [OpenTree subtree API](https://github.com/OpenTreeOfLife/germinator/wiki/Synthetic-tree-API-v3) limits a request to 25,000 tips; Aves fits this limit. Full-tree imports should use release downloads.

Python independently checks imported labels and edges against the source Newick and verifies archived API ancestry for Camarhynchus psittacula, Polioptila guianensis and Lepidocolaptes albolineatus. Node tests compare every published ID, name, raw source label, parent edge, child link, depth and terminal count with the imported records, check finite geometry, and verify ancestry bundles and descendant previews. The source's unnamed branching points retain their positions and relationships with snapshot-local IDs; these IDs are not represented as official OpenTree identifiers. These checks validate faithful import and display of this snapshot, not the biological truth of every relationship.

Source audit: [aves-source-validation.json](results/aves-source-validation.json).

## Broad clades and deep navigation

Parents with more than 64 immediate children use paged spatial indexes over contiguous child ranges. Index entries are separate from biological nodes, so the original direct parent/child relationships remain intact. A generated **100,000-child star** regression reaches the last child with fewer than 25 page requests and 200 scene visits, checks its direct parent and ancestry, and verifies that the collapsed overview remains visible. The real Aves dataset does not itself exercise this extreme fanout.

Per-page ancestry bundles avoid a serial geometry-page request for each ancestor. Named descendant previews also prevent details panels from downloading many geometry pages simply to cross unnamed branching points. The measured depth-60 path dropped from **43 requests / 5.6 MiB decoded** before this optimization to **5 requests / 400 KiB decoded**, including the overview, search and focused scene. Cache accounting fell from 22.4 MiB to 1.6 MiB. These are decoded payload and estimated retained-cache figures, not wire bytes or measured worker heap.

## Reproducible checks

```sh
npm run data:test
npm run data:validate
npm run data:build
npm test
npm run lint
npm run build
npm run benchmark:real
```

All **5 Python tests and 21 Node tests** passed, along with offline source validation, lint, TypeScript and the production build. The offline audit rejects changed processed records or archived Newick without silently regenerating the data under inspection. CI now repeats the scientific checks without contacting OpenTree.

The file-backed shared-store benchmark makes **720 camera queries** across Aves, the depth-60 tip and Passeriformes at 1280 × 720 and 390 × 844. All views retained finite geometry and stayed within scene/cache budgets. Warm-query p95 ranged from **0.03 to 16.2 ms**; cooperative yielding contributes to the higher figures. These timings exclude HTTP and GPU rendering. Raw results: [aves-store.json](results/aves-store.json).

For browser checks, build and run `npm run preview` for normal local delivery, or `npm run preview:slow` for a shared **1.6 Mbps**, **150 ms response-latency** profile. The slow server gzip-compresses the app and data, disables the HTTP cache and listens only on localhost. Open `/?bench=1&duration=30`, run the motion benchmark, search for `Camarhynchus psittacula`, select it and repeat the motion benchmark. Navigate to Passeriformes through its lineage and return home. The browser reports visible measurements in its diagnostics panel.

Browser results are recorded in [aves-browser.json](results/aves-browser.json):

| Check | Desktop, normal localhost | 390 × 844, throttled HTTP |
| --- | ---: | ---: |
| First map | 602 ms | 4,441 ms |
| Overview motion frame interval p95 | 8.4 ms | 8.4 ms |
| Main-thread long tasks during overview motion | 0 | 0 |
| Cold deep-target search | 178 ms | 916 ms |
| Deep-target selection to paint | 64 ms | 419 ms |
| Data requests through deep selection | 5 | 5 |

The narrow-screen depth-60 view also completed a separate 30-second motion run at 8.4 ms frame-interval p95, with no long tasks or additional requests. Navigating from that tip to the large Passeriformes clade took **3,262 ms** on the shaped connection, reaching 13 cumulative requests and a 6.2 MiB cache charge. Returning home succeeded. No browser console warnings or errors were recorded. Cold startup and uncached large-clade navigation remain the slowest interactions in this profile.

Visual inspection at 390 × 844 confirmed the normal overview, search, focused tip, scrollable lineage and bottom details panel. The dataset selector successfully switched to Primates and back to Aves. Temporary viewport overrides were reset after testing.

## Limits

These are local reproducible checks, not a comparison with Lifemap's servers. A narrow viewport on this desktop does not emulate a phone CPU, GPU or memory limit. HTTP shaping does not emulate radio conditions, packet loss or a production CDN. Frame intervals measure animation cadence rather than GPU execution; main-thread heap excludes the worker. Search timing includes input debounce; selection timing ends at the first scene paint containing the selected node, before camera animation necessarily ends. Long-task counts cover the motion interval.

The initial app bundle remains about 285 KiB gzip. Actual low-memory phone testing, worker-heap profiling and production CDN checks remain necessary before a full-tree release. The production build reports a large-chunk advisory. Scene work and the first 100 named descendants remain intentionally bounded; broad biological clades are no longer rejected for their child count.
