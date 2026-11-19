# Mongo Studio – rules for Claude Code

- Electron + React 19 + TS strict. Run `npm run typecheck && npm test` before saying a task is done.
- Renderer never imports `mongodb`, never sees credentials. All DB access lives in src/main/services.
- All documents cross IPC as raw BSON bytes, one Uint8Array per document (src/shared/bson-wire.ts: main sends
  driver `raw: true` buffers via `ownBytes`; the renderer decodes with `fromBsonBytes`). Never JSON.stringify BSON.
  EJSON (src/shared/ejson.ts) is only for text: clipboard, export, display. (Changed from canonical EJSON in
  Phase 5: 15x faster for object-heavy documents; a 10 MB document froze the UI for 1.2 s with EJSON.)
- Never eval user input. Parse with mongodb-query-parser (main) or run in the mongosh worker.
- Every write path must check permissions.can(connId, ns, action) and the read-only override.
- Every new IPC channel: type in src/shared/ipc-contract.ts + zod schema in main + preload binding + test.
- Long ops take maxTimeMS and are cancellable; closing a tab must kill its cursors.
- Type preservation is a hard requirement: any edit/import/export change needs a BSON round-trip test.
- Work one phase at a time from PLAN.md; tick the "Done when" boxes in the plan as they pass.

## Project notes

- Renderer calls IPC through `ipc()` in src/renderer/src/lib/ipc.ts, which unwraps the `{ ok, data | error }`
  envelope and throws `IpcError` (keeps MongoServerError `code`, e.g. 13 = Unauthorized).
- The preload is sandboxed and built as CommonJS (`out/preload/index.cjs`); it may only import `electron`
  and `src/shared`.
- `ELECTRON_RUN_AS_NODE` leaks in from VS Code terminals. electron.vite.config.ts and tests/e2e/app.ts strip it.
- `npm run dev` uses `--watch` so main/preload changes rebuild and restart Electron. Without it only the
  renderer hot-reloads, and a stale main process silently ignores new IPC fields.
- E2E tests run against the built app: `npm run test:e2e` (builds first).
- Library versions in use: mongodb 7, bson 7, mongodb-query-parser 5 (`parseFilter`, `parseProject`,
  `parseSort`, `parseCollation`, `isHintValid`…), @mongodb-js/mongodb-schema 12 (`parseSchema`,
  `analyzeDocuments`; the unscoped `mongodb-schema` is deprecated), @mongosh/node-runtime-worker-thread 5
  (`WorkerRuntime` with `evaluate`, `getCompletions`, `interrupt`, `terminate`). TypeScript is pinned to 6.0
  because typescript-eslint doesn't support 7 yet.
- Every driver read that returns user documents must spread `PRESERVE_TYPES` (src/main/services/bson-options.ts); otherwise the driver turns Int64/Double/Int32 into JS numbers and types are lost.
- UI is shadcn/ui (new-york, Tailwind v4, unified `radix-ui` package). Generated components live in
  src/renderer/src/components/ui and are ours to edit (sizes were tightened for a desktop app).
  App-level helpers built on them: components/form.tsx, Dialog.tsx, ConfirmDialog.tsx, Menu.tsx, IconButton.tsx.
  Use shadcn tokens (`bg-background`, `text-muted-foreground`, `bg-primary`, `text-destructive`…); `panel`,
  `panel-2`, `warn`, `ok` and `json-*` (one colour per BSON type) are app extras in index.css.
- Adding shadcn components: `npx shadcn@latest add <name>`, then (1) replace `from "cn"` with
  `from "@renderer/lib/utils"` in the new files and (2) check package.json: the CLI mis-resolves the utils
  alias and installs an unrelated npm package called `cn`, which must be removed.
- Document views: Tree (features/documents/JsonTree.tsx, collapsible, colour per BSON type) and Text (shell
  syntax). Type detection/display lives in src/shared/bson-types.ts.
- Results are paged, 25 per page (`PAGE_SIZE` in src/shared/query.ts), not infinite scroll (user decision,
  overrides PLAN.md Phase 5). Each page is its own find() with skip/limit layered on the user's skip/limit
  (`pageWindow`), fetched in one batch so no cursor stays open between pages. Paging reuses the query as
  it was when Find was pressed; only Find recounts.
- Permissions: shared/permissions.ts has the pure `can()`; main's PermissionService enforces it. Every
  write IPC handler must wrap its work in `permissions.guard(connId, ns, action, fn)` (checks the
  read-only override, secondary reads, learned denials and privileges, and records Unauthorized errors).
  Reads are never pre-blocked; they only learn from code 13. Use "db" as the ns for database-level actions.
- Test users for permission work: `scripts/seed-users.ts` (reader / writer / dba, password "pw").
- Editing: src/shared/doc-edit.ts (immutable path ops with segment paths, type-exact diff, conflict filter)
  and src/shared/edit-values.ts (inline text ↔ typed value, type conversion). Saves go through main's
  DocumentService.update: $set/$unset of changed paths filtered on _id + original values; keys that can't be
  dotted (".", leading "$") use `$replaceWith: { $literal }` filtered on the exact original ($$ROOT).
- Opening a dialog from a Radix menu item: defer it (setTimeout) or the dialog can lose keyboard input
  (components/Menu.tsx does this for context menus).
- Monaco in E2E: clear and wait for `.view-lines` to be empty before inserting text; submit handlers get the
  editor's live text (`onSubmit(text)`) because React state lags a keystroke.
- Autocomplete: the engine is pure and shared (src/shared/autocomplete: `analyze` scans the cursor context,
  `complete`/`hoverAt` resolve a scope per mode: filter/project/sort/collation/pipeline/update/document).
  Monaco adapter: renderer lib/autocomplete.ts (`attachCompletion(model, getTarget)`); field samples
  (1,000 docs, distinct strings ≤ 50 per field) are cached per namespace in lib/field-cache.ts.
  Operator snippet templates escape `$` automatically via `toSnippet` (placeholders `$1`/`${1:x}` stay).
- Query text may also be Extended JSON: the parser reads JSON containing EJSON wrapper keys (`$oid`,
  `$numberLong`…) as EJSON (`parseEJSONText`), so converted queries still run.
- Export to code lives in src/shared/code-export.ts; it never writes a connection string (always MONGODB_URI).
  tests/integration/code-export.test.ts runs the Node and Python output; Python needs pymongo
  (`python3 -m venv .venv-codegen && .venv-codegen/bin/pip install pymongo`, or set PYTHON), else skipped.
- E2E: hover with a stepped `page.mouse.move` (Monaco ignores a single synthetic mousemove); reopen a Radix
  menu only after the previous content unmounts (150 ms exit animation; a click during it closes the new one).
- Workspace: stores/tabs.ts (tabs, split view, pins, reopen stack) is persisted by stores/workspace-persist.ts
  through `workspace:get/save` (schema in src/shared/workspace.ts, validated in main). Restored tabs have
  `autoRun: false` and wait for Find; a tab whose connection isn't open shows a Connect button.
  With a split, `activate()` targets the focused pane; use `focusedTabId()` for "the current tab".
- Production connections: every write channel (`WRITE_CHANNELS` in lib/ipc.ts) passes the write guard,
  which asks for confirmation (features/connections/production-guard.ts). New write channels must be
  added to `WRITE_CHANNELS`. A declined write throws IpcError name 'CancelledError'.
- Renderer-only unit tests go in tests/renderer (typechecked by tsconfig.web.json, not the node project).
- Aggregation: src/shared/pipeline.ts holds the model and lossless text ↔ stages conversion (stage bodies
  stay the user's own text; disabled stages are `// ` comments in text mode). Main's AggregationService
  parses each body with parseShellValue. Previews run the prefix + $limit and must never contain
  $out/$merge (`containsWriteStage`, checked recursively before sending). Previews run under the owner
  "<tabId>#preview"; `cancelForTab(tabId)` also kills "<tabId>#…" sub-owners.
- E2E: put multi-line text into Monaco by pasting (Electron clipboard + Cmd/Ctrl+V); typing it trips
  bracket auto-closing. `.view-lines` innerText isn't in line order for multi-line content.
- Never put a Monaco editor inside a <label> (e.g. `<Field>` without `editor`): clicks get forwarded to
  Monaco's hidden IME textarea and typing is lost.
- Explain: src/shared/explain.ts analyses explain("executionStats") (classic executionStages with per-stage
  counts; SBE/explainVersion 2 uses queryPlanner.winningPlan.queryPlan; aggregate `$cursor` + later
  stages). tests/fixtures/explain-8.2.json holds real server output: re-capture it when upgrading MongoDB.
  Index suggestions follow ESR (equality, sort, range). Explaining a pipeline drops a final $out/$merge.
- Indexes: main's IndexService; size/usage/multikey/builds are best effort (null without privileges).
  Multikey comes from a hinted queryPlanner explain (isMultiKey on the IXSCAN).
- Shell: main's ShellService runs @mongosh/node-runtime-worker-thread (loaded lazily with createRequire:
  main is ESM and the package has no static named exports). It needs a global browser-style `Worker`:
  services/shell/thread-worker.ts provides one over worker_threads. Sessions use appName
  `mongo-studio-shell:<id>`: Ctrl+C interrupts and killOps that appName; closing runs db.getMongo().close()
  (frees cursors) then terminates. Read-only mode patches write methods inside the shell (readOnlyPatch):
  a guard against accidents, not a security boundary.
- Native modules (interruptor, used by the shell) must be built for Electron: `postinstall` runs
  `electron-builder install-app-deps`. Vitest (plain Node) must not import the shell runtime.
- E2E shell tests read `shell-last-output` (aria-live, plain text, `data-runs` counts commands): xterm only
  renders visible rows.
- Import/export: main's ImportExportService streams both ways (cursor batches + write backpressure;
  file read in 1 MB chunks, inserts of 1,000 `ordered: false`). Files only via tokens from main's own
  dialogs (`files:chooseExport/chooseImport` → registerFile); never accept paths from the renderer.
  Progress: `jobs:progress` events → stores/jobs.ts (status bar + dialogs). A cancelled/failed export
  deletes its partial file. Canonical EJSON round-trips byte-identically (tests/integration/import-export).
- E2E file dialogs: stub `dialog.showSaveDialog/showOpenDialog` in main with `app.evaluate` (see
  tests/e2e/import-export.spec.ts). The 1M-doc export memory check is opt-in: `PERF=1` (perf-export.spec.ts).
- Schema tab: main's SchemaService.analyze ($match + $sample, mongodb-schema with exact BSON types) →
  services/schema-analysis.ts builds fields, type shares and charts; `query:setFilterField` toggles a value.
- Zustand selectors must return stable values: `useStore((s) => Object.values(s.x))` re-renders forever
  (React #185). Select the object and derive outside the selector.
- E2E harness (tests/e2e/app.ts): Playwright's Electron support sometimes loses the page connection
  while the app is fine (window open, no navigation or crash). launchApp retries a launch that fails
  before the tab bar renders, app.close() is time-limited with a SIGKILL fallback, the config allows
  one retry (reported as "flaky"), and every occurrence logs evidence prefixed "[e2e]". If "[e2e]"
  lines show a renderer crash, navigation or main exit instead, that's a real app bug.
- Settings: shared/settings.ts (`settingsSchema`, `normalizeSettings`), main's settings-store,
  `settings:update` → `settings:changed` to every window; renderer stores/settings.ts
  (`currentSettings()` for non-React code). Font size is the `--mono-size` CSS var. Page size stays 25.
- Errors: `<ErrorBox error={err}>` and ErrorBoundary have "Copy details" (shared/error-details.ts).
- Logging: main's services/log.ts (`log.info/warn/error`) → main.log in the logs folder, rotated at 5 MB.
  Never log documents, queries or server error messages (they can quote values): IPC failures log
  channel + error name + code only. Everything passes through `redact`.
- Packaging: electron-builder.yml (dmg universal, nsis, AppImage → release/). Unsigned; signing notes in
  docs/release.md. Tag `vX.Y.Z` (= package.json version) → .github/workflows/release.yml builds, smoke-tests
  the packaged apps and publishes the GitHub Release. Icon: build/icon.svg → `npx electron scripts/render-icon.mjs`.
- Renderer-only packages (bundled by Vite) belong in devDependencies; `dependencies` are shipped in the
  app's node_modules.
- E2E window is fixed at 1400x900 (`E2E_WINDOW=WxH` overrides; main allows larger-than-screen under
  `MONGO_STUDIO_E2E`). `E2E_EXECUTABLE` runs specs against a packaged app (tests/e2e/smoke.spec.ts).
  Linux CI needs scripts/linux-e2e.sh (xvfb + unlocked gnome-keyring): without a keyring the app
  rightly refuses to save passwords.
  Playwright's Electron loader appends `--password-store=basic` (and a mock keychain on macOS); the
  harness passes `--password-store=gnome-libsecret` on Linux and main re-applies an explicit
  `--password-store` from argv so it wins.
- Results toolbar (DocumentsTab) is a container: labels hide below @6xl and the row wraps rather than
  overlapping the pager. Check narrow layouts with `E2E_WINDOW=900x600`.
