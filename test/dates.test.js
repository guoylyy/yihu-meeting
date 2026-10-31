import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MINUTES, addDays, localToUtc, meetingStatus, rangeLabel, shortDate, toLocal, todayIn, whenLabel } from '../src/dates.js'

const at = (s) => new Date(s)

test('当地时间转 UTC：上海比 UTC 早 8 小时', () => {
  assert.equal(localToUtc('2026-10-30T15:00', 'Asia/Shanghai').toISOString(), '2026-10-30T07:00:00.000Z')
})

test('转换可逆：toLocal 取回原值', () => {
  for (const s of ['2026-01-01T00:00', '2026-12-31T23:59', '2028-02-29T12:30']) assert.equal(toLocal(localToUtc(s)), s)
})

test('跨 UTC 日界的当地时间不挪天', () => {
  assert.equal(localToUtc('2026-11-02T06:00', 'Asia/Shanghai').toISOString(), '2026-11-01T22:00:00.000Z')
})

test('夏令时时区：按当天的偏移算', () => {
  assert.equal(localToUtc('2026-07-01T09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z')
  assert.equal(localToUtc('2026-12-01T09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z')
})

test('不存在的时间返回 null', () => {
  for (const s of ['2026-02-30T10:00', '2026-13-01T10:00', '2026-10-30T25:00', '2026-10-30', '', null, 123]) assert.equal(localToUtc(s), null)
  assert.equal(localToUtc('2026-03-08T02:30', 'America/New_York'), null) // 这一刻被夏令时跳过
})

test('状态：开始前是未开始', () => {
  assert.equal(meetingStatus(at('2026-10-30T07:00:00Z'), at('2026-10-30T08:00:00Z'), at('2026-10-30T06:59:59Z')), 'upcoming')
})

test('状态：开始那一刻算进行中，结束那一刻算已结束', () => {
  const s = at('2026-10-30T07:00:00Z')
  const e = at('2026-10-30T08:00:00Z')
  assert.equal(meetingStatus(s, e, s), 'ongoing')
  assert.equal(meetingStatus(s, e, at('2026-10-30T07:59:59Z')), 'ongoing')
  assert.equal(meetingStatus(s, e, e), 'ended')
})

test('状态：跨天的会过了午夜仍在进行中', () => {
  const s = localToUtc('2026-10-30T23:00')
  const e = localToUtc('2026-10-31T02:00')
  assert.equal(meetingStatus(s, e, localToUtc('2026-10-30T22:59')), 'upcoming')
  assert.equal(meetingStatus(s, e, localToUtc('2026-10-31T00:30')), 'ongoing')
  assert.equal(meetingStatus(s, e, localToUtc('2026-10-31T02:00')), 'ended')
})

test('状态：没写结束时间按默认时长算', () => {
  const s = at('2026-10-30T07:00:00Z')
  assert.equal(meetingStatus(s, null, new Date(s.getTime() + (DEFAULT_MINUTES - 1) * 60_000)), 'ongoing')
  assert.equal(meetingStatus(s, null, new Date(s.getTime() + DEFAULT_MINUTES * 60_000)), 'ended')
})

test('相对时间：今天、明天、昨天带时刻', () => {
  const today = '2026-10-30'
  assert.equal(whenLabel(localToUtc('2026-10-30T15:00'), today), '今天 15:00')
  assert.equal(whenLabel(localToUtc('2026-10-31T09:05'), today), '明天 09:05')
  assert.equal(whenLabel(localToUtc('2026-10-29T18:00'), today), '昨天 18:00')
})

test('相对时间：更远的写日期，跨年带年份', () => {
  const today = '2026-10-30'
  assert.equal(whenLabel(localToUtc('2026-11-02T10:00'), today), '11月2日 10:00')
  assert.equal(whenLabel(localToUtc('2027-01-05T10:00'), today), '2027年1月5日 10:00')
  assert.equal(shortDate('2026-03-01', today), '3月1日')
})

test('相对时间：UTC 已跨天而当地没跨，按当地算', () => {
  const now = at('2026-10-30T15:30:00Z') // 上海 23:30
  assert.equal(todayIn('Asia/Shanghai', now), '2026-10-30')
  assert.equal(todayIn('Asia/Shanghai', at('2026-10-30T16:30:00Z')), '2026-10-31')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('详情时间：同一天省略结束日期', () => {
  assert.equal(rangeLabel(localToUtc('2026-10-30T15:00'), localToUtc('2026-10-30T16:00'), '2026-10-30'), '10月30日 周五 15:00–16:00')
})

test('详情时间：跨天两头都写日期，没有结束时间只写开始', () => {
  assert.equal(rangeLabel(localToUtc('2026-10-30T23:00'), localToUtc('2026-10-31T01:00'), '2026-10-30'), '10月30日 周五 23:00 – 10月31日 周六 01:00')
  assert.equal(rangeLabel(localToUtc('2026-10-30T23:00'), null, '2026-10-30'), '10月30日 周五 23:00')
})
