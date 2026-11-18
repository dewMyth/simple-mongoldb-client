/**
 * Readline-style line editing for the xterm shell: cursor movement, history, multi-line input
 * (Enter continues while brackets/strings are open), Tab completion, Ctrl+C, paste.
 * Terminal-agnostic: it only needs `write` and the terminal width, so it's unit-tested.
 */
/* eslint-disable no-control-regex -- terminal input is made of control characters */
import { ansi, isIncompleteInput } from '@shared/shell-output'

export interface TerminalLike {
  write(data: string): void
  readonly cols: number
}

export interface LineEditorHost {
  /** Runs a complete command. The editor shows the next prompt when it resolves. */
  run(code: string): Promise<void>
  /** Ctrl+C while a command runs. */
  interrupt(): void
  complete(code: string): Promise<string[]>
  /** Called when history changes (to persist it). */
  onHistory?(history: string[]): void
}

const HISTORY_LIMIT = 500
const CONTINUATION = '... '
const visibleLength = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').length

export class LineEditor {
  private line = ''
  private cursor = 0
  /** Lines entered so far for an unfinished multi-line command. */
  private pending: string[] = []
  private history: string[]
  private historyIndex = -1
  private draft = ''
  /** Row of the terminal cursor within the input block (for redraws of wrapped input). */
  private cursorRow = 0
  private running = false
  private prompt = '> '

  constructor(
    private readonly term: TerminalLike,
    private readonly host: LineEditorHost,
    history: string[] = []
  ) {
    this.history = history.slice(-HISTORY_LIMIT)
  }

  get busy(): boolean {
    return this.running
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt
  }

  private get currentPrompt(): string {
    return this.pending.length ? CONTINUATION : this.prompt
  }

  /** Prints the prompt and an empty input line. */
  showPrompt(): void {
    this.line = ''
    this.cursor = 0
    this.cursorRow = 0
    this.term.write(ansi.green(this.currentPrompt))
  }

  /** Writes output above the input (e.g. print() while running). */
  printAbove(text: string): void {
    this.term.write(text.replace(/\r?\n/g, '\r\n') + '\r\n')
  }

  private redraw(): void {
    const cols = Math.max(1, this.term.cols)
    const promptLen = visibleLength(this.currentPrompt)
    let out = this.cursorRow > 0 ? `\u001b[${this.cursorRow}A` : ''
    out += `\r\u001b[J${ansi.green(this.currentPrompt)}${this.line}`
    const end = promptLen + this.line.length
    const target = promptLen + this.cursor
    const endRow = Math.floor(end / cols)
    const targetRow = Math.floor(target / cols)
    // A line that exactly fills the width leaves the cursor at its end; force the wrap.
    if (end > 0 && end % cols === 0) out += ' \r'
    if (endRow > targetRow) out += `\u001b[${endRow - targetRow}A`
    out += '\r'
    const col = target % cols
    if (col) out += `\u001b[${col}C`
    this.cursorRow = targetRow
    this.term.write(out)
  }

  private insert(text: string): void {
    const atEnd = this.cursor === this.line.length
    this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor)
    this.cursor += text.length
    const cols = Math.max(1, this.term.cols)
    const start = visibleLength(this.currentPrompt) + this.cursor - text.length
    const end = start + text.length
    // Fast path: appending at the end without reaching the next row.
    if (atEnd && Math.floor(start / cols) === Math.floor(end / cols) && end % cols !== 0) {
      this.term.write(text)
      return
    }
    this.redraw()
  }

  private async enter(): Promise<void> {
    const full = [...this.pending, this.line].join('\n')
    this.moveToEnd()
    this.term.write('\r\n')
    if (isIncompleteInput(full)) {
      this.pending.push(this.line)
      this.showPrompt()
      return
    }
    this.pending = []
    if (!full.trim()) {
      this.showPrompt()
      return
    }
    if (this.history.at(-1) !== full) {
      this.history.push(full)
      if (this.history.length > HISTORY_LIMIT) this.history.shift()
      this.host.onHistory?.(this.history)
    }
    this.historyIndex = -1
    this.running = true
    try {
      await this.host.run(full)
    } finally {
      this.running = false
      this.showPrompt()
    }
  }

  private moveToEnd(): void {
    if (this.cursor !== this.line.length) {
      this.cursor = this.line.length
      this.redraw()
    }
  }

  private recall(direction: 1 | -1): void {
    if (!this.history.length) return
    if (this.historyIndex === -1) {
      if (direction === 1) return
      this.draft = this.line
      this.historyIndex = this.history.length
    }
    const next = this.historyIndex + direction
    if (next < 0) return
    if (next >= this.history.length) {
      this.historyIndex = -1
      this.line = this.draft
    } else {
      this.historyIndex = next
      // Multi-line history entries are recalled on one line (still valid JS).
      this.line = this.history[next]!.replace(/\n\s*/g, ' ')
    }
    this.cursor = this.line.length
    this.redraw()
  }

  private async tab(): Promise<void> {
    const before = this.line.slice(0, this.cursor)
    const candidates = await this.host.complete([...this.pending, before].join('\n'))
    if (!candidates.length) return
    // Completions replace either the whole input before the cursor or its last token.
    const token = /[\w$.]*$/.exec(before)?.[0] ?? ''
    const base = candidates.every((c) => c.startsWith(before)) ? before : token
    const usable = candidates.filter((c) => c.startsWith(base))
    if (!usable.length) return
    let common = usable[0]!
    for (const c of usable) while (!c.startsWith(common)) common = common.slice(0, -1)
    if (common.length > base.length) {
      this.insert(common.slice(base.length))
      return
    }
    if (usable.length > 1) {
      this.moveToEnd()
      const width = Math.max(...usable.map((c) => c.length)) + 2
      const perRow = Math.max(1, Math.floor(this.term.cols / width))
      const rows: string[] = []
      for (let i = 0; i < usable.length; i += perRow)
        rows.push(
          usable
            .slice(i, i + perRow)
            .map((c) => c.padEnd(width))
            .join('')
            .trimEnd()
        )
      this.term.write('\r\n' + rows.join('\r\n') + '\r\n')
      const keep = this.line
      const cursor = this.cursor
      this.showPrompt()
      this.line = keep
      this.cursor = cursor
      this.redraw()
    }
  }

  private deleteWordBack(): void {
    const before = this.line.slice(0, this.cursor)
    const m = /(\s*[\w$]+|\s*[^\w$\s]+)\s*$/.exec(before) ?? /\s+$/.exec(before)
    const n = m ? m[0].length : 1
    this.line = before.slice(0, before.length - n) + this.line.slice(this.cursor)
    this.cursor -= n
    this.redraw()
  }

  /** Handles a chunk of terminal input (keys, escape sequences or pasted text). */
  async handle(data: string): Promise<void> {
    // Bracketed paste markers, if the terminal sends them.
    data = data.replace(/\u001b\[20[01]~/g, '')
    let i = 0
    while (i < data.length) {
      const rest = data.slice(i)
      if (this.running) {
        if (rest.startsWith('\u0003')) this.host.interrupt()
        return
      }
      const seq = /^\u001b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|\x7f|b|f)/.exec(rest)
      if (seq) {
        i += seq[0].length
        switch (seq[0]) {
          case '\u001b[D':
            if (this.cursor > 0) {
              this.cursor--
              this.redraw()
            }
            break
          case '\u001b[C':
            if (this.cursor < this.line.length) {
              this.cursor++
              this.redraw()
            }
            break
          case '\u001b[A':
            this.recall(-1)
            break
          case '\u001b[B':
            this.recall(1)
            break
          case '\u001b[H':
          case '\u001bOH':
          case '\u001b[1~':
            this.cursor = 0
            this.redraw()
            break
          case '\u001b[F':
          case '\u001bOF':
          case '\u001b[4~':
            this.cursor = this.line.length
            this.redraw()
            break
          case '\u001b[3~':
            if (this.cursor < this.line.length) {
              this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1)
              this.redraw()
            }
            break
          case '\u001b\x7f':
            this.deleteWordBack()
            break
          case '\u001bb': {
            const m = /[\w$]*[^\w$]*$/.exec(this.line.slice(0, this.cursor))
            this.cursor -= m ? Math.max(1, m[0].length) : 1
            this.cursor = Math.max(0, this.cursor)
            this.redraw()
            break
          }
          case '\u001bf': {
            const m = /^[^\w$]*[\w$]*/.exec(this.line.slice(this.cursor))
            this.cursor = Math.min(this.line.length, this.cursor + (m ? Math.max(1, m[0].length) : 1))
            this.redraw()
            break
          }
        }
        continue
      }
      const ch = rest[0]!
      i++
      switch (ch) {
        case '\r':
          if (rest[1] === '\n') i++
          await this.enter()
          break
        case '\n':
          await this.enter()
          break
        case '\u007f':
        case '\b':
          if (this.cursor > 0) {
            this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor)
            this.cursor--
            this.redraw()
          }
          break
        case '\u0003': // Ctrl+C at the prompt: abandon the input
          this.moveToEnd()
          this.term.write(ansi.dim('^C') + '\r\n')
          this.pending = []
          this.historyIndex = -1
          this.showPrompt()
          break
        case '\u0001':
          this.cursor = 0
          this.redraw()
          break
        case '\u0005':
          this.cursor = this.line.length
          this.redraw()
          break
        case '\u0015':
          this.line = this.line.slice(this.cursor)
          this.cursor = 0
          this.redraw()
          break
        case '\u000b':
          this.line = this.line.slice(0, this.cursor)
          this.redraw()
          break
        case '\u0017':
          this.deleteWordBack()
          break
        case '\u000c':
          this.term.write('\u001b[2J\u001b[3J\u001b[H')
          this.cursorRow = 0
          this.redraw()
          break
        case '\t':
          await this.tab()
          break
        default:
          if (ch >= ' ') {
            // Insert a run of printable characters at once (typing fast, pasting).
            const run = /^[^\u0000-\u001f\u007f]+/.exec(rest)![0]
            i += run.length - 1
            this.insert(run)
          }
      }
    }
  }
}
