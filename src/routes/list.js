// 列表数据：页面和 /api/list.html 共用
import { todayIn } from '../dates.js'
import { LIST_LIMIT, searchTerms } from '../meetings.js'
import { card } from '../present.js'

export const VIEWS_LIST = ['recent', 'all']

export async function listData(meetings, me, view, rawQ) {
  const today = todayIn()
  const now = new Date()
  const toCards = (rows) => rows.map((m) => card(m, today, now))
  const q = String(rawQ ?? '').trim()
  if (searchTerms(q).length) return { view, q, groups: [{ key: 'result', title: '', list: toCards(await meetings.search(me.id, q)) }], capped: false }
  if (view === 'all') {
    const rows = await meetings.listAll(me.id)
    return { view, q: '', groups: [{ key: 'all', title: '', list: toCards(rows) }], capped: rows.length >= LIST_LIMIT }
  }
  const { upcoming, ended } = await meetings.listRecent(me.id, now)
  return { view, q: '', capped: false, groups: [{ key: 'upcoming', title: '即将开始', list: toCards(upcoming) }, { key: 'ended', title: '最近结束', list: toCards(ended) }] }
}
