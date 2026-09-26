import { describe, expect, it } from 'vitest'
import { formatLifecycleTimestamp, lifecycleTimestampLines } from './order-timestamps'

describe('formatLifecycleTimestamp', () => {
  it('returns null for a null input', () => {
    expect(formatLifecycleTimestamp(null)).toBeNull()
  })

  it('formats a fixed ISO instant in en-PH / Asia/Manila', () => {
    // 2026-07-16T08:00:00.000Z → 16:00 in Manila
    expect(formatLifecycleTimestamp('2026-07-16T08:00:00.000Z')).toBe('Jul 16, 4:00 PM')
  })

  it('formats an early-morning UTC instant as late morning in Manila the same day', () => {
    // 2026-03-15T02:30:00.000Z → 10:30 AM Manila same day
    expect(formatLifecycleTimestamp('2026-03-15T02:30:00.000Z')).toBe('Mar 15, 10:30 AM')
  })

  it('crosses midnight into the next Manila day for late UTC evenings', () => {
    // 2026-12-31T16:00:00.000Z → Jan 1 12:00 AM Manila
    expect(formatLifecycleTimestamp('2026-12-31T16:00:00.000Z')).toBe('Jan 1, 12:00 AM')
  })
})

describe('lifecycleTimestampLines', () => {
  it('omits both lines when neither timestamp is set', () => {
    expect(lifecycleTimestampLines({ paidAt: null, deliveredAt: null })).toEqual([])
  })

  it('returns only a Paid line when paidAt is set', () => {
    expect(lifecycleTimestampLines({
      paidAt: '2026-07-16T08:00:00.000Z',
      deliveredAt: null,
    })).toEqual(['Paid Jul 16, 4:00 PM'])
  })

  it('returns Paid and Delivered lines when both are set', () => {
    expect(lifecycleTimestampLines({
      paidAt: '2026-07-16T08:00:00.000Z',
      deliveredAt: '2026-07-16T09:30:00.000Z',
    })).toEqual([
      'Paid Jul 16, 4:00 PM',
      'Delivered Jul 16, 5:30 PM',
    ])
  })

  it('returns a single Imported line for a history-imported order instead of its import-day timestamps', () => {
    expect(lifecycleTimestampLines({
      paidAt: '2026-09-26T08:00:00.000Z',
      deliveredAt: '2026-09-26T08:00:01.000Z',
      rawSource: 'history-import:viber-2026-03-01-mika',
    })).toEqual(['Imported'])
  })

  it('keeps Paid and Delivered lines for an order whose raw source only mentions history', () => {
    expect(lifecycleTimestampLines({
      paidAt: '2026-07-16T08:00:00.000Z',
      deliveredAt: null,
      rawSource: 'viber paste about history-import:',
    })).toEqual(['Paid Jul 16, 4:00 PM'])
  })

  it('returns only a Delivered line if paidAt is somehow absent (defensive)', () => {
    expect(lifecycleTimestampLines({
      paidAt: null,
      deliveredAt: '2026-07-16T09:30:00.000Z',
    })).toEqual(['Delivered Jul 16, 5:30 PM'])
  })
})
