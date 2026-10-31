// 把库里的行变成页面和接口要的样子。时间文案都在这里拼，模板不做计算
import { STATUS_LABEL, meetingStatus, rangeLabel, toLocal, whenLabel } from './dates.js'
import { todoLine } from './meetings.js'

export const BLOCKS = [['decision', '决议'], ['todo', '待办'], ['risk', '风险'], ['agenda', '下次议题']]

export function card(m, today, now = new Date()) {
  const status = meetingStatus(m.starts_at, m.ends_at, now)
  return { id: m.id, title: m.title, when: whenLabel(m.starts_at, today), status, status_label: STATUS_LABEL[status], people: Number(m.people), has_note: !!m.has_note }
}

export function detail(m, me, names, today, now = new Date()) {
  const status = meetingStatus(m.starts_at, m.ends_at, now)
  const nameOf = (id) => names.get(id) || (id === me.id ? me.name : `用户 ${id}`)
  return {
    id: m.id,
    title: m.title,
    status,
    status_label: STATUS_LABEL[status],
    range: rangeLabel(m.starts_at, m.ends_at, today),
    starts_at: toLocal(m.starts_at),
    ends_at: m.ends_at ? toLocal(m.ends_at) : '',
    location: m.location || '',
    agenda: m.agenda || '',
    mine: m.owner_id === me.id,
    owner: { id: m.owner_id, name: nameOf(m.owner_id) },
    attendees: m.attendee_ids.map((id) => ({ id, name: nameOf(id) })),
    note: m.note,
    note_saved_at: m.note_saved_at
  }
}

const shortDue = (due) => (due ? `${Number(due.slice(5, 7))}月${Number(due.slice(8, 10))}日` : '')

export const itemView = (i) => ({ id: i.id, kind: i.kind, text: i.text, owner: i.owner_name, due: i.due_date, due_label: shortDue(i.due_date), line: i.kind === 'todo' ? todoLine(i) : '' })

/** 四块按固定顺序分好，模板和接口都用 */
export function blocksOf(rows) {
  const items = rows.map(itemView)
  return BLOCKS.map(([kind, label]) => ({ kind, label, items: items.filter((i) => i.kind === kind) }))
}

/** MCP 的 get_meeting_notes 用：和模型输出同一种形状 */
export function summaryOf(rows) {
  const texts = (kind) => rows.filter((r) => r.kind === kind).map((r) => r.text)
  return {
    decisions: texts('decision'),
    todos: rows.filter((r) => r.kind === 'todo').map((r) => ({ title: r.text, owner: r.owner_name, due: r.due_date })),
    risks: texts('risk'),
    nextAgenda: texts('agenda')
  }
}
