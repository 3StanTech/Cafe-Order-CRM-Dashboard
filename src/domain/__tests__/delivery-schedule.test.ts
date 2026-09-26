import { describe, expect, it } from 'vitest'
import { formatClockTime, getAvailableDeliveryDates, getNextAvailableDeliveryDate, getRelevantDeliveryDate, isAvailableDeliveryDate, manilaToday } from '../delivery-schedule'

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

  it('skips owner-closed dates even on an open weekday', () => {
    const closed = { ...schedule, closedDates: ['2026-09-08'] }
    expect(getNextAvailableDeliveryDate(new Date('2026-09-07T10:00:00Z'), closed)?.deliveryDate).toBe('2026-09-09')
  })
})

describe('getAvailableDeliveryDates', () => {
  // 2026-09-07 is a Monday; open days are Tue, Wed, Fri.
  it('lists every open day within seven days, starting tomorrow before the cutoff', () => {
    expect(getAvailableDeliveryDates(new Date('2026-09-07T10:00:00Z'), schedule).map((option) => option.deliveryDate))
      .toEqual(['2026-09-08', '2026-09-09', '2026-09-11'])
  })

  it('starts the day after tomorrow at exactly the cutoff and never includes day eight', () => {
    // 20:00 Manila on Monday: Tuesday is no longer orderable. Day 7 is Monday 14th (closed), day 8 Tuesday 15th is excluded.
    expect(getAvailableDeliveryDates(new Date('2026-09-07T12:00:00Z'), schedule).map((option) => option.deliveryDate))
      .toEqual(['2026-09-09', '2026-09-11'])
    expect(getAvailableDeliveryDates(new Date('2026-09-08T10:00:00Z'), schedule).map((option) => option.deliveryDate))
      .toEqual(['2026-09-09', '2026-09-11', '2026-09-15'])
  })

  it('removes closed dates and carries the delivery window on each option', () => {
    const options = getAvailableDeliveryDates(new Date('2026-09-07T10:00:00Z'), { ...schedule, closedDates: ['2026-09-09', '2026-09-11'] })
    expect(options).toEqual([{ deliveryDate: '2026-09-08', deliveryWindowStart: '08:00', deliveryWindowEnd: '09:00' }])
  })

  it('is empty when closures cover the window, while the next date still resolves later', () => {
    const now = new Date('2026-09-07T10:00:00Z')
    const closed = { ...schedule, closedDates: ['2026-09-08', '2026-09-09', '2026-09-11'] }
    expect(getAvailableDeliveryDates(now, closed)).toEqual([])
    expect(getNextAvailableDeliveryDate(now, closed)?.deliveryDate).toBe('2026-09-15')
    expect(getAvailableDeliveryDates(now, { ...schedule, openDays: [] })).toEqual([])
  })

  it('uses the Manila calendar day around midnight', () => {
    // 16:30Z Tuesday = 00:30 Wednesday in Manila: Wednesday is today, so Friday is the first option.
    expect(getAvailableDeliveryDates(new Date('2026-09-08T16:30:00Z'), schedule)[0]?.deliveryDate).toBe('2026-09-11')
  })
})

describe('isAvailableDeliveryDate', () => {
  it('accepts any offered date and rejects closed, past, and out-of-window dates', () => {
    const now = new Date('2026-09-07T10:00:00Z')
    const closed = { ...schedule, closedDates: ['2026-09-09'] }
    expect(isAvailableDeliveryDate('2026-09-08', now, closed)).toBe(true)
    expect(isAvailableDeliveryDate('2026-09-11', now, closed)).toBe(true)
    expect(isAvailableDeliveryDate('2026-09-09', now, closed)).toBe(false)
    expect(isAvailableDeliveryDate('2026-09-10', now, closed)).toBe(false)
    expect(isAvailableDeliveryDate('2026-09-07', now, closed)).toBe(false)
    expect(isAvailableDeliveryDate('2026-09-15', now, closed)).toBe(false)
  })
})

describe('getRelevantDeliveryDate', () => {
  it('is today when today is open, otherwise the next open non-closed day', () => {
    expect(getRelevantDeliveryDate(new Date('2026-09-08T01:00:00Z'), schedule)).toBe('2026-09-08')
    expect(getRelevantDeliveryDate(new Date('2026-09-07T01:00:00Z'), schedule)).toBe('2026-09-08')
    expect(getRelevantDeliveryDate(new Date('2026-09-08T01:00:00Z'), { ...schedule, closedDates: ['2026-09-08'] })).toBe('2026-09-09')
  })

  it('honours a Saturday opening that the old hardcoded weekday set ignored', () => {
    // 2026-09-12 is a Saturday.
    expect(getRelevantDeliveryDate(new Date('2026-09-12T01:00:00Z'), { ...schedule, openDays: ['saturday'] })).toBe('2026-09-12')
  })

  it('falls back to today when no day is ever open', () => {
    expect(getRelevantDeliveryDate(new Date('2026-09-07T01:00:00Z'), { ...schedule, openDays: [] }, 10)).toBe('2026-09-07')
  })
})

describe('manilaToday and formatClockTime', () => {
  it('reads the Manila calendar date and formats owner clock settings', () => {
    expect(manilaToday(new Date('2026-09-07T16:30:00Z'))).toBe('2026-09-08')
    expect(formatClockTime('20:00')).toBe('8 PM')
    expect(formatClockTime('08:30')).toBe('8:30 AM')
    expect(formatClockTime('00:00')).toBe('12 AM')
    expect(formatClockTime('bad')).toBe('bad')
  })
})
