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
