import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { startHarness, clearTables } from './support/harness.js'
import { buildDocx, buildPdf, buildZip } from './support/fixtures.mjs'
import { FILE_MAX, ImportError, PDF_PAGES, decodeText, fixRadicals, kindOf, looksGarbled, readUpload, zipInflatedSize } from '../src/import.js'
import { NOTE_MAX } from '../src/meetings.js'

const ALICE = 11
const BOB = 12
const CAROL = 13
const FULL = {
  title: 'Q4 华东渠道推进会', held_at: '2026-10-28T14:00', location: '三楼大会议室', host: '李总', attendees: ['李总', '王芳', '王芳', '郑国栋'],
  project: '华东渠道', summary: '确定先上华东。王芳周五前给报价。合同有拖期风险。',
  decisions: ['先上华东'], todos: [{ title: '给报价', owner: '王芳', due_date: '2026-10-30' }, { title: '整理名单', owner: null, due_date: null }], risks: ['合同可能拖期'], nextAgenda: ['定价']
}
const DOCX = buildDocx(['Q4 华东渠道推进会纪要', '时间：10 月 28 日 14:00', '决议：先上华东', [['负责人', '事项'], ['王芳', '报价']]])

let h, alice, bob, carol

before(async () => {
  h = await startHarness({ aiTimeoutMs: 300 })
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  carol = await h.login(CAROL)
})
after(() => h.close())
beforeEach(async () => {
  await clearTables(h.pool)
  h.platform.state.llm = () => JSON.stringify(FULL)
})

const rejects = async (name, buf, code, pattern) => {
  await assert.rejects(readUpload(name, buf), (e) => {
    assert.ok(e instanceof ImportError, e.message)
    assert.equal(e.code, code)
    assert.match(e.message, pattern)
    return true
  })
}
const meetingCount = async () => (await h.pool.query('SELECT COUNT(*) AS n FROM meeting'))[0][0].n

// ---------- 抽文字 ----------
test('docx：抽出正文和表格里的文字', async () => {
  const { text, notices } = await readUpload('纪要.docx', DOCX)
  assert.match(text, /Q4 华东渠道推进会纪要/)
  assert.match(text, /决议：先上华东/)
  assert.match(text, /负责人[\s\S]*王芳[\s\S]*报价/)
  assert.deepEqual(notices, [])
})

test('docx：没有文字时说明原因', () => rejects('空.docx', buildDocx(['   ']), 'unreadable', /没有文字/))

test('docx：损坏或改了扩展名都给一句原因', async () => {
  await rejects('坏.docx', Buffer.from('这不是 zip 文件，只是一段文字'), 'unreadable', /不是有效的 \.docx/)
  await rejects('别的.docx', buildZip([['a.txt', 'hello']]), 'unreadable', /不是有效的 \.docx/)
})

test('docx：解压后过大的不解压，直接拒绝', async () => {
  const bomb = buildDocx(['x'], { declaredSize: 400 * 1024 * 1024 })
  assert.equal(zipInflatedSize(bomb) >= 400 * 1024 * 1024, true)
  await rejects('炸弹.docx', bomb, 'unreadable', /解压后太大/)
})

test('pdf：抽出中文，保留换行和分页', async () => {
  const { text, notices } = await readUpload('纪要.pdf', buildPdf(['华东渠道推进会纪要\n决议：先上华东，华南放到明年', '第二页：王芳周五前给报价，合同可能拖期']))
  assert.match(text, /华东渠道推进会纪要\n决议：先上华东/)
  assert.match(text, /第二页：王芳周五前给报价/)
  assert.deepEqual(notices, [])
})

test(`pdf：只读前 ${PDF_PAGES} 页，提示写明`, async () => {
  const pages = Array.from({ length: PDF_PAGES + 3 }, (_, i) => `第${i + 1}页的内容，这里写足够多的文字`)
  const { text, notices } = await readUpload('长.pdf', buildPdf(pages))
  assert.ok(text.includes(`第${PDF_PAGES}页`))
  assert.ok(!text.includes(`第${PDF_PAGES + 1}页`))
  assert.match(notices[0], /只读前 60 页/)
})

test('pdf：扫描件明确提示，不假装读到了', () => rejects('扫描.pdf', buildPdf([null, null, null]), 'scanned', /^这是扫描件，暂不能识别文字，请粘贴文本$/))

test('pdf：部分页是扫描页时照常入库并提示', async () => {
  const { text, notices } = await readUpload('混合.pdf', buildPdf(['这一页有足够多的文字可以读出来，不是扫描页', null]))
  assert.match(text, /足够多的文字/)
  assert.match(notices[0], /1 页读不出文字/)
})

test('pdf：损坏或改了扩展名都给一句原因', async () => {
  await rejects('坏.pdf', Buffer.from('%PDF-1.7 后面全是乱写的'), 'unreadable', /打不开/)
  await rejects('假.pdf', Buffer.from('其实是文本文件'), 'unreadable', /不是有效的 PDF/)
})

test('乱码判断：控制符多的算乱码，正常中英文不算', () => {
  assert.equal(looksGarbled('SNN\u001cn\u0001\u0002\u0003� abc'), true)
  assert.equal(looksGarbled('华东渠道 Q4 推进会，决议：先上华东。'), false)
})

test('pdf：康熙部首归一成普通汉字，中文标点不动', () => {
  assert.equal(fixRadicals('华南项\u2F6C复盘会：预算，维持。'), '华南项目复盘会：预算，维持。')
})

test('解析进程爆内存：只报这个文件，主进程照常，下一个文件能读', async () => {
  const huge = buildDocx(Array.from({ length: 90000 }, (_, i) => `第${i}段会议内容，决议先上华东，王芳负责报价，合同可能拖期`))
  const out = await Promise.allSettled([readUpload('巨大1.docx', huge), readUpload('巨大2.docx', huge)])
  for (const r of out) assert.match(r.reason.message, /太大太复杂/)
  assert.match((await readUpload('正常.docx', DOCX)).text, /先上华东/)
})

test('解析子进程拿不到数据库地址和平台凭证', async () => {
  const src = await readFile('src/import.js', 'utf8')
  assert.match(src, /env: \{ PATH: process\.env\.PATH \?\? '' \}/)
})

test('解析超时：子进程被杀掉，给一句话，不挂住请求', async () => {
  await assert.rejects(readUpload('慢.pdf', buildPdf(['这一页有足够多的文字可以读出来，不是扫描页']), { timeoutMs: 1 }), /读取超时/)
})

test('文本：UTF-8、带 BOM、GBK、UTF-16 都能读', async () => {
  assert.equal((await readUpload('a.txt', Buffer.from('会议记录'))).text, '会议记录')
  assert.equal((await readUpload('a.md', Buffer.from('﻿# 周会'))).text, '# 周会')
  assert.equal(decodeText(Buffer.from([0xbb, 0xe1, 0xd2, 0xe9])), '会议') // GBK
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x1a, 0x4f, 0xae, 0x8b])), '会议') // UTF-16 LE
})

test('文本：空文件、改了扩展名的二进制都给原因', async () => {
  await rejects('空.txt', Buffer.alloc(0), 'unreadable', /空文件/)
  await rejects('空白.txt', Buffer.from('  \n '), 'unreadable', /空文件/)
  await rejects('假.txt', Buffer.from([0x50, 0x4b, 0, 0, 1, 2]), 'unreadable', /不是文本文件/)
})

test('图片：明确说未开通，不静默失败', async () => {
  for (const name of ['白板.png', '拍照.JPG', '截图.jpeg']) await rejects(name, Buffer.from('x'), 'image', /^图片识别暂未开通，请先转成文字$/)
})

test('不支持的格式：给得出下一步', async () => {
  await rejects('老文件.doc', Buffer.from('x'), 'unsupported', /另存为 \.docx/)
  await rejects('表格.xlsx', Buffer.from('x'), 'unsupported', /不支持这种格式.*\.docx.*\.pdf/)
  await rejects('没有扩展名', Buffer.from('x'), 'unsupported', /不支持/)
})

test('文件过大：10MB 是上限', () => rejects('大.txt', Buffer.alloc(FILE_MAX + 1, 0x61), 'too_large', /不能超过 10MB/))

test('扩展名大小写不敏感', () => {
  assert.equal(kindOf('纪要.DOCX'), 'docx')
  assert.equal(kindOf('纪要.Pdf'), 'pdf')
  assert.equal(kindOf(null), 'other')
})

// ---------- 接口 ----------
test('导入 docx：元信息、四块、原文都落库', async () => {
  let seen
  h.platform.state.llm = (body) => { seen = body; return JSON.stringify(FULL) }
  const r = await alice.upload('周会.docx', DOCX)
  assert.equal(r.status, 201)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.message, '')
  assert.deepEqual(r.json.notices, [])
  assert.equal(r.json.meeting.project, '华东渠道')
  assert.match(seen.messages[1].content, /决议：先上华东/)
  const [[row]] = await h.pool.query('SELECT title, held_at, project, location, host, summary, attendee_names, source_name FROM meeting WHERE id = ?', [r.json.meeting.id])
  assert.equal(row.title, 'Q4 华东渠道推进会')
  assert.equal(row.held_at.toISOString(), '2026-10-28T06:00:00.000Z') // 14:00 上海时间
  assert.deepEqual([row.project, row.location, row.host, row.source_name], ['华东渠道', '三楼大会议室', '李总', '周会.docx'])
  assert.deepEqual(row.attendee_names, ['李总', '王芳', '郑国栋'])
  assert.match(row.summary, /先上华东/)
  const m = (await alice.get(`/api/meetings/${r.json.meeting.id}`)).json
  assert.match(m.note, /决议：先上华东/)
  const [items] = await h.pool.query('SELECT kind, text, owner_name, due_date FROM meeting_item WHERE meeting_id = ? ORDER BY id', [m.id])
  assert.deepEqual(items.map((i) => i.kind), ['decision', 'todo', 'todo', 'risk', 'agenda'])
  assert.deepEqual([items[1].owner_name, items[1].due_date], ['王芳', '2026-10-30'])
})

test('导入 pdf：走同一条链路', async () => {
  const r = await alice.upload('纪要.pdf', buildPdf(['华东渠道推进会纪要，决议先上华东，华南放到明年']))
  assert.equal(r.status, 201)
  assert.match((await alice.get(`/api/meetings/${r.json.meeting.id}`)).json.note, /决议先上华东/)
})

test('降级：模型回垃圾不 500，原文保存，标题用文件名', async () => {
  h.platform.state.llm = () => '抱歉我不会'
  const r = await alice.upload('十月周会.docx', DOCX)
  assert.equal(r.status, 201)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.reason, 'garbage')
  assert.match(r.json.message, /自动整理失败，可手动填写/)
  assert.equal(r.json.meeting.title, '十月周会')
  assert.match((await alice.get(`/api/meetings/${r.json.meeting.id}`)).json.note, /决议：先上华东/)
  assert.equal((await h.pool.query('SELECT COUNT(*) AS n FROM meeting_item'))[0][0].n, 0)
})

test('降级：只有元信息没有四块时用上元信息，四块留空', async () => {
  h.platform.state.llm = () => JSON.stringify({ title: '只识别了标题', project: '华东渠道', summary: '一句话。' })
  const r = await alice.upload('a.txt', Buffer.from('会议记录'))
  assert.equal(r.status, 201)
  assert.deepEqual([r.json.ok, r.json.reason], [false, 'partial'])
  assert.match(r.json.message, /可手动填写/)
  assert.deepEqual([r.json.meeting.title, r.json.meeting.project], ['只识别了标题', '华东渠道'])
})

test('降级：字段类型全错也不 500，只留合格的', async () => {
  h.platform.state.llm = () => JSON.stringify({ title: 123, held_at: '上周三', attendees: '王芳', project: {}, summary: null, decisions: '不是数组', todos: [{ owner: '没标题' }], risks: [1, null], nextAgenda: ['定价'] })
  const r = await alice.upload('a.txt', Buffer.from('会议记录'))
  assert.equal(r.status, 201)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.meeting.title, 'a')
  assert.match(r.json.notices.join(), /没看出开会时间/)
})

test('降级：模型超时和报错都不 500', async () => {
  h.platform.state.llm = () => new Promise(() => {})
  const slow = await alice.upload('a.txt', Buffer.from('会议记录'))
  assert.deepEqual([slow.status, slow.json.reason], [201, 'timeout'])
  h.platform.state.llm = () => undefined
  const down = await alice.upload('b.txt', Buffer.from('会议记录'))
  assert.deepEqual([down.status, down.json.reason], [201, 'failed'])
})

test('读不了的文件：422 + 一句原因，不落库', async () => {
  for (const [name, buf, pattern] of [['白板.png', Buffer.from('x'), /图片识别暂未开通/], ['扫描.pdf', buildPdf([null]), /这是扫描件/], ['表.xlsx', Buffer.from('x'), /不支持/], ['坏.docx', Buffer.from('x'), /不是有效的/]]) {
    const r = await alice.upload(name, buf)
    assert.equal(r.status, 422, name)
    assert.match(r.json.error, pattern)
  }
  assert.equal(await meetingCount(), 0)
})

test('一个失败不影响下一个', async () => {
  assert.equal((await alice.upload('a.png', Buffer.from('x'))).status, 422)
  assert.equal((await alice.upload('b.txt', Buffer.from('会议记录'))).status, 201)
  assert.equal(await meetingCount(), 1)
})

test('超过 10MB：413 给人话，不落库', async () => {
  const r = await alice.upload('大.txt', Buffer.alloc(FILE_MAX + 1, 0x61))
  assert.equal(r.status, 413)
  assert.equal(r.json.error, '单个文件不能超过 10MB')
  assert.equal(await meetingCount(), 0)
})

test('同一个人同时最多 5 个文件，多的 429', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  h.platform.state.llm = async () => { await gate; return JSON.stringify(FULL) }
  const uploads = Array.from({ length: 6 }, (_, i) => alice.upload(`${i}.txt`, Buffer.from('会议记录')))
  const rest = await Promise.race([Promise.all(uploads), new Promise((r) => { setTimeout(() => { release(); r(null) }, 150) })])
  const all = rest ?? await Promise.all(uploads)
  const refused = all.filter((r) => r.status === 429)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].json.error, '同时最多 5 个文件')
})

test('超长内容截到 5 万字并提示', async () => {
  const r = await alice.upload('长.txt', Buffer.from('字'.repeat(NOTE_MAX + 10)))
  assert.equal(r.status, 201)
  assert.match(r.json.notices.join(), /只保留了前 5 万字/)
  assert.equal([...(await alice.get(`/api/meetings/${r.json.meeting.id}`)).json.note].length, NOTE_MAX)
})

test('粘贴文字：标题回退到第一行，空内容 400', async () => {
  h.platform.state.llm = () => '垃圾'
  const r = await alice.post('/api/import/text', { text: '\n\n周会记录\n第二行' })
  assert.equal(r.status, 201)
  assert.equal(r.json.meeting.title, '周会记录')
  assert.equal((await alice.post('/api/import/text', { text: '  ' })).status, 400)
})

test('没写开会时间：按导入时间记，并提示', async () => {
  h.platform.state.llm = () => JSON.stringify({ ...FULL, held_at: null })
  const r = await alice.upload('a.txt', Buffer.from('会议记录'))
  assert.match(r.json.notices.join(), /没看出开会时间/)
})

test('文件名里的路径去掉', async () => {
  const r = await alice.upload('../../etc/计划.txt', Buffer.from('会议记录'))
  assert.equal((await alice.get(`/api/meetings/${r.json.meeting.id}`)).json.source_name, '计划.txt')
})

test('未登录 401', async () => {
  const r = await fetch(`${h.base}/api/import/file?name=a.txt`, { method: 'POST', body: 'x' })
  assert.equal(r.status, 401)
})

test('模型识别出的人名不授权：记录里写了也看不到，平台参与人才行', async () => {
  h.platform.state.llm = () => JSON.stringify({ ...FULL, attendees: ['李雷'], host: '李雷' })
  const r = await alice.upload('a.txt', Buffer.from('会议记录'))
  assert.equal((await bob.get(`/api/meetings/${r.json.meeting.id}`)).status, 404)
})

test('设置：默认参与人、摘要语言、默认截止天数对导入即时生效', async () => {
  assert.equal((await alice.put('/api/settings', { default_attendee_ids: [BOB], summary_lang: 'en', todo_due_days: 7 })).status, 200)
  let seen
  h.platform.state.llm = (body) => { seen = body; return JSON.stringify(FULL) }
  const r = await alice.upload('a.txt', Buffer.from('会议记录'))
  assert.match(seen.messages[0].content, /write in English/)
  assert.equal((await bob.get(`/api/meetings/${r.json.meeting.id}`)).status, 200)
  const [items] = await h.pool.query("SELECT text, due_date FROM meeting_item WHERE meeting_id = ? AND kind = 'todo' ORDER BY id", [r.json.meeting.id])
  assert.deepEqual(items.map((i) => i.due_date), ['2026-10-30', '2026-11-04']) // 没写的从开会日 10-28 起算 7 天
  assert.equal((await carol.get(`/api/meetings/${r.json.meeting.id}`)).status, 404)
})

test('详情页重新提炼：补空白，不覆盖人填的，摘要更新', async () => {
  const m = (await alice.post('/api/meetings', { title: '人起的标题', starts_at: '2026-11-02T15:00', location: '线上' })).json
  const r = await alice.post(`/api/meetings/${m.id}/extract`, { content: '会议记录' })
  assert.equal(r.json.ok, true)
  const after = (await alice.get(`/api/meetings/${m.id}`)).json
  assert.deepEqual([after.title, after.starts_at, after.location], ['人起的标题', '2026-11-02T15:00', '线上'])
  assert.deepEqual([after.project, after.host], ['华东渠道', '李总'])
  assert.match(after.summary, /先上华东/)
  assert.match((await alice.get(`/api/meetings/${m.id}/facts.html`)).text, /华东渠道/)
})

test('上报：不带原文和文件名', async () => {
  h.platform.state.events.length = 0
  await alice.upload('机密项目XYZ.txt', Buffer.from('机密内容ABC'))
  await alice.upload('机密项目XYZ.png', Buffer.from('x'))
  await h.ws.flush()
  const text = JSON.stringify(h.platform.state.events)
  assert.ok(h.platform.state.events.some((e) => e.action === 'meeting.import'))
  assert.ok(!text.includes('机密'))
})

test('导入页：四种来源和图片提示都写在页面上', async () => {
  const { status, text } = await alice.get('/import')
  assert.equal(status, 200)
  for (const word of ['粘贴文字', '支持 .docx / .pdf / .txt / .md，单文件 ≤10MB，一次最多 5 个', '图片怎么不支持？', '图片识别暂未开通，请先把图片内容转成文字再粘进来']) assert.ok(text.includes(word), word)
  for (const gone of ['支持的格式', '单个不超过 10MB']) assert.ok(!text.includes(gone), gone)
  assert.match(text, /<dialog class="yh-sheet yh-sheet--auto" id="image-help"/) // 不带 open，默认收起
  assert.ok(!/id="image-help"[^>]*\sopen/.test(text))
})

test('空态里有导入入口，列表页右上也有', async () => {
  const { text } = await alice.get('/')
  assert.match(text, /id="import-btn" href="import"/)
  assert.match(text, /yh-empty[\s\S]*href="import"/)
})
