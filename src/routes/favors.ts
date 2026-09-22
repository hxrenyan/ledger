import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { badRequest, notFound } from '../http.ts'
import { assertAmountCents } from '../money.ts'
import { dateToOccurredAt } from '../time.ts'
import { newId } from '../seed.ts'

const OCCASION_MAX = 16

type ContactRow = {
  id: string
  name: string
  relation: string
  note: string
  archived: number
}

type GiftRow = {
  id: string
  contact_id: string
  kind: string
  amount_cents: number
  occasion: string
  occurred_at: number
  note: string
  created_at: number
  updated_at: number
}

export function registerFavorRoutes(app: Hono<AppEnv>) {
  app.get('/api/v1/contacts', async (c) => {
    const db = c.get('db')
    const ledgerId = c.get('ledgerId')
    const rows = await db.all<
      ContactRow & { given_cents: number; received_cents: number }
    >(
      `SELECT c.id, c.name, c.relation, c.note, c.archived,
              COALESCE(SUM(CASE WHEN g.kind = 'give' THEN g.amount_cents ELSE 0 END), 0) AS given_cents,
              COALESCE(SUM(CASE WHEN g.kind = 'receive' THEN g.amount_cents ELSE 0 END), 0) AS received_cents
       FROM contacts c
       LEFT JOIN gifts g ON g.contact_id = c.id
       WHERE c.ledger_id = ?
       GROUP BY c.id
       ORDER BY c.archived ASC, c.name COLLATE NOCASE ASC`,
      [ledgerId],
    )
    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        relation: r.relation,
        note: r.note,
        archived: !!r.archived,
        given_cents: Number(r.given_cents) || 0,
        received_cents: Number(r.received_cents) || 0,
        net_cents: (Number(r.received_cents) || 0) - (Number(r.given_cents) || 0),
      })),
    })
  })

  app.post('/api/v1/contacts', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const saved = await upsertContact(c.get('db'), c.get('ledgerId'), null, body)
    return c.json(saved, 201)
  })

  app.patch('/api/v1/contacts/:id', async (c) => {
    const saved = await upsertContact(
      c.get('db'),
      c.get('ledgerId'),
      c.req.param('id'),
      await c.req.json().catch(() => ({})),
    )
    return c.json(saved)
  })

  app.get('/api/v1/gifts', async (c) => {
    const contactId = c.req.query('contact_id')
    const params: unknown[] = [c.get('ledgerId')]
    let extra = ''
    if (contactId) {
      extra = ' AND g.contact_id = ?'
      params.push(contactId)
    }
    const rows = await c.get('db').all<GiftRow & { contact_name: string }>(
      `SELECT g.id, g.contact_id, g.kind, g.amount_cents, g.occasion, g.occurred_at, g.note, g.created_at, g.updated_at,
              c.name AS contact_name
       FROM gifts g JOIN contacts c ON c.id = g.contact_id
       WHERE g.ledger_id = ? ${extra}
       ORDER BY g.occurred_at DESC, g.created_at DESC`,
      params,
    )
    return c.json({ items: rows.map(shapeGift) })
  })

  app.get('/api/v1/gifts/:id', async (c) => {
    const row = await c.get('db').first<GiftRow & { contact_name: string }>(
      `SELECT g.id, g.contact_id, g.kind, g.amount_cents, g.occasion, g.occurred_at, g.note, g.created_at, g.updated_at,
              c.name AS contact_name
       FROM gifts g JOIN contacts c ON c.id = g.contact_id
       WHERE g.id = ? AND g.ledger_id = ?`,
      [c.req.param('id'), c.get('ledgerId')],
    )
    if (!row) throw notFound('往来记录不存在')
    return c.json(shapeGift(row))
  })

  app.post('/api/v1/gifts', async (c) => {
    const saved = await upsertGift(c, null, await c.req.json().catch(() => ({})))
    return c.json(saved, 201)
  })

  app.patch('/api/v1/gifts/:id', async (c) => {
    const saved = await upsertGift(c, c.req.param('id'), await c.req.json().catch(() => ({})))
    return c.json(saved)
  })

  app.delete('/api/v1/gifts/:id', async (c) => {
    const db = c.get('db')
    const row = await db.first(
      `SELECT id FROM gifts WHERE id = ? AND ledger_id = ?`,
      [c.req.param('id'), c.get('ledgerId')],
    )
    if (!row) throw notFound('往来记录不存在')
    await db.run(`DELETE FROM gifts WHERE id = ?`, [c.req.param('id')])
    return c.json({ ok: true })
  })
}

function shapeGift(row: GiftRow & { contact_name?: string }) {
  return {
    id: row.id,
    contact_id: row.contact_id,
    contact_name: row.contact_name,
    kind: row.kind,
    amount_cents: row.amount_cents,
    occasion: row.occasion,
    occurred_at: row.occurred_at,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function assertName(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 32) {
    throw badRequest(`${label}须为 1–32 字`)
  }
  return raw.trim()
}

async function upsertContact(
  db: AppEnv['Variables']['db'],
  ledgerId: string,
  id: string | null,
  body: Record<string, unknown>,
) {
  const name = body.name != null ? assertName(body.name, '姓名') : ''
  const relation = typeof body.relation === 'string' ? body.relation.trim().slice(0, 16) : ''
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
  if (!id) {
    if (!name) throw badRequest('姓名须为 1–32 字')
    const existing = await db.first<ContactRow>(
      `SELECT id, name, relation, note, archived FROM contacts
       WHERE ledger_id = ? AND name = ? AND archived = 0`,
      [ledgerId, name],
    )
    if (existing) {
      return { ...existing, archived: !!existing.archived }
    }
    const cid = newId()
    const now = Date.now()
    await db.run(
      `INSERT INTO contacts (id, ledger_id, name, relation, note, archived, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [cid, ledgerId, name, relation, note, now],
    )
    return { id: cid, name, relation, note, archived: false }
  }
  const row = await db.first<ContactRow>(
    `SELECT id, name, relation, note, archived FROM contacts WHERE id = ? AND ledger_id = ?`,
    [id, ledgerId],
  )
  if (!row) throw notFound('联系人不存在')
  const nextName = name || row.name
  const nextRel = body.relation != null ? relation : row.relation
  const nextNote = body.note != null ? note : row.note
  const archived = body.archived != null ? (body.archived ? 1 : 0) : row.archived
  await db.run(
    `UPDATE contacts SET name = ?, relation = ?, note = ?, archived = ? WHERE id = ?`,
    [nextName, nextRel, nextNote, archived, id],
  )
  return { id, name: nextName, relation: nextRel, note: nextNote, archived: !!archived }
}

async function upsertGift(c: Context<AppEnv>, id: string | null, body: Record<string, unknown>) {
  const db = c.get('db')
  const ledgerId = c.get('ledgerId')
  const kind = body.kind === 'give' || body.kind === 'receive' ? body.kind : null
  if (!kind) throw badRequest('类型须为 give（送出）或 receive（收入）')
  const amount = assertAmountCents(body.amount_cents)
  const occasion = typeof body.occasion === 'string' ? body.occasion.trim().slice(0, OCCASION_MAX) : ''
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
  const occurredAt =
    typeof body.date === 'string'
      ? dateToOccurredAt(body.date)
      : typeof body.occurred_at === 'number'
        ? body.occurred_at
        : Date.now()

  const contactId = typeof body.contact_id === 'string' ? body.contact_id : ''
  if (!contactId) throw badRequest('请选择对方')
  const contactRow = await db.first(`SELECT id FROM contacts WHERE id = ? AND ledger_id = ?`, [contactId, ledgerId])
  if (!contactRow) throw badRequest('联系人不存在')

  const now = Date.now()
  if (!id) {
    const gid = newId()
    await db.run(
      `INSERT INTO gifts (id, ledger_id, contact_id, kind, amount_cents, occasion, occurred_at, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gid, ledgerId, contactId, kind, amount, occasion, occurredAt, note, c.get('userId'), now, now],
    )
    const contact = await db.first<{ name: string }>(`SELECT name FROM contacts WHERE id = ?`, [contactId])
    return shapeGift({
      id: gid,
      contact_id: contactId,
      contact_name: contact?.name,
      kind,
      amount_cents: amount,
      occasion,
      occurred_at: occurredAt,
      note,
      created_at: now,
      updated_at: now,
    })
  }

  const existing = await db.first(`SELECT id FROM gifts WHERE id = ? AND ledger_id = ?`, [id, ledgerId])
  if (!existing) throw notFound('往来记录不存在')
  await db.run(
    `UPDATE gifts
     SET contact_id = ?, kind = ?, amount_cents = ?, occasion = ?, occurred_at = ?, note = ?, updated_at = ?
     WHERE id = ?`,
    [contactId, kind, amount, occasion, occurredAt, note, now, id],
  )
  const contact = await db.first<{ name: string }>(`SELECT name FROM contacts WHERE id = ?`, [contactId])
  return shapeGift({
    id,
    contact_id: contactId,
    contact_name: contact?.name,
    kind,
    amount_cents: amount,
    occasion,
    occurred_at: occurredAt,
    note,
    created_at: now,
    updated_at: now,
  })
}
