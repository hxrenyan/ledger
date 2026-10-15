import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.ts'
import { balanceStmts, type TxMoney } from '../balance.ts'
import {
  buildReminder,
  dateKindLabel,
  dateLabel,
  normalizeDateKind,
  parseContactDate,
  todayYmd,
  type ContactDate,
  type Ymd,
} from '../calendar/contactDate.ts'
import { CONTACT_DATE_KIND, ensureDictItem } from '../dicts.ts'
import { badRequest, notFound } from '../http.ts'
import { parseOptionalId, routeId } from '../id.ts'
import { assertAmountCents } from '../money.ts'
import { dateTimeToOccurredAt, dateToOccurredAt } from '../time.ts'

const OCCASION_MAX = 16

type ContactRow = {
  id: number
  name: string
  relation: string
  archived: number
  date_item_id: number
  date_name: string | null
  date_calendar: string
  date_month: number | null
  date_day: number | null
  date_year: number | null
  date_leap: number
}

type GiftRow = {
  id: number
  contact_id: number
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
      `SELECT c.id, c.name, c.relation, c.archived,
              c.date_item_id, c.date_calendar, c.date_month, c.date_day, c.date_year, c.date_leap,
              d.name AS date_name,
              COALESCE(SUM(CASE WHEN g.kind = 'give' THEN g.amount_cents ELSE 0 END), 0) AS given_cents,
              COALESCE(SUM(CASE WHEN g.kind = 'receive' THEN g.amount_cents ELSE 0 END), 0) AS received_cents
       FROM contacts c
       LEFT JOIN dict_items d ON d.id = c.date_item_id AND d.kind = ?
         AND (d.ledger_id IS NULL OR d.ledger_id = c.ledger_id)
       LEFT JOIN gifts g ON g.contact_id = c.id
       WHERE c.ledger_id = ?
       GROUP BY c.id
       ORDER BY c.archived ASC, c.name COLLATE NOCASE ASC`,
      [CONTACT_DATE_KIND, ledgerId],
    )
    const today = todayYmd()
    return c.json({
      items: rows.map((r) => {
        const given = Number(r.given_cents) || 0
        const received = Number(r.received_cents) || 0
        return {
          ...shapeContact(r, today),
          given_cents: given,
          received_cents: received,
          net_cents: received - given,
        }
      }),
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
      routeId(c.req.param('id'), '联系人'),
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
      params.push(routeId(contactId, '联系人'))
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
      [routeId(c.req.param('id'), '往来'), c.get('ledgerId')],
    )
    if (!row) throw notFound('往来记录不存在')
    return c.json(shapeGift(row))
  })

  app.post('/api/v1/gifts', async (c) => {
    const saved = await upsertGift(c, null, await c.req.json().catch(() => ({})))
    return c.json(saved, 201)
  })

  app.patch('/api/v1/gifts/:id', async (c) => {
    const saved = await upsertGift(c, routeId(c.req.param('id'), '往来'), await c.req.json().catch(() => ({})))
    return c.json(saved)
  })

  app.delete('/api/v1/gifts/:id', async (c) => {
    const db = c.get('db')
    const row = await db.first(
      `SELECT id FROM gifts WHERE id = ? AND ledger_id = ?`,
      [routeId(c.req.param('id'), '往来'), c.get('ledgerId')],
    )
    if (!row) throw notFound('往来记录不存在')
    await db.run(`DELETE FROM gifts WHERE id = ?`, [routeId(c.req.param('id'), '往来')])
    return c.json({ ok: true })
  })

  /** 明细改记成人情：冲掉账户余额，删掉流水，写成一条往来。 */
  app.post('/api/v1/transactions/:id/to-gift', async (c) => {
    const saved = await transactionToGift(c, routeId(c.req.param('id'), '流水'), await c.req.json().catch(() => ({})))
    return c.json(saved, 201)
  })

  /** 人情改记成明细：删掉往来，按所选账户和分类记一笔流水。 */
  app.post('/api/v1/gifts/:id/to-transaction', async (c) => {
    const saved = await giftToTransaction(c, routeId(c.req.param('id'), '往来'), await c.req.json().catch(() => ({})))
    return c.json(saved, 201)
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

const CONTACT_SQL = `SELECT c.id, c.name, c.relation, c.archived,
            c.date_item_id, c.date_calendar, c.date_month, c.date_day, c.date_year, c.date_leap,
            d.name AS date_name
     FROM contacts c
     LEFT JOIN dict_items d ON d.id = c.date_item_id AND d.kind = ?
       AND (d.ledger_id IS NULL OR d.ledger_id = c.ledger_id)`

function assertName(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 32) {
    throw badRequest(`${label}须为 1–32 字`)
  }
  return raw.trim()
}

function shapeContact(row: ContactRow, today: Ymd) {
  const date = contactDateOf(row)
  return {
    id: row.id,
    name: row.name,
    relation: row.relation,
    archived: !!row.archived,
    date: date
      ? { ...date, item_id: row.date_item_id, label: dateLabel(date), kind_label: dateKindLabel(date.kind) }
      : null,
    reminder: buildReminder(date, today),
  }
}

function contactDateOf(row: ContactRow): ContactDate | null {
  const kind = normalizeDateKind(row.date_name || '')
  if (!kind || !row.date_item_id) return null
  if (row.date_calendar !== 'solar' && row.date_calendar !== 'lunar') return null
  if (row.date_month == null || row.date_day == null) return null
  return {
    kind,
    calendar: row.date_calendar,
    month: Number(row.date_month),
    day: Number(row.date_day),
    year: row.date_year == null ? null : Number(row.date_year),
    leap: !!row.date_leap,
  }
}

/** body 没带 date 就保持原样；null 表示清掉。 */
function readDatePatch(body: Record<string, unknown>, today: Ymd): ContactDate | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'date')) return undefined
  if (body.date == null) return null
  try {
    return parseContactDate(body.date, today)
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : '日期无效')
  }
}

async function dateFields(db: AppEnv['Variables']['db'], ledgerId: number, date: ContactDate | null) {
  if (!date) return { itemId: 0, name: '', calendar: '', month: null as number | null, day: null as number | null, year: null as number | null, leap: 0 }
  const item = await ensureDictItem(db, ledgerId, CONTACT_DATE_KIND, date.kind)
  return {
    itemId: item.id,
    name: item.name,
    calendar: date.calendar,
    month: date.month,
    day: date.day,
    year: date.year,
    leap: date.leap ? 1 : 0,
  }
}

async function upsertContact(
  db: AppEnv['Variables']['db'],
  ledgerId: number,
  id: number | null,
  body: Record<string, unknown>,
) {
  const name = body.name != null ? assertName(body.name, '姓名') : ''
  const relation = typeof body.relation === 'string' ? body.relation.trim().slice(0, 16) : ''
  const today = todayYmd()
  const datePatch = readDatePatch(body, today)
  if (!id) {
    if (!name) throw badRequest('姓名须为 1–32 字')
    const existing = await db.first<ContactRow>(
      `${CONTACT_SQL}
       WHERE c.ledger_id = ? AND c.name = ? AND c.archived = 0`,
      [CONTACT_DATE_KIND, ledgerId, name],
    )
    if (existing) {
      if (datePatch === undefined) return shapeContact(existing, today)
      const cols = await dateFields(db, ledgerId, datePatch)
      const nextRel = body.relation != null ? relation : existing.relation
      await db.run(
        `UPDATE contacts
         SET relation = ?, date_item_id = ?, date_calendar = ?, date_month = ?, date_day = ?, date_year = ?, date_leap = ?
         WHERE id = ?`,
        [nextRel, cols.itemId, cols.calendar, cols.month, cols.day, cols.year, cols.leap, existing.id],
      )
      return shapeContact({ ...existing, relation: nextRel, ...dateRow(cols) }, today)
    }
    const now = Date.now()
    const cols = await dateFields(db, ledgerId, datePatch ?? null)
    const created = await db.first<{ id: number }>(
      `INSERT INTO contacts
        (ledger_id, name, relation, archived, created_at, date_item_id, date_calendar, date_month, date_day, date_year, date_leap)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [ledgerId, name, relation, now, cols.itemId, cols.calendar, cols.month, cols.day, cols.year, cols.leap],
    )
    if (!created) throw new Error('联系人创建失败')
    return shapeContact(
      {
        id: created.id,
        name,
        relation,
        archived: 0,
        ...dateRow(cols),
      },
      today,
    )
  }
  const row = await db.first<ContactRow>(
    `${CONTACT_SQL} WHERE c.id = ? AND c.ledger_id = ?`,
    [CONTACT_DATE_KIND, id, ledgerId],
  )
  if (!row) throw notFound('联系人不存在')
  const nextName = name || row.name
  const nextRel = body.relation != null ? relation : row.relation
  const archived = body.archived != null ? (body.archived ? 1 : 0) : row.archived
  const cols = datePatch === undefined ? fieldsOf(row) : await dateFields(db, ledgerId, datePatch)
  await db.run(
    `UPDATE contacts
     SET name = ?, relation = ?, archived = ?, date_item_id = ?, date_calendar = ?, date_month = ?, date_day = ?, date_year = ?, date_leap = ?
     WHERE id = ?`,
    [nextName, nextRel, archived, cols.itemId, cols.calendar, cols.month, cols.day, cols.year, cols.leap, id],
  )
  return shapeContact(
    {
      id,
      name: nextName,
      relation: nextRel,
      archived,
      ...dateRow(cols),
    },
    today,
  )
}

function fieldsOf(row: ContactRow) {
  return {
    itemId: row.date_item_id,
    name: row.date_name || '',
    calendar: row.date_calendar,
    month: row.date_month,
    day: row.date_day,
    year: row.date_year,
    leap: row.date_leap,
  }
}

function dateRow(cols: ReturnType<typeof fieldsOf>): Pick<
  ContactRow,
  'date_item_id' | 'date_name' | 'date_calendar' | 'date_month' | 'date_day' | 'date_year' | 'date_leap'
> {
  return {
    date_item_id: cols.itemId,
    date_name: cols.name,
    date_calendar: cols.calendar,
    date_month: cols.month,
    date_day: cols.day,
    date_year: cols.year,
    date_leap: cols.leap,
  }
}

async function upsertGift(c: Context<AppEnv>, id: number | null, body: Record<string, unknown>) {
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

  const contactId = routeId(body.contact_id, '联系人')
  const contact = await db.first<{ id: number; name: string }>(
    `SELECT id, name FROM contacts WHERE id = ? AND ledger_id = ?`,
    [contactId, ledgerId],
  )
  if (!contact) throw badRequest('联系人不存在')

  const now = Date.now()
  if (!id) {
    const also = await readAlsoTransaction(db, ledgerId, body, kind === 'receive' ? 'income' : 'expense')
    const giftSql = `INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occasion, occurred_at, note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    const giftParams = [ledgerId, contactId, kind, amount, occasion, occurredAt, note, c.get('userId'), now, now]
    let gid: number | null = null
    let transactionId: number | null = null
    if (!also) {
      const created = await db.first<{ id: number }>(`${giftSql} RETURNING id`, giftParams)
      gid = created?.id ?? null
    } else {
      const txNote = note || contact.name
      const money: TxMoney = { kind: also.kind, amount_cents: amount, account_id: also.accountId, to_account_id: null }
      const written = await db.batch([
        { sql: giftSql, params: giftParams },
        {
          sql: `INSERT INTO transactions
            (ledger_id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_by, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
          params: [ledgerId, also.accountId, also.categoryId, also.kind, amount, occurredAt, txNote, c.get('userId'), now, now],
        },
        ...balanceStmts(money, 1),
      ])
      gid = written[0]?.lastId ?? null
      transactionId = written[1]?.lastId ?? null
    }
    if (gid == null) throw new Error('往来记录创建失败')
    return {
      ...shapeGift({
        id: gid,
        contact_id: contactId,
        contact_name: contact.name,
        kind,
        amount_cents: amount,
        occasion,
        occurred_at: occurredAt,
        note,
        created_at: now,
        updated_at: now,
      }),
      ...(transactionId != null ? { transaction_id: transactionId } : {}),
    }
  }

  const existing = await db.first(`SELECT id FROM gifts WHERE id = ? AND ledger_id = ?`, [id, ledgerId])
  if (!existing) throw notFound('往来记录不存在')
  await db.run(
    `UPDATE gifts
     SET contact_id = ?, kind = ?, amount_cents = ?, occasion = ?, occurred_at = ?, note = ?, updated_at = ?
     WHERE id = ?`,
    [contactId, kind, amount, occasion, occurredAt, note, now, id],
  )
  return shapeGift({
    id,
    contact_id: contactId,
    contact_name: contact.name,
    kind,
    amount_cents: amount,
    occasion,
    occurred_at: occurredAt,
    note,
    created_at: now,
    updated_at: now,
  })
}

/** 新建人情时可选：再记一笔同金额的支出或收入。改人情不走这里。 */
async function readAlsoTransaction(
  db: AppEnv['Variables']['db'],
  ledgerId: number,
  body: Record<string, unknown>,
  kind: 'expense' | 'income',
) {
  const hasAccount = body.account_id != null && body.account_id !== '' && body.account_id !== 0
  const hasCategory = body.category_id != null && body.category_id !== '' && body.category_id !== 0
  if (!hasAccount && !hasCategory) return null
  const accountId = parseOptionalId(body.account_id, '账户')
  const categoryId = parseOptionalId(body.category_id, '分类')
  if (!accountId) throw badRequest('请选择账户')
  if (!categoryId) throw badRequest('请选择分类')
  const account = await db.first<{ id: number; archived: number }>(
    `SELECT id, archived FROM accounts WHERE id = ? AND ledger_id = ?`,
    [accountId, ledgerId],
  )
  if (!account || account.archived) throw badRequest('账户不存在')
  const category = await db.first<{ id: number; kind: string; archived: number }>(
    `SELECT id, kind, archived FROM categories WHERE id = ? AND ledger_id = ?`,
    [categoryId, ledgerId],
  )
  if (!category || category.archived) throw badRequest('分类不存在')
  if (category.kind !== kind) throw badRequest('分类类型与收支不一致')
  return { accountId, categoryId, kind }
}

async function transactionToGift(c: Context<AppEnv>, txId: number, body: Record<string, unknown>) {
  const db = c.get('db')
  const ledgerId = c.get('ledgerId')
  const tx = await db.first<TxMoney & { note: string; has_receipt: number }>(
    `SELECT kind, amount_cents, account_id, to_account_id, note, has_receipt
     FROM transactions WHERE id = ? AND ledger_id = ?`,
    [txId, ledgerId],
  )
  if (!tx) throw notFound('流水不存在')
  if (tx.kind === 'transfer') throw badRequest('转账不能转成人情')

  const kind = body.kind === 'give' || body.kind === 'receive' ? body.kind : tx.kind === 'income' ? 'receive' : 'give'
  const amount = body.amount_cents != null ? assertAmountCents(body.amount_cents) : tx.amount_cents
  const occasion = typeof body.occasion === 'string' ? body.occasion.trim().slice(0, OCCASION_MAX) : ''
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : tx.note
  const occurredAt = typeof body.date === 'string' ? dateToOccurredAt(body.date) : Date.now()
  const contactId = routeId(body.contact_id, '联系人')
  const contact = await db.first<{ id: number; name: string }>(
    `SELECT id, name FROM contacts WHERE id = ? AND ledger_id = ?`,
    [contactId, ledgerId],
  )
  if (!contact) throw badRequest('联系人不存在')

  const now = Date.now()
  const written = await db.batch([
    ...balanceStmts(tx, -1),
    { sql: `DELETE FROM attachments WHERE transaction_id = ?`, params: [txId] },
    { sql: `DELETE FROM transactions WHERE id = ? AND ledger_id = ?`, params: [txId, ledgerId] },
    {
      sql: `INSERT INTO gifts (ledger_id, contact_id, kind, amount_cents, occasion, occurred_at, note, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [ledgerId, contactId, kind, amount, occasion, occurredAt, note, c.get('userId'), now, now],
    },
  ])
  const giftId = written[written.length - 1]?.lastId
  if (giftId == null) throw new Error('转成人情失败')
  return shapeGift({
    id: giftId,
    contact_id: contactId,
    contact_name: contact.name,
    kind,
    amount_cents: amount,
    occasion,
    occurred_at: occurredAt,
    note,
    created_at: now,
    updated_at: now,
  })
}

async function giftToTransaction(c: Context<AppEnv>, giftId: number, body: Record<string, unknown>) {
  const db = c.get('db')
  const ledgerId = c.get('ledgerId')
  const gift = await db.first(`SELECT id FROM gifts WHERE id = ? AND ledger_id = ?`, [giftId, ledgerId])
  if (!gift) throw notFound('往来记录不存在')

  const kind = body.kind === 'income' || body.kind === 'expense' ? body.kind : null
  if (!kind) throw badRequest('类型须为 expense 或 income')
  const amount = assertAmountCents(body.amount_cents)
  const accountId = parseOptionalId(body.account_id, '账户')
  const categoryId = parseOptionalId(body.category_id, '分类')
  if (!accountId) throw badRequest('请选择账户')
  if (!categoryId) throw badRequest('请选择分类')
  const account = await db.first<{ id: number; archived: number }>(
    `SELECT id, archived FROM accounts WHERE id = ? AND ledger_id = ?`,
    [accountId, ledgerId],
  )
  if (!account || account.archived) throw badRequest('账户不存在')
  const category = await db.first<{ id: number; kind: string; archived: number }>(
    `SELECT id, kind, archived FROM categories WHERE id = ? AND ledger_id = ?`,
    [categoryId, ledgerId],
  )
  if (!category || category.archived) throw badRequest('分类不存在')
  if (category.kind !== kind) throw badRequest('分类类型与收支不一致')

  const occurredAt =
    typeof body.date === 'string'
      ? typeof body.time === 'string' && body.time.trim()
        ? dateTimeToOccurredAt(body.date, body.time.trim())
        : dateToOccurredAt(body.date)
      : Date.now()
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
  const excluded = body.excluded ? 1 : 0
  const now = Date.now()
  const userId = c.get('userId')
  const money: TxMoney = { kind, amount_cents: amount, account_id: accountId, to_account_id: null }
  const written = await db.batch([
    {
      sql: `INSERT INTO transactions
        (ledger_id, account_id, to_account_id, category_id, kind, amount_cents, occurred_at, note, has_receipt, excluded, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      params: [ledgerId, accountId, categoryId, kind, amount, occurredAt, note, excluded, userId, now, now],
    },
    ...balanceStmts(money, 1),
    { sql: `DELETE FROM gifts WHERE id = ? AND ledger_id = ?`, params: [giftId, ledgerId] },
  ])
  const txId = written[0]?.lastId
  if (txId == null) throw new Error('转成明细失败')
  return {
    id: txId,
    account_id: accountId,
    category_id: categoryId,
    kind,
    amount_cents: amount,
    occurred_at: occurredAt,
    note,
    excluded: !!excluded,
  }
}
