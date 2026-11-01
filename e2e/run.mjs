// 真机式实测：独立实例 + 临时库，经 /apps/meeting 前缀访问（和平台拓扑一致）。截图和报告写到 artifacts/
//   E2E_DATABASE_URL=mysql://… npm run e2e     不给就用 Docker 起临时库
import { mkdirSync, writeFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { chromium, webkit } from 'playwright-core'
import { startFakePlatform } from '../test/support/fake-platform.mjs'
import { toLocal } from '../src/dates.js'
import { VERSION } from '../src/version.js'
import { MINUTE, SIZES, SMALL_TARGETS, startApp, startDatabase } from './support.mjs'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3060
const PLATFORM_PORT = APP_PORT + 1
const OUT = 'artifacts/e2e'
const LONG_TITLE = '第四季度华东区全部经销商返利对账与年度框架协议续签条款复核专题会议（含法务、财务、销售三方），需要逐条确认修订版本AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const NOTES = `10月30日周会
李总：华东先上，华南放到明年一季度。
郑国栋下周一前整理客户名单。
王芳担心合同法务还没回，可能拖期。
定价下次再聊。`
const SUMMARY = {
  decisions: ['华东先上，华南放到明年一季度'],
  todos: [{ title: '整理客户名单', owner: '郑国栋', due: '2026-11-02' }, { title: '催法务回合同', owner: null, due: null }],
  risks: ['合同法务还没回，可能拖期', '返利对账超长文本'.repeat(12)],
  nextAgenda: ['定价']
}

mkdirSync(OUT, { recursive: true })
const report = { ok: true, checks: [], under44: [], scroll: [] }
const check = (name, pass, detail = '') => {
  report.checks.push({ name, pass, detail })
  if (!pass) report.ok = false
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  ${detail}` : ''}`)
}

const db = await startDatabase()
const dbUrl = db.url

const platform = await startFakePlatform({ port: PLATFORM_PORT, appTarget: { host: '127.0.0.1', port: APP_PORT } })
platform.state.llm = () => JSON.stringify(SUMMARY)

const appUrl = `${platform.url}/apps/meeting`
const server = await startApp({ port: APP_PORT, env: { DATABASE_URL: dbUrl, YH_CLIENT_ID: 'cid', YH_CLIENT_SECRET: 'secret', YH_API_URL: platform.url, YH_WEB_URL: platform.url, YH_APP_URL: appUrl, YH_BASE_PATH: '/apps/meeting', MEETING_AI_TIMEOUT_MS: '2000' } })

async function audit(page, label) {
  const r = await page.evaluate(() => ({ sw: document.body.scrollWidth, iw: window.innerWidth, dw: document.documentElement.scrollWidth }))
  report.scroll.push({ label, ...r })
  check(`${label} scrollWidth <= innerWidth`, r.sw <= r.iw && r.dw <= r.iw, `body=${r.sw} doc=${r.dw} inner=${r.iw}`)
  for (const item of await page.evaluate(SMALL_TARGETS)) report.under44.push(`${label}: ${item}`)
}

const fullShot = (page, path) => page.screenshot({ path, fullPage: true })
const block = (kind) => `.block[data-kind="${kind}"]`
const openAdd = (page, kind) => page.click(`${block(kind)} [data-toggle]`)
const pageHeight = (page) => page.evaluate(() => document.documentElement.scrollHeight)

async function loginContext(browser, userId, viewport, options = {}) {
  platform.state.loginAs = userId
  const ctx = await browser.newContext({ viewport, isMobile: false, deviceScaleFactor: 2, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', ...options })
  const page = await ctx.newPage()
  page.problems = []
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()) })
  page.on('pageerror', (e) => page.problems.push(e.message))
  await page.goto(`${appUrl}/`)
  await page.waitForSelector('#new-btn')
  return { ctx, page }
}

const local = (minutes) => toLocal(new Date(Date.now() + minutes * MINUTE))
const itemAction = async (page, item, action) => {
  await page.click(`${item} [data-more]`)
  await page.waitForSelector('#item-menu[open]')
  await page.click(action)
}
const hideToast = (page) => page.evaluate(() => { document.getElementById('toast').hidden = true })

const pool = mysql.createPool({ uri: dbUrl, timezone: 'Z' })
const seed = async (owner, title, startMin, endMin, attendees = [], note = null) => {
  const [r] = await pool.execute('INSERT INTO meeting (owner_id, title, starts_at, ends_at, location) VALUES (?, ?, ?, ?, ?)', [owner, title, new Date(Date.now() + startMin * MINUTE), endMin === null ? null : new Date(Date.now() + endMin * MINUTE), null])
  for (const a of attendees) await pool.execute('INSERT INTO meeting_attendee (meeting_id, user_id) VALUES (?, ?)', [r.insertId, a])
  if (note) await pool.execute('INSERT INTO meeting_note (meeting_id, content) VALUES (?, ?)', [r.insertId, note])
  return r.insertId
}

const browser = await chromium.launch()
try {
  // 空态
  {
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 })
    check('空态一句说明加导入', (await page.textContent('.yh-empty p')) === '还没有会议。' && await page.locator('.yh-empty a.yh-btn').count() === 1)
    await page.screenshot({ path: `${OUT}/375-empty.png` })
    await audit(page, '375 空态')
    await ctx.close()
  }

  await seed(11, LONG_TITLE, 90, 150, [12, 13])
  await seed(11, '产品评审', -20, 40, [12])
  await seed(13, '销售周报', 60 * 26, null, [11])
  await seed(11, '客户复盘', -60 * 5, -60 * 4, [12, 13], '讨论了返利，预算；评审')
  await seed(11, '老会议', -60 * 24 * 40, -60 * 24 * 40 + 60)
  const secret = await seed(13, '别人的会', 30, 60, [14])

  for (const [tag, width, height] of SIZES) {
    const { ctx, page } = await loginContext(browser, 11, { width, height }, { permissions: ['clipboard-read', 'clipboard-write'] })
    const label = tag

    // 列表
    await page.screenshot({ path: `${OUT}/${tag}-list.png` })
    await audit(page, `${label} 列表`)
    if (width > 640) {
      check(`${label} 版本号 v${VERSION} 在右上角`, (await page.textContent('#version')) === `v${VERSION}`)
      const ver = await page.locator('#version').boundingBox()
      check(`${label} 版本号靠右上`, ver.x + ver.width > width / 2 && ver.y < 60, `x=${Math.round(ver.x)} y=${Math.round(ver.y)}`)
    } else {
      await page.click('#user-menu summary')
      check(`${label} 手机版本号收进头像菜单第一行`, (await page.textContent('.yh-menu-ver')) === `版本 v${VERSION}`)
      await page.keyboard.press('Escape')
    }
    check(`${label} 分组：即将开始、最近结束`, await page.locator('h2.group').allTextContents().then((t) => t.join() === '即将开始,最近结束'))
    check(`${label} 进行中标记`, await page.locator('.meeting:has-text("产品评审") .status.ongoing').count() === 1)
    check(`${label} 相对时间`, /^今天 \d\d:\d\d$/.test(await page.textContent('.meeting:has-text("产品评审") .when')) || /^昨天 \d\d:\d\d$/.test(await page.textContent('.meeting:has-text("产品评审") .when')))
    check(`${label} 纪要标记`, await page.locator('.meeting:has-text("客户复盘") .yh-tag').count() === 1 && await page.locator('.meeting:has-text("产品评审") .yh-tag').count() === 0)
    check(`${label} 人数含创建者`, (await page.textContent('.meeting:has-text("客户复盘") .yh-row-sub')).includes('3 人'))
    check(`${label} 别人的会看不到`, await page.locator('.meeting:has-text("别人的会")').count() === 0)

    const imp = await page.locator('#import-btn').boundingBox()
    check(`${label} 导入按钮在首屏`, imp.y + imp.height <= height / 2, `y=${Math.round(imp.y)}`)

    // 切全部、搜索
    await page.click('.tab[data-view="all"]')
    await page.waitForSelector('.meeting:has-text("老会议")')
    check(`${label} 全部里有老会议`, true)
    await audit(page, `${label} 全部`)
    await page.fill('#search', '返利，评审')
    await page.waitForFunction(() => document.querySelectorAll('.meeting').length === 1)
    check(`${label} 搜正文带中文标点`, (await page.textContent('.meeting .yh-row-title')) === '客户复盘')
    await page.fill('#search', '不存在的词')
    await page.waitForSelector('.yh-empty')
    check(`${label} 搜不到有说明，没有动作`, (await page.textContent('.yh-empty')).trim() === '没有找到相关会议。' && await page.locator('.yh-empty a').count() === 0)
    await page.route('**/api/list.html*', (r) => r.abort())
    await page.fill('#search', '断网')
    await page.waitForSelector('.yh-error')
    await page.unroute('**/api/list.html*')
    page.problems = page.problems.filter((p) => !p.includes('ERR_FAILED'))
    await page.fill('#search', '')
    await page.click('.yh-error .yh-btn')
    await page.waitForSelector('.meeting')
    check(`${label} 列表失败：一句原因 + 重试`, await page.locator('.yh-error').count() === 0)
    await page.click('.tab[data-view="recent"]')
    await page.waitForSelector('h2.group')

    // 新建弹层
    await page.click('#new-btn')
    await page.waitForSelector('#sheet[open]')
    check(`${label} 新建默认开始时间`, /^\d{4}-\d\d-\d\dT\d\d:(00|30)$/.test(await page.inputValue('#f-start')))
    await page.screenshot({ path: `${OUT}/${tag}-new.png` })
    await audit(page, `${label} 新建弹层`)
    await page.waitForFunction(() => !document.getAnimations().length) // 手机上弹层有滑入动画，停稳了再量
    const save = await page.locator('#sheet-save').boundingBox()
    check(`${label} 保存按钮在可见区`, save.y + save.height <= height, `bottom=${Math.round(save.y + save.height)}/${height}`)

    // 标题为空：错误提示不能被弹层盖住
    await page.click('#sheet-save')
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 弹层里能看到报错`, await page.evaluate(() => {
      const r = document.getElementById('toast').getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.id === 'toast'
    }), await page.textContent('#toast'))
    await hideToast(page)
    page.problems = page.problems.filter((p) => !p.includes('400')) // 上面故意提交的空标题

    await page.fill('#f-title', `Q4 周会（${tag}）`)
    await page.fill('#f-start', local(-10))
    await page.fill('#f-end', local(50))
    await page.fill('#f-location', '三楼会议室')
    await page.fill('#f-agenda', '一、华东计划\n二、合同进度')

    // 选人：多选，搜索后之前选的不丢
    await page.click('#f-people')
    await page.waitForSelector('#picker[open] #picker-list button')
    await page.screenshot({ path: `${OUT}/${tag}-people.png` })
    await audit(page, `${label} 选人`)
    await page.click('#picker-list button:has-text("李雷")')
    await page.fill('#picker-q', '销售')
    await page.waitForFunction(() => document.querySelectorAll('#picker-list button').length === 1)
    await page.click('#picker-list button:has-text("韩梅梅")')
    await page.click('#picker-done')
    check(`${label} 选人回填`, (await page.textContent('#f-people-name')) === '李雷、韩梅梅')

    await page.click('#sheet-save')
    await page.waitForURL(/\/apps\/meeting\/meetings\/\d+$/)
    const detailUrl = page.url()

    // 详情
    await page.waitForSelector('.note-card')
    check(`${label} 详情：进行中`, (await page.textContent('.status')) === '进行中')
    check(`${label} 详情：参与人`, (await page.locator('#m-people li').allTextContents()).join() === '王小明（创建者）,李雷,韩梅梅')
    await fullShot(page, `${OUT}/${tag}-detail.png`)
    await audit(page, `${label} 详情`)
    const bar = await page.locator('#extract-btn').boundingBox()
    const noteTitle = await page.locator('.note-head h2').boundingBox()
    check(`${label} 提炼按钮和纪要标题同一行、靠右`, bar.y < noteTitle.y + noteTitle.height && noteTitle.y < bar.y + bar.height && bar.x > noteTitle.x + noteTitle.width && bar.x + bar.width > width * 0.4, `btn=(${Math.round(bar.x)},${Math.round(bar.y)}) title=(${Math.round(noteTitle.x)},${Math.round(noteTitle.y)})`)
    check(`${label} 提炼按钮在文档流里`, await page.evaluate(() => getComputedStyle(document.getElementById('extract-btn').parentElement).position) === 'static')

    // 空块：只有标题和添加，没有表单，没有说明
    check(`${label} 空块没有表单和说明`, await page.locator('.block .add:visible, .block .note-line').count() === 0)
    check(`${label} 空块标题不带条数`, (await page.locator('.block h2').allTextContents()).join() === '决议,待办,风险,下次议题')
    check(`${label} 空块添加按钮齐全`, (await page.locator('.block [data-toggle]').allTextContents()).join() === '添加,添加,添加,添加')
    await fullShot(page, `${OUT}/${tag}-blocks-empty.png`)

    // AI 失败：原文保存，四块空，一句说明
    platform.state.llm = () => '抱歉我不知道'
    await page.fill('#note', NOTES)
    await page.click('#extract-btn')
    await page.waitForSelector('#ai-msg:not([hidden])')
    check(`${label} AI 失败提示不是灰字`, await page.locator('#ai-msg.quiet').count() === 0)
    check(`${label} AI 失败有说明`, (await page.textContent('#ai-msg')).includes('纪要已保存'), await page.textContent('#ai-msg'))
    check(`${label} AI 失败四块留空`, await page.locator('.item').count() === 0)
    await fullShot(page, `${OUT}/${tag}-ai-failed.png`)
    await page.reload()
    await page.waitForSelector('.note-card')
    check(`${label} AI 失败后原文还在`, (await page.inputValue('#note')) === NOTES)

    // 模型说四块都没有：一行灰字
    platform.state.llm = () => JSON.stringify({ decisions: [], todos: [], risks: [], nextAgenda: [] })
    await page.click('#extract-btn')
    await page.waitForSelector('#ai-msg:not([hidden])')
    const quiet = await page.evaluate(() => {
      const el = document.getElementById('ai-msg')
      const s = getComputedStyle(el)
      return { text: el.textContent, color: s.color, muted: getComputedStyle(document.querySelector('.save-state')).color, border: s.borderTopWidth, height: el.getBoundingClientRect().height }
    })
    check(`${label} 没提炼出内容给一行灰字`, quiet.text === '这次没提炼出内容，可以手动补' && quiet.color === quiet.muted && quiet.border === '0px' && quiet.height < 30, JSON.stringify(quiet))
    await fullShot(page, `${OUT}/${tag}-ai-nothing.png`)
    await page.reload()
    await page.waitForSelector('.note-card')
    platform.state.llm = () => JSON.stringify(SUMMARY)

    // AI 提炼
    await page.click('#extract-btn')
    await page.waitForSelector('.item')
    const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.block')].map((b) => [b.dataset.kind, b.querySelectorAll('.item').length])))
    check(`${label} 四块都有内容`, JSON.stringify(counts) === '{"decision":1,"todo":2,"risk":2,"agenda":1}', JSON.stringify(counts))
    check(`${label} 待办没有收件箱说明`, await page.locator('.block[data-kind="todo"] .note-line').count() === 0)
    await hideToast(page)

    // 折叠态：四块只有标题、条目和添加
    check(`${label} 标题带条数`, (await page.locator('.block h2').allTextContents()).join() === '决议 · 1,待办 · 2,风险 · 2,下次议题 · 1')
    check(`${label} 折叠态没有表单`, await page.locator('.block .add:visible').count() === 0)
    await fullShot(page, `${OUT}/${tag}-collapsed.png`)
    await page.locator(block('todo')).screenshot({ path: `${OUT}/${tag}-todo-hint.png` })

    // 展开：焦点进输入框，按钮变收起，其他块不动
    await openAdd(page, 'todo')
    check(`${label} 展开后焦点在输入框`, await page.evaluate(() => document.activeElement?.name === 'text' && document.activeElement.closest('.block').dataset.kind === 'todo'))
    check(`${label} 只展开这一块`, await page.locator('.block .add:visible').count() === 1)
    check(`${label} 展开后按钮是收起`, (await page.textContent(`${block('todo')} [data-toggle]`)) === '收起' && (await page.getAttribute(`${block('todo')} [data-toggle]`, 'aria-expanded')) === 'true')
    for (const [state, kind] of [['添加', 'risk'], ['收起', 'todo']]) {
      const b = await page.locator(`${block(kind)} [data-toggle]`).boundingBox()
      check(`${label} ${state}按钮 ≥44px`, b.width >= 44 && b.height >= 44, `${b.width}×${b.height}`)
    }
    const f = Object.fromEntries(await Promise.all(['input[name="text"]', 'input[name="owner"]', 'input[name="due"]', '.yh-btn'].map(async (s) => [s, await page.locator(`${block('todo')} .add ${s}`).boundingBox()])))
    const rows = new Set(Object.values(f).map((b) => Math.round(b.y))).size
    const oneRow = width === 768 // 1440 上四块在右栏，宽度和手机差不多
    check(`${label} 待办表单排成 ${oneRow ? '一行' : '两行'}`, rows === (oneRow ? 1 : 2), `${rows} 行`)
    await fullShot(page, `${OUT}/${tag}-expanded.png`)
    await audit(page, `${label} 展开态`)

    // Esc、收起都折叠，焦点回到按钮；写了一半的内容还在
    await page.fill(`${block('todo')} input[name="text"]`, '写了一半')
    await page.keyboard.press('Escape')
    check(`${label} Esc 收起`, await page.locator('.block .add:visible').count() === 0 && (await page.textContent(`${block('todo')} [data-toggle]`)) === '添加')
    check(`${label} 收起后焦点回到添加`, await page.evaluate(() => document.activeElement?.hasAttribute('data-toggle')))
    await openAdd(page, 'todo')
    check(`${label} 收起再展开内容还在`, (await page.inputValue(`${block('todo')} input[name="text"]`)) === '写了一半')
    await openAdd(page, 'todo')
    check(`${label} 点收起折叠`, await page.locator('.block .add:visible').count() === 0)

    // 刷新不记住展开
    await openAdd(page, 'risk')
    await page.reload()
    await page.waitForSelector('.block')
    check(`${label} 刷新后收起`, await page.locator('.block .add:visible').count() === 0)
    await page.evaluate(() => document.querySelector('.block').scrollIntoView())
    await page.screenshot({ path: `${OUT}/${tag}-ai-result.png` })
    await fullShot(page, `${OUT}/${tag}-ai-result-full.png`)
    await audit(page, `${label} AI 结果`)

    // 复制
    await itemAction(page, '.block[data-kind="todo"] .item:first-child', '#item-copy')
    await page.waitForSelector('#toast:not([hidden])')
    check(`${label} 复制成一行`, (await page.evaluate(() => navigator.clipboard.readText())) === '整理客户名单 @郑国栋 11-02')
    await hideToast(page)

    // 手动补、单条删
    await openAdd(page, 'todo')
    await page.fill('.block[data-kind="todo"] input[name="text"]', '发报价')
    await page.fill('.block[data-kind="todo"] input[name="owner"]', '王芳')
    await page.fill('.block[data-kind="todo"] input[name="due"]', '2026-11-06')
    await page.click('.block[data-kind="todo"] .add .yh-btn')
    await page.waitForSelector('[data-line="发报价 @王芳 11-06"]')
    check(`${label} 手动补待办`, true)
    check(`${label} 保存后折叠、条数更新、焦点在添加`, await page.locator('.block .add:visible').count() === 0 && (await page.textContent(`${block('todo')} h2`)) === '待办 · 3' && await page.evaluate(() => document.activeElement?.matches('.block[data-kind="todo"] [data-toggle]')))
    await openAdd(page, 'risk')
    await page.fill('.block[data-kind="risk"] input[name="text"]', '人手不够')
    await page.press('.block[data-kind="risk"] input[name="text"]', 'Enter')
    await page.waitForSelector('.block[data-kind="risk"] .item:has-text("人手不够")')
    await page.click('.block[data-kind="decision"] [data-del]')
    await page.waitForFunction(() => !document.querySelector('.block[data-kind="decision"] .item'))
    check(`${label} 单条删除`, await page.locator('.block[data-kind="risk"] .item').count() === 3)

    // 待办从 ⋯ 菜单删光
    for (let n = await page.locator(`${block('todo')} .item`).count(); n > 0; n--) {
      await itemAction(page, `${block('todo')} .item:first-child`, '#item-del')
      await page.waitForFunction(([s, left]) => document.querySelectorAll(s).length === left, [`${block('todo')} .item`, n - 1])
    }
    check(`${label} 待办能从菜单删光`, await page.locator(`${block('todo')} .item`).count() === 0)

    // 重新提炼要确认
    await page.click('#extract-btn')
    await page.waitForSelector('#confirm[open]')
    check(`${label} 重新提炼先确认`, (await page.textContent('#confirm-text')).includes('手动补的也会被替换'))
    await audit(page, `${label} 确认框`)
    await page.click('#confirm-no')

    // 编辑
    await page.click('#edit-btn')
    await page.waitForSelector('#sheet[open]')
    check(`${label} 编辑回填参与人`, (await page.textContent('#f-people-name')) === '李雷、韩梅梅')
    await page.fill('#f-location', '线上')
    await page.click('#sheet-save')
    await page.waitForFunction(() => document.querySelector('.detail .yh-sub').textContent.includes('线上'))
    check(`${label} 编辑后保存`, true)

    // 自动保存：失焦
    await page.click('#note-edit')
    await page.fill('#note', `${NOTES}\n失焦保存`)
    check(`${label} 输入后提示有改动`, (await page.textContent('#save-state')) === '有改动')
    await page.locator('#note').blur()
    await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存')
    await page.reload()
    await page.waitForSelector('.note-card')
    check(`${label} 失焦自动保存`, (await page.inputValue('#note')).endsWith('失焦保存'))

    // 删除要二次确认，写明纪要一并删除；取消什么都不发生
    await page.click('#delete-btn')
    await page.waitForSelector('#confirm[open]')
    check(`${label} 删除确认文案`, (await page.textContent('#confirm-text')).includes('纪要一并删除'))
    await page.screenshot({ path: `${OUT}/${tag}-delete.png` })
    await page.click('#confirm-no')
    check(`${label} 取消删除`, page.url() === detailUrl)

    if (tag === '375') {
      // 网络断开：提示不丢内容
      await page.click('#note-edit')
      await page.route('**/api/meetings/*/note', (r) => r.abort())
      await page.fill('#note', '断网时写的')
      await page.locator('#note').blur()
      await page.waitForFunction(() => document.getElementById('save-state').textContent.startsWith('未保存'))
      check('375 保存失败有提示', true, await page.textContent('#save-state'))
      await page.unroute('**/api/meetings/*/note')
      page.problems = page.problems.filter((p) => !p.includes('ERR_FAILED'))
      await page.evaluate(() => window.addEventListener('pagehide', (e) => e.stopImmediatePropagation(), { capture: true, once: true }))
      await page.route('**/api/meetings/*/note', (r) => r.abort()) // 刷新时的保存也发不出去，等于页面被杀
      await page.reload()
      await page.waitForSelector('.note-card')
      await page.unroute('**/api/meetings/*/note')
      check('375 重开后恢复没保存的草稿', (await page.inputValue('#note')) === '断网时写的', await page.textContent('#toast'))
      // 恢复时那次保存还撞在上面的断网里，网好了失焦再存一次
      await page.locator('#note').focus()
      await page.locator('#note').blur()
      await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存')
      await hideToast(page)
      page.problems = page.problems.filter((p) => !p.includes('ERR_FAILED'))
    }

    // 删除
    await page.click('#delete-btn')
    await page.waitForSelector('#confirm[open]')
    await page.click('#confirm-yes')
    await page.waitForURL(`${appUrl}/`)
    await page.waitForSelector('.tabs')
    check(`${label} 删除后回列表`, await page.locator(`.meeting:has-text("Q4 周会（${tag}）")`).count() === 0)

    check(`${label} 控制台无报错`, page.problems.length === 0, page.problems.join(' | ').slice(0, 300))
    await ctx.close()
  }

  // 30 秒定时保存：用假时钟走时间
  {
    const id = await seed(11, '定时保存', 10, 70)
    platform.state.loginAs = 11
    const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } })
    const page = await ctx.newPage()
    await page.clock.install()
    await page.goto(`${appUrl}/meetings/${id}`)
    await page.waitForSelector('.note-card')
    await page.locator('#note').focus()
    await page.keyboard.type('定时')
    await page.clock.fastForward(29_000)
    await page.waitForTimeout(100)
    const before = await pool.execute('SELECT content FROM meeting_note WHERE meeting_id = ?', [id])
    check('未到 30 秒不保存', before[0].length === 0)
    await page.clock.fastForward(2_000)
    await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存')
    const [after] = await pool.execute('SELECT content FROM meeting_note WHERE meeting_id = ?', [id])
    check('30 秒自动保存', after[0]?.content === '定时')
    // 切走：手机切到别的应用时 visibilitychange 比定时器先到
    await page.keyboard.type('切走')
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存')
    const [left] = await pool.execute('SELECT content FROM meeting_note WHERE meeting_id = ?', [id])
    check('切走时立刻保存', left[0]?.content === '定时切走')
    await ctx.close()
  }

  // 复制退回老办法：内置浏览器没有 clipboard 接口
  {
    const id = await seed(11, '复制兜底', 10, 70)
    await pool.execute("INSERT INTO meeting_item (meeting_id, kind, text, owner_name, due_date, source) VALUES (?, 'todo', '整理客户名单', '郑国栋', '2026-11-02', 'ai')", [id])
    const { ctx, page } = await loginContext(browser, 11, { width: 375, height: 667 }, { permissions: ['clipboard-read', 'clipboard-write'] })
    await page.goto(`${appUrl}/meetings/${id}`)
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('blocked')) })
    await itemAction(page, '.item', '#item-copy')
    await page.waitForSelector('#toast:not([hidden])')
    check('复制兜底成功', (await page.textContent('#toast')).startsWith('已复制') && (await page.evaluate(() => navigator.clipboard.readText())) === '整理客户名单 @郑国栋 11-02')
    await ctx.close()
  }

  // 参与人视角
  {
    const id = await seed(11, '评审会', -30, 30, [12], '参与人能看到的原文')
    await pool.execute("INSERT INTO meeting_item (meeting_id, kind, text, source) VALUES (?, 'decision', '方案通过', 'ai')", [id])
    await pool.execute("INSERT INTO meeting_item (meeting_id, kind, text, owner_name, source) VALUES (?, 'todo', '排期', '李雷', 'ai')", [id])
    const { ctx, page } = await loginContext(browser, 12, { width: 375, height: 667 })
    await page.goto(`${appUrl}/meetings/${id}`)
    await page.waitForSelector('.block')
    check('参与人看得到纪要', (await page.textContent('#note-text')) === '参与人能看到的原文')
    check('参与人没有编辑入口', await page.locator('#note, #note-edit, #edit-btn, #delete-btn, #extract-btn, [data-del], [data-more], .add').count() === 0)
    check('参与人能复制待办', await page.locator('[data-copy]').count() === 1)
    await page.screenshot({ path: `${OUT}/375-attendee.png`, fullPage: true })
    await audit(page, '375 参与人详情')
    await ctx.close()

    const c = await loginContext(browser, 13, { width: 375, height: 667 })
    const res = await c.page.goto(`${appUrl}/meetings/${id}`)
    check('非参与人直改 id 是 404', res.status() === 404)
    check('404 页有说明和返回', (await c.page.textContent('.yh-empty')).includes('不存在') && await c.page.locator('.back').count() === 1)
    await audit(c.page, '375 404 页')
    await c.page.screenshot({ path: `${OUT}/375-404.png` })
    await c.ctx.close()

    const b = await loginContext(browser, 11, { width: 375, height: 667 })
    const res2 = await b.page.goto(`${appUrl}/meetings/${secret}`)
    check('创建者也进不了别人的会', res2.status() === 404)
    await b.ctx.close()
  }

  // iOS 内核走一遍窄屏
  try {
    const wk = await webkit.launch()
    const { ctx, page } = await loginContext(wk, 11, { width: 375, height: 667 })
    await audit(page, 'WebKit 375 列表')
    await page.click('#new-btn')
    await page.waitForSelector('#sheet[open]')
    await audit(page, 'WebKit 375 新建弹层')
    await page.waitForFunction(() => !document.getAnimations().length)
    const b = await page.locator('#sheet-save').boundingBox()
    check('WebKit 375 保存按钮在可见区', b.y + b.height <= 667, `bottom=${Math.round(b.y + b.height)}`)
    const f = await page.locator('#f-start').boundingBox()
    check('WebKit 375 时间框没撑破', f.x + f.width <= 375, `right=${Math.round(f.x + f.width)}`)
    await page.screenshot({ path: `${OUT}/375-webkit-new.png` })
    await page.fill('#f-title', 'WebKit 会议')
    await page.fill('#f-start', local(5))
    await page.click('#sheet-save')
    await page.waitForURL(/meetings\/\d+$/)
    await page.waitForSelector('.note-card')
    await page.fill('#note', NOTES)
    await page.click('#extract-btn')
    await page.waitForSelector('.item')
    await audit(page, 'WebKit 375 AI 结果')
    await fullShot(page, `${OUT}/375-webkit-result.png`)
    await ctx.close()
    await wk.close()
  } catch (e) {
    check('WebKit 走查', false, e.message.slice(0, 200))
  }
} catch (e) {
  check('流程走完', false, e.stack?.slice(0, 600))
} finally {
  await browser.close()
  await pool.end()
  server.kill()
  await platform.close()
  db.stop()
}

report.under44 = [...new Set(report.under44)]
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(`\n<44px 的可点元素（${report.under44.length} 个）：`)
for (const line of report.under44) console.log(`  ${line}`)
console.log(`\n检查 ${report.checks.length} 项，失败 ${report.checks.filter((c) => !c.pass).length} 项`)
process.exit(report.ok && !report.under44.length ? 0 : 1)
