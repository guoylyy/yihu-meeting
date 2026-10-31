// 接口路由保持薄：取当前用户 → 调 meetings.js。权限都在 meetings.js
import express from 'express'
import { VIEWS_LIST, listData } from './list.js'
import { HttpError, parseAttendees } from '../meetings.js'
import { extractNotes } from '../extract.js'
import { blocksOf } from '../present.js'
import { matchesKeyword } from '../platform-users.js'
import { toLocal, tzName } from '../dates.js'

const PICKER_LIMIT = 50

export function apiRouter({ ws, meetings, users, llm, aiTimeoutMs, requireReady, requireUser, wrap, loadDetail }) {
  const r = express.Router()
  const data = [requireReady, requireUser]

  /** 只查新加的人：平台一时连不上时，改地点不该因为原有参与人查不到而失败 */
  async function checkAttendees(ids, existing = []) {
    const added = ids.filter((id) => !existing.includes(id))
    if (!added.length) return
    const known = new Set((await users.all()).filter((u) => u.active).map((u) => u.id))
    if (added.some((id) => !known.has(id))) throw new HttpError(400, '平台上找不到这个人')
  }

  // 列表 HTML 片段：切视图、搜索时局部刷新。放在 /api 下，未登录时回 401 而不是跳转
  r.get('/list.html', ...data, wrap(async (req, res) => {
    const view = VIEWS_LIST.includes(req.query.view) ? req.query.view : 'recent'
    if (req.query.q) ws.track(req.me, 'meeting.search', { view })
    res.render('partials/list', await listData(meetings, req.me, view, req.query.q))
  }))

  r.get('/meetings', ...data, wrap(async (req, res) => {
    const view = VIEWS_LIST.includes(req.query.view) ? req.query.view : 'all'
    res.json(await listData(meetings, req.me, view, req.query.q))
  }))

  r.post('/meetings', ...data, wrap(async (req, res) => {
    await checkAttendees(parseAttendees(req.body?.attendee_ids, req.me.id))
    const m = await meetings.create(req.me.id, req.body || {})
    ws.track(req.me, 'meeting.create', { meetingId: m.id, attendees: m.attendee_ids.length })
    res.status(201).json(await loadDetail(req.me, m.id))
  }))

  r.get('/meetings/:id', ...data, wrap(async (req, res) => {
    res.json(await loadDetail(req.me, req.params.id))
  }))

  r.patch('/meetings/:id', ...data, wrap(async (req, res) => {
    // 先确认会议归自己，别让人靠报错探测平台用户
    const cur = await meetings.get(req.me.id, req.params.id)
    if (cur.owner_id !== req.me.id) throw new HttpError(403, '只有创建者能修改会议')
    await checkAttendees(parseAttendees(req.body?.attendee_ids, req.me.id), cur.attendee_ids)
    const m = await meetings.update(req.me.id, req.params.id, req.body || {})
    ws.track(req.me, 'meeting.update', { meetingId: m.id, attendeeIds: m.attendee_ids })
    res.json(await loadDetail(req.me, m.id))
  }))

  r.delete('/meetings/:id', ...data, wrap(async (req, res) => {
    await meetings.remove(req.me.id, req.params.id)
    ws.track(req.me, 'meeting.delete', { meetingId: req.params.id })
    res.status(204).end()
  }))

  r.put('/meetings/:id/note', ...data, wrap(async (req, res) => {
    const { saved_at: savedAt } = await meetings.saveNote(req.me.id, req.params.id, req.body?.content)
    ws.track(req.me, 'note.save', { meetingId: req.params.id, chars: req.body.content.length })
    res.json({ saved_at: savedAt })
  }))

  // 先存原文再调模型：AI 怎么失败都不丢纪要。失败也是 200，由页面给一句说明
  r.post('/meetings/:id/extract', ...data, wrap(async (req, res) => {
    const saved = await meetings.saveNote(req.me.id, req.params.id, req.body?.content)
    if (!saved.content.trim()) throw new HttpError(400, '先写点纪要再提炼')
    const m = await meetings.get(req.me.id, req.params.id)
    const out = await extractNotes(saved.content, { llm, title: m.title, date: toLocal(m.starts_at).slice(0, 10), tz: tzName(), timeoutMs: aiTimeoutMs })
    const count = out.ok ? await meetings.replaceItems(req.me.id, req.params.id, out.summary) : 0
    ws.track(req.me, 'note.extract', { meetingId: m.id, ok: out.ok, reason: out.reason, count })
    res.json({ ok: out.ok, reason: out.reason, message: out.message ?? (count ? '' : '没有提炼出内容，可以手动补充。'), count, saved_at: saved.saved_at })
  }))

  r.get('/meetings/:id/blocks.html', ...data, wrap(async (req, res) => {
    const m = await meetings.get(req.me.id, req.params.id)
    res.render('partials/blocks', { blocks: blocksOf(await meetings.items(req.me.id, req.params.id)), mine: m.owner_id === req.me.id })
  }))

  r.post('/meetings/:id/items', ...data, wrap(async (req, res) => {
    const item = await meetings.addItem(req.me.id, req.params.id, req.body || {})
    ws.track(req.me, 'item.add', { meetingId: req.params.id, kind: item.kind })
    res.status(201).json(item)
  }))

  r.delete('/meetings/:id/items/:itemId', ...data, wrap(async (req, res) => {
    const kind = await meetings.removeItem(req.me.id, req.params.id, req.params.itemId)
    ws.track(req.me, 'item.delete', { meetingId: req.params.id, kind })
    res.status(204).end()
  }))

  // 只给选人用，字段收到最少，不把手机号之类带给前端
  r.get('/users', requireUser, wrap(async (req, res) => {
    const hits = (await users.all()).filter((u) => u.active && u.id !== req.me.id && matchesKeyword(u, req.query.q))
    res.json({ total: hits.length, list: hits.slice(0, PICKER_LIMIT).map(({ id, name, dept }) => ({ id, name, dept })) })
  }))

  return r
}
