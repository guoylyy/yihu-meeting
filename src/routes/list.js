// 列表数据：页面和 /api/list.html 共用
import { todayIn } from '../dates.js'
import { LIST_LIMIT, PROJECT_MAX, searchTerms } from '../meetings.js'
import { card } from '../present.js'

export const VIEWS_LIST = ['recent', 'all']

const parseProject = (raw) => String(raw ?? '').trim().slice(0, PROJECT_MAX) || null

export async function listData(meetings, me, view, rawQ, rawProject) {
  const today = todayIn()
  const project = parseProject(rawProject)
  const now = new Date()
  const toCards = (rows) => rows.map((m) => card(m, today, now))
  const q = String(rawQ ?? '').trim()
  const shared = { view, project: project ?? '' }
  if (searchTerms(q).length) return { ...shared, q, groups: [{ key: 'result', title: '', list: toCards(await meetings.search(me.id, q, LIST_LIMIT, project)) }], capped: false }
  if (view === 'all') {
    const rows = await meetings.listAll(me.id, LIST_LIMIT, project)
    return { ...shared, q: '', groups: [{ key: 'all', title: '', list: toCards(rows) }], capped: rows.length >= LIST_LIMIT }
  }
  const { upcoming, ended } = await meetings.listRecent(me.id, now, project)
  return { ...shared, q: '', capped: false, groups: [{ key: 'upcoming', title: '即将开始', list: toCards(upcoming) }, { key: 'ended', title: '最近结束', list: toCards(ended) }] }
}
