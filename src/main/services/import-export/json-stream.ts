/**
 * Splits a JSON file into document texts while streaming, without loading it whole: a top-level
 * array (`[ {...}, {...} ]`), JSON lines, or concatenated/single documents. Each text is then
 * parsed with EJSON (so `$oid`, `$numberLong`… become BSON types).
 */
export class JsonDocumentSplitter {
  private pending = ''
  private mode: 'unknown' | 'array' | 'values' | 'ended' = 'unknown'
  private depth = 0
  private inString = false
  private escape = false
  /** Start of the current element in `pending` (-1: between elements). */
  private start = -1
  private scanned = 0
  /** The current top-level element isn't an object/array (e.g. a bad JSON line): it ends at a newline. */
  private bare = false

  /** Feeds a chunk; returns the texts of the elements it completed. */
  feed(chunk: string): string[] {
    this.pending += chunk
    const out: string[] = []
    const s = this.pending
    let i = this.scanned
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (this.inString) {
        if (this.escape) this.escape = false
        else if (c === 92 /* \ */) this.escape = true
        else if (c === 34 /* " */) this.inString = false
        continue
      }
      if (this.mode === 'unknown') {
        if (c === 0xfeff || c <= 32) continue
        if (c === 91 /* [ */) {
          this.mode = 'array'
          this.depth = 1
          continue
        }
        this.mode = 'values'
      }
      if (this.mode === 'ended') {
        if (c > 32) throw new Error('Unexpected text after the end of the JSON array')
        continue
      }
      const depthBefore = this.depth
      const elementLevel = this.mode === 'array' ? 1 : 0
      if (this.start < 0) {
        // Between elements: skip whitespace and separators.
        if (c <= 32 || (c === 44 /* , */ && this.mode === 'array')) continue
        if (this.mode === 'array' && c === 93 /* ] */) {
          this.mode = 'ended'
          this.depth = 0
          continue
        }
        this.start = i
        this.bare = this.mode === 'values' && c !== 123 && c !== 91
      }
      if (this.bare) {
        if (c === 10 /* \n */) {
          out.push(s.slice(this.start, i).trim())
          this.start = -1
          this.bare = false
        }
        continue
      }
      if (c === 34) {
        this.inString = true
        continue
      }
      if (c === 123 || c === 91) this.depth++
      else if (c === 125 || c === 93) this.depth--
      if (this.mode === 'array' && depthBefore === 1 && (c === 44 || this.depth === 0)) {
        // ',' or the closing ']' ends the element.
        out.push(s.slice(this.start, i).trim())
        this.start = -1
        if (this.depth === 0) this.mode = 'ended'
        continue
      }
      // A top-level document (or array) is complete when its brackets close.
      if (this.mode === 'values' && this.depth === elementLevel && (c === 125 || c === 93)) {
        out.push(s.slice(this.start, i + 1))
        this.start = -1
      }
    }
    // Keep only what the next chunk needs.
    const keepFrom = this.start >= 0 ? this.start : s.length
    this.pending = s.slice(keepFrom)
    if (this.start >= 0) this.start = 0
    this.scanned = this.pending.length
    return out
  }

  /** Ends the input: returns a trailing element, or throws if the JSON is incomplete. */
  end(): string[] {
    if (this.inString) throw new Error('The file ends inside a string')
    if (this.mode === 'array') throw new Error('The JSON array isn’t closed: missing "]"')
    if (this.depth !== 0) throw new Error('The file ends in the middle of a document')
    const rest = this.pending.trim()
    this.pending = ''
    return rest ? [rest] : []
  }
}
