/** Pipelines used to check that text ↔ stage mode conversion is lossless. */

/** Stage-mode fixtures: what the stage editor holds. */
export const stageFixtures: {
  name: string
  stages: { operator: string; body: string; enabled: boolean }[]
}[] = [
  {
    name: 'six-stage orders report',
    stages: [
      {
        operator: '$match',
        body: "{ status: { $in: ['paid', 'shipped'] }, total: { $gte: NumberDecimal('10.00') } }",
        enabled: true
      },
      { operator: '$unwind', body: "'$items'", enabled: true },
      {
        operator: '$group',
        body: "{\n  _id: '$items.sku',\n  qty: { $sum: '$items.qty' },\n  revenue: { $sum: { $multiply: ['$items.qty', '$items.price'] } }\n}",
        enabled: true
      },
      {
        operator: '$lookup',
        body: "{\n  from: 'products',\n  localField: '_id',\n  foreignField: 'sku',\n  as: 'product'\n}",
        enabled: true
      },
      {
        operator: '$project',
        body: "{ _id: 0, sku: '$_id', qty: 1, revenue: 1, name: { $first: '$product.name' } }",
        enabled: true
      },
      { operator: '$sort', body: '{ revenue: -1 }', enabled: true }
    ]
  },
  {
    name: 'disabled stages at the start, middle and end',
    stages: [
      { operator: '$limit', body: '1000', enabled: false },
      { operator: '$match', body: '{ a: 1 }', enabled: true },
      { operator: '$project', body: '{\n  a: 1,\n  b: 1\n}', enabled: false },
      { operator: '$sort', body: '{ a: -1 }', enabled: true },
      { operator: '$count', body: "'n'", enabled: false }
    ]
  },
  {
    name: 'tricky literals: brackets in strings, regexes, comments',
    stages: [
      {
        operator: '$match',
        body: '{\n  // a comment with } and ]\n  name: /^[a-z]{2,},\\/$/i,\n  note: "it\'s { not } a [stage], really"\n}',
        enabled: true
      },
      {
        operator: '$addFields',
        body: "{ when: ISODate('2026-01-01T00:00:00Z'), n: NumberLong('9007199254740993'), d: Double(10) }",
        enabled: true
      },
      { operator: '$set', body: '{ /* inline */ x: [1, [2, { y: 3 }]] }', enabled: true }
    ]
  },
  { name: 'all disabled', stages: [{ operator: '$match', body: '{}', enabled: false }] },
  { name: 'empty body', stages: [{ operator: '$match', body: '', enabled: true }] },
  { name: 'empty pipeline', stages: [] }
]

/** Hand-written text pipelines (not in canonical layout): conversion must keep their meaning. */
export const textFixtures: string[] = [
  `[{$match:{status:"paid"}},{$group:{_id:"$customer",n:{$sum:1}}},{$sort:{n:-1}},{$limit:10}]`,
  `[
    // top-level comment that isn't a stage
    { "$match": { tags: { $all: ["a", "b"] } } },
    {
        $project: {
            tags: 1,   // trailing comment
            re: /a,b}/g
        }
    },
  ]`,
  `[ { $facet: { byStatus: [{ $sortByCount: '$status' }], total: [{ $count: 'n' }] } } ]`
]
