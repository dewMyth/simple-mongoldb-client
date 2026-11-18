/**
 * Embedded mongosh shell sessions: the real mongosh runtime (@mongosh/node-runtime-worker-thread)
 * in a worker thread, connected with the connection's credentials and SSH tunnel. Credentials
 * stay in main; the renderer only sends code and gets formatted text back.
 *
 * Read-only mode: the shell's write methods are replaced with ones that refuse. That guards
 * against accidents only. It isn't a security boundary (determined code can reach the driver),
 * and the UI says so. Real protection is a read-only database user.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { WorkerRuntime } from '@mongosh/node-runtime-worker-thread'
import ConnectionString from 'mongodb-connection-string-url'
import type { ShellEvalResult, ShellSessionInfo } from '@shared/shell'
import { ansi, formatShellError, formatShellResult } from '@shared/shell-output'
import type { ConnectionManager } from '../connection-manager'
import { killServerOps } from '../cursor-registry'
import { installWorkerGlobal } from './thread-worker'

interface Session {
  id: string
  connectionId: string
  tabId: string
  appName: string
  runtime: WorkerRuntime
  busy: boolean
  /** Whether the read-only patch is currently applied in the shell. */
  readOnlyApplied: boolean
  prompt: string
}

export type ShellOutput = (sessionId: string, text: string) => void

type WorkerRuntimeClass = typeof import('@mongosh/node-runtime-worker-thread').WorkerRuntime
let runtimeClass: WorkerRuntimeClass | null = null
/**
 * Loaded on first use, through require: main is an ES module and this webpack-built CommonJS
 * package has no static named exports. Lazy, so a broken native build can't stop the app.
 */
function loadWorkerRuntime(): WorkerRuntimeClass {
  runtimeClass ??= (
    createRequire(import.meta.url)(
      '@mongosh/node-runtime-worker-thread'
    ) as typeof import('@mongosh/node-runtime-worker-thread')
  ).WorkerRuntime
  return runtimeClass
}

/** Commands allowed through db.runCommand/adminCommand in read-only mode. */
const READ_COMMANDS = [
  'ping',
  'hello',
  'isMaster',
  'ismaster',
  'buildInfo',
  'buildinfo',
  'serverStatus',
  'dbStats',
  'dbstats',
  'collStats',
  'listCollections',
  'listDatabases',
  'listIndexes',
  'connectionStatus',
  'getParameter',
  'hostInfo',
  'currentOp',
  'getCmdLineOpts',
  'getLog',
  'find',
  'aggregate',
  'count',
  'distinct',
  'explain',
  'replSetGetStatus',
  'replSetGetConfig',
  'top',
  'dataSize',
  'getMore',
  'killCursors',
  'listCommands',
  'whatsmyuri',
  'features',
  'lockInfo',
  'usersInfo',
  'rolesInfo',
  'getShardMap',
  'listShards',
  'validate'
]

const COLLECTION_WRITES = [
  'insertOne',
  'insertMany',
  'insert',
  'updateOne',
  'updateMany',
  'update',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'remove',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'findAndModify',
  'bulkWrite',
  'initializeOrderedBulkOp',
  'initializeUnorderedBulkOp',
  'drop',
  'createIndex',
  'createIndexes',
  'ensureIndex',
  'dropIndex',
  'dropIndexes',
  'hideIndex',
  'unhideIndex',
  'renameCollection',
  'createSearchIndex',
  'createSearchIndexes',
  'updateSearchIndex',
  'dropSearchIndex',
  'mapReduce',
  'compactStructuredEncryptionData'
]

const DATABASE_WRITES = [
  'dropDatabase',
  'createCollection',
  'createView',
  'createUser',
  'updateUser',
  'dropUser',
  'dropAllUsers',
  'grantRolesToUser',
  'revokeRolesFromUser',
  'createRole',
  'updateRole',
  'dropRole',
  'dropAllRoles',
  'grantPrivilegesToRole',
  'revokePrivilegesFromRole',
  'grantRolesToRole',
  'revokeRolesFromRole',
  'setProfilingLevel',
  'fsyncLock',
  'fsyncUnlock',
  'shutdownServer',
  'killOp',
  'createEncryptedCollection',
  'cloneDatabase',
  'copyDatabase'
]

/** JS evaluated in the shell to (un)install the read-only guard. */
export function readOnlyPatch(enable: boolean): string {
  return `(() => {
  const C = Object.getPrototypeOf(db.getCollection('__mongo_studio__'))
  const D = Object.getPrototypeOf(db)
  const M = Object.getPrototypeOf(db.getMongo())
  const store = (globalThis.__mongoStudioOriginals ??= new Map())
  const restore = () => { for (const [[proto, m], fn] of store) proto[m] = fn; store.clear() }
  restore()
  if (!${enable}) return
  const refuse = (what) => {
    throw new Error('Read-only mode: ' + what + ' is blocked. Turn read-only off for this connection to write. (This guards against accidents; it is not a security boundary.)')
  }
  const wrap = (proto, m, make) => {
    const orig = proto[m]
    if (typeof orig !== 'function') return
    store.set([proto, m], orig)
    const fn = make(orig)
    // Keep mongosh's markers (async handling, help) on the replacement.
    for (const k of Reflect.ownKeys(orig)) { try { if (!(k in fn) || k === 'returnsPromise') fn[k] = orig[k] } catch {} }
    proto[m] = fn
  }
  const writesIn = (pipeline) => Array.isArray(pipeline) && pipeline.some((s) => s && typeof s === 'object' && ('$out' in s || '$merge' in s))
  for (const m of ${JSON.stringify(COLLECTION_WRITES)}) wrap(C, m, () => function () { refuse('db.collection.' + m + '()') })
  for (const m of ${JSON.stringify(DATABASE_WRITES)}) wrap(D, m, () => function () { refuse('db.' + m + '()') })
  wrap(M, 'bulkWrite', () => function () { refuse('Mongo.bulkWrite()') })
  wrap(C, 'aggregate', (orig) => function (...args) {
    if (writesIn(Array.isArray(args[0]) ? args[0] : args)) refuse('an aggregation with $out or $merge')
    return orig.apply(this, args)
  })
  wrap(D, 'aggregate', (orig) => function (...args) {
    if (writesIn(Array.isArray(args[0]) ? args[0] : args)) refuse('an aggregation with $out or $merge')
    return orig.apply(this, args)
  })
  const allowed = new Set(${JSON.stringify(READ_COMMANDS)})
  for (const m of ['runCommand', 'adminCommand']) wrap(D, m, (orig) => function (cmd, ...rest) {
    const name = typeof cmd === 'string' ? cmd : cmd && typeof cmd === 'object' ? Object.keys(cmd)[0] : undefined
    if (!name || !allowed.has(name)) refuse('db.' + m + '({ ' + name + ': … })')
    if (name === 'aggregate' && writesIn(cmd.pipeline)) refuse('an aggregation with $out or $merge')
    return orig.call(this, cmd, ...rest)
  })
})()`
}

export class ShellService {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly connections: ConnectionManager,
    private readonly isReadOnly: (connectionId: string) => boolean,
    private readonly output: ShellOutput
  ) {
    // Disconnecting ends the connection's shells.
    connections.onChange((ids) => {
      for (const s of [...this.sessions.values()]) if (!ids.includes(s.connectionId)) void this.close(s.id)
    })
  }

  private get(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error('This shell session has ended. Close the tab and open a new shell.')
    return s
  }

  /** Starts a session for a tab, or returns the tab's existing one (the tab was re-shown). */
  async start(input: { connectionId: string; tabId: string; db?: string | null }): Promise<ShellSessionInfo> {
    const existing = [...this.sessions.values()].find(
      (s) => s.tabId === input.tabId && s.connectionId === input.connectionId
    )
    if (existing)
      return {
        sessionId: existing.id,
        prompt: existing.prompt,
        readOnly: existing.readOnlyApplied,
        resumed: true
      }

    const target = this.connections.shellTarget(input.connectionId)
    const cs = new ConnectionString(target.uri)
    if (input.db) cs.pathname = `/${encodeURIComponent(input.db)}`
    const uri = cs.toString()

    const id = randomUUID()
    const appName = `mongo-studio-shell:${id}`
    installWorkerGlobal()
    const Runtime = loadWorkerRuntime()
    const runtime = new Runtime(uri, {
      ...target.options,
      appName,
      productName: 'Mongo Studio',
      productDocsLink: 'https://www.mongodb.com/docs/mongodb-shell/'
    } as ConstructorParameters<WorkerRuntimeClass>[1])
    runtime.setEvaluationListener({
      onPrint: (values: { type: string | null; printable: unknown }[]) => {
        const text = values.map((v) => formatShellResult(v.type, v.printable)).join(' ')
        this.output(id, text)
      },
      onPrompt: () => {
        this.output(
          id,
          ansi.yellow('Interactive prompts (passwordPrompt(), prompt()) aren’t supported in this shell.')
        )
        return ''
      },
      onClearCommand: () => this.output(id, '\u001b[2J\u001b[3J\u001b[H'),
      onExit: () =>
        Promise.reject(
          new Error('exit/quit isn’t available here: close the tab to end the shell.')
        ) as Promise<never>
    } as Parameters<WorkerRuntime['setEvaluationListener']>[0])

    const session: Session = {
      id,
      connectionId: input.connectionId,
      tabId: input.tabId,
      appName,
      runtime,
      busy: false,
      readOnlyApplied: false,
      prompt: '> '
    }
    try {
      await runtime.evaluate('db.getName()') // connects; fails fast on bad credentials
      await this.syncReadOnly(session)
      session.prompt = await runtime.getShellPrompt()
    } catch (err) {
      await runtime.terminate().catch(() => {})
      throw new Error(`The shell couldn’t connect: ${(err as Error).message}`, { cause: err })
    }
    this.sessions.set(id, session)
    return { sessionId: id, prompt: session.prompt, readOnly: session.readOnlyApplied, resumed: false }
  }

  /** Applies or removes the read-only guard to match the connection's current state. */
  private async syncReadOnly(s: Session): Promise<void> {
    const want = this.isReadOnly(s.connectionId)
    if (want === s.readOnlyApplied) return
    await s.runtime.evaluate(readOnlyPatch(want))
    s.readOnlyApplied = want
    this.output(
      s.id,
      want
        ? ansi.yellow('Read-only mode is on: write commands are refused in this shell.')
        : ansi.dim('Read-only mode is off: write commands are allowed.')
    )
  }

  async evaluate(id: string, code: string): Promise<ShellEvalResult> {
    const s = this.get(id)
    if (s.busy)
      return {
        ok: false,
        output: formatShellError({ message: 'Still running the previous command (Ctrl+C interrupts it).' }),
        prompt: s.prompt,
        readOnly: s.readOnlyApplied
      }
    s.busy = true
    try {
      await this.syncReadOnly(s)
      const r = await s.runtime.evaluate(code)
      s.prompt = await s.runtime.getShellPrompt().catch(() => s.prompt)
      return {
        ok: true,
        output: formatShellResult(r.type, r.printable),
        prompt: s.prompt,
        readOnly: s.readOnlyApplied
      }
    } catch (err) {
      return {
        ok: false,
        output: formatShellError(err as Error),
        prompt: s.prompt,
        readOnly: s.readOnlyApplied
      }
    } finally {
      s.busy = false
    }
  }

  /** Ctrl+C: stops the evaluation and kills its server-side operations (frees the cursor). */
  async interrupt(id: string): Promise<boolean> {
    const s = this.get(id)
    const interrupted = await s.runtime.interrupt().catch(() => false)
    await this.killServerOps(s)
    return interrupted
  }

  private async killServerOps(s: Session): Promise<void> {
    if (!this.connections.isOpen(s.connectionId)) return
    const client = this.connections.client(s.connectionId)
    try {
      const ops = await client
        .db('admin')
        .aggregate<{ opid: unknown }>([
          { $currentOp: { allUsers: false, idleConnections: false } },
          { $match: { appName: s.appName } },
          { $project: { opid: 1 } }
        ])
        .toArray()
      await Promise.all(
        ops.map((o) =>
          client
            .db('admin')
            .command({ killOp: 1, op: o.opid })
            .catch(() => {})
        )
      )
    } catch {
      // Without the inprog privilege the evaluation still stops; the server finishes the op.
      await killServerOps(client, s.appName).catch(() => {})
    }
  }

  async complete(id: string, code: string): Promise<string[]> {
    const s = this.get(id)
    if (s.busy) return []
    const items = await s.runtime.getCompletions(code).catch(() => [])
    return items.map((c) => c.completion)
  }

  /** Ends a session: closes the shell's client first so its cursors are freed on the server. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    if (s.busy) await this.interrupt(id).catch(() => false)
    await Promise.race([
      s.runtime.evaluate('db.getMongo().close()').catch(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ])
    await s.runtime.terminate().catch(() => {})
  }

  async closeForTab(tabId: string): Promise<number> {
    const ids = [...this.sessions.values()].filter((s) => s.tabId === tabId).map((s) => s.id)
    await Promise.all(ids.map((id) => this.close(id)))
    return ids.length
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }
}
