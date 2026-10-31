// 公用交互：请求、提示、确认、新建 / 编辑弹层、选人、列表。详情页的纪要在 detail.js。地址全用相对路径，配合 <base> 挂在 /apps/meeting/ 下
const $ = (id) => document.getElementById(id)
const sheet = $('sheet')
const picker = $('picker')
let editingId = null // 正在编辑的会议；null 表示新建
let chosen = new Map() // 选中的参与人 id → 姓名
let toastTimer

async function api(method, url, body, extra = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...extra
  }).catch(() => { throw new Error('网络不太好，稍后再试') })
  // 登录过期：刷新页面，由服务端重新走授权
  if (r.status === 401) { location.reload(); throw new Error('登录已过期') }
  const isJson = (r.headers.get('content-type') || '').includes('json')
  if (!r.ok) throw new Error((isJson && (await r.json()).error) || '网络不太好，稍后再试')
  if (r.status === 204) return null
  return isJson ? r.json() : r.text()
}

function toast(text) {
  const el = $('toast')
  // 模态 dialog 在顶层，提示放在外面会被盖住，要挪进最上面那层
  const dialogs = document.querySelectorAll('dialog[open]')
  ;(dialogs[dialogs.length - 1] || document.body).append(el)
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 2500)
}

/** 二次确认。原生 confirm 在钉钉、微信内置浏览器里不一定弹，用自己的弹层 */
function ask({ title, text, yes, danger = false }) {
  const d = $('confirm')
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-yes').textContent = yes
  $('confirm-yes').classList.toggle('danger', danger)
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true })
    d.returnValue = ''
    d.showModal()
  })
}
$('confirm-no').addEventListener('click', () => $('confirm').close('no'))
$('confirm-yes').addEventListener('click', () => $('confirm').close('yes'))

// ---------- 列表 ----------
const listEl = $('list')
const searchEl = $('search')
let view = document.querySelector('.tab.on')?.dataset.view || 'recent'

let listSeq = 0
async function loadList() {
  const seq = ++listSeq
  const q = searchEl.value.trim()
  const query = `view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`
  const html = await api('GET', `api/list.html?${query}`)
  if (seq !== listSeq) return // 连续输入时，只认最后一次
  listEl.innerHTML = html
  history.replaceState(null, '', `?${query}`)
}

document.querySelector('.tabs')?.addEventListener('click', (e) => {
  const a = e.target.closest('.tab')
  if (!a) return
  e.preventDefault()
  view = a.dataset.view
  searchEl.value = ''
  for (const t of document.querySelectorAll('.tab')) {
    const on = t === a
    t.classList.toggle('on', on)
    if (on) t.setAttribute('aria-current', 'page')
    else t.removeAttribute('aria-current')
  }
  loadList().catch((err) => toast(err.message))
})

let searchTimer
const searchSoon = () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadList().catch((err) => toast(err.message)), 250)
}
// 拼音输入过程中不搜，选完字才搜
searchEl?.addEventListener('input', (e) => { if (!e.isComposing) searchSoon() })
searchEl?.addEventListener('compositionend', searchSoon)

// ---------- 新建 / 编辑弹层 ----------
/** 默认开始时间：下一个整点或半点，按会议时区算，和手机时区无关 */
function nextSlot() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: document.body.dataset.tz, dateStyle: 'short', timeStyle: 'short' })
  const step = 30 * 60_000
  return fmt.format(new Date(Math.ceil(Date.now() / step) * step)).replace(' ', 'T')
}

function showPeople() {
  $('f-people-name').textContent = chosen.size ? [...chosen.values()].join('、') : '只有我'
}

function openForm(m) {
  editingId = m?.id ?? null
  $('sheet-title').textContent = m ? '编辑会议' : '新建会议'
  $('f-title').value = m?.title ?? ''
  $('f-start').value = m?.starts_at ?? nextSlot()
  $('f-end').value = m?.ends_at ?? ''
  $('f-location').value = m?.location ?? ''
  $('f-agenda').value = m?.agenda ?? ''
  chosen = new Map((m?.attendees ?? []).map((a) => [a.id, a.name]))
  showPeople()
  sheet.showModal()
}

$('new-btn')?.addEventListener('click', () => openForm(null))

$('meeting-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('sheet-save')
  btn.disabled = true
  const fields = {
    title: $('f-title').value,
    starts_at: $('f-start').value,
    ends_at: $('f-end').value || null,
    location: $('f-location').value,
    agenda: $('f-agenda').value,
    attendee_ids: [...chosen.keys()]
  }
  try {
    if (editingId) {
      await api('PATCH', `api/meetings/${editingId}`, fields)
      await window.flushNote?.()
      location.reload()
    } else {
      const created = await api('POST', 'api/meetings', fields)
      location.href = `meetings/${created.id}`
    }
  } catch (err) {
    toast(err.message)
    btn.disabled = false
  }
})

for (const d of [sheet, picker]) {
  if (!d) continue
  d.querySelector('[data-close]').addEventListener('click', () => d.close())
  // 点遮罩关闭（桌面）
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })
}

// ---------- 选人：可多选，搜索时已选的人不丢 ----------
async function loadPeople(q) {
  const msg = $('picker-msg')
  const ul = $('picker-list')
  try {
    const { list, total } = await api('GET', `api/users?q=${encodeURIComponent(q)}`)
    ul.replaceChildren(...list.map((u) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.id = u.id
      b.dataset.name = u.name
      b.setAttribute('aria-pressed', String(chosen.has(u.id)))
      const name = document.createElement('span')
      name.className = 'who'
      name.textContent = u.name
      const dept = document.createElement('span')
      dept.className = 'dept'
      dept.textContent = u.dept || ''
      b.append(name, dept)
      li.append(b)
      return li
    }))
    msg.hidden = list.length > 0 && total <= list.length
    msg.textContent = list.length ? `共 ${total} 人，搜一下更快` : '没有找到这个人'
  } catch (e) {
    ul.replaceChildren()
    msg.textContent = e.message
    msg.hidden = false
  }
}

$('f-people')?.addEventListener('click', () => {
  $('picker-q').value = ''
  $('picker-list').replaceChildren()
  $('picker-msg').hidden = true
  picker.showModal()
  loadPeople('')
})

let pickerTimer
$('picker-q')?.addEventListener('input', (e) => {
  clearTimeout(pickerTimer)
  pickerTimer = setTimeout(() => loadPeople(e.target.value), 200)
})

$('picker-list')?.addEventListener('click', (e) => {
  const b = e.target.closest('button')
  if (!b) return
  const id = Number(b.dataset.id)
  if (chosen.has(id)) chosen.delete(id)
  else chosen.set(id, b.dataset.name)
  b.setAttribute('aria-pressed', String(chosen.has(id)))
})

$('picker-done')?.addEventListener('click', () => {
  showPeople()
  picker.close()
})

// 键盘弹起时可视区变矮，弹层跟着留在键盘上方
if (window.visualViewport) {
  const vv = window.visualViewport
  const sync = () => document.documentElement.style.setProperty('--vvh', `${vv.height}px`)
  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
}
