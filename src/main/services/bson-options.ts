/**
 * Read options for anything that returns *user documents* to the UI.
 *
 * By default the driver "promotes" BSON values to JS primitives: Int32, Int64 and Double all
 * become `number` (so 10.0 looks like Int32 and Int64 beyond 2^53 loses precision), Binary
 * becomes Buffer, and regexes become RegExp (dropping flags JS doesn't know, like "x").
 * Every find/aggregate/getMore that feeds the UI must spread these options.
 */
export const PRESERVE_TYPES = {
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
  useBigInt64: false
} as const
