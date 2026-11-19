/**
 * BSON bytes → Extended JSON text, directly: no decoded document and no intermediate EJSON
 * object tree, which is what made 1M-document exports grow the heap. The output is identical to
 * `EJSON.stringify(BSON.deserialize(bytes, exact types), { relaxed })` (tested byte for byte);
 * rare types (DBPointer, old binary subtype 2, vectors) fall back to exactly that.
 */
import { BSON, Decimal128, EJSON, type Document } from 'bson'

const DECODE = { promoteValues: false, promoteLongs: false, promoteBuffers: false, bsonRegExp: true } as const
const MAX_DATE = 253402300800000 // year 10000: the end of ISO-8601 dates EJSON writes as strings
const TWO_PWR_32 = 4294967296

class Unsupported extends Error {}

/** A JSON number for a double, as JSON.stringify writes it. */
const jsonNumber = (n: number) => JSON.stringify(n)

function canonicalDouble(n: number): string {
  if (Object.is(n, -0)) return '-0.0'
  return Number.isInteger(n) ? n.toFixed(1) : n.toString()
}

/** Date as EJSON's ISO string: milliseconds only when non-zero. */
function isoString(ms: number): string {
  const d = new Date(ms)
  const iso = d.toISOString()
  return d.getUTCMilliseconds() !== 0 ? iso : iso.slice(0, -5) + 'Z'
}

export function bsonToEJSON(bytes: Uint8Array, relaxed: boolean): string {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    return writeDocument(buf, 0, relaxed, false)
  } catch (err) {
    if (!(err instanceof Unsupported)) throw err
    return EJSON.stringify(BSON.deserialize(buf, DECODE) as Document, { relaxed })
  }
}

function cstringEnd(buf: Buffer, at: number): number {
  const end = buf.indexOf(0, at)
  if (end < 0) throw new Error('Corrupt BSON: unterminated name')
  return end
}

function writeDocument(buf: Buffer, start: number, relaxed: boolean, array: boolean): string {
  const size = buf.readInt32LE(start)
  const end = start + size - 1
  let i = start + 4
  let out = array ? '[' : '{'
  let first = true
  while (i < end) {
    const type = buf[i]!
    const nameEnd = cstringEnd(buf, i + 1)
    const name = buf.toString('utf8', i + 1, nameEnd)
    i = nameEnd + 1
    let value: string
    switch (type) {
      case 0x01: {
        const n = buf.readDoubleLE(i)
        i += 8
        value = relaxed && Number.isFinite(n) ? jsonNumber(n) : `{"$numberDouble":"${canonicalDouble(n)}"}`
        break
      }
      case 0x02:
      case 0x0d:
      case 0x0e: {
        const len = buf.readInt32LE(i)
        const s = buf.toString('utf8', i + 4, i + 4 + len - 1)
        i += 4 + len
        const str = JSON.stringify(s)
        value = type === 0x02 ? str : type === 0x0d ? `{"$code":${str}}` : `{"$symbol":${str}}`
        break
      }
      case 0x03:
      case 0x04: {
        const len = buf.readInt32LE(i)
        value = writeDocument(buf, i, relaxed, type === 0x04)
        i += len
        break
      }
      case 0x05: {
        const len = buf.readInt32LE(i)
        const sub = buf[i + 4]!
        if (sub === 0x02 || sub === 0x09) throw new Unsupported()
        const b64 = buf.toString('base64', i + 5, i + 5 + len)
        const hex = sub.toString(16)
        value = `{"$binary":{"base64":"${b64}","subType":"${hex.length === 1 ? '0' + hex : hex}"}}`
        i += 5 + len
        break
      }
      case 0x06:
        value = 'null' // EJSON writes undefined as null
        break
      case 0x07:
        value = `{"$oid":"${buf.toString('hex', i, i + 12)}"}`
        i += 12
        break
      case 0x08:
        value = buf[i] ? 'true' : 'false'
        i += 1
        break
      case 0x09: {
        const ms = buf.readBigInt64LE(i)
        i += 8
        const n = Number(ms)
        value =
          relaxed && n > -1 && n < MAX_DATE
            ? `{"$date":"${isoString(n)}"}`
            : `{"$date":{"$numberLong":"${ms.toString()}"}}`
        break
      }
      case 0x0a:
        value = 'null'
        break
      case 0x0b: {
        const pEnd = cstringEnd(buf, i)
        const pattern = buf.toString('utf8', i, pEnd)
        const oEnd = cstringEnd(buf, pEnd + 1)
        // BSONRegExp sorts its flags.
        const options = buf
          .toString('utf8', pEnd + 1, oEnd)
          .split('')
          .sort()
          .join('')
        i = oEnd + 1
        value = `{"$regularExpression":{"pattern":${JSON.stringify(pattern)},"options":${JSON.stringify(options)}}}`
        break
      }
      case 0x0f: {
        const total = buf.readInt32LE(i)
        const codeLen = buf.readInt32LE(i + 4)
        const code = buf.toString('utf8', i + 8, i + 8 + codeLen - 1)
        const scope = writeDocument(buf, i + 8 + codeLen, relaxed, false)
        value = `{"$code":${JSON.stringify(code)},"$scope":${scope}}`
        i += total
        break
      }
      case 0x10: {
        const n = buf.readInt32LE(i)
        i += 4
        value = relaxed ? String(n) : `{"$numberInt":"${n}"}`
        break
      }
      case 0x11: {
        const inc = buf.readUInt32LE(i)
        const t = buf.readUInt32LE(i + 4)
        i += 8
        value = `{"$timestamp":{"t":${t},"i":${inc}}}`
        break
      }
      case 0x12: {
        if (relaxed) {
          // Long.toNumber(): high * 2^32 + unsigned low (kept exactly as bson computes it).
          value = jsonNumber(buf.readInt32LE(i + 4) * TWO_PWR_32 + buf.readUInt32LE(i))
        } else value = `{"$numberLong":"${buf.readBigInt64LE(i).toString()}"}`
        i += 8
        break
      }
      case 0x13:
        value = `{"$numberDecimal":"${new Decimal128(buf.subarray(i, i + 16)).toString()}"}`
        i += 16
        break
      case 0xff:
        value = '{"$minKey":1}'
        break
      case 0x7f:
        value = '{"$maxKey":1}'
        break
      default:
        throw new Unsupported() // DBPointer and anything unexpected
    }
    out += (first ? '' : ',') + (array ? value : `${JSON.stringify(name)}:${value}`)
    first = false
  }
  return out + (array ? ']' : '}')
}
