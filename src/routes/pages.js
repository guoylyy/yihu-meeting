// 页面：列表和会议详情都由服务端渲染
import express from 'express'
import { basePathOf } from '../yh-one.mjs'
import { VERSION } from '../version.js'
import { tzName } from '../dates.js'
import { HttpError } from '../meetings.js'
import { blocksOf } from '../present.js'
import { VIEWS_LIST, listData } from './list.js'

const VIEW_TABS = [['recent', '近期'], ['all', '全部']]

export function pageRouter({ ws, meetings, ready, userOf, wrap, loadDetail }) {
  const r = express.Router()
  const page = (req) => ({ base: `${basePathOf(req)}/`, version: VERSION, tz: tzName(), meeting: null })

  const problemOf = (req) => {
    if (!userOf(req)) return '应用未接入平台，请联系管理员'
    return ready() ? null : '数据库还没准备好，稍后刷新'
  }

  r.get('/', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    const shell = { ...page(req), tabs: VIEW_TABS, view: 'recent', q: '', groups: [], capped: false }
    if (problem) return res.status(503).render('index', { ...shell, problem })
    const view = VIEWS_LIST.includes(req.query.view) ? req.query.view : 'recent'
    ws.track(me, 'home.view', { view })
    res.render('index', { ...shell, problem: null, ...await listData(meetings, me, view, req.query.q) })
  }))

  r.get('/meetings/:id', wrap(async (req, res) => {
    const me = userOf(req)
    const problem = problemOf(req)
    if (problem) return res.status(503).render('missing', { ...page(req), message: problem })
    try {
      const meeting = await loadDetail(me, req.params.id)
      ws.track(me, 'meeting.view', { meetingId: meeting.id })
      res.render('detail', { ...page(req), meeting, blocks: blocksOf(await meetings.items(me.id, meeting.id)), mine: meeting.mine })
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e
      res.status(404).render('missing', { ...page(req), message: '这场会议不存在，或者你不在参与人里。' })
    }
  }))

  return r
}
