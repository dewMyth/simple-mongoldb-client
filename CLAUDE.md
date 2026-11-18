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

## Project notes

- Renderer calls IPC through `ipc()` in src/renderer/src/lib/ipc.ts, which unwraps the `{ ok, data | error }`
  envelope and throws `IpcError` (keeps MongoServerError `code`, e.g. 13 = Unauthorized).
- The preload is sandboxed and built as CommonJS (`out/preload/index.cjs`); it may only import `electron`
  and `src/shared`.
- `ELECTRON_RUN_AS_NODE` leaks in from VS Code terminals. electron.vite.config.ts and tests/e2e/app.ts strip it.
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
