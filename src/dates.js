// 时间只在这里算：库里存 UTC，容器时区是 UTC，用户看到和录入的都是 MEETING_TZ 的当地时间。日期用 'YYYY-MM-DD' 字符串
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_MS = 86400_000
const MINUTE_MS = 60_000

/** 没写结束时间的会议按这么长算，状态和列表分组都用它 */
export const DEFAULT_MINUTES = 60
export const STATUS_LABEL = { upcoming: '未开始', ongoing: '进行中', ended: '已结束' }

export const tzName = () => process.env.MEETING_TZ || 'Asia/Shanghai'

const utc = (d) => { const [y, m, day] = d.split('-').map(Number); return Date.UTC(y, m - 1, day) }
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10)

export const addDays = (d, n) => fmt(utc(d) + n * DAY_MS)
export const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY_MS)
export const weekdayOf = (d) => new Date(utc(d)).getUTCDay()

function localParts(now, tz) {
  const parts = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now)) parts[p.type] = p.value
  return parts
}

export function todayIn(tz = tzName(), now = new Date()) {
  const p = localParts(now, tz)
  return `${p.year}-${p.month}-${p.day}`
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return fmt(utc(s)) === s
}

/** 当地时间串 YYYY-MM-DDTHH:mm，正好是 datetime-local 输入框的值 */
export function toLocal(d, tz = tzName()) {
  const p = localParts(d, tz)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

function offsetMs(ms, tz) {
  const p = localParts(new Date(ms), tz)
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)) - Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

/** datetime-local 的值按 tz 转成绝对时间；格式错、日期不存在（2 月 30、夏令时跳过的时刻）返回 null */
export function localToUtc(s, tz = tzName()) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return null
  const wall = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)), Number(s.slice(11, 13)), Number(s.slice(14, 16)))
  if (Number.isNaN(wall)) return null
  const d = new Date(wall - offsetMs(wall - offsetMs(wall, tz), tz))
  return toLocal(d, tz) === s ? d : null
}

/** 状态只由时间推导，不存库 */
export function meetingStatus(startsAt, endsAt, now = new Date()) {
  if (now < startsAt) return 'upcoming'
  const end = endsAt ?? new Date(startsAt.getTime() + DEFAULT_MINUTES * MINUTE_MS)
  return now < end ? 'ongoing' : 'ended'
}

export function shortDate(d, today) {
  const [y, m, day] = d.split('-').map(Number)
  return (y === Number(today.slice(0, 4)) ? '' : `${y}年`) + `${m}月${day}日`
}

/** 列表上的相对时间：今天 15:00、昨天 09:30、11月2日 10:00 */
export function whenLabel(d, today, tz = tzName()) {
  const local = toLocal(d, tz)
  const [date, time] = local.split('T')
  const word = { 0: '今天', 1: '明天', [-1]: '昨天' }[daysBetween(today, date)]
  return `${word ?? shortDate(date, today)} ${time}`
}

/** 详情页的完整时间：10月30日 周五 15:00–16:00；跨天时两头都写日期 */
export function rangeLabel(startsAt, endsAt, today, tz = tzName()) {
  const dateOf = (date) => `${shortDate(date, today)} ${WEEKDAYS[weekdayOf(date)]}`
  const [startDate, startTime] = toLocal(startsAt, tz).split('T')
  const head = `${dateOf(startDate)} ${startTime}`
  if (!endsAt) return head
  const [endDate, endTime] = toLocal(endsAt, tz).split('T')
  return endDate === startDate ? `${head}–${endTime}` : `${head} – ${dateOf(endDate)} ${endTime}`
}
