// 设置页：改一项存一项，没有保存按钮，下一次操作就用新值
const box = $('settings')
const daysEl = $('s-days')
const daysError = $('s-days-error')

async function saveSetting(body) {
  await api('PUT', 'api/settings', body)
  toast('已保存')
}

chosen = new Map(JSON.parse(box.dataset.defaults).map((p) => [p.id, p.name]))
showPeople()

// 选人弹层在 app.js 里，点「完成」时回调这里
window.onPeoplePicked = () => saveSetting({ default_attendee_ids: [...chosen.keys()] }).catch((e) => toast(e.message))

$('s-lang').addEventListener('change', (e) => saveSetting({ summary_lang: e.target.value }).catch((err) => toast(err.message)))

daysEl.addEventListener('change', async () => {
  daysError.hidden = true
  try {
    await saveSetting({ todo_due_days: daysEl.value === '' ? 0 : Number(daysEl.value) })
  } catch (err) {
    daysError.textContent = err.message
    daysError.hidden = false
  }
})
