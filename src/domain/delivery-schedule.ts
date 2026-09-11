import type { OpenDay } from '../features/settings/settings-store'

const MANILA_TIME_ZONE = 'Asia/Manila'
const DAY_NAMES: readonly OpenDay[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export type DeliveryScheduleSettings = {
  openDays: readonly OpenDay[]
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

/**
 * Computes the next date customers may select using Manila wall-clock time.
 * A missing date is intentionally resolved here rather than by the parser or
 * browser, so the public quote and later acceptance share the same rule.
 */
export function getNextAvailableDeliveryDate(now: Date, settings: DeliveryScheduleSettings, searchDays = 370): DeliveryDateResult | null {
  const current = manilaParts(now)
  const [cutoffHour, cutoffMinute] = settings.orderCutoff.split(':').map(Number)
  const candidateOffset = current.hour * 60 + current.minute < cutoffHour * 60 + cutoffMinute ? 1 : 2
  for (let offset = candidateOffset; offset <= searchDays; offset += 1) {
    const candidate = addDays(current.year, current.month, current.day, offset)
    if (!settings.openDays.includes(weekday(candidate.year, candidate.month, candidate.day))) continue
    return {
      deliveryDate: isoDate(candidate.year, candidate.month, candidate.day),
      deliveryWindowStart: settings.deliveryWindowStart,
      deliveryWindowEnd: settings.deliveryWindowEnd,
    }
  }
  return null
}

export function isAvailableDeliveryDate(date: string, now: Date, settings: DeliveryScheduleSettings): boolean {
  const next = getNextAvailableDeliveryDate(now, settings)
  return next?.deliveryDate === date
}

export function formatDeliveryDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf())) return date
  return new Intl.DateTimeFormat('en-PH', { timeZone: MANILA_TIME_ZONE, dateStyle: 'full' }).format(parsed)
}
