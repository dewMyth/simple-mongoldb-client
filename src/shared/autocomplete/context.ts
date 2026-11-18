/**
 * Works out where the cursor is in (possibly incomplete) shell-syntax text: which containers
 * enclose it, which key each container is currently on, and whether a key or a value is being
 * typed. Tolerant by design: it's a scanner, not a parser, so half-typed input still gives a
 * useful answer.
 */

export interface Frame {
  kind: 'object' | 'array' | 'call'
  /** Object frames: the key whose value is being written (null while typing a key). */
  key: string | null
  /** Object frames: what comes next. */
  state: 'key' | 'colon' | 'value' | 'afterValue'
  /** Array frames: index of the element being written. */
  index: number
}

export type CursorPosition =
  /** Typing an object key. */
  | 'key'
  /** Typing the value of an object key. */
  | 'value'
  /** Typing an array element. */
  | 'element'
  /** Somewhere nothing can be suggested (inside a constructor call, a regex, after a key…). */
  | 'none'
  /** Outside every container. */
  | 'root'

export interface CursorContext {
  /** Enclosing containers, outermost first. */
  frames: Frame[]
  position: CursorPosition
  /** The partial word or string contents being typed. */
  prefix: string
  /** Offset where the text to replace starts (the prefix, without an opening quote). */
  prefixStart: number
  /** Set when the cursor is inside a string literal. */
  quote: '"' | "'" | '`' | null
  /** A ':' already follows the cursor (don't insert another). */
  colonAfter: boolean
}

const IDENT_START = /[A-Za-z_$]/
const IDENT_CHAR = /[\w$]/

export function analyze(text: string, offset: number): CursorContext {
  const src = text.slice(0, offset)
  const frames: Frame[] = []
  const top = () => frames[frames.length - 1]
  let i = 0
  /** Last significant token, to tell a regex literal from a division. */
  let lastSig = ''

  const valueDone = () => {
    const f = top()
    if (!f) return
    if (f.kind === 'object') {
      if (f.state === 'key' || f.state === 'colon') f.state = 'colon'
      else f.state = 'afterValue'
    } else if (f.kind === 'array') {
      // stays on the same element until ','
    }
  }
  const keyToken = (k: string) => {
    const f = top()
    if (f?.kind === 'object' && f.state === 'key') {
      f.key = k
      f.state = 'colon'
      return true
    }
    return false
  }

  let quote: CursorContext['quote'] = null
  let stringStart = -1
  let inRegex = false
  let inComment = false

  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    // comments
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i)
      if (end === -1) {
        inComment = true
        break
      }
      i = end + 1
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) {
        inComment = true
        break
      }
      i = end + 2
      continue
    }
    // strings
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let value = ''
      let closed = false
      while (j < src.length) {
        const ch = src[j]!
        if (ch === '\\') {
          value += src[j + 1] ?? ''
          j += 2
          continue
        }
        if (ch === c) {
          closed = true
          break
        }
        value += ch
        j++
      }
      if (!closed) {
        quote = c
        stringStart = i + 1
        break
      }
      if (!keyToken(value)) valueDone()
      lastSig = 'str'
      i = j + 1
      continue
    }
    // regex literal: '/' where a value can start
    if (c === '/' && (lastSig === '' || /^[:[,({]$/.test(lastSig))) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < src.length) {
        const ch = src[j]!
        if (ch === '\\') {
          j += 2
          continue
        }
        if (ch === '\n') break
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) {
          closed = true
          break
        }
        j++
      }
      if (!closed) {
        inRegex = true
        break
      }
      j++
      while (j < src.length && /[a-z]/i.test(src[j]!)) j++
      valueDone()
      lastSig = 'regex'
      i = j
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (IDENT_START.test(c)) {
      let j = i + 1
      while (
        j < src.length &&
        (IDENT_CHAR.test(src[j]!) || (src[j] === '.' && IDENT_START.test(src[j + 1] ?? '')))
      )
        j++
      if (j === src.length) break // the word being typed: becomes the prefix
      const word = src.slice(i, j)
      i = j
      if (word === 'new') continue
      // Constructor call follows?
      let k = j
      while (k < src.length && /\s/.test(src[k]!)) k++
      if (src[k] === '(') {
        lastSig = 'ident'
        continue // '(' pushes a call frame below
      }
      if (!keyToken(word)) valueDone()
      lastSig = 'ident'
      continue
    }
    if (/[\d.-]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[\w.+-]/.test(src[j]!)) j++
      if (j === src.length) break
      if (!keyToken(src.slice(i, j))) valueDone()
      lastSig = 'num'
      i = j
      continue
    }
    switch (c) {
      case '{':
        frames.push({ kind: 'object', key: null, state: 'key', index: 0 })
        break
      case '[':
        frames.push({ kind: 'array', key: null, state: 'value', index: 0 })
        break
      case '(':
        frames.push({ kind: 'call', key: null, state: 'value', index: 0 })
        break
      case '}':
      case ']':
      case ')':
        frames.pop()
        valueDone()
        break
      case ':': {
        const f = top()
        if (f?.kind === 'object') f.state = 'value'
        break
      }
      case ',': {
        const f = top()
        if (f?.kind === 'object') {
          f.state = 'key'
          f.key = null
        } else if (f?.kind === 'array') f.index++
        break
      }
    }
    lastSig = c
    i++
  }

  // What is being typed right now?
  let prefix = ''
  let prefixStart = offset
  if (quote) {
    prefix = text.slice(stringStart, offset)
    prefixStart = stringStart
  } else if (!inRegex && !inComment) {
    const m = /[A-Za-z_$][\w$]*(?:\.[\w$]*)*$|[\w$]+$/.exec(src)
    if (m) {
      prefix = m[0]
      prefixStart = offset - prefix.length
    }
  }

  const after = text.slice(offset)
  const restOfWord = quote ? /^[^"'`]*["'`]?/.exec(after)![0] : /^[\w$.]*/.exec(after)![0]
  const colonAfter = /^\s*:/.test(after.slice(restOfWord.length))

  const f = top()
  let position: CursorPosition
  if (inRegex || inComment) position = 'none'
  else if (!f) position = 'root'
  else if (f.kind === 'call') position = 'none'
  else if (f.kind === 'array') {
    // After a complete element and before ',' nothing fits; detect via the last significant char.
    position = /^[[,]$/.test(lastSig) || prefix || quote ? 'element' : 'none'
  } else if (f.state === 'key') position = 'key'
  else if (f.state === 'value') position = 'value'
  else position = 'none'

  return { frames, position, prefix, prefixStart, quote, colonAfter }
}
