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
