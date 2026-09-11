import { describe, expect, it } from 'vitest'
import { getNextAvailableDeliveryDate, isAvailableDeliveryDate } from '../delivery-schedule'

const schedule = {
  openDays: ['tuesday', 'wednesday', 'friday'] as const,
  orderCutoff: '20:00',
  deliveryWindowStart: '08:00',
  deliveryWindowEnd: '09:00',
}

describe('getNextAvailableDeliveryDate', () => {
  it('starts tomorrow before cutoff and the following day at or after cutoff in Manila time', () => {
    expect(getNextAvailableDeliveryDate(new Date('2026-09-07T10:00:00Z'), schedule)).toMatchObject({
      deliveryDate: '2026-09-08', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00',
    })
    expect(getNextAvailableDeliveryDate(new Date('2026-09-07T12:00:00Z'), schedule)?.deliveryDate).toBe('2026-09-09')
    expect(getNextAvailableDeliveryDate(new Date('2026-09-07T12:01:00Z'), schedule)?.deliveryDate).toBe('2026-09-09')
  })

  it('skips closed days and handles Manila midnight without using the server timezone', () => {
    expect(getNextAvailableDeliveryDate(new Date('2026-09-08T16:30:00Z'), schedule)?.deliveryDate).toBe('2026-09-11')
    expect(getNextAvailableDeliveryDate(new Date('2026-09-10T03:00:00Z'), schedule)?.deliveryDate).toBe('2026-09-11')
  })

  it('returns null when no configured delivery day exists in the search window', () => {
    expect(getNextAvailableDeliveryDate(new Date('2026-09-07T10:00:00Z'), { ...schedule, openDays: [] }, 10)).toBeNull()
  })

  it('accepts only the server-computed next available date', () => {
    const now = new Date('2026-09-07T10:00:00Z')
    expect(isAvailableDeliveryDate('2026-09-08', now, schedule)).toBe(true)
    expect(isAvailableDeliveryDate('2026-09-09', now, schedule)).toBe(false)
  })
})
