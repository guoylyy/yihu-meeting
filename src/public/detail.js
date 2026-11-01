// 详情页：纪要阅读 / 编辑、自动保存、AI 提炼、四块的增删和复制。参与人没有输入框，这里大部分逻辑不会跑
const meetingId = document.body.dataset.id
const noteEl = $('note')
const noteView = $('note-text')
const noteEditBtn = $('note-edit')
const blocksEl = $('blocks')
const stateEl = $('save-state')
const aiMsg = $('ai-msg')
const AUTOSAVE_MS = 30_000
const KEEPALIVE_BYTES = 60_000 // keepalive 请求体上限是 64KB，再大只能走普通请求

// ---------- 纪要草稿 ----------
// 输入时先写本地，再每 30 秒、失焦、切走时存到服务器。手机切走后页面可能直接被杀，本地这份能兜住
const draftKey = `meeting-draft-${meetingId}`
let dirty = false
let saving = null
let savedAt = noteEl?.dataset.savedAt ?? ''

const setState = (text) => { if (stateEl) stateEl.textContent = text }
const remember = () => {
  try { localStorage.setItem(draftKey, JSON.stringify({ base: savedAt, text: noteEl.value })) } catch { /* 隐私模式写不进去 */ }
}
const forget = () => {
  try { localStorage.removeItem(draftKey) } catch { /* 同上 */ }
}

async function saveNote(extra = {}) {
  while (saving) await saving
  if (!dirty) return
  const content = noteEl.value
  dirty = false
  setState('保存中…')
  saving = api('PUT', `api/meetings/${meetingId}/note`, { content }, extra)
    .then((r) => {
      savedAt = r.saved_at
      if (dirty) return remember()
      forget()
      setState('已保存')
    })
    .catch((e) => {
      dirty = true
      setState(`未保存：${e.message}`)
    })
    .finally(() => { saving = null })
  return saving
}
window.flushNote = saveNote

function saveOnLeave() {
  if (!dirty) return
  const size = new Blob([noteEl.value]).size
  saveNote({ keepalive: size < KEEPALIVE_BYTES })
}

/** 默认读全文，点「编辑」才出输入框。还没内容时没什么可读，直接是输入框 */
function setEditing(on) {
  const editing = on || !noteEl.value.trim()
  if (!editing) noteView.textContent = noteEl.value
  noteView.hidden = editing
  noteEl.hidden = !editing
  noteEditBtn.textContent = editing ? '完成' : '编辑'
}

if (noteEl) {
  setEditing(false)
  noteEditBtn.addEventListener('click', () => {
    const open = noteEl.hidden
    setEditing(open)
    if (open) noteEl.focus()
    else saveNote()
  })

  let draft = null
  try { draft = JSON.parse(localStorage.getItem(draftKey)) } catch { /* 坏数据当没有 */ }
  // 只认基于当前服务器版本写的草稿；服务器已经更新过，说明这份过期了
  if (draft && draft.base === savedAt && draft.text !== noteEl.value) {
    noteEl.value = draft.text
    setEditing(true)
    dirty = true
    toast('已恢复上次没保存的内容')
    saveNote()
  } else forget()

  noteEl.addEventListener('input', () => {
    dirty = true
    setState('有改动')
    remember()
  })
  noteEl.addEventListener('blur', () => saveNote())
  setInterval(() => saveNote(), AUTOSAVE_MS)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveOnLeave() })
  window.addEventListener('pagehide', saveOnLeave)
}

// ---------- AI 提炼 ----------
function showAiMsg(text, quiet = false) {
  aiMsg.textContent = text
  aiMsg.hidden = !text
  aiMsg.classList.toggle('quiet', quiet)
}

async function reloadBlocks() {
  blocksEl.innerHTML = await api('GET', `api/meetings/${meetingId}/blocks.html`)
}

async function reloadFacts() {
  $('facts').innerHTML = await api('GET', `api/meetings/${meetingId}/facts.html`)
}

$('extract-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget
  const content = noteEl.value
  if (!content.trim()) {
    toast('先写点纪要再提炼')
    return noteEl.focus()
  }
  if (blocksEl.querySelector('.item')) {
    const go = await ask({ title: '重新提炼？', text: '下面四块会被替换，手动补的也会被替换。', yes: '重新提炼' })
    if (!go) return
  }
  btn.disabled = true
  btn.textContent = '提炼中…'
  showAiMsg('')
  while (saving) await saving
  dirty = false
  try {
    const r = await api('POST', `api/meetings/${meetingId}/extract`, { content })
    savedAt = r.saved_at
    if (noteEl.value !== content) dirty = true
    else { forget(); setState('已保存') }
    showAiMsg(r.message, r.ok)
    if (r.ok) {
      await reloadBlocks()
      if (r.count) toast(`提炼出 ${r.count} 条`)
    }
    await reloadFacts()
  } catch (err) {
    dirty = true
    showAiMsg(err.message)
  } finally {
    btn.disabled = false
    btn.textContent = '用 AI 提炼'
  }
})

// ---------- 四块：单条删除、手动补一条、复制待办 ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 内置浏览器和 http 下没有 clipboard 接口，退回老办法
    const t = document.createElement('textarea')
    t.value = text
    t.setAttribute('readonly', '')
    t.className = 'copy-buffer'
    document.body.append(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

async function copyLine(line) {
  toast((await copyText(line)) ? '已复制，粘到收件箱即可' : '复制失败，长按文字手动复制')
}

async function deleteItem(id) {
  try {
    await api('DELETE', `api/meetings/${meetingId}/items/${id}`)
    await reloadBlocks()
  } catch (err) { toast(err.message) }
}

// 展开状态只在 DOM 上：重新渲染四块、刷新页面都回到收起
function toggleAdd(block, open) {
  const form = block.querySelector('.add')
  const btn = block.querySelector('[data-toggle]')
  form.hidden = !open
  btn.textContent = open ? '收起' : '添加'
  btn.setAttribute('aria-expanded', String(open))
  ;(open ? form.elements.text : btn).focus()
}

blocksEl.addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle]')
  if (toggle) {
    const block = toggle.closest('.block')
    return toggleAdd(block, block.querySelector('.add').hidden)
  }
  const assign = e.target.closest('[data-assign]')
  if (assign) return openAssign(assign)
  const more = e.target.closest('[data-more]')
  if (more) return openItemMenu(more)
  const copy = e.target.closest('[data-copy]')
  if (copy) return copyLine(copy.dataset.copy)
  if (e.target.closest('[data-del]')) deleteItem(e.target.closest('.item').dataset.id)
})

blocksEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.isComposing) return // 拼音输入时 Esc 是取消选字
  const block = e.target.closest('.block')
  if (block?.querySelector('.add:not([hidden])')) toggleAdd(block, false)
})

blocksEl.addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target
  const data = Object.fromEntries(new FormData(form))
  if (!data.text.trim()) return form.elements.text.focus()
  const { kind } = form.closest('.block').dataset
  try {
    await api('POST', `api/meetings/${meetingId}/items`, { ...data, kind })
    await reloadBlocks()
    showAiMsg('')
    blocksEl.querySelector(`[data-kind="${kind}"] [data-toggle]`).focus()
  } catch (err) { toast(err.message) }
})

// ---------- 待办的 ⋯ 菜单 ----------
const itemMenu = $('item-menu')
let menuTarget = null

function openItemMenu(btn) {
  menuTarget = { id: btn.closest('.item').dataset.id, line: btn.dataset.line }
  $('item-menu-text').textContent = btn.dataset.text
  itemMenu.showModal()
}

itemMenu?.querySelector('[data-close]').addEventListener('click', () => itemMenu.close())
itemMenu?.addEventListener('click', (e) => { if (e.target === itemMenu) itemMenu.close() })
// 先关菜单：模态弹层开着时外面的元素是惰性的，复制的兜底办法选不中文字
$('item-copy')?.addEventListener('click', () => {
  itemMenu.close()
  copyLine(menuTarget.line)
})
$('item-del')?.addEventListener('click', () => {
  itemMenu.close()
  deleteItem(menuTarget.id)
})

// ---------- 指派待办 ----------
const assignSheet = $('assign')
let assigningId = null

function openAssign(btn) {
  assigningId = btn.closest('.item').dataset.id
  $('assign-text').textContent = btn.dataset.text
  $('assign-owner').value = btn.dataset.owner
  $('assign-due').value = btn.dataset.due
  assignSheet.showModal()
  $('assign-owner').focus()
}

assignSheet?.querySelector('[data-close]').addEventListener('click', () => assignSheet.close())
assignSheet?.addEventListener('click', (e) => { if (e.target === assignSheet) assignSheet.close() })

$('assign-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('assign-save')
  btn.disabled = true
  try {
    await api('PATCH', `api/meetings/${meetingId}/items/${assigningId}`, { owner: $('assign-owner').value, due: $('assign-due').value || null })
    assignSheet.close()
    await reloadBlocks()
    toast('已指派')
  } catch (err) { toast(err.message) }
  btn.disabled = false
})

// ---------- 编辑、删除 ----------
$('edit-btn')?.addEventListener('click', async () => {
  try {
    openForm(await api('GET', `api/meetings/${meetingId}`))
  } catch (err) { toast(err.message) }
})

$('delete-btn')?.addEventListener('click', async () => {
  const go = await ask({ title: '删除这场会议？', text: '纪要一并删除，删除后不能恢复。', yes: '删除', danger: true })
  if (!go) return
  try {
    await api('DELETE', `api/meetings/${meetingId}`)
    dirty = false
    forget()
    location.href = './'
  } catch (err) { toast(err.message) }
})
