// 每人一份的应用设置，存在本应用的库里（换设备也在），每次请求现读，改完下一次操作就生效，不用重启
import { addDays } from './dates.js'
import { ATTENDEE_MAX, HttpError, parseAttendees } from './meetings.js'

export const LANGS = [['zh', '中文'], ['en', '英文']]
export const DUE_DAYS_MAX = 365
export const DEFAULTS = { default_attendee_ids: [], summary_lang: 'zh', todo_due_days: 0 }

const parseLang = (v) => {
  if (!LANGS.some(([code]) => code === v)) throw new HttpError(400, '摘要语言不对')
  return v
}
const parseDays = (v) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > DUE_DAYS_MAX) throw new HttpError(400, `待办默认截止天数要在 0 到 ${DUE_DAYS_MAX} 之间`)
  return n
}

/** 没写截止日的待办补默认值。天数是 0 表示不补 */
export const withDefaultDue = (todos, base, days) => (days ? todos.map((t) => ({ ...t, due: t.due ?? addDays(base, days) })) : todos)

export function createSettings({ pool }) {
  async function get(userId) {
    const [rows] = await pool.execute('SELECT default_attendee_ids, summary_lang, todo_due_days FROM meeting_setting WHERE user_id = ?', [userId])
    if (!rows.length) return { ...DEFAULTS }
    return { default_attendee_ids: rows[0].default_attendee_ids ?? [], summary_lang: rows[0].summary_lang, todo_due_days: rows[0].todo_due_days }
  }

  /** 部分更新：一次只改一项，页面改一项存一项 */
  async function save(userId, input) {
    const cur = await get(userId)
    const next = {
      default_attendee_ids: 'default_attendee_ids' in input ? parseAttendees(input.default_attendee_ids, userId).slice(0, ATTENDEE_MAX) : cur.default_attendee_ids,
      summary_lang: 'summary_lang' in input ? parseLang(input.summary_lang) : cur.summary_lang,
      todo_due_days: 'todo_due_days' in input ? parseDays(input.todo_due_days) : cur.todo_due_days
    }
    await pool.execute(
      'INSERT INTO meeting_setting (user_id, default_attendee_ids, summary_lang, todo_due_days) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE default_attendee_ids = VALUES(default_attendee_ids), summary_lang = VALUES(summary_lang), todo_due_days = VALUES(todo_due_days)',
      [userId, JSON.stringify(next.default_attendee_ids), next.summary_lang, next.todo_due_days]
    )
    return next
  }

  return { get, save }
}
