import { isDay } from './public-provider.mjs'

export const dayMs = 86_400_000
export const koreanOffset = 9 * 60 * 60_000
export const day = timestamp => new Date(timestamp).toISOString().slice(0, 10)
export const weekend = date => [0, 6].includes(new Date(date).getUTCDay())

// KRX 2026 disclosure calendar and special-session notice (2026-11-19).
const holidays = [
  '01-01', '02-16', '02-17', '02-18', '03-02', '05-01', '05-05', '05-25', '06-03',
  '07-17', '08-17', '09-24', '09-25', '10-05', '10-09', '12-25', '12-31',
].map(date => '2026-' + date)
const eveningSlot = 1275
const morningSlots = [490, 610]

export function createKrxCalendar(raw = process.env.KRX_CALENDAR_OVERRIDES) {
  const config = raw ? JSON.parse(raw) : {}
  const { years = [], closed = [], regularClose = {}, afterClose = {} } = config
  const validTimes = values => values && typeof values === 'object' && !Array.isArray(values) &&
    Object.entries(values).every(([date, time]) => isDay(date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
  if (!Array.isArray(years) || !years.every(year => Number.isInteger(year) && year >= 2026 && year <= 2100) ||
    !Array.isArray(closed) || !closed.every(isDay) || !validTimes(regularClose) || !validTimes(afterClose)) {
    throw new Error('Invalid KRX market calendar overrides')
  }
  const closedDays = new Set([...holidays, ...closed])
  const covered = new Set([2026, ...years])
  const minutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  return {
    known: date => covered.has(Number(date.slice(0, 4))),
    closed: date => weekend(date) || closedDays.has(date),
    regular: date => minutes(regularClose[date] ?? (date === '2026-11-19' ? '16:30' : '15:30')),
    after: date => minutes(afterClose[date] ?? '20:00'),
  }
}

export function krxCollectionSession(time, calendar) {
  const local = time + koreanOffset
  const today = day(local)
  const midnight = Date.parse(today) - koreanOffset
  const nowMinutes = (time - midnight) / 60_000
  const closed = calendar.closed(today)
  const known = calendar.known(today)
  const evening = Math.max(eveningSlot, calendar.regular(today) + 30)
  const slot = !closed && known && nowMinutes >= evening ? evening : undefined
  const at = minute => midnight + minute * 60_000
  const previous = () => {
    let prior = Date.parse(today) - dayMs
    while (calendar.closed(day(prior))) prior -= dayMs
    return day(prior)
  }
  const prior = slot === undefined ? previous() : today
  const catchup = !closed && known && calendar.known(prior) && slot === undefined
    ? morningSlots.findLast(minute => nowMinutes >= minute) : undefined
  return {
    today, date: prior, slot: slot ?? catchup ?? null,
    slotStart: at(slot ?? catchup ?? 0), canCollect: slot !== undefined || catchup !== undefined,
    recoveryWindow: catchup === morningSlots.at(-1), recoveryStartsAt: at(morningSlots.at(-1)),
    closed, known, beforeClose: !closed && slot === undefined,
    afterCheckAt: new Date(at(Math.max(1215, calendar.after(today) + 15))).toISOString(),
  }
}
