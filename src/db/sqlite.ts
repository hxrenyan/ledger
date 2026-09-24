import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { insertedId, type Db, type Stmt } from './types.ts'

export function createSqliteDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const raw = new Database(path)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')

  return {
    async all(sql, params = []) {
      return raw.prepare(sql).all(...params) as never
    },
    async first(sql, params = []) {
      return (raw.prepare(sql).get(...params) as never) ?? null
    },
    async run(sql, params = []) {
      raw.prepare(sql).run(...params)
    },
    async exec(sql) {
      raw.exec(sql)
    },
    async batch(stmts: Stmt[]) {
      const tx = raw.transaction(() => {
        return stmts.map((s) => {
          const info = raw.prepare(s.sql).run(...(s.params ?? []))
          return { lastId: insertedId(s.sql, info.changes, Number(info.lastInsertRowid)) }
        })
      })
      return tx()
    },
  }
}
