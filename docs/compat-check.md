# Compass side-by-side check

Phase 3 asks for a manual comparison: the same 20 queries, run in Mongo Studio and in MongoDB
Compass against the same data, must return identical counts.

Both apps use `mongodb-query-parser` for the query bar, and the automated corpus
(`tests/fixtures/compass-queries.ts`, 100+ cases) pins the parser output, so differences here
would point to execution differences (options, collation, count method), not parsing.

## How to run it

1. Seed the dataset into a server Compass can reach:
   ```sh
   npx tsx scripts/compat-check.ts mongodb://localhost:27017
   ```
   This drops and recreates `compat_check.orders` (500 deterministic documents plus a 2dsphere
   index) and prints Mongo Studio's counts (the table below was generated the same way).
2. Open `compat_check.orders` in Compass, paste each query into the filter bar and record the
   document count in the **Compass** column.
3. Repeat in Mongo Studio by pasting into the filter bar; the count shown must match the
   Mongo Studio column.
4. When all 20 rows match, tick the box in PLAN.md (Phase 3).

## Results

Status: **Mongo Studio column generated; Compass column not yet filled in.**

| #   | Query                                                                                   | Mongo Studio | Compass |
| --- | --------------------------------------------------------------------------------------- | ------------ | ------- |
| 1   | `{}`                                                                                    | 500          |         |
| 2   | `{ status: "paid" }`                                                                    | 125          |         |
| 3   | `{ status: { $in: ["paid", "shipped"] } }`                                              | 250          |         |
| 4   | `{ total: { $gte: NumberDecimal("100") } }`                                             | 293          |         |
| 5   | `{ qty: NumberLong(3) }`                                                                | 50           |         |
| 6   | `{ qty: { $gt: 5, $lte: 8 } }`                                                          | 150          |         |
| 7   | `{ createdAt: { $gte: ISODate("2026-03-01"), $lt: ISODate("2026-04-01") } }`            | 83           |         |
| 8   | `{ "customer.name": /^a/i }`                                                            | 168          |         |
| 9   | `{ "customer.email": { $exists: false } }`                                              | 100          |         |
| 10  | `{ tags: "gift" }`                                                                      | 300          |         |
| 11  | `{ tags: { $all: ["gift", "express"] } }`                                               | 200          |         |
| 12  | `{ tags: { $size: 0 } }`                                                                | 100          |         |
| 13  | `{ items: { $elemMatch: { sku: "B-2", qty: { $gte: 2 } } } }`                           | 84           |         |
| 14  | `{ $or: [{ status: "cancelled" }, { total: { $lt: NumberDecimal("10") } }] }`           | 140          |         |
| 15  | `{ $expr: { $gt: ["$qty", "$minQty"] } }`                                               | 297          |         |
| 16  | `{ total: { $type: "decimal" } }`                                                       | 500          |         |
| 17  | `{ flags: { $bitsAllSet: [0, 2] } }`                                                    | 124          |         |
| 18  | `{ _id: { $gt: ObjectId("650000000000000000000100") } }`                                | 243          |         |
| 19  | `{ "customer.name": { $regex: "smith", $options: "i" }, status: { $ne: "cancelled" } }` | 125          |         |
| 20  | `{ loc: { $geoWithin: { $centerSphere: [[79.86, 6.92], 0.001] } } }`                    | 500          |         |
