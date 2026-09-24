import { insertedId, type Db, type Stmt } from './types.ts'

export function createD1Db(d1: D1Database): Db {
  return {
    async all(sql, params = []) {
      const r = await d1.prepare(sql).bind(...params).all()
      return (r.results ?? []) as never
    },
    async first(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) as never
    },
    async run(sql, params = []) {
      await d1.prepare(sql).bind(...params).run()
    },
    async exec(sql) {
      await d1.exec(sql)
    },
    async batch(stmts: Stmt[]) {
      const results = await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...(s.params ?? []))))
      return results.map((r, i) => ({
        lastId: insertedId(stmts[i]?.sql ?? '', r.meta?.changes ?? 0, Number(r.meta?.last_row_id ?? 0)),
      }))
    },
  }
}
