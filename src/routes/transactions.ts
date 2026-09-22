import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, notFound } from '../http.ts'
import { assertAmountCents, centsToYuan } from '../money.ts'
import { balanceStmts, type TxMoney } from '../balance.ts'
import { dateToOccurredAt, occurredAtToDate, shanghaiDayRange, shanghaiMonth, shanghaiMonthRange } from '../time.ts'
import { newId } from '../seed.ts'

const RECEIPT_MAX = 512 * 1024
const RECEIPT_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

type TxRow = {
  id: string
  account_id: string
  to_account_id: string | null
  category_id: string | null
  kind: string
  amount_cents: number
  occurred_at: number
  note: string
  has_receipt: number
  excluded: number
  created_at: number
  updated_at: number
}

export function registerTransactionRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/transactions', async (c) => {
    const month = c.req.query('month') || shanghaiMonth()
    const { start, end } = shanghaiMonthRange(month)
    const day = c.req.query('day')
    const range = day ? shanghaiDayRange(day) : { start, end }
    const accountId = c.req.query('account_id')
    const categoryId = c.req.query('category_id')
    const q = (c.req.query('q') || '').trim()
    const params: unknown[] = [c.get('ledgerId'), range.start, range.end]
    let extra = ''
    if (accountId) {
      extra += ' AND (account_id = ? OR to_account_id = ?)'
      params.push(accountId, accountId)
    }
    if (categoryId) {
      extra += ' AND category_id = ?'
      params.push(categoryId)
    }
    if (q) {
      extra += ' AND note LIKE ?'
      params.push(`%${q}%`)
    }
    const rows = await c.get('db').all<TxRow>(
      `SELECT id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_at, updated_at
       FROM transactions
       WHERE ledger_id = ? AND occurred_at >= ? AND occurred_at < ? ${extra}
       ORDER BY occurred_at DESC, created_at DESC`,
      params,
    )
    return c.json({ month, items: rows.map(shape) })
  })

  app.get('/api/v1/transactions/:id', async (c) => {
    const row = await c.get('db').first<TxRow>(
      `SELECT id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_at, updated_at
       FROM transactions WHERE id = ? AND ledger_id = ?`,
      [c.req.param('id'), c.get('ledgerId')],
    )
    if (!row) throw notFound('流水不存在')
    return c.json(shape(row))
  })

  app.post('/api/v1/transactions', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const saved = await upsertTx(c, null, body)
    return c.json(saved, 201)
  })

  app.patch('/api/v1/transactions/:id', async (c) => {
    const saved = await upsertTx(c, c.req.param('id'), await c.req.json().catch(() => ({})))
    return c.json(saved)
  })

  app.delete('/api/v1/transactions/:id', async (c) => {
    const db = c.get('db')
    const row = await db.first<TxMoney>(
      `SELECT kind, amount_cents, account_id, to_account_id FROM transactions WHERE id = ? AND ledger_id = ?`,
      [c.req.param('id'), c.get('ledgerId')],
    )
    if (!row) throw notFound('流水不存在')
    await db.batch([
      ...balanceStmts(row, -1),
      { sql: `DELETE FROM attachments WHERE transaction_id = ?`, params: [c.req.param('id')] },
      { sql: `DELETE FROM transactions WHERE id = ?`, params: [c.req.param('id')] },
    ])
    return c.json({ ok: true })
  })

  app.post('/api/v1/transactions/:id/receipt', async (c) => {
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const txId = c.req.param('id')
    const tx = await db.first(`SELECT id FROM transactions WHERE id = ? AND ledger_id = ?`, [txId, ledgerId])
    if (!tx) throw notFound('流水不存在')
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw badRequest('请上传图片')
    if (file.size <= 0 || file.size > RECEIPT_MAX) throw badRequest('收据须小于 512KB')
    const mime = file.type
    if (!RECEIPT_MIME.has(mime)) throw badRequest('仅支持 jpeg / png / webp')
    const bytes = new Uint8Array(await file.arrayBuffer())
    await db.batch([
      { sql: `DELETE FROM attachments WHERE transaction_id = ?`, params: [txId] },
      {
        sql: `INSERT INTO attachments (transaction_id, ledger_id, mime, bytes, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: [txId, ledgerId, mime, bytes, Date.now()],
      },
      { sql: `UPDATE transactions SET has_receipt = 1 WHERE id = ?`, params: [txId] },
    ])
    return c.json({ ok: true, has_receipt: true, size: bytes.length })
  })

  app.get('/api/v1/transactions/:id/receipt', async (c) => {
    const row = await c.get('db').first<{ mime: string; bytes: unknown }>(
      `SELECT mime, bytes FROM attachments WHERE transaction_id = ? AND ledger_id = ?`,
      [c.req.param('id'), c.get('ledgerId')],
    )
    if (!row) throw notFound('没有收据')
    return new Response(asBytes(row.bytes), {
      headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=3600' },
    })
  })

  app.delete('/api/v1/transactions/:id/receipt', async (c) => {
    const db = c.get('db')
    const txId = c.req.param('id')
    const tx = await db.first(`SELECT id FROM transactions WHERE id = ? AND ledger_id = ?`, [txId, c.get('ledgerId')])
    if (!tx) throw notFound('流水不存在')
    await db.batch([
      { sql: `DELETE FROM attachments WHERE transaction_id = ?`, params: [txId] },
      { sql: `UPDATE transactions SET has_receipt = 0 WHERE id = ?`, params: [txId] },
    ])
    return c.json({ ok: true })
  })

  const exportCsv = async (c: Context<AppEnv>) => {
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const rows = await db.all<{
      kind: string
      amount_cents: number
      occurred_at: number
      note: string
      excluded: number
      account_name: string
      to_account_name: string | null
      category_name: string | null
    }>(
      `SELECT t.kind, t.amount_cents, t.occurred_at, t.note, IFNULL(t.excluded, 0) AS excluded,
              a.name AS account_name, b.name AS to_account_name, c.name AS category_name
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN accounts b ON b.id = t.to_account_id
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.ledger_id = ?
       ORDER BY t.occurred_at ASC, t.created_at ASC`,
      [ledgerId],
    )
    const gifts = await db.all<{
      kind: string
      amount_cents: number
      occurred_at: number
      note: string
      occasion: string
      contact_name: string
    }>(
      `SELECT g.kind, g.amount_cents, g.occurred_at, g.note, g.occasion, p.name AS contact_name
       FROM gifts g JOIN contacts p ON p.id = g.contact_id
       WHERE g.ledger_id = ?
       ORDER BY g.occurred_at ASC, g.created_at ASC`,
      [ledgerId],
    )
    const lines = ['日期,类型,金额,分类,账户,转入账户,不计入,备注']
    for (const r of rows) {
      const kind = r.kind === 'income' ? '收入' : r.kind === 'expense' ? '支出' : '转账'
      lines.push(
        [
          csvCell(occurredAtToDate(r.occurred_at)),
          csvCell(kind),
          csvCell(centsToYuan(r.amount_cents)),
          csvCell(r.category_name),
          csvCell(r.account_name),
          csvCell(r.to_account_name),
          csvCell(r.excluded ? '是' : ''),
          csvCell(r.note),
        ].join(','),
      )
    }
    if (gifts.length) {
      lines.push('')
      lines.push('人情往来')
      lines.push('日期,方向,金额,对方,事由,备注')
      for (const g of gifts) {
        lines.push(
          [
            csvCell(occurredAtToDate(g.occurred_at)),
            csvCell(g.kind === 'give' ? '送出' : '收入'),
            csvCell(centsToYuan(g.amount_cents)),
            csvCell(g.contact_name),
            csvCell(g.occasion),
            csvCell(g.note),
          ].join(','),
        )
      }
    }
    const bom = '\uFEFF'
    return new Response(bom + lines.join('\r\n') + '\r\n', {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': "attachment; filename=ledger.csv; filename*=UTF-8''%E8%AE%B0%E8%B4%A6.csv",
      },
    })
  }
  app.get('/api/v1/export.csv', exportCsv)
  app.get('/api/v1/export', exportCsv)
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return `"${s.replace(/"/g, '""')}"`
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  throw badRequest('收据数据损坏')
}

function shape(row: TxRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    to_account_id: row.to_account_id,
    category_id: row.category_id,
    kind: row.kind,
    amount_cents: row.amount_cents,
    occurred_at: row.occurred_at,
    note: row.note,
    has_receipt: !!row.has_receipt,
    excluded: !!row.excluded,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function upsertTx(c: Context<AppEnv>, id: string | null, body: Record<string, unknown>) {
  const db = c.get('db')
  const ledgerId = c.get('ledgerId')
  const userId = c.get('userId')
  const kind =
    body.kind === 'income' || body.kind === 'expense' || body.kind === 'transfer' ? body.kind : null
  if (!kind) throw badRequest('类型须为 expense、income 或 transfer')
  const amount = assertAmountCents(body.amount_cents)
  const accountId = typeof body.account_id === 'string' ? body.account_id : ''
  const toAccountId = typeof body.to_account_id === 'string' ? body.to_account_id : ''
  const categoryId = typeof body.category_id === 'string' ? body.category_id : ''
  if (!accountId) throw badRequest('请选择账户')
  const occurredAt =
    typeof body.date === 'string'
      ? dateToOccurredAt(body.date)
      : typeof body.occurred_at === 'number'
        ? body.occurred_at
        : Date.now()
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
  const excluded = body.excluded ? 1 : 0

  const account = await db.first<{ id: string; archived: number }>(
    `SELECT id, archived FROM accounts WHERE id = ? AND ledger_id = ?`,
    [accountId, ledgerId],
  )
  if (!account) throw badRequest('账户不存在')

  let toAccount: { id: string; archived: number } | null = null
  if (kind === 'transfer') {
    if (!toAccountId) throw badRequest('请选择转入账户')
    if (toAccountId === accountId) throw badRequest('转出与转入不能相同')
    toAccount = await db.first<{ id: string; archived: number }>(
      `SELECT id, archived FROM accounts WHERE id = ? AND ledger_id = ?`,
      [toAccountId, ledgerId],
    )
    if (!toAccount) throw badRequest('转入账户不存在')
  } else if (!categoryId) {
    throw badRequest('请选择分类')
  }

  let category: { id: string; kind: string; archived: number } | null = null
  if (kind !== 'transfer') {
    category = await db.first<{ id: string; kind: string; archived: number }>(
      `SELECT id, kind, archived FROM categories WHERE id = ? AND ledger_id = ?`,
      [categoryId, ledgerId],
    )
    if (!category) throw badRequest('分类不存在')
    if (category.kind !== kind) throw badRequest('分类类型与收支不一致')
  }

  if (!id && (account.archived || toAccount?.archived || category?.archived)) {
    throw badRequest('已归档的账户或分类不能记账')
  }

  const now = Date.now()
  const catVal = kind === 'transfer' ? null : categoryId
  const toVal = kind === 'transfer' ? toAccountId : null
  const next: TxMoney = { kind, amount_cents: amount, account_id: accountId, to_account_id: toVal }

  if (!id) {
    const txId = newId()
    await db.batch([
      {
        sql: `INSERT INTO transactions
          (id, ledger_id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        params: [txId, ledgerId, accountId, toVal, catVal, kind, amount, occurredAt, note, excluded, userId, now, now],
      },
      ...balanceStmts(next, 1),
    ])
    return shape({
      id: txId,
      account_id: accountId,
      to_account_id: toVal,
      category_id: catVal,
      kind,
      amount_cents: amount,
      occurred_at: occurredAt,
      note,
      has_receipt: 0,
      excluded,
      created_at: now,
      updated_at: now,
    })
  }

  const existing = await db.first<TxRow>(
    `SELECT id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_at, updated_at
     FROM transactions WHERE id = ? AND ledger_id = ?`,
    [id, ledgerId],
  )
  if (!existing) throw notFound('流水不存在')
  await db.batch([
    ...balanceStmts(existing, -1),
    {
      sql: `UPDATE transactions
       SET account_id = ?, to_account_id = ?, category_id = ?, kind = ?, amount_cents = ?, occurred_at = ?, note = ?, excluded = ?, updated_at = ?
       WHERE id = ?`,
      params: [accountId, toVal, catVal, kind, amount, occurredAt, note, excluded, now, id],
    },
    ...balanceStmts(next, 1),
  ])
  return shape({
    id,
    account_id: accountId,
    to_account_id: toVal,
    category_id: catVal,
    kind,
    amount_cents: amount,
    occurred_at: occurredAt,
    note,
    has_receipt: existing.has_receipt,
    excluded,
    created_at: now,
    updated_at: now,
  })
}
