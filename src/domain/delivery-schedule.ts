import type { OpenDay } from '../features/settings/settings-store'

const MANILA_TIME_ZONE = 'Asia/Manila'
const DAY_NAMES: readonly OpenDay[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export type DeliveryScheduleSettings = {
  openDays: readonly OpenDay[]
  /** Specific Manila dates (YYYY-MM-DD) the owner is closed, overriding openDays. */
  closedDates?: readonly string[]
  orderCutoff: string
  deliveryWindowStart: string
  deliveryWindowEnd: string
}

export type DeliveryDateResult = {
  deliveryDate: string
  deliveryWindowStart: string
  deliveryWindowEnd: string
}

function manilaParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') }
}

function isoDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10)
}

function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }
}

function weekday(year: number, month: number, day: number): OpenDay {
  return DAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]
}

type DateParts = { year: number; month: number; day: number }

/** Today's calendar date in Manila as YYYY-MM-DD, independent of the device or server timezone. */
export function manilaToday(now: Date): string {
  const current = manilaParts(now)
  return isoDate(current.year, current.month, current.day)
}

function isOpenCandidate(date: DateParts, settings: DeliveryScheduleSettings): boolean {
  if (!settings.openDays.includes(weekday(date.year, date.month, date.day))) return false
  return !(settings.closedDates ?? []).includes(isoDate(date.year, date.month, date.day))
}

function deliveryResult(date: DateParts, settings: DeliveryScheduleSettings): DeliveryDateResult {
  return {
    deliveryDate: isoDate(date.year, date.month, date.day),
    deliveryWindowStart: settings.deliveryWindowStart,
    deliveryWindowEnd: settings.deliveryWindowEnd,
  }
}

/** First orderable day offset: tomorrow before the cutoff, the day after at or after it. */
function firstOrderableOffset(now: Date, settings: DeliveryScheduleSettings): number {
  const current = manilaParts(now)
  const [cutoffHour, cutoffMinute] = settings.orderCutoff.split(':').map(Number)
  return current.hour * 60 + current.minute < cutoffHour * 60 + cutoffMinute ? 1 : 2
}

/**
 * Computes the next date customers may select using Manila wall-clock time.
 * A missing date is intentionally resolved here rather than by the parser or
 * browser, so the public quote and later acceptance share the same rule.
 */
export function getNextAvailableDeliveryDate(now: Date, settings: DeliveryScheduleSettings, searchDays = 370): DeliveryDateResult | null {
  const current = manilaParts(now)
  for (let offset = firstOrderableOffset(now, settings); offset <= searchDays; offset += 1) {
    const candidate = addDays(current.year, current.month, current.day, offset)
    if (isOpenCandidate(candidate, settings)) return deliveryResult(candidate, settings)
  }
  return null
}

/**
 * Every date a customer may pick: open, not closed, orderable before the
 * cutoff, and no further than `horizonDays` calendar days from today (Manila).
 */
export function getAvailableDeliveryDates(now: Date, settings: DeliveryScheduleSettings, horizonDays = 7): DeliveryDateResult[] {
  const current = manilaParts(now)
  const dates: DeliveryDateResult[] = []
  for (let offset = firstOrderableOffset(now, settings); offset <= horizonDays; offset += 1) {
    const candidate = addDays(current.year, current.month, current.day, offset)
    if (isOpenCandidate(candidate, settings)) dates.push(deliveryResult(candidate, settings))
  }
  return dates
}

export function isAvailableDeliveryDate(date: string, now: Date, settings: DeliveryScheduleSettings): boolean {
  return getAvailableDeliveryDates(now, settings).some((option) => option.deliveryDate === date)
}

/**
 * The delivery run the owner is working on: today when today is an open,
 * non-closed day, otherwise the next such day. Falls back to today.
 */
export function getRelevantDeliveryDate(now: Date, settings: DeliveryScheduleSettings, searchDays = 370): string {
  const current = manilaParts(now)
  for (let offset = 0; offset <= searchDays; offset += 1) {
    const candidate = addDays(current.year, current.month, current.day, offset)
    if (isOpenCandidate(candidate, settings)) return isoDate(candidate.year, candidate.month, candidate.day)
  }
  return isoDate(current.year, current.month, current.day)
}

/** `20:00` → `8 PM`, `08:30` → `8:30 AM`; unparseable input is returned unchanged. */
export function formatClockTime(value: string): string {
  const [hour, minute] = value.split(':').map(Number)
  if (!Number.isSafeInteger(hour) || !Number.isSafeInteger(minute)) return value
  const suffix = hour >= 12 ? 'PM' : 'AM'
  const twelveHour = hour % 12 || 12
  return minute === 0 ? `${twelveHour} ${suffix}` : `${twelveHour}:${String(minute).padStart(2, '0')} ${suffix}`
}

export function formatDeliveryDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf())) return date
  return new Intl.DateTimeFormat('en-PH', { timeZone: MANILA_TIME_ZONE, dateStyle: 'full' }).format(parsed)
}
