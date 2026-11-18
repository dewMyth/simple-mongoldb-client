/**
 * One document containing every BSON type, with edge cases that clients commonly break:
 * Int64 around 2^53, Decimal128 with many digits, Binary subtypes 0/4/5, dates before 1970,
 * MinKey/MaxKey, nested mixed-type arrays, -0, NaN/Infinity doubles.
 */
import {
  Binary,
  BSONRegExp,
  BSONSymbol,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  type Document
} from 'bson'

export const ALL_TYPES_ID = new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9')

export function allTypesDoc(): Document {
  return {
    _id: ALL_TYPES_ID,
    string: 'héllo wörld 🌍',
    emptyString: '',
    int32: new Int32(42),
    int32Negative: new Int32(-2147483648),
    int64: Long.fromString('9007199254740993'), // 2^53 + 1: not representable as a double
    int64Max: Long.MAX_VALUE,
    int64Small: Long.fromNumber(5),
    double: new Double(3.14159),
    doubleWhole: new Double(10), // must stay Double, not become Int32
    doubleNegZero: new Double(-0),
    doubleNaN: new Double(NaN),
    doubleInf: new Double(Infinity),
    decimal128: Decimal128.fromString('1234567890123456789012345678901234'),
    decimal128Small: Decimal128.fromString('10.50'),
    boolTrue: true,
    boolFalse: false,
    date: new Date('2026-01-15T10:30:00.123Z'),
    datePre1970: new Date('1969-07-20T20:17:40Z'),
    dateEpoch: new Date(0),
    null: null,
    objectId: new ObjectId('507f1f77bcf86cd799439011'),
    binaryGeneric: new Binary(Buffer.from([0, 1, 2, 3, 254, 255]), 0),
    binaryUuid: new UUID('3b241101-e2bb-4255-8caf-4136c566a962').toBinary(),
    binaryMd5: new Binary(Buffer.from('d41d8cd98f00b204e9800998ecf8427e', 'hex'), 5),
    binaryUserDefined: new Binary(Buffer.from('custom'), 128),
    timestamp: new Timestamp({ t: 1700000000, i: 1 }),
    regex: new BSONRegExp('^dew', 'i'),
    regexFlags: new BSONRegExp('a.b', 'imsx'),
    minKey: new MinKey(),
    maxKey: new MaxKey(),
    code: new Code('function () { return 1 }'),
    codeWithScope: new Code('function () { return x }', { x: 1 }),
    symbol: new BSONSymbol('sym'),
    dbRef: new DBRef('orders', new ObjectId('507f191e810c19729de860ea'), 'shop'),
    nested: {
      level2: {
        level3: { deep: new Int32(1), when: new Date('2000-02-29T00:00:00Z') }
      }
    },
    emptyObject: {},
    emptyArray: [],
    mixedArray: [
      new Int32(1),
      Long.fromNumber(2),
      new Double(3.5),
      Decimal128.fromString('4.25'),
      'five',
      null,
      true,
      new Date('1950-01-01T00:00:00Z'),
      [new Int32(1), [new Int32(2)]],
      { inArray: new ObjectId('507f1f77bcf86cd799439012') }
    ],
    'dotted.key': 'keys with dots',
    $dollarKey: 'keys starting with $ (allowed in 5.0+)'
  }
}
