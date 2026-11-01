// 页面：列表、会议详情、导入、设置、关于都由服务端渲染
import express from 'express'
import { basePathOf } from '../yh-one.mjs'
import { VERSION } from '../version.js'
import { localToUtc, todayIn, tzName } from '../dates.js'
import { ACCEPT, FILES_MAX } from '../import.js'
import { HttpError } from '../meetings.js'
import { blocksOf, card } from '../present.js'
import { aboutInfo } from '../about.js'
import { DUE_DAYS_MAX, LANGS } from '../settings.js'
import { VIEWS_LIST, listData } from './list.js'

const VIEW_TABS = [['recent', '近期'], ['all', '全部']]
const RAIL_RECENT = 4
const RAIL_PROJECTS = 6

/** 当月在 MEETING_TZ 下的起止，换成 UTC 查库 */
function monthRange(today) {
  const [y, m] = today.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return [localToUtc(`${today.slice(0, 7)}-01T00:00`), localToUtc(`${next}-01T00:00`)]
}

export function pageRouter({ ws, meetings, settings, users, about, ready, userOf, wrap, loadDetail }) {
  const r = express.Router()
  const page = (req, script = null) => {
    const me = userOf(req)
    return { base: `${basePathOf(req)}/`, version: VERSION, tz: tzName(), meeting: null, script, me, initial: [...(me?.name ?? '')][0] ?? '我', hosted: ws.enabled, projects: [], defaults: [] }
  }

  const problemOf = (req) => {
    if (!userOf(req)) return '应用未接入平台，请联系管理员'
    return ready() ? null : '数据库还没准备好，稍后刷新'
  }

  async function defaultPeople(ids) {
    const names = await users.names(ids)
    return ids.map((id) => ({ id, name: names.get(id) || `用户 ${id}` }))
  }

  async function rail(me) {
    const today = todayIn()
    const [from, to] = monthRange(today)
    const [stats, recent] = await Promise.all([meetings.monthStats(me.id, from, to), meetings.listRecent(me.id)])
    return { stats, recent: recent.ended.slice(0, RAIL_RECENT).map((m) => card(m, today)) }
  }

  r.get('/', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    const shell = { ...page(req), tabs: VIEW_TABS, view: 'recent', q: '', project: '', groups: [], capped: false, rail: null }
    if (problem) return res.status(503).render('index', { ...shell, problem })
    const view = VIEWS_LIST.includes(req.query.view) ? req.query.view : 'recent'
    ws.track(me, 'home.view', { view })
    const cfg = await settings.get(me.id)
    res.render('index', {
      ...shell,
      problem: null,
      projects: await meetings.projects(me.id),
      defaults: await defaultPeople(cfg.default_attendee_ids),
      rail: await rail(me),
      railProjects: RAIL_PROJECTS,
      ...await listData(meetings, me, view, req.query.q, req.query.project)
    })
  }))

  r.get('/meetings/:id', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    try {
      const meeting = await loadDetail(me, req.params.id)
      ws.track(me, 'meeting.view', { meetingId: meeting.id })
      res.render('detail', { ...page(req), meeting, blocks: blocksOf(await meetings.items(me.id, meeting.id)), mine: meeting.mine, projects: await meetings.projects(me.id) })
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e
      res.status(404).render('missing', { ...page(req), message: '这场会议不存在，或者你不在参与人里。' })
    }
  }))

  r.get('/import', wrap(async (req, res) => {
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    ws.track(userOf(req), 'import.view', {})
    res.render('import', { ...page(req, 'import'), projects: await meetings.projects(userOf(req).id), accept: ACCEPT.join(','), filesMax: FILES_MAX })
  }))

  r.get('/settings', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    const cfg = await settings.get(me.id)
    res.render('settings', { ...page(req, 'settings'), cfg, langs: LANGS, dueMax: DUE_DAYS_MAX, defaults: await defaultPeople(cfg.default_attendee_ids), model: (await about.modelInfo.name()) ?? '未配置' })
  }))

  r.get('/about', wrap(async (req, res) => {
    const problem = userOf(req) ? null : '应用未接入平台，请联系管理员'
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    res.render('about', { ...page(req), info: await aboutInfo(about) })
  }))

  // 退出：清本应用会话，再让平台也退出。本地单人模式没有平台，回首页
  r.get('/logout', (req, res) => {
    if (!ws.enabled) return res.redirect(302, `${basePathOf(req)}/`)
    ws.logout(req)
    res.redirect(302, ws.logoutUrl(req))
  })

  return r
}
