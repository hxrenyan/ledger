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
import { contactStorageScope, type ContactStorageScope } from '../contacts.ts'
import { badRequest, notFound } from '../http.ts'
import { parseOptionalId, routeId } from '../id.ts'
import { assertAmountCents } from '../money.ts'
import { dateTimeToOccurredAt, dateToOccurredAt } from '../time.ts'

const OCCASION_MAX = 16

/** 一个人最多记这么多条日子。 */
const DATE_LIMIT = 8

type ContactRow = {
  id: number
  name: string
  relation: string
  archived: number
}

type DateRow = {
  id: number
  contact_id: number
  item_id: number
  date_name: string | null
  calendar: string
  month: number
  day: number
  year: number | null
  leap: number
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
    const scope = await contactStorageScope(db, ledgerId)
    const rows = await db.all<ContactRow & { given_cents: number; received_cents: number }>(
      `SELECT c.id, c.name, c.relation, c.archived,
              COALESCE(SUM(CASE WHEN g.kind = 'give' THEN g.amount_cents ELSE 0 END), 0) AS given_cents,
              COALESCE(SUM(CASE WHEN g.kind = 'receive' THEN g.amount_cents ELSE 0 END), 0) AS received_cents
       FROM contacts c
       LEFT JOIN gifts g ON g.contact_id = c.id AND g.ledger_id = ?
       WHERE c.${scope.column} = ?
       GROUP BY c.id
       ORDER BY c.archived ASC, c.name COLLATE NOCASE ASC`,
      [ledgerId, scope.id],
    )
    const today = todayYmd()
    const byContact = groupDates(await loadContactDates(db, scope))
    return c.json({
      items: rows.map((r) => {
        const given = Number(r.given_cents) || 0
        const received = Number(r.received_cents) || 0
        return {
          ...shapeContact(r, byContact.get(r.id) ?? [], today),
          given_cents: given,
          received_cents: received,
          net_cents: received - given,
        }
      }),
    })
  })

  app.post('/api/v1/contacts', async (c) => {
    const db = c.get('db')
    const body = await c.req.json().catch(() => ({}))
    const scope = await contactStorageScope(db, c.get('ledgerId'))
    const saved = await upsertContact(db, scope, null, body)
    return c.json(saved, 201)
  })

  app.patch('/api/v1/contacts/:id', async (c) => {
    const db = c.get('db')
    const scope = await contactStorageScope(db, c.get('ledgerId'))
    const saved = await upsertContact(
      db,
      scope,
      routeId(c.req.param('id'), '联系人'),
      await c.req.json().catch(() => ({})),
    )
    return c.json(saved)
  })

  app.get('/api/v1/gifts', async (c) => {
    const scope = await contactStorageScope(c.get('db'), c.get('ledgerId'))
    const contactId = c.req.query('contact_id')
    const params: unknown[] = [c.get('ledgerId'), scope.id]
    let extra = ''
    if (contactId) {
      extra = ' AND g.contact_id = ?'
      params.push(routeId(contactId, '联系人'))
    }
    const rows = await c.get('db').all<GiftRow & { contact_name: string }>(
      `SELECT g.id, g.contact_id, g.kind, g.amount_cents, g.occasion, g.occurred_at, g.note, g.created_at, g.updated_at,
              c.name AS contact_name
       FROM gifts g JOIN contacts c ON c.id = g.contact_id
       WHERE g.ledger_id = ? AND c.${scope.column} = ? ${extra}
       ORDER BY g.occurred_at DESC, g.created_at DESC`,
      params,
    )
    return c.json({ items: rows.map(shapeGift) })
  })

  app.get('/api/v1/gifts/:id', async (c) => {
    const scope = await contactStorageScope(c.get('db'), c.get('ledgerId'))
    const row = await c.get('db').first<GiftRow & { contact_name: string }>(
      `SELECT g.id, g.contact_id, g.kind, g.amount_cents, g.occasion, g.occurred_at, g.note, g.created_at, g.updated_at,
              c.name AS contact_name
       FROM gifts g JOIN contacts c ON c.id = g.contact_id
       WHERE g.id = ? AND g.ledger_id = ? AND c.${scope.column} = ?`,
      [routeId(c.req.param('id'), '往来'), c.get('ledgerId'), scope.id],
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

const CONTACT_SQL = `SELECT id, name, relation, archived FROM contacts`

type ShapedDate = ContactDate & {
  id: number
  item_id: number
  label: string
  kind_label: string
  reminder: ReturnType<typeof buildReminder>
}

function assertName(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 32) {
    throw badRequest(`${label}须为 1–32 字`)
  }
  return raw.trim()
}

function shapeContact(row: ContactRow, dateRows: DateRow[], today: Ymd) {
  const dates = dateRows.map((item) => shapeDate(item, today)).filter((item): item is ShapedDate => item != null)
  const primary = pickPrimary(dates)
  return {
    id: row.id,
    name: row.name,
    relation: row.relation,
    archived: !!row.archived,
    dates: dates.map(publicDate),
    date: primary ? publicDate(primary) : null,
    reminder: primary?.reminder ?? null,
  }
}

function publicDate(date: ShapedDate) {
  return {
    id: date.id,
    kind: date.kind,
    calendar: date.calendar,
    month: date.month,
    day: date.day,
    year: date.year,
    leap: date.leap,
    item_id: date.item_id,
    label: date.label,
    kind_label: date.kind_label,
    reminder: date.reminder,
  }
}

function shapeDate(row: DateRow, today: Ymd): ShapedDate | null {
  const kind = normalizeDateKind(row.date_name || '')
  if (!kind || !row.item_id) return null
  if (row.calendar !== 'solar' && row.calendar !== 'lunar') return null
  if (row.month == null || row.day == null) return null
  const date: ContactDate = {
    kind,
    calendar: row.calendar,
    month: Number(row.month),
    day: Number(row.day),
    year: row.year == null ? null : Number(row.year),
    leap: !!row.leap,
  }
  return {
    ...date,
    id: row.id,
    item_id: row.item_id,
    label: dateLabel(date),
    kind_label: dateKindLabel(date.kind),
    reminder: buildReminder(date, today),
  }
}

/** 即将到来的优先，其次是刚过去的。都没有就用第一条。 */
function pickPrimary(dates: ShapedDate[]): ShapedDate | null {
  const upcoming = dates
    .filter((item) => item.reminder?.state === 'upcoming')
    .sort((a, b) => (a.reminder?.days ?? 0) - (b.reminder?.days ?? 0))
  if (upcoming[0]) return upcoming[0]
  const past = dates
    .filter((item) => item.reminder?.state === 'past')
    .sort((a, b) => (a.reminder?.days ?? 0) - (b.reminder?.days ?? 0))
  return past[0] ?? dates[0] ?? null
}

/**
 * 没带 dates / date 就保持原样。
 * dates 是整表替换；只带 date 时也替换成这一条，date 为 null 则清空。
 */
function readDatesPatch(body: Record<string, unknown>, today: Ymd): ContactDate[] | undefined {
  if (Object.prototype.hasOwnProperty.call(body, 'dates')) {
    if (!Array.isArray(body.dates)) throw badRequest('日子须为列表')
    if (body.dates.length > DATE_LIMIT) throw badRequest(`日子最多 ${DATE_LIMIT} 个`)
    const parsed = body.dates.map((item) => parseOneDate(item, today))
    const seen = new Set<string>()
    for (const date of parsed) {
      const key = `${date.kind}|${date.calendar}|${date.month}|${date.day}|${date.year ?? ''}|${date.leap ? 1 : 0}`
      if (seen.has(key)) throw badRequest('同一日子不能重复')
      seen.add(key)
    }
    return parsed
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'date')) return undefined
  if (body.date == null) return []
  return [parseOneDate(body.date, today)]
}

function parseOneDate(raw: unknown, today: Ymd): ContactDate {
  try {
    return parseContactDate(raw, today)
  } catch (e) {
    throw badRequest(e instanceof Error ? e.message : '日期无效')
  }
}

async function loadContactDates(db: AppEnv['Variables']['db'], scope: ContactStorageScope, contactId?: number) {
  const dateNameJoin = scope.ownerScoped
    ? 'di.ledger_id IS NULL AND (di.user_id IS NULL OR di.user_id = d.user_id)'
    : '(di.ledger_id IS NULL OR di.ledger_id = d.ledger_id)'
  if (contactId != null) {
    return db.all<DateRow>(
      `SELECT d.id, d.contact_id, d.item_id, d.calendar, d.month, d.day, d.year, d.leap, di.name AS date_name
       FROM contact_dates d
       LEFT JOIN dict_items di ON di.id = d.item_id AND di.kind = ?
         AND ${dateNameJoin}
       WHERE d.${scope.column} = ? AND d.contact_id = ?
       ORDER BY d.sort_order ASC, d.id ASC`,
      [CONTACT_DATE_KIND, scope.id, contactId],
    )
  }
  return db.all<DateRow>(
    `SELECT d.id, d.contact_id, d.item_id, d.calendar, d.month, d.day, d.year, d.leap, di.name AS date_name
     FROM contact_dates d
     LEFT JOIN dict_items di ON di.id = d.item_id AND di.kind = ?
       AND ${dateNameJoin}
     WHERE d.${scope.column} = ?
     ORDER BY d.contact_id ASC, d.sort_order ASC, d.id ASC`,
    [CONTACT_DATE_KIND, scope.id],
  )
}

function groupDates(rows: DateRow[]) {
  const map = new Map<number, DateRow[]>()
  for (const row of rows) {
    const list = map.get(row.contact_id) ?? []
    list.push(row)
    map.set(row.contact_id, list)
  }
  return map
}

async function dateCols(db: AppEnv['Variables']['db'], scope: ContactStorageScope, dates: ContactDate[]) {
  const cols = []
  const dictScope = scope.ownerScoped
    ? { userId: scope.ownerId }
    : { ledgerId: scope.ledgerId }
  for (const date of dates) {
    const item = await ensureDictItem(db, dictScope, CONTACT_DATE_KIND, date.kind)
    cols.push({ ...date, itemId: item.id })
  }
  return cols
}

function replaceDateStmts(
  scope: ContactStorageScope,
  contactId: number,
  cols: Awaited<ReturnType<typeof dateCols>>,
  now: number,
) {
  const stmts: { sql: string; params: unknown[] }[] = [
    {
      sql: `DELETE FROM contact_dates WHERE ${scope.column} = ? AND contact_id = ?`,
      params: [scope.id, contactId],
    },
  ]
  cols.forEach((col, index) => {
    stmts.push({
      sql: `INSERT INTO contact_dates
              (${scope.column}, contact_id, item_id, calendar, month, day, year, leap, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        scope.id,
        contactId,
        col.itemId,
        col.calendar,
        col.month,
        col.day,
        col.year,
        col.leap ? 1 : 0,
        index,
        now,
      ],
    })
  })
  return stmts
}

async function upsertContact(
  db: AppEnv['Variables']['db'],
  scope: ContactStorageScope,
  id: number | null,
  body: Record<string, unknown>,
) {
  const name = body.name != null ? assertName(body.name, '姓名') : ''
  const relation = typeof body.relation === 'string' ? body.relation.trim().slice(0, 16) : ''
  const today = todayYmd()
  const datesPatch = readDatesPatch(body, today)
  if (!id) {
    if (!name) throw badRequest('姓名须为 1–32 字')
    const existing = await db.first<ContactRow>(
      `${CONTACT_SQL} WHERE ${scope.column} = ? AND name = ? AND archived = 0`,
      [scope.id, name],
    )
    if (existing) {
      if (datesPatch === undefined) {
        const dates = await loadContactDates(db, scope, existing.id)
        return shapeContact(existing, dates, today)
      }
      const cols = await dateCols(db, scope, datesPatch)
      const nextRel = body.relation != null ? relation : existing.relation
      const now = Date.now()
      await db.batch([
        {
          sql: `UPDATE contacts SET relation = ? WHERE id = ? AND ${scope.column} = ?`,
          params: [nextRel, existing.id, scope.id],
        },
        ...replaceDateStmts(scope, existing.id, cols, now),
      ])
      return shapeContact(
        { ...existing, relation: nextRel },
        await loadContactDates(db, scope, existing.id),
        today,
      )
    }
    const now = Date.now()
    const cols = await dateCols(db, scope, datesPatch ?? [])
    const inserted = await db.batch([
      {
        sql: `INSERT INTO contacts (${scope.column}, name, relation, archived, created_at) VALUES (?, ?, ?, 0, ?)`,
        params: [scope.id, name, relation, now],
      },
      ...cols.map((col, index) => ({
        sql: `INSERT INTO contact_dates
                (${scope.column}, contact_id, item_id, calendar, month, day, year, leap, sort_order, created_at)
              SELECT ?, c.id, ?, ?, ?, ?, ?, ?, ?, ?
              FROM contacts c
              WHERE c.${scope.column} = ? AND c.name = ? AND c.created_at = ?
              ORDER BY c.id DESC
              LIMIT 1`,
        params: [
          scope.id,
          col.itemId,
          col.calendar,
          col.month,
          col.day,
          col.year,
          col.leap ? 1 : 0,
          index,
          now,
          scope.id,
          name,
          now,
        ],
      })),
    ])
    const createdId = inserted[0]?.lastId
    if (createdId == null) throw new Error('联系人创建失败')
    return shapeContact(
      { id: createdId, name, relation, archived: 0 },
      await loadContactDates(db, scope, createdId),
      today,
    )
  }
  const row = await db.first<ContactRow>(`${CONTACT_SQL} WHERE id = ? AND ${scope.column} = ?`, [id, scope.id])
  if (!row) throw notFound('联系人不存在')
  const nextName = name || row.name
  const nextRel = body.relation != null ? relation : row.relation
  const archived = body.archived != null ? (body.archived ? 1 : 0) : row.archived
  const now = Date.now()
  const stmts: { sql: string; params: unknown[] }[] = [
    {
      sql: `UPDATE contacts SET name = ?, relation = ?, archived = ? WHERE id = ? AND ${scope.column} = ?`,
      params: [nextName, nextRel, archived, id, scope.id],
    },
  ]
  if (datesPatch !== undefined) {
    const cols = await dateCols(db, scope, datesPatch)
    stmts.push(...replaceDateStmts(scope, id, cols, now))
  }
  await db.batch(stmts)
  return shapeContact(
    { id, name: nextName, relation: nextRel, archived },
    await loadContactDates(db, scope, id),
    today,
  )
}

async function upsertGift(c: Context<AppEnv>, id: number | null, body: Record<string, unknown>) {
  const db = c.get('db')
  const ledgerId = c.get('ledgerId')
  const scope = await contactStorageScope(db, ledgerId)
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
    `SELECT id, name FROM contacts WHERE id = ? AND ${scope.column} = ?`,
    [contactId, scope.id],
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
  const scope = await contactStorageScope(db, ledgerId)
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
    `SELECT id, name FROM contacts WHERE id = ? AND ${scope.column} = ?`,
    [contactId, scope.id],
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
