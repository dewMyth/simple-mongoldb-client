# MongoDB Desktop Client: Implementation Plan

> An Electron + React + TypeScript MongoDB client in the spirit of MongoDB Compass, built to be **faster on large collections**, have a **smarter query editor** and work well with **many tabs open**.
> Working name: **Mongo Studio**. Rename freely.

This plan is meant to be run phase by phase in Claude Code. Each phase lists its tasks and a **Done when** checklist. Don't start a phase until the previous phase's checklist passes.

---

## 0. Decisions already made

| Area | Decision |
|---|---|
| Shell | Electron (latest stable), `electron-vite` |
| UI | React 19 + TypeScript (strict) + Vite, Tailwind CSS, Radix UI primitives |
| State | Zustand (UI/tab state) + TanStack Query (async DB calls over IPC) |
| Editors | Monaco Editor (query bar, pipeline stages, JSON doc editor, shell input) |
| Lists/grids | TanStack Virtual (list/JSON views), TanStack Table + virtualization (table view) |
| DB driver | Official `mongodb` Node driver (v6+), **main process only** |
| Query parsing | `mongodb-query-parser` (the parser Compass uses), so Compass-style query strings behave the same |
| BSON over IPC | `bson` EJSON **canonical** mode, so every type survives the round trip |
| Schema analysis | `mongodb-schema` |
| Shell | `@mongosh/node-runtime-worker-thread` (what Compass uses), rendered with xterm.js |
| Permissions | Auto-detect privileges via `connectionStatus`, plus a per-connection read-only override |
| Secrets | Electron `safeStorage` (OS keychain-backed encryption) |
| Settings/history | `electron-store` (JSON) for v1 |
| Tests | Vitest (unit), `mongodb-memory-server` (integration), Playwright for Electron (E2E) |
| Packaging | `electron-builder` for macOS (dmg), Windows (nsis) and Linux (AppImage) |

**Before Phase 1:** have Claude Code check the current major versions and APIs of `mongodb-query-parser`, `@mongosh/node-runtime-worker-thread` and `mongodb-schema` on npm. They change, and their exported function names should be confirmed rather than assumed.

---

## 1. Architecture

```
┌──────────────────────────── Renderer (React, sandboxed) ───────────────────────────┐
│  Tabs ▸ Connection sidebar ▸ Query bar (Monaco) ▸ Results (List/JSON/Table)         │
│  Aggregation builder ▸ Indexes ▸ Explain ▸ Schema ▸ Shell (xterm) ▸ Import/Export   │
│                    window.api.*  (typed, via contextBridge)                         │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │ IPC (ipcRenderer.invoke / MessagePort streams)
┌───────────────────────────────────────▼─────────────────────────────────────────────┐
│ Main process                                                                        │
│  ConnectionManager (MongoClient pool per connection id)                             │
│  QueryService (parse → execute → stream cursor batches as canonical EJSON)          │
│  PermissionService (connectionStatus → privilege matrix per namespace)              │
│  CursorRegistry (open cursors, getMore, kill on tab close / timeout)                │
│  SchemaService ▸ IndexService ▸ ImportExportService ▸ StorageService (safeStorage)  │
│  ShellHost → worker thread running mongosh runtime                                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Hard rules (add these to `CLAUDE.md`):**
1. The renderer never imports `mongodb` or touches credentials. All DB work happens in main.
2. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Exactly one preload exposes a typed API.
3. Every IPC payload containing documents is **canonical EJSON** (`EJSON.serialize(doc, { relaxed: false })`). Never send plain `JSON.stringify`'d BSON.
4. User query text is **parsed, never `eval`'d**. Only `mongodb-query-parser` / the mongosh worker interpret user input.
5. All long operations accept a `maxTimeMS` and an abort signal. Closing a tab kills its cursors.

### Folder layout

```
src/
  main/
    index.ts                 # app lifecycle, window creation
    ipc/                     # one file per channel group, zod-validated inputs
    services/
      connection-manager.ts
      query-service.ts
      cursor-registry.ts
      permission-service.ts
      schema-service.ts
      index-service.ts
      import-export-service.ts
      storage-service.ts
      shell-host.ts
  preload/
    index.ts                 # contextBridge.exposeInMainWorld('api', …)
  shared/
    ipc-contract.ts          # request/response types shared by main + renderer
    ejson.ts                 # serialize/deserialize helpers
    bson-types.ts            # type tags, display + edit metadata
  renderer/
    app/                     # routes, layout, tab host
    features/
      connections/
      documents/             # list/json/table views, doc editor
      query-bar/
      aggregation/
      indexes/
      explain/
      schema/
      shell/
      import-export/
    components/              # shared UI
    stores/                  # zustand stores
tests/
  fixtures/compass-queries.ts  # the compatibility corpus (see Phase 3)
  integration/
  e2e/
```

---

## 2. Phases

### Phase 1: Scaffold and secure shell

**Tasks**
- Scaffold with `electron-vite` (React + TS template). Add Tailwind, Radix, Zustand, TanStack Query, Monaco (`@monaco-editor/react` with local loader, no CDN).
- Configure a strict CSP, `sandbox: true`, `contextIsolation: true`. Block `window.open` and navigation to external URLs (open them in the system browser).
- Build the typed IPC layer: `shared/ipc-contract.ts` defines every channel's input/output; main handlers validate input with `zod`; preload exposes `window.api` with matching types.
- App shell: left sidebar, top tab bar, main panel, status bar. Light and dark themes.
- ESLint + Prettier + Vitest + Playwright-Electron wired up, plus a GitHub Actions workflow running lint, typecheck and tests on macOS/Windows/Linux.

**Done when**
- [x] `npm run dev` opens the app with the empty layout and a theme toggle
- [x] An E2E test launches the app and asserts the window title
- [x] `window.require` and `process` are undefined in the renderer (test it)
- [ ] CI is green on all three OSes _(workflow written; needs a GitHub remote to run)_

---

### Phase 2: Connections

**Tasks**
- Connection form with two modes: **connection string** (primary) and **fields** (host, port, auth mechanism, TLS, replica set, readPreference, authSource, appName). Keep both in sync using `mongodb-connection-string-url`.
- Support `mongodb://` and `mongodb+srv://`, SCRAM, X.509 (cert file pickers), TLS CA file, `directConnection`, `tlsAllowInvalidCertificates` (show a warning badge).
- **SSH tunnel** (password or private key) via `ssh2`, managed in main.
- Save connections with a name, colour and folder. Passwords and keys are encrypted with `safeStorage`; the connection string is stored with the password stripped.
- "Test connection" runs `ping` + `buildInfo` + `hello` and shows the server version, topology (standalone / replica set / sharded / Atlas) and latency.
- Sidebar tree: connections → databases → collections and views (lazy-loaded, with counts from `estimatedDocumentCount`). Create/drop database and collection, gated by permissions (Phase 4).
- Several connections can be open at once. Each gets its own `MongoClient`, keyed by connection id.

**Done when**
- [x] Integration test connects to `mongodb-memory-server` (standalone and replica set) and lists dbs/collections
- [x] Saved credentials don't appear in plaintext anywhere on disk (test greps the store file)
- [x] An invalid host shows a readable error within the timeout (`serverSelectionTimeoutMS` configurable)
- [x] Two connections can be browsed side by side

---

### Phase 3: Query bar with Compass compatibility (core of the app)

Compass's query bar accepts **shell syntax**, not strict JSON. These must all work:

```js
{ _id: ObjectId("65f1c0...") }
{ createdAt: { $gte: ISODate("2026-01-01") } }
{ name: /^dew/i }
{ amount: NumberDecimal("10.50"), qty: NumberLong(5), n: NumberInt(3) }
{ uuid: UUID("..."), bin: BinData(0, "...") }
{ ts: Timestamp({ t: 1700000000, i: 1 }) }
{ $expr: { $gt: ["$a", "$b"] } }
{ tags: { $elemMatch: { $eq: "x" } } }
{ loc: { $near: { $geometry: { type: "Point", coordinates: [79.86, 6.92] } } } }
{ $text: { $search: "coffee" } }
{ "nested.field": { $exists: true }, 'single': 'quotes', unquoted: 1 }
```

**Tasks**
- Query bar fields, matching Compass's options panel: **Filter, Project, Sort, Collation, Hint, Skip, Limit, MaxTimeMS**.
- Parse each field in **main** with `mongodb-query-parser` (filter/project/sort/collation parsers). Show inline red squiggles in Monaco on parse errors, with the parser's message.
- Build `tests/fixtures/compass-queries.ts`: **at least 80 query strings** covering every BSON constructor, regex forms, all query operators (comparison, logical, element, evaluation, array, geo, bitwise, `$expr`, `$jsonSchema`, `$text`), dotted paths, unquoted keys, single quotes, trailing commas and comments. Each entry stores the input string and the expected canonical EJSON. This corpus is the compatibility contract; it runs in CI.
- Execute with `find()` and stream batches through the `CursorRegistry` (see Phase 5 for performance).
- Counting: no filter → `estimatedDocumentCount`; with filter → `countDocuments` with `maxTimeMS: 5000`. On timeout, show "≥ N documents" instead of blocking.
- **Query history** (last 200 per namespace) and **saved/favourite queries** with names, in `electron-store`. Up/down arrow recalls history.
- Keyboard: `Cmd/Ctrl+Enter` runs, `Esc` cancels (kills the cursor), `Cmd/Ctrl+Shift+F` formats.

**Done when**
- [x] The full compatibility corpus passes in CI
- [ ] A side-by-side check against real Compass on the same dataset gives identical result counts for 20 sample queries (manual, documented in `docs/compat-check.md`) _(script + table ready; Compass column needs a manual run)_
- [x] Cancelling a long query frees the cursor on the server (verify with `currentOp`)

---

### Phase 4: Permissions (auto-detect + override)

**Tasks**
- After connecting, run `db.adminCommand({ connectionStatus: 1, showPrivileges: true })`. Build a **privilege matrix**: for each `{db, collection}` resource (including wildcard resources like `{db: "", collection: ""}`), which actions are granted (`find`, `insert`, `update`, `remove`, `createIndex`, `dropIndex`, `createCollection`, `dropCollection`, `dropDatabase`, `collMod`).
- Expose `permissions.can(connId, ns, action)` to the renderer.
- Edge cases:
  - **No auth** (local dev) → everything allowed.
  - **readPreference is not primary**, or connected to a secondary with `directConnection` → treat as read-only.
  - **Built-in roles** (`readAnyDatabase`, `dbOwner`, Atlas roles) come through as privileges, so no role-name special-casing is needed.
  - If `connectionStatus` fails or returns no privileges (some proxies, Atlas Data Federation), fall back to **optimistic mode**: allow in the UI, catch server error code `13` (Unauthorized), and then disable that action for that namespace for the rest of the session.
- **Per-connection override**: a "Read-only" toggle in the connection settings and a lock icon in the tab bar. Override can only *restrict* privileges, never grant more.
- UI behaviour: actions you can't do are **disabled with a tooltip** ("Your user lacks `update` on `shop.orders`"), not hidden.
- Display the current user, their roles and a "why can't I edit?" panel per collection.

**Done when**
- [ ] Integration tests with three users (`read`, `readWrite`, `dbAdmin` on different DBs) assert the correct buttons are enabled per namespace
- [ ] The read-only toggle blocks every write path, including the shell (Phase 9)
- [ ] An optimistic-mode Unauthorized error disables the action without crashing

---

### Phase 5: Documents view (speed on big collections)

**Tasks**
- **Three views**: List (expandable doc cards like Compass), JSON (one Monaco-styled block per doc), and Table (columns from sampled schema, nested fields as expandable cells).
- **Streaming**: main opens a cursor with `batchSize` ≈ 100 and pushes batches over a `MessagePort` as the user scrolls (`getMore` on demand). The renderer holds a windowed cache; docs far outside the viewport are released.
- **Virtualization** everywhere (TanStack Virtual), with variable row heights measured lazily.
- **Lazy document tree**: big nested docs and arrays render the first N children and a "show 50 more" control. Long strings and binary are truncated with an expand action.
- **Pagination modes**: infinite scroll (default) and classic pages (skip/limit) for people who want it.
- **Type-aware rendering**: every BSON type gets its own colour and badge: ObjectId (with a hover tooltip showing the embedded timestamp), Date (local + UTC on hover), Int32/Int64/Double/Decimal128 (distinct badges), Binary/UUID (subtype shown), Timestamp, Regex, MinKey/MaxKey, Code, DBRef, null, undefined.
- Copy actions: copy doc as shell syntax, as canonical EJSON, as relaxed JSON; copy field path; copy value.
- Performance budget, measured with a seeded collection of **1M documents of ~2 KB each** plus a few 10 MB documents:
  - First batch visible < **300 ms** after query returns on localhost
  - Scrolling stays at 60 fps (check with Chrome DevTools performance panel)
  - Renderer memory stays < 500 MB after scrolling 50k docs
  - Opening a 10 MB document doesn't freeze the UI (parse in a worker if needed)

**Done when**
- [ ] A `scripts/seed-bench.ts` script creates the benchmark dataset
- [ ] All four performance budgets met and recorded in `docs/perf.md`
- [ ] Every BSON type in the fixture "all types" document renders with the correct badge

---

### Phase 6: Viewing and editing BSON safely

Editing must **never silently change a type** (e.g. Int64 → Double, Decimal128 → Double, Date → string). This is where many clients get it wrong.

**Tasks**
- **Inline edit** in List/Table views: click a value, edit it, with a type dropdown next to each field (String, Int32, Int64, Double, Decimal128, Boolean, Date, ObjectId, Null, Object, Array, Binary, UUID, Timestamp, Regex). Changing the type validates and converts the value, or shows an error.
- **Full-document JSON edit** in Monaco using **shell syntax** (same parser as the query bar), so `NumberLong(5)` stays Int64 when saved.
- Add field, add array element, rename field, delete field, reorder (cosmetic only), with undo/redo inside the editor.
- **Saving** (same strategy as Compass):
  - Compute a diff between the original and edited document.
  - Send `findOneAndUpdate` with `$set`/`$unset` for changed paths only.
  - Filter = `_id` **plus the original values of the changed fields**, so if someone else changed the doc in the meantime, the update matches 0 docs. Show a conflict dialog: "Document changed on server" with reload / overwrite / cancel.
  - Docs without `_id` (capped collections, some views): editing disabled with an explanation.
- **Insert document(s)**: single (form or JSON) and bulk (JSON array).
- **Clone document**: opens the insert dialog with `_id` removed.
- **Delete**: single, and "delete all matching filter" with a typed confirmation showing the count.
- **Bulk update**: "update all matching filter" with an update document editor and a preview of the first 5 affected docs before/after.
- Every write button respects `permissions.can(...)` from Phase 4.

**Done when**
- [ ] Round-trip test: load the "all types" fixture doc, edit one unrelated field, save, re-read; every other field's type and value is byte-identical (compare BSON buffers)
- [ ] Concurrent-edit test triggers the conflict dialog
- [ ] Editing a Decimal128 value keeps it Decimal128

---

### Phase 7: Smarter query editor

**Tasks**
- **Autocomplete** in the Monaco query bar and pipeline editor:
  - Field names (including dotted paths) from a `$sample` of 1,000 docs per collection, cached per namespace, refreshed on demand. Show each field's observed types and frequency in the completion detail.
  - Query operators, aggregation stages, and expression operators with short docs and snippets (`$match` → `{ $match: { $1 } }`).
  - BSON constructors (`ObjectId("")`, `ISODate("")`, etc.).
  - Context-aware: inside `$match` suggest query operators; inside `$project`/`$group` suggest expression operators.
- **Hover docs** on operators.
- **Value suggestions**: for low-cardinality string fields (≤ 50 distinct values in the sample), suggest the values.
- **Snippets library**: date range for today/last 7 days, `_id` from timestamp, regex contains (case-insensitive), etc.
- **Format/prettify** and **convert** (shell syntax ↔ canonical EJSON ↔ relaxed JSON).
- **Export query to code**: Node.js, Python (PyMongo), Java, C#, Go, and mongosh. Use `bson-transpilers` if it still fits, otherwise write templates.

**Done when**
- [ ] Typing `{ cus` in a collection with `customer.name` suggests `customer.name` with its type
- [ ] Operator completions change correctly between `$match` and `$group`
- [ ] Exported Node and Python code runs and returns the same count (integration test)

---

### Phase 8: Multi-tab workspace

**Tasks**
- Tab types: Documents, Aggregation, Indexes, Schema, Explain, Shell, Import/Export, Connection info.
- Each tab stores `{ connectionId, ns, type, queryState, viewMode, scrollAnchor }` in Zustand, persisted to disk so tabs restore on restart (queries restored, but **not re-run** automatically).
- Open in new tab: `Cmd/Ctrl+click` in the sidebar; duplicate tab; pin tab; close others; reopen closed tab (`Cmd/Ctrl+Shift+T`).
- **Split view**: two tabs side by side (horizontal or vertical) for comparing collections or connections.
- Tab colour comes from the connection colour, so prod vs dev is obvious at a glance. Add an optional "production" flag on a connection that shows a red border and asks for confirmation on every write.
- Command palette (`Cmd/Ctrl+K`): jump to any collection on any open connection, run recent queries, switch tabs.
- Closing a tab kills its cursors and shell sessions (via `CursorRegistry`).

**Done when**
- [ ] 20 open tabs across 3 connections stay responsive (tab switch < 100 ms)
- [ ] Restart restores all tabs with their queries
- [ ] Closing a tab with a running query leaves no open cursor on the server

---

### Phase 9: Aggregation builder

**Tasks**
- **Stage-by-stage editor**: list of stage cards, each with a stage-type dropdown and a Monaco editor for the stage body. Drag to reorder, toggle stage on/off, delete, duplicate.
- **Per-stage preview**: each card shows the output of the pipeline up to that stage, run on a `$limit`ed sample (default 20 docs, configurable). Debounced auto-preview, with a toggle to disable for heavy pipelines.
- **Text mode**: edit the whole pipeline as one array in shell syntax. Switching between text and stage modes is lossless.
- Handle stages that can't be previewed safely: `$out` and `$merge` show a warning and only run on an explicit "Run full pipeline" click (blocked when read-only). `$search`/`$vectorSearch` show an Atlas-only note when not on Atlas.
- Options: `allowDiskUse`, `maxTimeMS`, collation, comment.
- Save/load pipelines per namespace; export pipeline to code (reuse Phase 7 exporter).
- "Create view from pipeline" (permission-gated).

**Done when**
- [ ] A 6-stage pipeline (`$match`, `$unwind`, `$group`, `$lookup`, `$project`, `$sort`) previews correctly at each stage
- [ ] Text ↔ stage mode conversion round-trips the fixture pipelines exactly
- [ ] `$out` never runs during preview (test)

---

### Phase 10: Indexes and explain plan

**Tasks**
- **Indexes tab**: list with name, keys, type (single, compound, multikey, text, 2dsphere, hashed, wildcard, TTL, partial, unique, sparse, hidden), size, and usage stats from `$indexStats`.
- Create index dialog with all options (unique, sparse, partial filter with autocomplete, TTL, collation, hidden, wildcard projection). Build in the background, with progress shown from `currentOp`.
- Drop / hide / unhide index (permission-gated, with confirmation).
- **Explain plan** for find and aggregate: run `explain("executionStats")`, show
  - a summary card: docs examined vs returned, keys examined, execution time, index used or COLLSCAN warning;
  - a visual tree of stages (IXSCAN → FETCH → SORT…) with per-stage counts and times;
  - the raw explain JSON in a collapsible panel.
- An "explain" button in the query bar and aggregation builder, which opens an Explain tab for that exact query.
- Simple hints: COLLSCAN on a large collection, in-memory SORT, and a high examined/returned ratio each produce a suggested index you can create in one click.

**Done when**
- [ ] Explain on an unindexed filter shows COLLSCAN and suggests an index; creating it and re-running shows IXSCAN
- [ ] Index list matches `db.coll.getIndexes()` for all index types in the fixture

---

### Phase 11: Embedded shell

**Tasks**
- Shell tab running `@mongosh/node-runtime-worker-thread` in a worker, connected with the tab's connection options (reuse credentials from main, never pass them to the renderer).
- xterm.js frontend with history, multi-line input, `Ctrl+C` to interrupt, and autocomplete from the mongosh runtime.
- Respect **read-only mode**: when the connection is read-only (override or detected), start the shell with a read-only user if possible; otherwise intercept write methods and refuse them with a clear message. Document the limits of this protection honestly in the UI: interception guards against accidents, it isn't a security boundary.
- `use db`, `show collections`, `it` for cursor iteration, `.pretty()` and the usual helpers all work because the real mongosh runtime is used.

**Done when**
- [ ] `db.orders.find().limit(3)`, `db.orders.aggregate([...])`, and `it` work as in mongosh
- [ ] `Ctrl+C` interrupts a long `find` and frees the cursor
- [ ] In read-only mode, `insertOne` is refused with a message

---

### Phase 12: Schema analysis, import and export

**Tasks**
- **Schema tab**: run `mongodb-schema` on a `$sample` (size configurable, default 1,000). For each field show types with percentages, presence rate, and a mini chart (histogram for numbers/dates, top values for strings). Clicking a value adds it to the query filter, as in Compass.
- **Export**: current query or full collection, as JSON (canonical EJSON, relaxed EJSON or JSON lines) or CSV (choose fields; nested fields flattened with dot notation). Streamed to disk with progress and cancel, so 1M+ docs work without loading into memory.
- **Import**: JSON (array or JSON lines, EJSON-aware) and CSV with a preview of the first 20 rows, a per-column type picker, a "stop on error / skip errors" option and progress. Inserts in batches of 1,000 with `ordered: false`.
- Permission gating on import.

**Done when**
- [ ] Export then import of the "all types" fixture collection via EJSON is lossless (BSON compare)
- [ ] Exporting 1M docs keeps main-process memory < 300 MB
- [ ] Schema of the fixture collection reports mixed-type fields correctly

---

### Phase 13: Polish, packaging, release

**Tasks**
- Settings page: theme, default view, batch size, default `maxTimeMS`, sample size, font size, keyboard shortcut list.
- Error handling everywhere: server error codes mapped to readable messages, with "copy details" for bug reports.
- Logging to a rotating file in the app data folder (no documents or credentials in logs).
- `electron-builder` configs for dmg (universal), nsis, AppImage. Notes for macOS signing + notarization and Windows signing (certificates needed from you).
- Optional: auto-update via `electron-updater` with GitHub Releases.
- README with screenshots and a feature comparison table against Compass.

**Done when**
- [ ] Installers build in CI for all three OSes
- [ ] Fresh-install smoke test passes on each OS (connect, query, edit, export)

---

## 3. Test fixtures to create early (Phase 1–2)

- `tests/fixtures/all-types.ts`: one document containing **every BSON type** (including nested arrays of mixed types, Int64 at the 2^53 boundary, Decimal128 with many digits, Binary subtypes 0/4/5, dates before 1970, MinKey/MaxKey).
- `tests/fixtures/compass-queries.ts`: the compatibility corpus from Phase 3.
- `tests/fixtures/pipelines.ts`: ten realistic aggregation pipelines.
- `scripts/seed-bench.ts`: the 1M-doc benchmark dataset.
- `scripts/seed-users.ts`: users with `read`, `readWrite` and `dbAdmin` roles for the permission tests.

---

## 4. Suggested `CLAUDE.md` for the repo

```md
# Mongo Studio – rules for Claude Code

- Electron + React 19 + TS strict. Run `npm run typecheck && npm test` before saying a task is done.
- Renderer never imports `mongodb`, never sees credentials. All DB access lives in src/main/services.
- All documents cross IPC as canonical EJSON. Use helpers in src/shared/ejson.ts. Never JSON.stringify BSON.
- Never eval user input. Parse with mongodb-query-parser (main) or run in the mongosh worker.
- Every write path must check permissions.can(connId, ns, action) and the read-only override.
- Every new IPC channel: type in src/shared/ipc-contract.ts + zod schema in main + preload binding + test.
- Long ops take maxTimeMS and are cancellable; closing a tab must kill its cursors.
- Type preservation is a hard requirement: any edit/import/export change needs a BSON round-trip test.
- Work one phase at a time from PLAN.md; tick the "Done when" boxes in the plan as they pass.
```

---

## 5. How to run this in Claude Code

1. Create an empty repo, copy this file in as `PLAN.md`, and add the `CLAUDE.md` above.
2. Start each phase with a prompt like:
   > Read PLAN.md and CLAUDE.md. Implement **Phase N** only. First list the files you'll create or change and any library APIs you need to verify on npm. Then implement, write the tests from the "Done when" list, run them, and tick the boxes that pass. Stop and report anything that failed.
3. For Phases 3, 5 and 6 (parsing, performance, editing), ask Claude Code to write the tests **first**, then the implementation.
4. Run `mongod` locally (or Docker `mongo:8`) for manual checks. Tests use `mongodb-memory-server`.
5. After each phase, commit and manually try the feature against a real database (ideally one of your own projects' DBs, read-only first).

---

## 6. Later ideas (not in v1)

- AI query assist: natural language → filter/pipeline, bring-your-own API key
- Data diff between two collections or two connections
- Saved dashboards / charts from aggregation results
- Real-time change stream viewer
- Visual `$lookup` relationship explorer
- Atlas Search index management
- Plugin system
