/**
 * Main-process log: `main.log` in the app's logs folder, rotated at 5 MB (main.1.log, main.2.log).
 * Records startup, connects/disconnects, IPC failures (channel, error name and code only: server
 * messages can quote document values) and uncaught errors. Never documents, queries or
 * credentials; everything written passes through `redact`.
 * Until `initLog` runs (e.g. in tests) logging is a no-op.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'
type Fields = Record<string, string | number | boolean | null | undefined>

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

/** Removes credentials from connection strings and secret-looking key=value / "key": value pairs. */
export function redact(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<credentials>@')
    .replace(
      /\b([a-z_]*(?:password|passphrase|secret|token|privatekey|apikey)["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/gi,
      (_m, key: string, value: string) =>
        key + (value.startsWith('"') ? '"<redacted>"' : value.startsWith("'") ? "'<redacted>'" : '<redacted>')
    )
}

/** The hosts of a connection string, without credentials or options (for log lines). */
export function uriHosts(uri: string): string {
  const m = /^mongodb(\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(uri.trim())
  return m ? `${m[1] ? 'srv:' : ''}${m[2]}` : '<unparsed>'
}

export class FileLog {
  private readonly file: string
  constructor(
    private readonly dir: string,
    private readonly maxBytes = MAX_BYTES,
    private readonly keep = KEEP
  ) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'main.log')
  }

  write(level: LogLevel, message: string, fields?: Fields, error?: unknown): void {
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`
    for (const [k, v] of Object.entries(fields ?? {}))
      if (v !== undefined) line += ` ${k}=${JSON.stringify(v)}`
    if (error instanceof Error) line += `\n  ${error.stack ?? `${error.name}: ${error.message}`}`
    else if (error !== undefined) line += `\n  ${String(error)}`
    try {
      this.rotate()
      appendFileSync(this.file, redact(line) + '\n')
    } catch {
      // Logging must never break the app.
    }
  }

  private rotate(): void {
    if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return
    const name = (i: number) => join(this.dir, i === 0 ? 'main.log' : `main.${i}.log`)
    if (existsSync(name(this.keep - 1))) unlinkSync(name(this.keep - 1))
    for (let i = this.keep - 2; i >= 0; i--) if (existsSync(name(i))) renameSync(name(i), name(i + 1))
  }
}

let current: FileLog | null = null

export function initLog(dir: string): FileLog {
  current = new FileLog(dir)
  return current
}

export const log = {
  info: (message: string, fields?: Fields) => current?.write('info', message, fields),
  warn: (message: string, fields?: Fields, error?: unknown) => current?.write('warn', message, fields, error),
  error: (message: string, fields?: Fields, error?: unknown) =>
    current?.write('error', message, fields, error)
}
