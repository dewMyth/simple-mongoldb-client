/**
 * A browser-style `Worker` over Node's worker_threads, which @mongosh/node-runtime-worker-thread
 * expects as a global. The worker script is CommonJS (it uses require) yet talks through a
 * web-worker `self`, so the bootstrap below runs as CommonJS in the thread and gives it a `self`
 * backed by parentPort. (The `web-worker` package can't: it evaluates scripts without require.)
 */
import { Worker as NodeWorker } from 'node:worker_threads'
import { setMaxListeners } from 'node:events'
import { fileURLToPath } from 'node:url'

const BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads')
const { setMaxListeners } = require('node:events')
const target = new EventTarget()
setMaxListeners(0, target)
globalThis.self = globalThis
self.addEventListener = target.addEventListener.bind(target)
self.removeEventListener = target.removeEventListener.bind(target)
self.dispatchEvent = target.dispatchEvent.bind(target)
self.postMessage = (data, transfer) => parentPort.postMessage(data, transfer)
parentPort.on('message', (data) => {
  const e = new Event('message')
  e.data = data
  target.dispatchEvent(e)
})
require(workerData.mod)
`

type DataEvent = Event & { data?: unknown; error?: unknown; message?: string }

export class ThreadWorker extends EventTarget {
  private readonly worker: NodeWorker

  constructor(url: string | URL, options: { env?: NodeJS.ProcessEnv } = {}) {
    super()
    setMaxListeners(0, this) // the RPC layer adds one listener per call in flight
    this.worker = new NodeWorker(BOOTSTRAP, {
      eval: true,
      workerData: { mod: fileURLToPath(String(url)) },
      env: options.env
    })
    this.worker.on('message', (data: unknown) => {
      const e: DataEvent = new Event('message')
      e.data = data
      this.dispatchEvent(e)
    })
    this.worker.on('error', (err: Error) => {
      const e: DataEvent = new Event('error')
      e.error = err
      e.message = err.message
      this.dispatchEvent(e)
    })
    this.worker.on('exit', () => this.dispatchEvent(new Event('close')))
  }

  postMessage(data: unknown, transfer?: readonly import('node:worker_threads').Transferable[]): void {
    this.worker.postMessage(data, transfer)
  }

  terminate(): Promise<number> {
    return this.worker.terminate()
  }
}

/** Installs the shim as the global Worker (the main process has none). */
export function installWorkerGlobal(): void {
  const g = globalThis as { Worker?: unknown }
  g.Worker ??= ThreadWorker
}
