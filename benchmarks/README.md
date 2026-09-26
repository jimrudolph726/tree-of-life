# Streaming milestone measurements

These are historical measurements of the earlier streaming milestone. See [the Aves milestone](aves-milestone.md) for the larger biological dataset, broad-clade support and sustained browser checks.

Measured locally on 24 September 2026: Windows 11, Intel Core i5-10500, about 32 GiB RAM, Node 24.15.0. Raw reports live in [results/](results/). These are generated topology fixtures, not biological datasets or a comparison with Lifemap's servers.

## What was measured

`npm run benchmark:build` creates six reproducible datasets in `.benchmarks/`, each in a fresh Node process. It measures the offline build, opens an overview through the same `TreeStore` used by the worker, searches the final fixture ID, focuses that node, then runs 24 warm queries around it. File reads replace HTTP for these measurements. Cooperative traversal yields are included in query duration.

Balanced fixtures have four children per internal node. Unbalanced fixtures begin with a 256-level comb before the broad subtree. Their overviews have very different visible complexity; faster unbalanced overview queries do not imply a universal speed advantage.

| Shape | Nodes | Maximum depth | First query | Overview payload | Search + focused query | Warm focused query p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Balanced | 10,000 | 7 | 68.28 ms | 166.0 KiB | 4.42 ms | 0.100 ms |
| Unbalanced | 10,000 | 263 | 3.63 ms | 83.0 KiB | 6.44 ms | 0.111 ms |
| Balanced | 100,000 | 9 | 48.91 ms | 83.0 KiB | 7.99 ms | 0.160 ms |
| Unbalanced | 100,000 | 265 | 6.33 ms | 83.0 KiB | 9.25 ms | 0.158 ms |
| Balanced | 1,000,000 | 10 | 101.22 ms | 166.0 KiB | 8.35 ms | 0.101 ms |
| Unbalanced | 1,000,000 | 266 | 2.88 ms | 83.0 KiB | 11.38 ms | 0.164 ms |

The million-node overviews requested **two pages and one page**, respectively. No overview or focused query hit the scene budget. The million-node build took 12.5–13.6 seconds, generated about 252 MiB of uncompressed files per fixture, and peaked near 800 MiB process RSS. After search/focus and the warm sequence, cache charges were 3.11 MiB and 3.43 MiB against a 24 MiB limit.

Payload totals exclude the manifest and mean decoded response bytes, not compressed wire bytes. Cache charge estimates retained decoded pages at four times serialized size; it is not an actual heap measurement or a bound on all transient worker memory. Peak process RSS describes the offline builder, not browser memory. Search/focus timings above exclude browser input debounce, HTTP and painting.

## Browser check

Each development URL was opened in the Codex in-app Chromium browser at 1280 × 720, then **Run motion benchmark** animated a five-second pan/zoom sequence from the overview. Results were read from the visible diagnostic output and saved in [browser-local.json](results/browser-local.json).

| Shape | Nodes | First map | Frame interval p95 | Main-thread long tasks during motion | Sampled frames |
| --- | ---: | ---: | ---: | ---: | ---: |
| Balanced | 10,000 | 384 ms | 8.4 ms | 0 | 596 |
| Unbalanced | 10,000 | 367 ms | 8.4 ms | 0 | 595 |
| Balanced | 100,000 | 371 ms | 8.4 ms | 0 | 597 |
| Unbalanced | 100,000 | 399 ms | 8.4 ms | 0 | 593 |
| Balanced | 1,000,000 | 300 ms | 8.4 ms | 0 | 595 |
| Unbalanced | 1,000,000 | 290 ms | 8.4 ms | 0 | 597 |

These are single local runs with a reused browser/module cache, no throttling and a roughly 120 Hz animation cadence. The intervals are `requestAnimationFrame` timings, **not GPU execution times**. First-map timing includes page startup until the first rendered scene; it does not establish a cold-cache production latency. Long-task counts cover motion only. Reported main-thread heap ranged about 44–62 MiB and excludes worker memory. One 100k run was repeated after a source edit caused a development reload.

The unbalanced million-node fixture was also searched for `test-0999999`: the node at depth 266 appeared with distinct geometry, highlighted ancestry and a complete details panel. The production build was checked at 390 × 844 with real Primates search, selected-clade fitting and readable labels. No console warnings or errors appeared during those checks.

## Reproduce

1. Run `npm ci`, `npm run benchmark:build`, then `npm run dev`.
2. Open `/?dataset=balanced-1000000&bench=1` or `/?dataset=unbalanced-1000000&bench=1`; replace the size with `10000` or `100000` for other fixtures.
3. Click **Run motion benchmark**, wait for it to finish, and copy the displayed JSON. Run multiple iterations and report the device, browser, cache state and viewport when comparing results.
4. Search the last fixture ID (`test-0009999`, `test-0099999`, or `test-0999999`) to exercise indexed lookup and coordinate-frame changes.
5. Use `npm test` for automated topology, streaming, eviction, cancellation, corruption, deep-frame and camera regressions.

## What this establishes, and what remains

The runtime does not need all million node records to display an overview or reach a deep search result. Overview page counts stay small; worker queries and local coordinate frames make tree size and depth manageable in these fixtures. The real Primates view continues to work with the same pipeline.

A full-tree release still needs real large OpenTree ingestion, fanout partitioning for clades exceeding 12,000 immediate children, larger-scale disk-backed preprocessing if build memory becomes limiting, actual worker-heap measurement, and repeated tests on low-memory devices and slower CDN connections. Browser integration checks here are manual, not CI automation. Production JavaScript still includes roughly 285 kB of gzipped main-bundle code, primarily the visualization stack; Vite reports its normal chunk-size advisory. The GitHub Actions workflow has been added but has not been run remotely.
