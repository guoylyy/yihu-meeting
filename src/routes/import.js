// 导入接口：一个文件一个请求，单个失败不影响其他，也不会有一个请求占着几个大文件的内存
//   先存原文再调模型，和详情页提炼同一条底线：AI 怎么失败都不丢内容
import path from 'node:path'
import express from 'express'
import { FILE_MAX, FILES_MAX, ImportError, kindOf, readUpload } from '../import.js'
import { HttpError, NOTE_MAX, TITLE_MAX } from '../meetings.js'
import { extractNotes } from '../extract.js'
import { todayIn, toLocal, tzName, whenLabel } from '../dates.js'
import { withDefaultDue } from '../settings.js'

const FALLBACK_TITLE = '导入的会议'
const TITLE_FROM_TEXT = 40

const clip = (s, max) => [...s].slice(0, max).join('')
const tidy = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const firstLine = (text) => clip(text.split('\n').find((l) => l.trim())?.trim() ?? '', TITLE_FROM_TEXT)
const baseName = (name) => clip(path.basename(String(name ?? '').replace(/\\/g, '/')).trim(), 255)

export function importRouter({ ws, meetings, settings, llm, aiTimeoutMs, importTimeoutMs, requireReady, requireUser, wrap }) {
  const r = express.Router()
  const data = [requireReady, requireUser]
  const inFlight = new Map() // 用户 id → 正在处理的文件数

  /** 页面是一个个传的，这里是兜底：绕过页面并发猛传时不让一个人占满解析线程 */
  function limitPerUser(req, res, next) {
    const n = inFlight.get(req.me.id) ?? 0
    if (n >= FILES_MAX) return next(new HttpError(429, `同时最多 ${FILES_MAX} 个文件`))
    inFlight.set(req.me.id, n + 1)
    res.once('close', () => {
      const left = inFlight.get(req.me.id) - 1
      if (left) inFlight.set(req.me.id, left)
      else inFlight.delete(req.me.id)
    })
    next()
  }

  const rawBody = express.raw({ type: () => true, limit: FILE_MAX })
  function readBody(req, res, next) {
    rawBody(req, res, (e) => next(e?.type === 'entity.too.large' ? new HttpError(413, '单个文件不能超过 10MB') : e))
  }

  async function importText(me, { text, sourceName, fallbackTitle, notices }) {
    const cfg = await settings.get(me.id)
    let note = tidy(text)
    if ([...note].length > NOTE_MAX) {
      note = clip(note, NOTE_MAX)
      notices.push(`内容太长，只保留了前 ${NOTE_MAX / 10000} 万字`)
    }
    const m = await meetings.create(me.id, {
      title: clip(fallbackTitle || firstLine(note) || FALLBACK_TITLE, TITLE_MAX),
      starts_at: toLocal(new Date()),
      attendee_ids: cfg.default_attendee_ids,
      source_name: sourceName
    })
    await meetings.saveNote(me.id, m.id, note)

    const today = todayIn()
    const out = await extractNotes(note, { llm, title: '（待识别）', date: today, tz: tzName(), lang: cfg.summary_lang, timeoutMs: aiTimeoutMs })
    if (out.meta) await meetings.applyMeta(me.id, m.id, out.meta, { overwrite: true })
    if (out.ok) {
      const base = out.meta?.held_at?.slice(0, 10) ?? today
      await meetings.replaceItems(me.id, m.id, { ...out.summary, todos: withDefaultDue(out.summary.todos, base, cfg.todo_due_days) })
      if (!out.meta?.held_at) notices.push('记录里没看出开会时间，先按导入时间记，可在详情里改')
    }
    const saved = await meetings.get(me.id, m.id)
    return {
      ok: out.ok,
      reason: out.reason ?? null,
      message: out.message ?? '',
      notices,
      meeting: { id: saved.id, title: saved.title, project: saved.project ?? '', when: whenLabel(saved.starts_at, today) }
    }
  }

  r.post('/import/text', ...data, limitPerUser, wrap(async (req, res) => {
    const text = req.body?.text
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, '先粘贴会议记录')
    const out = await importText(req.me, { text, notices: [] })
    ws.track(req.me, 'meeting.import', { source: 'paste', ok: out.ok, reason: out.reason, chars: text.length })
    res.status(201).json(out)
  }))

  r.post('/import/file', ...data, limitPerUser, readBody, wrap(async (req, res) => {
    const name = baseName(req.query.name)
    if (!name) throw new HttpError(400, '缺少文件名')
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, '请求内容不对')
    try {
      const { text, notices } = await readUpload(name, req.body, { timeoutMs: importTimeoutMs })
      const out = await importText(req.me, { text, sourceName: name, fallbackTitle: name.replace(/\.[^.]+$/, ''), notices: [...notices] })
      ws.track(req.me, 'meeting.import', { source: kindOf(name), ok: out.ok, reason: out.reason, chars: text.length })
      res.status(201).json(out)
    } catch (e) {
      if (!(e instanceof ImportError)) throw e
      ws.track(req.me, 'meeting.import', { source: kindOf(name), ok: false, reason: e.code })
      res.status(422).json({ error: e.message, code: e.code })
    }
  }))

  return r
}
