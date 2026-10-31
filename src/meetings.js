// 会议、纪要、提炼结果的全部读写。权限只在这一层：每条 SQL 都带当前用户 id，路由和 MCP 没有绕过它的路
//   看得到：自己创建的、参与人里有自己的。其余一律 404（不告诉对方这个 id 存在）
//   创建人：能改、能删、能写纪要
//   参与人：只读，写操作 403
import { DEFAULT_MINUTES, isValidDate, localToUtc } from './dates.js'

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export const TITLE_MAX = 200
export const LOCATION_MAX = 200
export const AGENDA_MAX = 5000
export const NOTE_MAX = 50000
export const ITEM_MAX = 500
export const OWNER_MAX = 50
export const ATTENDEE_MAX = 200
export const BLOCK_MAX = 100
export const KINDS = ['decision', 'todo', 'risk', 'agenda']
export const RECENT_EACH = 5
export const LIST_LIMIT = 200
const SEARCH_MAX = 100
const SEARCH_TERMS = 5

const VISIBLE = '(m.owner_id = ? OR EXISTS (SELECT 1 FROM meeting_attendee a WHERE a.meeting_id = m.id AND a.user_id = ?))'
const END_AT = `COALESCE(m.ends_at, m.starts_at + INTERVAL ${DEFAULT_MINUTES} MINUTE)`
const ROW = `SELECT m.id, m.owner_id, m.title, m.starts_at, m.ends_at, m.location,
  (SELECT COUNT(*) FROM meeting_attendee a WHERE a.meeting_id = m.id) + 1 AS people,
  (EXISTS (SELECT 1 FROM meeting_note n WHERE n.meeting_id = m.id AND n.content <> '')
    OR EXISTS (SELECT 1 FROM meeting_item i WHERE i.meeting_id = m.id)) AS has_note
  FROM meeting m`

const text = (v, max, label, required = false) => {
  const s = String(v ?? '').trim()
  if (required && !s) throw new HttpError(400, `${label}不能为空`)
  if ([...s].length > max) throw new HttpError(400, `${label}不能超过 ${max} 字`)
  return s || null
}
const parseTitle = (v) => text(v, TITLE_MAX, '标题', true)
const parseLocation = (v) => text(v, LOCATION_MAX, '地点')
const parseAgenda = (v) => text(v, AGENDA_MAX, '议程')
const parseStart = (v) => {
  if (v === null || v === undefined || v === '') throw new HttpError(400, '开始时间不能为空')
  const d = localToUtc(v)
  if (!d) throw new HttpError(400, '开始时间格式不对')
  return d
}
const parseEnd = (v, start) => {
  if (v === null || v === undefined || v === '') return null
  const d = localToUtc(v)
  if (!d) throw new HttpError(400, '结束时间格式不对')
  if (d <= start) throw new HttpError(400, '结束时间要晚于开始时间')
  return d
}
const parseId = (v, what = '会议') => {
  if (!/^[1-9]\d{0,18}$/.test(String(v))) throw new HttpError(404, `${what}不存在`)
  return String(v)
}

/** 参与人 id 去重；创建人本来就算在内，不进参与人表 */
export function parseAttendees(v, ownerId) {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) throw new HttpError(400, '参与人不对')
  const ids = v.map(Number)
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, '参与人不对')
  const out = [...new Set(ids)].filter((n) => n !== ownerId)
  if (out.length > ATTENDEE_MAX) throw new HttpError(400, `参与人不能超过 ${ATTENDEE_MAX} 人`)
  return out
}

const parseNote = (v) => {
  if (typeof v !== 'string') throw new HttpError(400, '纪要内容不对')
  if ([...v].length > NOTE_MAX) throw new HttpError(400, `纪要不能超过 ${NOTE_MAX} 字`)
  return v
}

/** 搜索词按空白和中英文标点拆开，每段都要命中：搜「预算，评审」和「预算 评审」结果一样。全是标点时按原文搜 */
export function searchTerms(q) {
  const s = [...String(q ?? '').trim()].slice(0, SEARCH_MAX).join('')
  const terms = s.split(/[\s\p{P}\p{S}]+/u).filter(Boolean).slice(0, SEARCH_TERMS)
  return terms.length ? terms : (s ? [s] : [])
}
const likeOf = (term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`

/** 待办复制成一行：整理客户名单 @郑国栋 11-02。没负责人、没日期就省掉那一段 */
export function todoLine({ text: title, owner_name: owner, due_date: due }) {
  const name = owner ? `@${owner.replace(/\s+/g, '')}` : ''
  return [title.replace(/\s+/g, ' ').trim(), name, due ? due.slice(5) : ''].filter(Boolean).join(' ')
}

export function createMeetings({ pool }) {
  async function tx(fn) {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const out = await fn(conn)
      await conn.commit()
      return out
    } catch (e) {
      await conn.rollback().catch(() => {})
      throw e
    } finally {
      conn.release()
    }
  }

  /** 写操作的入口：锁住会议行，后面的纪要和条目都排在这把锁后面。看不到 404，只读 403 */
  async function lockOwned(conn, userId, id, message) {
    const [rows] = await conn.execute(`SELECT m.id, m.owner_id FROM meeting m WHERE m.id = ? AND ${VISIBLE} FOR UPDATE`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '会议不存在')
    if (rows[0].owner_id !== userId) throw new HttpError(403, message)
  }

  async function listRecent(userId, now = new Date()) {
    const [upcoming] = await pool.query(`${ROW} WHERE ${VISIBLE} AND ${END_AT} > ? ORDER BY m.starts_at, m.id LIMIT ?`, [userId, userId, now, RECENT_EACH])
    const [ended] = await pool.query(`${ROW} WHERE ${VISIBLE} AND ${END_AT} <= ? ORDER BY ${END_AT} DESC, m.id DESC LIMIT ?`, [userId, userId, now, RECENT_EACH])
    return { upcoming, ended }
  }

  async function listAll(userId, limit = LIST_LIMIT) {
    const [rows] = await pool.query(`${ROW} WHERE ${VISIBLE} ORDER BY m.starts_at DESC, m.id DESC LIMIT ?`, [userId, userId, limit])
    return rows
  }

  async function search(userId, q, limit = LIST_LIMIT) {
    const terms = searchTerms(q)
    if (!terms.length) return []
    const match = terms.map(() => '(m.title LIKE ? OR n.content LIKE ?)').join(' AND ')
    const args = terms.flatMap((t) => [likeOf(t), likeOf(t)])
    const [rows] = await pool.query(
      `${ROW} LEFT JOIN meeting_note n ON n.meeting_id = m.id WHERE ${VISIBLE} AND ${match} ORDER BY m.starts_at DESC, m.id DESC LIMIT ?`,
      [userId, userId, ...args, limit]
    )
    return rows
  }

  async function listBetween(userId, from, to, limit) {
    const [rows] = await pool.query(`${ROW} WHERE ${VISIBLE} AND m.starts_at BETWEEN ? AND ? ORDER BY m.starts_at DESC, m.id DESC LIMIT ?`, [userId, userId, from, to, limit])
    return rows
  }

  async function get(userId, rawId) {
    const id = parseId(rawId)
    const [rows] = await pool.execute(`SELECT m.id, m.owner_id, m.title, m.starts_at, m.ends_at, m.location, m.agenda, m.updated_at FROM meeting m WHERE m.id = ? AND ${VISIBLE}`, [id, userId, userId])
    if (!rows.length) throw new HttpError(404, '会议不存在')
    const [attendees] = await pool.execute('SELECT user_id FROM meeting_attendee WHERE meeting_id = ? ORDER BY user_id', [id])
    const [notes] = await pool.execute('SELECT content, updated_at FROM meeting_note WHERE meeting_id = ?', [id])
    return { ...rows[0], attendee_ids: attendees.map((a) => a.user_id), note: notes[0]?.content ?? '', note_saved_at: notes[0]?.updated_at ?? null }
  }

  async function items(userId, rawId) {
    const m = await get(userId, rawId)
    const [rows] = await pool.execute('SELECT id, kind, text, owner_name, due_date, source FROM meeting_item WHERE meeting_id = ? ORDER BY id', [m.id])
    return rows
  }

  async function setAttendees(conn, id, ids) {
    await conn.execute('DELETE FROM meeting_attendee WHERE meeting_id = ?', [id])
    if (ids.length) await conn.query('INSERT INTO meeting_attendee (meeting_id, user_id) VALUES ?', [ids.map((u) => [id, u])])
  }

  async function create(userId, input) {
    const starts = parseStart(input.starts_at)
    const f = { title: parseTitle(input.title), starts, ends: parseEnd(input.ends_at, starts), location: parseLocation(input.location), agenda: parseAgenda(input.agenda) }
    const ids = parseAttendees(input.attendee_ids, userId)
    const newId = await tx(async (conn) => {
      const [r] = await conn.execute(
        'INSERT INTO meeting (owner_id, title, starts_at, ends_at, location, agenda) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, f.title, f.starts, f.ends, f.location, f.agenda]
      )
      await setAttendees(conn, r.insertId, ids)
      return r.insertId
    })
    return get(userId, newId)
  }

  /** 部分更新：没传的字段保持原样，尤其是参与人 */
  async function update(userId, rawId, input) {
    const id = parseId(rawId)
    await tx(async (conn) => {
      await lockOwned(conn, userId, id, '只有创建者能修改会议')
      const [[cur]] = await conn.execute('SELECT title, starts_at, ends_at, location, agenda FROM meeting WHERE id = ?', [id])
      const starts = 'starts_at' in input ? parseStart(input.starts_at) : cur.starts_at
      const ends = 'ends_at' in input ? parseEnd(input.ends_at, starts) : cur.ends_at
      if (ends && ends <= starts) throw new HttpError(400, '结束时间要晚于开始时间')
      await conn.execute('UPDATE meeting SET title = ?, starts_at = ?, ends_at = ?, location = ?, agenda = ? WHERE id = ?', [
        'title' in input ? parseTitle(input.title) : cur.title,
        starts,
        ends,
        'location' in input ? parseLocation(input.location) : cur.location,
        'agenda' in input ? parseAgenda(input.agenda) : cur.agenda,
        id
      ])
      if ('attendee_ids' in input) await setAttendees(conn, id, parseAttendees(input.attendee_ids, userId))
    })
    return get(userId, id)
  }

  async function remove(userId, rawId) {
    const id = parseId(rawId)
    await tx(async (conn) => {
      await lockOwned(conn, userId, id, '只有创建者能删除会议')
      for (const table of ['meeting_item', 'meeting_note', 'meeting_attendee']) {
        await conn.execute(`DELETE FROM ${table} WHERE meeting_id = ?`, [id])
      }
      await conn.execute('DELETE FROM meeting WHERE id = ?', [id])
    })
  }

  async function saveNote(userId, rawId, rawContent) {
    const id = parseId(rawId)
    const content = parseNote(rawContent)
    return tx(async (conn) => {
      await lockOwned(conn, userId, id, '只有创建者能改纪要')
      await conn.execute('INSERT INTO meeting_note (meeting_id, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)', [id, content])
      const [rows] = await conn.execute('SELECT updated_at FROM meeting_note WHERE meeting_id = ?', [id])
      return { content, saved_at: rows[0].updated_at }
    })
  }

  /** 提炼成功才调：整批替换四块。summary 已经过 extract.js 收敛 */
  async function replaceItems(userId, rawId, summary) {
    const id = parseId(rawId)
    const rows = [
      ...summary.decisions.map((t) => [id, 'decision', t, null, null, 'ai']),
      ...summary.todos.map((t) => [id, 'todo', t.title, t.owner, t.due, 'ai']),
      ...summary.risks.map((t) => [id, 'risk', t, null, null, 'ai']),
      ...summary.nextAgenda.map((t) => [id, 'agenda', t, null, null, 'ai'])
    ]
    await tx(async (conn) => {
      await lockOwned(conn, userId, id, '只有创建者能改纪要')
      await conn.execute('DELETE FROM meeting_item WHERE meeting_id = ?', [id])
      if (rows.length) await conn.query('INSERT INTO meeting_item (meeting_id, kind, text, owner_name, due_date, source) VALUES ?', [rows])
    })
    return rows.length
  }

  async function addItem(userId, rawId, input) {
    const id = parseId(rawId)
    if (!KINDS.includes(input.kind)) throw new HttpError(400, '没有这一块')
    const body = text(input.text, ITEM_MAX, '内容', true)
    const isTodo = input.kind === 'todo'
    const owner = isTodo ? text(input.owner, OWNER_MAX, '负责人') : null
    const due = isTodo && input.due ? input.due : null
    if (due && !isValidDate(due)) throw new HttpError(400, '截止日期格式不对')
    return tx(async (conn) => {
      await lockOwned(conn, userId, id, '只有创建者能改纪要')
      const [[{ n }]] = await conn.execute('SELECT COUNT(*) AS n FROM meeting_item WHERE meeting_id = ? AND kind = ?', [id, input.kind])
      if (n >= BLOCK_MAX) throw new HttpError(400, `这一块最多 ${BLOCK_MAX} 条`)
      const [r] = await conn.execute(
        "INSERT INTO meeting_item (meeting_id, kind, text, owner_name, due_date, source) VALUES (?, ?, ?, ?, ?, 'manual')",
        [id, input.kind, body, owner, due]
      )
      return { id: r.insertId, kind: input.kind, text: body, owner_name: owner, due_date: due, source: 'manual' }
    })
  }

  async function removeItem(userId, rawId, rawItemId) {
    const id = parseId(rawId)
    const itemId = parseId(rawItemId, '这一条')
    return tx(async (conn) => {
      await lockOwned(conn, userId, id, '只有创建者能改纪要')
      const [rows] = await conn.execute('SELECT kind FROM meeting_item WHERE id = ? AND meeting_id = ?', [itemId, id])
      if (!rows.length) throw new HttpError(404, '这一条不存在')
      await conn.execute('DELETE FROM meeting_item WHERE id = ?', [itemId])
      return rows[0].kind
    })
  }

  return { listRecent, listAll, listBetween, search, get, items, create, update, remove, saveNote, replaceItems, addItem, removeItem }
}
