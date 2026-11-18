/**
 * MongoDB operator catalogue for autocomplete and hover docs.
 *
 * `value` is what gets inserted after "name: " when the operator is completed at a key position,
 * in Monaco snippet syntax ($1, ${1:default}, $0). Operator names inside templates ("$match")
 * are escaped automatically by toSnippet(), so templates are written naturally.
 */

export type OperatorKind =
  | 'query' // field-level query operator: { age: { $gt: 1 } }
  | 'queryTop' // top-level query operator: { $or: [...] }
  | 'update'
  | 'stage'
  | 'expression'
  | 'accumulator'
  | 'pushModifier'

export interface OperatorInfo {
  name: string
  kind: OperatorKind
  doc: string
  /** Snippet inserted after "name: ". Defaults to "$1". */
  value?: string
  /** Named arguments when the operator takes an object ({ $cond: { if, then, else } }). */
  args?: string[]
  /** Accumulators that also work as expressions ($sum, $max…). */
  alsoExpression?: boolean
}

const q = (name: string, doc: string, value?: string): OperatorInfo => ({ name, kind: 'query', doc, value })
const top = (name: string, doc: string, value?: string): OperatorInfo => ({
  name,
  kind: 'queryTop',
  doc,
  value
})
const upd = (name: string, doc: string, value = '{ $1 }'): OperatorInfo => ({
  name,
  kind: 'update',
  doc,
  value
})
const stage = (name: string, doc: string, value = '{ $1 }', args?: string[]): OperatorInfo => ({
  name,
  kind: 'stage',
  doc,
  value,
  args
})
const ex = (name: string, doc: string, value = '[$1]', args?: string[]): OperatorInfo => ({
  name,
  kind: 'expression',
  doc,
  value,
  args
})
const acc = (name: string, doc: string, value = '"\\$$1"', alsoExpression = false): OperatorInfo => ({
  name,
  kind: 'accumulator',
  doc,
  value,
  alsoExpression
})

export const QUERY_OPERATORS: OperatorInfo[] = [
  q('$eq', 'Matches values equal to the given value.'),
  q('$ne', 'Matches values not equal to the given value (also matches documents without the field).'),
  q('$gt', 'Matches values greater than the given value.'),
  q('$gte', 'Matches values greater than or equal to the given value.'),
  q('$lt', 'Matches values less than the given value.'),
  q('$lte', 'Matches values less than or equal to the given value.'),
  q('$in', 'Matches any of the values in the array.', '[$1]'),
  q('$nin', 'Matches none of the values in the array (also matches documents without the field).', '[$1]'),
  q('$exists', 'Matches documents that have (true) or lack (false) the field.', '${1:true}'),
  q(
    '$type',
    'Matches values of the given BSON type, by alias ("string", "int", "long", "double", "decimal", "date", "objectId"…) or number.',
    '"${1|string,int,long,double,decimal,bool,date,objectId,array,object,null,binData|}"'
  ),
  q('$regex', 'Matches strings against a regular expression.', '/${1:pattern}/${2:i}'),
  q('$options', 'Regex flags for $regex: i (case-insensitive), m, x, s.', '"${1:i}"'),
  q('$not', 'Inverts a field operator expression: { $not: { $gt: 5 } }.', '{ $1 }'),
  q('$elemMatch', 'Matches arrays with at least one element matching all the conditions.', '{ $1 }'),
  q('$size', 'Matches arrays with exactly this many elements.', '${1:0}'),
  q('$all', 'Matches arrays containing all of the given values.', '[$1]'),
  q(
    '$mod',
    'Matches values where value % divisor equals remainder: [divisor, remainder].',
    '[${1:2}, ${2:0}]'
  ),
  q('$bitsAllSet', 'Matches numbers or binary data where all the given bit positions are 1.', '[$1]'),
  q('$bitsAnySet', 'Matches numbers or binary data where any of the given bit positions is 1.', '[$1]'),
  q('$bitsAllClear', 'Matches numbers or binary data where all the given bit positions are 0.', '[$1]'),
  q('$bitsAnyClear', 'Matches numbers or binary data where any of the given bit positions is 0.', '[$1]'),
  q(
    '$geoWithin',
    'Matches geometries entirely within a shape.',
    '{ \\$geometry: { type: "Polygon", coordinates: [$1] } }'
  ),
  q(
    '$geoIntersects',
    'Matches geometries that intersect the given GeoJSON geometry.',
    '{ \\$geometry: { $1 } }'
  ),
  q(
    '$near',
    'Sorts documents by distance from a point (needs a geospatial index).',
    '{ \\$geometry: { type: "Point", coordinates: [${1:lng}, ${2:lat}] } }'
  ),
  q(
    '$nearSphere',
    'Like $near, using spherical geometry.',
    '{ \\$geometry: { type: "Point", coordinates: [${1:lng}, ${2:lat}] } }'
  )
]

export const QUERY_TOP_OPERATORS: OperatorInfo[] = [
  top('$and', 'Matches documents that satisfy every condition in the array.', '[{ $1 }, { $2 }]'),
  top('$or', 'Matches documents that satisfy at least one condition in the array.', '[{ $1 }, { $2 }]'),
  top('$nor', 'Matches documents that satisfy none of the conditions in the array.', '[{ $1 }]'),
  top('$expr', 'Uses aggregation expressions inside a query, e.g. to compare two fields.', '{ $1 }'),
  top('$text', 'Full-text search (needs a text index).', '{ \\$search: "${1:words}" }'),
  top('$jsonSchema', 'Matches documents that validate against a JSON Schema.', '{ $1 }'),
  top('$comment', 'Attaches a comment to the query (shows in logs and profiler).', '"${1:comment}"'),
  top(
    '$where',
    'Matches with a JavaScript expression run on the server. Slow; avoid.',
    '"${1:this.a > this.b}"'
  )
]

export const UPDATE_OPERATORS: OperatorInfo[] = [
  upd('$set', 'Sets the value of fields.'),
  upd('$unset', 'Removes fields: { $unset: { field: "" } }.'),
  upd('$inc', 'Increments fields by the given amount.'),
  upd('$mul', 'Multiplies fields by the given number.'),
  upd('$min', 'Updates the field only if the given value is less than the current value.'),
  upd('$max', 'Updates the field only if the given value is greater than the current value.'),
  upd('$rename', 'Renames fields: { $rename: { old: "new" } }.'),
  upd('$currentDate', 'Sets fields to the current date: { field: true } or { $type: "timestamp" }.'),
  upd('$setOnInsert', 'Sets fields only when an upsert inserts a document.'),
  upd('$push', 'Appends a value to an array (use $each to append several).'),
  upd('$addToSet', 'Adds a value to an array unless it is already there.'),
  upd('$pull', 'Removes all array elements that match a value or condition.'),
  upd('$pullAll', 'Removes all instances of the given values from an array.'),
  upd('$pop', 'Removes the first (-1) or last (1) element of an array.'),
  upd('$bit', 'Performs bitwise and/or/xor on integer fields.')
]

export const PUSH_MODIFIERS: OperatorInfo[] = [
  { name: '$each', kind: 'pushModifier', doc: 'Appends each element of the array.', value: '[$1]' },
  {
    name: '$slice',
    kind: 'pushModifier',
    doc: 'Limits the array to this many elements after the push.',
    value: '${1:-10}'
  },
  { name: '$sort', kind: 'pushModifier', doc: 'Sorts the array after the push.', value: '{ $1 }' },
  {
    name: '$position',
    kind: 'pushModifier',
    doc: 'Inserts at this index instead of appending.',
    value: '${1:0}'
  }
]

export const STAGES: OperatorInfo[] = [
  stage('$match', 'Filters documents with a query, like find(). Put it first so it can use indexes.'),
  stage('$project', 'Includes, excludes or computes fields.'),
  stage('$addFields', 'Adds computed fields, keeping the existing ones.'),
  stage('$set', 'Alias of $addFields.'),
  stage('$unset', 'Removes fields.', '"${1:field}"'),
  stage(
    '$group',
    'Groups documents by _id and computes accumulators per group.',
    '{ _id: ${1:"\\$field"}, ${2:count}: { \\$sum: 1 } }'
  ),
  stage('$sort', 'Sorts documents: 1 ascending, -1 descending.', '{ ${1:field}: ${2:-1} }'),
  stage('$limit', 'Passes only the first n documents.', '${1:10}'),
  stage('$skip', 'Skips the first n documents.', '${1:0}'),
  stage('$count', 'Outputs a single document with the number of input documents.', '"${1:count}"'),
  stage('$unwind', 'Outputs one document per array element.', '"\\$${1:field}"', [
    'path',
    'includeArrayIndex',
    'preserveNullAndEmptyArrays'
  ]),
  stage(
    '$lookup',
    'Joins documents from another collection.',
    '{ from: "${1:collection}", localField: "${2:field}", foreignField: "${3:_id}", as: "${4:joined}" }',
    ['from', 'localField', 'foreignField', 'as', 'let', 'pipeline']
  ),
  stage('$facet', 'Runs several sub-pipelines on the same input.', '{ ${1:name}: [$2] }'),
  stage('$replaceRoot', 'Replaces each document with an embedded document.', '{ newRoot: "\\$${1:field}" }', [
    'newRoot'
  ]),
  stage('$replaceWith', 'Replaces each document with the result of an expression.', '"\\$${1:field}"'),
  stage('$sample', 'Randomly selects n documents.', '{ size: ${1:10} }', ['size']),
  stage('$sortByCount', 'Groups by an expression and counts, sorted by count descending.', '"\\$${1:field}"'),
  stage(
    '$bucket',
    'Groups documents into buckets by boundaries.',
    '{ groupBy: "\\$${1:field}", boundaries: [$2], default: "${3:other}" }',
    ['groupBy', 'boundaries', 'default', 'output']
  ),
  stage(
    '$bucketAuto',
    'Groups documents into a number of evenly distributed buckets.',
    '{ groupBy: "\\$${1:field}", buckets: ${2:5} }',
    ['groupBy', 'buckets', 'output', 'granularity']
  ),
  stage(
    '$graphLookup',
    'Recursively searches a collection (trees, graphs).',
    '{ from: "${1:collection}", startWith: "\\$${2:field}", connectFromField: "${3:field}", connectToField: "${4:field}", as: "${5:result}" }',
    [
      'from',
      'startWith',
      'connectFromField',
      'connectToField',
      'as',
      'maxDepth',
      'depthField',
      'restrictSearchWithMatch'
    ]
  ),
  stage(
    '$unionWith',
    'Adds the documents of another collection (optionally through a pipeline).',
    '{ coll: "${1:collection}", pipeline: [$2] }',
    ['coll', 'pipeline']
  ),
  stage(
    '$out',
    'Writes the results to a collection, replacing it. Must be the last stage.',
    '"${1:collection}"'
  ),
  stage(
    '$merge',
    'Merges the results into a collection. Must be the last stage.',
    '{ into: "${1:collection}" }',
    ['into', 'on', 'let', 'whenMatched', 'whenNotMatched']
  ),
  stage('$redact', 'Restricts content by evaluating $$DESCEND / $$PRUNE / $$KEEP.'),
  stage(
    '$setWindowFields',
    'Computes window functions (running totals, ranks…) over partitions.',
    '{ partitionBy: "\\$${1:field}", sortBy: { ${2:field}: 1 }, output: { $3 } }',
    ['partitionBy', 'sortBy', 'output']
  ),
  stage(
    '$densify',
    'Fills gaps in a sequence of values.',
    '{ field: "${1:field}", range: { step: ${2:1}, bounds: "full" } }',
    ['field', 'partitionByFields', 'range']
  ),
  stage('$fill', 'Fills null and missing values.', '{ output: { $1 } }', [
    'partitionBy',
    'partitionByFields',
    'sortBy',
    'output'
  ]),
  stage(
    '$geoNear',
    'Sorts by distance from a point. Must be the first stage.',
    '{ near: { type: "Point", coordinates: [$1] }, distanceField: "${2:distance}" }',
    ['near', 'distanceField', 'spherical', 'maxDistance', 'minDistance', 'query', 'key']
  ),
  stage('$indexStats', 'Returns usage statistics for each index.', '{}'),
  stage('$collStats', 'Returns collection statistics.', '{ storageStats: {} }'),
  stage('$documents', 'Starts the pipeline with literal documents (on db.aggregate).', '[$1]'),
  stage(
    '$search',
    'Atlas Search full-text query (Atlas only).',
    '{ index: "${1:default}", text: { query: "$2", path: "$3" } }'
  ),
  stage(
    '$vectorSearch',
    'Atlas Vector Search (Atlas only).',
    '{ index: "$1", path: "$2", queryVector: [$3], numCandidates: ${4:100}, limit: ${5:10} }'
  )
]

export const ACCUMULATORS: OperatorInfo[] = [
  acc('$sum', 'Sum of numeric values. { $sum: 1 } counts documents.', '${1:1}', true),
  acc('$avg', 'Average of numeric values.', undefined, true),
  acc('$min', 'Lowest value.', undefined, true),
  acc('$max', 'Highest value.', undefined, true),
  acc('$first', 'Value from the first document of each group.', undefined, true),
  acc('$last', 'Value from the last document of each group.', undefined, true),
  acc('$push', 'Array of all values in the group.'),
  acc('$addToSet', 'Array of distinct values in the group.'),
  acc('$count', 'Number of documents in the group.', '{}'),
  acc('$stdDevPop', 'Population standard deviation.', undefined, true),
  acc('$stdDevSamp', 'Sample standard deviation.', undefined, true),
  acc('$mergeObjects', 'Merges the documents of the group into one.', undefined, true),
  acc(
    '$top',
    'Top element of the group by a sort order.',
    '{ sortBy: { ${1:field}: -1 }, output: "\\$${2:field}" }'
  ),
  acc(
    '$bottom',
    'Bottom element of the group by a sort order.',
    '{ sortBy: { ${1:field}: -1 }, output: "\\$${2:field}" }'
  ),
  acc(
    '$topN',
    'Top n elements of the group by a sort order.',
    '{ n: ${1:3}, sortBy: { ${2:field}: -1 }, output: "\\$${3:field}" }'
  ),
  acc('$firstN', 'First n values of the group.', '{ n: ${1:3}, input: "\\$${2:field}" }'),
  acc('$lastN', 'Last n values of the group.', '{ n: ${1:3}, input: "\\$${2:field}" }'),
  acc('$median', 'Median of numeric values.', '{ input: "\\$${1:field}", method: "approximate" }'),
  acc(
    '$percentile',
    'Percentiles of numeric values.',
    '{ input: "\\$${1:field}", p: [${2:0.95}], method: "approximate" }'
  )
]

export const EXPRESSIONS: OperatorInfo[] = [
  // arithmetic
  ex('$add', 'Adds numbers, or a number of milliseconds to a date.'),
  ex('$subtract', 'Subtracts the second value from the first (numbers or dates).'),
  ex('$multiply', 'Multiplies numbers.'),
  ex('$divide', 'Divides the first number by the second.'),
  ex('$mod', 'Remainder of dividing the first number by the second.'),
  ex('$abs', 'Absolute value.', '"\\$$1"'),
  ex('$ceil', 'Smallest integer greater than or equal to the number.', '"\\$$1"'),
  ex('$floor', 'Largest integer less than or equal to the number.', '"\\$$1"'),
  ex('$round', 'Rounds to a number of decimal places.', '["\\$$1", ${2:0}]'),
  ex('$trunc', 'Truncates to a number of decimal places.', '["\\$$1", ${2:0}]'),
  ex('$pow', 'Raises a number to an exponent.'),
  ex('$sqrt', 'Square root.', '"\\$$1"'),
  ex('$log10', 'Base-10 logarithm.', '"\\$$1"'),
  // comparison & boolean
  ex('$eq', 'True if the two values are equal.'),
  ex('$ne', 'True if the two values are not equal.'),
  ex('$gt', 'True if the first value is greater than the second.'),
  ex('$gte', 'True if the first value is greater than or equal to the second.'),
  ex('$lt', 'True if the first value is less than the second.'),
  ex('$lte', 'True if the first value is less than or equal to the second.'),
  ex('$cmp', 'Returns -1, 0 or 1 comparing two values.'),
  ex('$and', 'True if every expression is true.'),
  ex('$or', 'True if any expression is true.'),
  ex('$not', 'Inverts a boolean expression.'),
  ex('$in', 'True if the value is in the array: [value, array].'),
  // conditional
  ex('$cond', 'If-then-else.', '{ if: $1, then: $2, else: $3 }', ['if', 'then', 'else']),
  ex('$ifNull', 'First non-null value: [expr, replacement].', '["\\$$1", ${2:null}]'),
  ex(
    '$switch',
    'Evaluates cases in order and returns the first match.',
    '{ branches: [{ case: $1, then: $2 }], default: $3 }',
    ['branches', 'default']
  ),
  // strings
  ex('$concat', 'Concatenates strings.'),
  ex('$toLower', 'Lowercases a string.', '"\\$$1"'),
  ex('$toUpper', 'Uppercases a string.', '"\\$$1"'),
  ex('$trim', 'Removes whitespace (or given characters) from both ends.', '{ input: "\\$$1" }', [
    'input',
    'chars'
  ]),
  ex('$split', 'Splits a string into an array: [string, delimiter].'),
  ex('$substrCP', 'Substring by code points: [string, start, length].'),
  ex('$strLenCP', 'Length of a string in code points.', '"\\$$1"'),
  ex('$regexMatch', 'True if the string matches the regex.', '{ input: "\\$$1", regex: /$2/ }', [
    'input',
    'regex',
    'options'
  ]),
  ex('$regexFind', 'First regex match in the string.', '{ input: "\\$$1", regex: /$2/ }', [
    'input',
    'regex',
    'options'
  ]),
  ex(
    '$replaceAll',
    'Replaces every occurrence of a substring.',
    '{ input: "\\$$1", find: "$2", replacement: "$3" }',
    ['input', 'find', 'replacement']
  ),
  // arrays
  ex('$size', 'Number of elements in an array.', '"\\$$1"'),
  ex('$arrayElemAt', 'Element at an index: [array, index].', '["\\$$1", ${2:0}]'),
  ex('$first', 'First element of an array.', '"\\$$1"'),
  ex('$last', 'Last element of an array.', '"\\$$1"'),
  ex('$slice', 'Subset of an array: [array, n] or [array, position, n].'),
  ex('$concatArrays', 'Concatenates arrays.'),
  ex(
    '$filter',
    'Elements of an array that match a condition.',
    '{ input: "\\$$1", as: "${2:item}", cond: $3 }',
    ['input', 'as', 'cond', 'limit']
  ),
  ex(
    '$map',
    'Applies an expression to each element of an array.',
    '{ input: "\\$$1", as: "${2:item}", in: $3 }',
    ['input', 'as', 'in']
  ),
  ex(
    '$reduce',
    'Combines array elements into a single value.',
    '{ input: "\\$$1", initialValue: ${2:0}, in: $3 }',
    ['input', 'initialValue', 'in']
  ),
  ex('$isArray', 'True if the value is an array.', '"\\$$1"'),
  ex('$reverseArray', 'Reverses an array.', '"\\$$1"'),
  ex('$sortArray', 'Sorts an array.', '{ input: "\\$$1", sortBy: ${2:1} }', ['input', 'sortBy']),
  ex('$indexOfArray', 'Index of the first occurrence of a value in an array.'),
  ex('$objectToArray', 'Converts a document to an array of { k, v }.', '"\\$$1"'),
  ex('$arrayToObject', 'Converts an array of { k, v } (or [k, v]) to a document.', '"\\$$1"'),
  // dates
  ex('$dateToString', 'Formats a date as a string.', '{ format: "${1:%Y-%m-%d}", date: "\\$$2" }', [
    'format',
    'date',
    'timezone',
    'onNull'
  ]),
  ex('$dateFromString', 'Parses a date from a string.', '{ dateString: "\\$$1" }', [
    'dateString',
    'format',
    'timezone',
    'onError',
    'onNull'
  ]),
  ex(
    '$dateAdd',
    'Adds a number of time units to a date.',
    '{ startDate: "\\$$1", unit: "${2:day}", amount: ${3:1} }',
    ['startDate', 'unit', 'amount', 'timezone']
  ),
  ex(
    '$dateSubtract',
    'Subtracts a number of time units from a date.',
    '{ startDate: "\\$$1", unit: "${2:day}", amount: ${3:1} }',
    ['startDate', 'unit', 'amount', 'timezone']
  ),
  ex(
    '$dateDiff',
    'Difference between two dates in a unit.',
    '{ startDate: "\\$$1", endDate: "\\$$2", unit: "${3:day}" }',
    ['startDate', 'endDate', 'unit', 'timezone', 'startOfWeek']
  ),
  ex('$dateTrunc', 'Truncates a date to a unit (day, month…).', '{ date: "\\$$1", unit: "${2:day}" }', [
    'date',
    'unit',
    'binSize',
    'timezone',
    'startOfWeek'
  ]),
  ex('$year', 'Year of a date.', '"\\$$1"'),
  ex('$month', 'Month of a date (1–12).', '"\\$$1"'),
  ex('$dayOfMonth', 'Day of the month (1–31).', '"\\$$1"'),
  ex('$dayOfWeek', 'Day of the week (1 = Sunday … 7 = Saturday).', '"\\$$1"'),
  ex('$hour', 'Hour of a date (0–23).', '"\\$$1"'),
  // types
  ex('$type', 'BSON type name of a value.', '"\\$$1"'),
  ex(
    '$convert',
    'Converts a value to a type, with error handling.',
    '{ input: "\\$$1", to: "${2:string}", onError: ${3:null} }',
    ['input', 'to', 'onError', 'onNull']
  ),
  ex('$toString', 'Converts a value to a string.', '"\\$$1"'),
  ex('$toInt', 'Converts a value to an Int32.', '"\\$$1"'),
  ex('$toLong', 'Converts a value to an Int64.', '"\\$$1"'),
  ex('$toDouble', 'Converts a value to a Double.', '"\\$$1"'),
  ex('$toDecimal', 'Converts a value to a Decimal128.', '"\\$$1"'),
  ex('$toDate', 'Converts a value to a date.', '"\\$$1"'),
  ex('$toObjectId', 'Converts a string to an ObjectId.', '"\\$$1"'),
  ex('$toBool', 'Converts a value to a boolean.', '"\\$$1"'),
  // documents & variables
  ex(
    '$getField',
    'Value of a field, including names with dots or $.',
    '{ field: "$1", input: "\\$\\$CURRENT" }',
    ['field', 'input']
  ),
  ex(
    '$setField',
    'Adds, updates or removes a field, including names with dots or $.',
    '{ field: "$1", input: "\\$\\$ROOT", value: $2 }',
    ['field', 'input', 'value']
  ),
  ex('$let', 'Defines variables for use in an expression.', '{ vars: { $1 }, in: $2 }', ['vars', 'in']),
  ex('$literal', 'Returns a value without parsing it as an expression.', '$1')
]

/** BSON constructors accepted by the query parser (and their shell output form). */
export interface ConstructorInfo {
  name: string
  doc: string
  /** Full snippet, e.g. ObjectId("$1"). */
  snippet: string
}

export const CONSTRUCTORS: ConstructorInfo[] = [
  { name: 'ObjectId', doc: 'A 12-byte ObjectId from 24 hex characters.', snippet: 'ObjectId("$1")' },
  {
    name: 'ISODate',
    doc: 'A date from an ISO-8601 string (UTC unless an offset is given).',
    snippet: 'ISODate("${1:2026-01-01T00:00:00Z}")'
  },
  {
    name: 'new Date',
    doc: 'A date: now, from milliseconds, or from an ISO string.',
    snippet: 'new Date($1)'
  },
  {
    name: 'NumberLong',
    doc: 'A 64-bit integer (Int64). Pass a string to keep precision past 2^53.',
    snippet: 'NumberLong("$1")'
  },
  { name: 'NumberInt', doc: 'A 32-bit integer (Int32).', snippet: 'NumberInt($1)' },
  {
    name: 'NumberDecimal',
    doc: 'A 128-bit decimal (exact, for money). Pass a string.',
    snippet: 'NumberDecimal("$1")'
  },
  { name: 'Double', doc: 'A 64-bit floating point number, even for whole values.', snippet: 'Double($1)' },
  { name: 'UUID', doc: 'A UUID stored as Binary subtype 4.', snippet: 'UUID("$1")' },
  { name: 'BinData', doc: 'Binary data: BinData(subtype, base64).', snippet: 'BinData(${1:0}, "$2")' },
  {
    name: 'Timestamp',
    doc: 'An internal MongoDB timestamp (seconds, increment).',
    snippet: 'Timestamp({ t: $1, i: ${2:1} })'
  },
  {
    name: 'RegExp',
    doc: 'A regular expression: RegExp(pattern, flags), or /pattern/flags.',
    snippet: 'RegExp("$1", "${2:i}")'
  },
  { name: 'MinKey', doc: 'Compares lower than every other value.', snippet: 'MinKey()' },
  { name: 'MaxKey', doc: 'Compares higher than every other value.', snippet: 'MaxKey()' }
]

export const SYSTEM_VARIABLES: { name: string; doc: string }[] = [
  { name: '$$NOW', doc: 'The current date and time (same for the whole pipeline).' },
  { name: '$$ROOT', doc: 'The top-level document being processed.' },
  { name: '$$CURRENT', doc: 'The current document (usually the same as $$ROOT).' },
  { name: '$$REMOVE', doc: 'Removes the field when used as a value.' },
  { name: '$$CLUSTER_TIME', doc: 'The current cluster timestamp (replica sets and sharded clusters).' }
]

export const COLLATION_OPTIONS: OperatorInfo[] = [
  ['locale', 'ICU locale, e.g. "en", "fr", or "simple" for binary comparison.', '"${1:en}"'],
  ['strength', '1 = base letters, 2 = + accents, 3 = + case (default), 4, 5.', '${1:2}'],
  ['caseLevel', 'Include case comparison at strength 1 or 2.', '${1:false}'],
  ['caseFirst', '"upper", "lower" or "off".', '"${1|upper,lower,off|}"'],
  ['numericOrdering', 'Compare numeric strings as numbers ("10" > "9").', '${1:true}'],
  [
    'alternate',
    '"non-ignorable" or "shifted" (ignore spaces and punctuation).',
    '"${1|non-ignorable,shifted|}"'
  ],
  ['maxVariable', 'With alternate "shifted": "punct" or "space".', '"${1|punct,space|}"'],
  ['backwards', 'Sort strings with diacritics from the back (French).', '${1:false}'],
  ['normalization', 'Check whether text needs normalization.', '${1:false}']
].map(([name, doc, value]) => ({ name: name!, kind: 'query' as const, doc: doc!, value }))

/** Every operator by name, for hover. Several kinds can share a name ($min, $size…). */
export function lookupOperator(name: string): OperatorInfo[] {
  return ALL.filter((o) => o.name === name)
}

const ALL: OperatorInfo[] = [
  ...QUERY_TOP_OPERATORS,
  ...QUERY_OPERATORS,
  ...UPDATE_OPERATORS,
  ...STAGES,
  ...ACCUMULATORS,
  ...EXPRESSIONS,
  ...PUSH_MODIFIERS
]

export const kindLabel: Record<OperatorKind, string> = {
  query: 'query operator',
  queryTop: 'query operator',
  update: 'update operator',
  stage: 'aggregation stage',
  expression: 'expression operator',
  accumulator: 'accumulator',
  pushModifier: '$push modifier'
}

/**
 * Escapes "$" for Monaco snippet syntax, except placeholders ($1, ${1:…}, $0).
 * Templates may already contain "\\$" (escaped on purpose); those are kept.
 */
export function toSnippet(template: string): string {
  return template.replace(/(\\)?\$(?![\d{])/g, (_m, escaped: string | undefined) => (escaped ? '\\$' : '\\$'))
}
