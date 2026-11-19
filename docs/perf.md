# Performance (Phase 5)

Measured on 18 Nov 2026 with `scripts/bench-ui.ts` against the built app and a local `mongod`
8.2.6 (WiredTiger cache 2 GB) seeded by `scripts/seed-bench.ts`.

- Machine: Apple Silicon (arm64, 10 cores, 16 GB RAM), macOS, 60 Hz display, window 1440×900.
- Dataset: `bench.docs`, 1,000,000 documents averaging 1,989 bytes (1.85 GB uncompressed),
  with nested objects, arrays of sub-documents, Int32/Int64/Double/Decimal128/Date values.
  `bench.huge`: three ~10 MB documents (an array of ~170k sub-documents, a 10 MB string,
  10 MB of binary).
- The app shows 25 documents per page (classic paging, see PLAN.md Phase 5), so "scrolling
  50k documents" is measured as paging through 2,000 pages.

## Budgets

| Budget                                         | Target    | Result                                                 |     |
| ---------------------------------------------- | --------- | ------------------------------------------------------ | --- |
| First page visible after the query returns     | < 300 ms  | **28 ms** render (31 ms from click, incl. 3 ms query)  | ✅  |
| Scrolling                                      | 60 fps    | **60 fps**, 0 slow frames (> 25 ms), p95 frame 17.4 ms | ✅  |
| Renderer memory after 50k documents            | < 500 MB  | **336 MB** working set (66 MB JS heap)                 | ✅  |
| Opening a 10 MB document doesn't freeze the UI | no freeze | **≤ 75 ms** longest main-thread block (was 1,178 ms)   | ✅  |

## Details

First page of `bench.docs` (median of 5 runs; query = request → decoded documents, render = decoded → painted):

| View  | Query  | Render  | Total   |
| ----- | ------ | ------- | ------- |
| Tree  | 3.3 ms | 27.7 ms | 31.2 ms |
| JSON  | 3.0 ms | 30.7 ms | 33.7 ms |
| Table | 3.4 ms | 28.0 ms | 31.3 ms |

Scrolling a fully expanded page (rAF-driven, 4 s): tree 60.1 fps, JSON 60.0 fps, 0 slow frames each.

Memory (Electron process working set; JS heap from `performance.memory` after a forced GC):

| When                                              | Renderer | Renderer JS heap | Main   |
| ------------------------------------------------- | -------- | ---------------- | ------ |
| After the first page                              | 272 MB   | 48 MB            | 188 MB |
| After paging 2,000 pages (50,000 documents, 96 s) | 336 MB   | 66 MB            | 180 MB |
| After also opening the three 10 MB documents      | 435 MB   | 206 MB           | 396 MB |

The renderer only ever holds the current page, so memory stays flat while paging.

10 MB documents (`bench.huge`, all three on one page):

| View  | Query | Render | Longest main-thread block |
| ----- | ----- | ------ | ------------------------- |
| Tree  | 90 ms | 6 ms   | 60 ms                     |
| JSON  | 83 ms | 16 ms  | 75 ms                     |
| Table | 72 ms | 4 ms   | 54 ms                     |

Expanding the ~170k-item array in the tree: 38 ms, no long tasks (50 items render at a time).

## What made the difference

- **Raw BSON over IPC** (hard rule 3 changed, Nov 2026). Canonical EJSON for the 10 MB array
  document cost ~177 ms to build in main, ~258 ms to copy over IPC and ~483 ms to decode in the
  renderer, a 1.2 s freeze. Raw BSON bytes straight from the driver (`raw: true`): no encode in
  main, ~1 ms copy, ~52 ms decode. Types are preserved by construction.
- **Bounded formatting.** Huge strings/binaries are formatted only as far as they're shown
  (tree: 300 chars, table: 500 chars, JSON view: 100 KB), and the JSON view never builds the full
  text of a > 1 MB document until "Show all" is clicked.
- **Lazy trees.** Nested values start collapsed; arrays render 50 children at a time.

## Known limits

- **Deep pages are slow on big collections.** "Last page" of 1M documents takes ~950 ms, almost
  all of it the server skipping 999,975 documents (`skip` is O(n), as in Compass). Shallow pages
  are ~3 ms. A future improvement: serve "Last" by reversing the sort, and keyset paging when the
  sort is on an indexed field.
- "Show all" on a multi-megabyte string or a > 1 MB document in the JSON view builds the full text
  synchronously; it's user-initiated and labelled "may take a moment".

## Reproduce

```sh
mongod --dbpath /tmp/benchdb --port 27999 --wiredTigerCacheSizeGB 2      # any local mongod
npx tsx scripts/seed-bench.ts mongodb://127.0.0.1:27999                  # ~30 s
npm run build
npx tsx scripts/bench-ui.ts mongodb://127.0.0.1:27999 2000               # ~2.5 min, writes bench-results.json
```

# Export memory (Phase 12)

Measured on 19 Nov 2026 with `PERF=1 npx playwright test tests/e2e/perf-export.spec.ts` (built app,
same machine): 1,000,000 documents (~230 bytes each: nested object, array of sub-documents,
Double, Date) exported as canonical-EJSON JSON lines through the UI. Main-process memory is
sampled inside the main process every 10 ms.

| Budget                                 | Target   | Result                                                 |     |
| -------------------------------------- | -------- | ------------------------------------------------------ | --- |
| Main-process memory while exporting 1M | < 300 MB | **291 MB** peak RSS (213 MB idle), 2.3 s, ~425k docs/s | ✅  |

How it stays flat: the cursor returns raw BSON (`raw: true`), each document is written as
EJSON straight from its bytes (`ejson-writer.ts`, byte-identical to `EJSON.stringify`, no
decoded objects), output goes through one reusable 1 MB buffer, and nothing awaits per document.

| Version                                                 | Peak RSS           |
| ------------------------------------------------------- | ------------------ |
| Decode each batch + `EJSON.stringify` + a write per doc | 350–357 MB         |
| Raw cursor, decode one at a time, 256 KB string chunks  | 291–355 MB (noisy) |
| Direct BSON → EJSON writer                              | 291–296 MB         |
| + reusable output buffer, no per-document await         | 291 MB             |

The margin is small: what remains is V8 growing its young generation under the allocation rate
(JS heap capacity 30 → 99 MB while live data stays ~30–60 MB); the idle 213 MB is mostly
Electron's own native memory. Writing bytes straight from BSON with no per-value strings would
cut it further if a slower machine ever goes over.
