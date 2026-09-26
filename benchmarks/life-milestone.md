# Complete tree-of-life explorer

This milestone publishes the complete **OpenTree 16.1 cellular-life synthesis** locally: **2,725,682 nodes, 2,599,664 named taxa, 2,385,875 tips and 2,725,681 edges**. Maximum source depth is **111**, and the broadest source node has **12,964 immediate children**. The source taxonomy is **3.7draft3**. Viruses are outside this release.

## Opening experience

The three source children of cellular organisms—Eukaryota, Archaea and Bacteria—receive comparable space and consistent colors. Before interacting, desktop visitors can see Fungi and Opisthokonta, Methanobacteria and Thermoprotei, and Actinobacteria and Cyanobacteria. Label priorities and alternate placements prevent important neighboring labels from covering each other. Smaller screens retain the three main entry points and a reduced label set.

These microbial names deliberately follow OpenTree. They are not replaced with similarly placed names from Lifemap's different taxonomy. The layout adjusts display distances and collapses unnamed vertices to zero-length display edges; it does not change biological parent links. Map area and distance do not represent age, abundance or a scientific branch-length estimate.

Regions, labels and nodes are clickable. Search jumps across the full release, breadcrumbs and descendant lists navigate ancestry, and Back/Forward restore previous views. A selected destination is prepared while the previous map remains visible. Aves and Primates remain separately selectable.

## Source integrity

The [official release](https://tree.opentreeoflife.org/about/synthesis-release/v16.1) supplies both canonical-ID and name-bearing complete Newick trees. The importer parses them independently with an explicit stack and compares every node, source identifier and edge. It also checks the [release's source statistics](https://files.opentreeoflife.org/synthesis/opentree16.1/output/labelled_supertree/input_output_stats.json). Both files, their archive and configuration are pinned by SHA-256 in `data/processed/opentree/life/provenance.json`.

The full publication audit compares every ID, raw label, derived display name, parent edge, child link, depth and terminal count to the compact imported data. It checks finite geometry and all **813,520** display-routing targets. A routed edge may skip only source unnamed vertices with zero-length display transforms. Every duplicated render record is checked against a fingerprint of the canonical published record, and every routed frontier is checked for completeness and duplicates.

Raw source labels are retained; display names apply Newick underscore normalization. These checks establish faithful representation of a versioned synthesis, not independent proof of every biological relationship in it. Source unresolved relationships and non-monophyletic taxa are not silently repaired.

## Delivery and memory

The initial overview is **194,465 bytes decoded / 79,900 bytes gzip**, requested as one data packet. It includes actual source IDs and geometry and joins the same coordinate system used by deeper navigation. Search uses a small top directory and fetches relevant directory and term blocks. It does not download a complete taxon-name index.

Spatial routing pages contain render records for visible named groups, avoiding hundreds of unrelated source-geometry page downloads just to traverse unnamed vertices. Small routing leaves reduce unused metadata in a packet; up to eight index pages load concurrently. All retained data uses a **64 MiB cache accounting budget** for the full release (24 MiB for smaller datasets). Versioned HTTP responses can also use the browser cache. Geometry and rendering work remain bounded independently of total source size.

The offline importer uses compact parent and UTF-8 label arrays. The builder partitions search sorting on disk. Large source and generated files are ignored by Git and recreated with `npm run data:life`; provenance, tests and reports are tracked. The static publication is 2,282,693,635 bytes (2.13 GiB), which is the deployable data collection, not a browser download per visit. Local production builds copy that collection to `dist/`. The measured build took 214.6 seconds and peaked at 1,516 MiB process RSS on Node 24.15.0.

## Reproduction and results

```sh
python -m pip install -r pipeline/requirements.txt
npm run data:life
npm run data:life:validate
npm run data:test
npm test
npm run lint
npm run build
npm run benchmark:life
```

The full-release workflow in GitHub Actions is manually dispatched. Ordinary push/PR CI covers unit regressions, the smaller scientific audits, lint and app compilation without repeatedly downloading and building the multi-gigabyte publication.

Machine-readable results:

- [Build size and memory](results/life-build.json)
- [Exhaustive source and routing validation](results/life-validation.json)
- [Shared-store exploration benchmark](results/life-store.json)
- [Production browser checks](results/life-browser.json)

Publication `0735fe894f146d1b` passed the exhaustive audit, 23 Node tests, eight Python tests and ESLint. The production build passes with Vite's large-chunk advisory.

Manual production-browser measurements on this Windows desktop:

| Check | Desktop, localhost | 390 × 844, simulated slow HTTP |
| --- | ---: | ---: |
| First map | 603 ms | 4,462 ms |
| 30-second opening motion, frame p95 | 8.4 ms | 8.4 ms |
| Long main-thread tasks during opening motion | 0 | 0 |
| Homo sapiens search | 193 ms | 1,903 ms |
| Homo sapiens selection to first target paint | 56 ms | 2,079 ms |

The desktop browser may reuse previously visited app assets. The slow server disables HTTP caching and shares 1.6 Mbps across responses with 150 ms added latency. Its opening motion remains within the overview packet at this viewport. A first Fungi search took 4.01 seconds and selection preparation took 8.28 seconds on that connection; the previous map remained visible. A separate 30-second motion run inside Fungi recorded 8.4 ms frame p95, zero long main-thread tasks and nine additional requests, ending at 59.7 MiB cache charge. These cold detailed-clade waits remain an optimization target, even though camera motion stays responsive. Back and Forward restored the deep human selection correctly. Neither browser run reported console warnings or errors.

The store benchmark exercises 600 camera queries across five selections at 1280 × 720 and 390 × 844, checks every scene's finite coordinates and cache charge, and verifies the opening labels. None of these views hit the traversal limit. Across the five selections, desktop reads totaled 27.8 MiB and narrow-screen reads totaled 27.9 MiB decoded. Selection preparation ranged from 6.8–126.0 ms; the slowest per-clade exploration p95 was 95.1 ms. These are filesystem-backed store timings, excluding HTTP and GPU drawing. Browser motion measurements report animation-frame cadence, not GPU execution time; main-thread heap measurements exclude worker memory.

## Practical limits

This is a complete local release, not a public deployment or a comparison with Lifemap's servers. Actual low-memory phones, worker heap and a real CDN remain to be tested. Narrow viewport checks run on desktop hardware. The slow preview shapes HTTP bandwidth and response latency; it does not emulate radio conditions, packet loss or a slower CPU/GPU.

The opening data is small, but a cold jump into a detailed clade still has to fetch its relevant pages. Coarse geometry stays visible while worker queries refine it. Search currently supports name/word prefixes and OTT IDs; it is not fuzzy search. The initial descendants list is capped at 100. The app bundle retains Vite's large-chunk advisory (about 286 KiB gzip for the main JavaScript bundle).
