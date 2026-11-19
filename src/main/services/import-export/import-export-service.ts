/**
 * Streamed export (JSON array / JSON lines as canonical or relaxed EJSON, or CSV) and import
 * (JSON array / JSON lines / documents, EJSON-aware; CSV with per-column types), with progress
 * and cancel. Nothing is loaded whole: the cursor is read in batches and writes wait for the
 * file stream to drain; imports read the file in chunks and insert batches of 1,000.
 *
 * Files are only touched through tokens from main's own dialogs (registerFile), so the
 * renderer can't make main read or write an arbitrary path.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { once } from 'node:events'
import { basename } from 'node:path'
import { BSON, EJSON, type Document } from 'bson'
import type { FindOptions, MongoBulkWriteError } from 'mongodb'
import { ownBytes } from '@shared/bson-wire'
import type {
  ChosenFile,
  CsvColumnType,
  ExportStart,
  ImportPreview,
  ImportStart,
  JobProgress
} from '@shared/import-export'
import type { ConnectionManager } from '../connection-manager'
import type { CursorRegistry } from '../cursor-registry'
import { ReadableError } from '../errors'
import { parseQuery } from '../query-parser'
import { splitNamespace } from '../query-service'
import { JsonDocumentSplitter } from './json-stream'
import { CsvReader, csvCell, csvRow, detectColumnType, rowToDocument } from './csv'
import { bsonToEJSON } from './ejson-writer'

export const IMPORT_BATCH = 1000
const PROGRESS_EVERY_MS = 200
const MAX_ERRORS = 20
const PREVIEW_ROWS = 20
const PREVIEW_BYTES = 1 << 20
/** Export output is written in chunks of about this many bytes. */
const OUT_BUFFER = 1024 * 1024
/** Decoding for export: every BSON type kept exactly (see bson-options.ts). */
const DECODE = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const

interface Job {
  progress: JobProgress
  path: string
  controller: AbortController
  /** Emits progress (throttled unless forced). */
  tick: (force?: boolean) => void
  done: Promise<JobProgress>
}

export class ImportExportService {
  private readonly files = new Map<string, { path: string; mode: 'read' | 'write' }>()
  private readonly jobs = new Map<string, Job>()

  constructor(
    private readonly connections: ConnectionManager,
    private readonly registry: CursorRegistry,
    private readonly emit: (p: JobProgress) => void
  ) {}

  /** Called by main's dialog handlers (and tests): the only way a path enters the service. */
  async registerFile(path: string, mode: 'read' | 'write'): Promise<ChosenFile> {
    const token = randomUUID()
    this.files.set(token, { path, mode })
    const size = mode === 'read' ? (await fsp.stat(path)).size : 0
    return { token, name: basename(path), size }
  }

  private file(token: string, mode: 'read' | 'write'): string {
    const f = this.files.get(token)
    if (!f || f.mode !== mode) throw new Error('Choose the file again (the selection expired).')
    return f.path
  }

  private startJob(
    kind: 'export' | 'import',
    ns: string,
    path: string,
    run: (job: Job) => Promise<void>
  ): Job {
    const progress: JobProgress = {
      jobId: randomUUID(),
      kind,
      ns,
      file: basename(path),
      status: 'running',
      processed: 0,
      total: null,
      bytes: 0,
      totalBytes: null,
      inserted: 0,
      failed: 0,
      errors: [],
      message: null
    }
    let last = 0
    const job = {
      progress,
      path,
      controller: new AbortController(),
      tick: (force = false) => {
        const now = Date.now()
        if (force || now - last >= PROGRESS_EVERY_MS) {
          last = now
          this.emit({ ...progress, errors: [...progress.errors] })
        }
      }
    } as Job
    const tick = job.tick
    job.done = (async () => {
      tick(true)
      try {
        await run(job)
        progress.status = job.controller.signal.aborted ? 'cancelled' : 'done'
      } catch (err) {
        if (job.controller.signal.aborted) progress.status = 'cancelled'
        else {
          progress.status = 'error'
          progress.message = err instanceof ReadableError ? err.message : (err as Error).message
        }
      }
      tick(true)
      return { ...progress }
    })()
    this.jobs.set(progress.jobId, job)
    return job
  }

  // ------------------------------------------------------------------ export

  /** Starts an export; progress and the result arrive through `emit`. */
  startExport(input: ExportStart): Job {
    const path = this.file(input.token, 'write')
    this.files.delete(input.token)
    if (input.format === 'csv' && !input.fields?.length) throw new Error('Choose at least one field for CSV.')
    return this.startJob('export', input.ns, path, (job) => this.runExport(job, input))
  }

  private async runExport(job: Job, input: ExportStart): Promise<void> {
    const client = this.connections.client(input.connectionId)
    const { db, coll } = splitNamespace(input.ns)
    const collection = client.db(db).collection(coll)
    let filter: Document = {}
    // raw: the driver hands back each document's bytes. JSON is written straight from them
    // (ejson-writer.ts); CSV decodes one document at a time. Either way a 1M+ export stays small.
    const options: FindOptions = { raw: true, batchSize: 1000 }
    if (input.source.kind === 'query') {
      const parsed = parseQuery(input.source.query)
      if (!parsed.ok) throw new Error(`${parsed.errors[0]!.field}: ${parsed.errors[0]!.message}`)
      const q = parsed.query
      filter = q.filter
      Object.assign(options, {
        projection: q.project,
        sort: q.sort,
        skip: q.skip,
        limit: q.limit,
        collation: q.collation,
        hint: q.hint,
        maxTimeMS: q.maxTimeMS
      })
    }
    const p = job.progress
    p.total = await (Object.keys(filter).length || options.skip || options.limit
      ? collection
          .countDocuments(filter, { maxTimeMS: 5000, skip: options.skip, limit: options.limit })
          .catch(() => null)
      : collection.estimatedDocumentCount().catch(() => null))

    // Not a sweepable "cursor": a long export reads continuously but never via getMore().
    const op = this.registry.register({
      client,
      connectionId: input.connectionId,
      tabId: null,
      kind: 'command'
    })
    const cursor = collection.find(filter, { ...options, comment: op.comment })
    op.cursor = cursor
    const onAbort = () => void this.registry.cancel(op.id)
    job.controller.signal.addEventListener('abort', onAbort)

    const out = createWriteStream(job.path)
    let failed: Error | null = null
    out.on('error', (e) => (failed = e))
    // Output goes into one reusable buffer that's written when full: no per-chunk strings or
    // Buffer copies, and no promise per document. The buffer is reused only after its write has
    // completed (the callback), so the stream never sees it change.
    let buffer = Buffer.allocUnsafe(OUT_BUFFER)
    let used = 0
    const flush = async () => {
      if (failed) throw failed
      if (!used) return
      const slice = buffer.subarray(0, used)
      p.bytes += used
      used = 0
      await new Promise<void>((resolve, reject) => out.write(slice, (err) => (err ? reject(err) : resolve())))
    }
    /** Appends text: 'full' means flush now; 'no-room' means nothing was appended (flush, then retry). */
    const append = (text: string): 'appended' | 'full' | 'no-room' => {
      const max = Buffer.byteLength(text)
      if (max > buffer.length - used) {
        if (used) return 'no-room'
        buffer = Buffer.allocUnsafe(Math.max(max, OUT_BUFFER)) // one document bigger than the buffer
      }
      used += buffer.write(text, used)
      return used >= OUT_BUFFER - 64 * 1024 ? 'full' : 'appended'
    }
    const write = async (text: string) => {
      let r = append(text)
      if (r === 'no-room') {
        await flush()
        r = append(text)
      }
      if (r === 'full') await flush()
    }
    const relaxed = input.ejson === 'relaxed'
    try {
      if (input.format === 'csv') await write(input.fields!.map(csvCell).join(',') + '\n')
      if (input.format === 'json') await write('[')
      for await (const raw of cursor) {
        if (job.controller.signal.aborted) break
        const bytes = raw as unknown as Uint8Array
        const text =
          input.format === 'csv'
            ? csvRow(BSON.deserialize(bytes, DECODE), input.fields!) + '\n'
            : input.format === 'json'
              ? // Straight from the BSON bytes: no decoded document, no intermediate EJSON objects.
                `${p.processed ? ',' : ''}\n${bsonToEJSON(bytes, relaxed)}`
              : `${bsonToEJSON(bytes, relaxed)}\n`
        // No await (and no promise) unless the buffer has to be flushed.
        const r = append(text)
        if (r === 'full') await flush()
        else if (r === 'no-room') await write(text)
        p.processed++
        job.tick()
      }
      if (input.format === 'json') await write(p.processed ? '\n]\n' : ']\n')
      await flush()
      out.end()
      await once(out, 'finish')
      if (job.controller.signal.aborted) throw new Error('cancelled')
    } catch (err) {
      out.destroy()
      // A partial file is misleading: remove it on cancel or error.
      await fsp.rm(job.path, { force: true }).catch(() => {})
      if (job.controller.signal.aborted) throw err
      throw new ReadableError(err)
    } finally {
      job.controller.signal.removeEventListener('abort', onAbort)
      this.registry.release(op.id)
      await cursor.close().catch(() => {})
    }
  }

  // ------------------------------------------------------------------ import

  async preview(token: string, format?: 'json' | 'csv'): Promise<ImportPreview> {
    const path = this.file(token, 'read')
    const size = (await fsp.stat(path)).size
    const fmt = format ?? (/\.csv$/i.test(path) ? 'csv' : 'json')
    const handle = await fsp.open(path, 'r')
    let text: string
    try {
      const buf = Buffer.alloc(Math.min(size, PREVIEW_BYTES))
      await handle.read(buf, 0, buf.length, 0)
      text = buf.toString('utf8')
    } finally {
      await handle.close()
    }
    const result: ImportPreview = { format: fmt, name: basename(path), size, docs: [], csv: null, errors: [] }
    const complete = size <= PREVIEW_BYTES
    if (fmt === 'csv') {
      const reader = new CsvReader()
      const rows = reader.feed(text)
      if (complete) rows.push(...reader.end())
      const [headers = [], ...data] = rows.slice(0, PREVIEW_ROWS + 1)
      result.csv = {
        headers,
        rows: data,
        detected: headers.map((_, i) => detectColumnType(data.map((r) => r[i] ?? '')))
      }
      if (!headers.length) result.errors.push('The file has no header row.')
      return result
    }
    const splitter = new JsonDocumentSplitter()
    let texts: string[]
    try {
      texts = splitter.feed(text)
      if (complete) texts.push(...splitter.end())
    } catch (err) {
      texts = []
      result.errors.push((err as Error).message)
    }
    for (const [i, t] of texts.slice(0, PREVIEW_ROWS).entries()) {
      try {
        result.docs.push(ownBytes(BSON.serialize(parseDocument(t))))
      } catch (err) {
        result.errors.push(`Document ${i + 1}: ${(err as Error).message}`)
      }
    }
    if (!texts.length && !result.errors.length) result.errors.push('No documents found in the file.')
    return result
  }

  /** Starts an import; the caller has already checked the insert permission. */
  startImport(input: ImportStart, guard: <T>(fn: () => Promise<T>) => Promise<T>): Job {
    const path = this.file(input.token, 'read')
    this.files.delete(input.token)
    return this.startJob('import', input.ns, path, (job) => guard(() => this.runImport(job, input)))
  }

  private async runImport(job: Job, input: ImportStart): Promise<void> {
    const p = job.progress
    p.totalBytes = (await fsp.stat(job.path)).size
    const { db, coll } = splitNamespace(input.ns)
    const collection = this.connections.client(input.connectionId).db(db).collection(coll)
    let batch: Document[] = []
    let stop = false

    const fail = (message: string) => {
      p.failed++
      if (p.errors.length < MAX_ERRORS) p.errors.push(message)
      if (input.stopOnError) {
        stop = true
        throw new Error(message)
      }
    }
    const flush = async () => {
      if (!batch.length) return
      const docs = batch
      batch = []
      try {
        const r = await collection.insertMany(docs, { ordered: false })
        p.inserted += r.insertedCount
      } catch (err) {
        const e = err as MongoBulkWriteError
        const writeErrors = e.writeErrors
          ? Array.isArray(e.writeErrors)
            ? e.writeErrors
            : [e.writeErrors]
          : null
        if (!writeErrors) throw new ReadableError(err)
        p.inserted += e.result?.insertedCount ?? docs.length - writeErrors.length
        for (const we of writeErrors) {
          const doc = docs[we.index]
          fail(
            `Document ${p.processed - docs.length + we.index + 1}${doc?._id !== undefined ? ` (_id ${EJSON.stringify(doc._id as Document)})` : ''}: ${we.errmsg ?? 'insert failed'}`
          )
          if (stop) return
        }
      }
      job.tick()
    }
    const add = async (doc: Document) => {
      batch.push(doc)
      if (batch.length >= IMPORT_BATCH) await flush()
    }

    const stream = createReadStream(job.path, { encoding: 'utf8', highWaterMark: 1 << 20 })
    job.controller.signal.addEventListener('abort', () => stream.destroy())
    try {
      if (input.format === 'csv') {
        const reader = new CsvReader()
        let headers: string[] | null = null
        let types: CsvColumnType[] = []
        const handleRows = async (rows: string[][]) => {
          for (const row of rows) {
            if (!headers) {
              headers = row
              types = headers.map((h) => input.columns?.find((c) => c.name === h)?.type ?? 'auto')
              continue
            }
            if (row.length === 1 && row[0] === '') continue // blank line
            p.processed++
            try {
              await add(rowToDocument(headers, types, row, input.ignoreEmpty))
            } catch (err) {
              if (stop) throw err
              fail(`Row ${p.processed + 1}: ${(err as Error).message}`)
            }
          }
        }
        for await (const chunk of stream) {
          p.bytes += Buffer.byteLength(chunk as string)
          await handleRows(reader.feed(chunk as string))
          job.tick()
        }
        if (job.controller.signal.aborted) return
        await handleRows(reader.end())
      } else {
        const splitter = new JsonDocumentSplitter()
        const handleTexts = async (texts: string[]) => {
          for (const t of texts) {
            p.processed++
            let doc: Document
            try {
              doc = parseDocument(t)
            } catch (err) {
              fail(`Document ${p.processed}: ${(err as Error).message}`)
              continue
            }
            await add(doc)
          }
        }
        for await (const chunk of stream) {
          p.bytes += Buffer.byteLength(chunk as string)
          await handleTexts(splitter.feed(chunk as string))
          job.tick()
        }
        if (job.controller.signal.aborted) return
        await handleTexts(splitter.end())
      }
      await flush()
    } catch (err) {
      if (job.controller.signal.aborted) return
      throw err
    }
  }

  // ------------------------------------------------------------------ jobs

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job || job.progress.status !== 'running') return false
    job.controller.abort()
    return true
  }

  /** The finished export's file path (main only: for "Show in folder"). */
  pathOf(jobId: string): string | null {
    return this.jobs.get(jobId)?.path ?? null
  }

  async cancelAll(): Promise<void> {
    for (const id of this.jobs.keys()) this.cancel(id)
    await Promise.all([...this.jobs.values()].map((j) => j.done.catch(() => {})))
  }
}

/** One document from JSON/EJSON text (types kept: $numberLong → Long, plain numbers → Int32/Double). */
export function parseDocument(text: string): Document {
  const v = EJSON.parse(text, { relaxed: false }) as unknown
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Each item must be a document ({ … })')
  return v as Document
}
