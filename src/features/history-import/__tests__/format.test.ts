import { describe, expect, it } from 'vitest'
import type { StoredOrder } from '../../../data/types'
import { priceOrder } from '../../../domain/pricing'
import { validateDraft } from '../../import/parser'
import { historyRowProblems, isImportableRow, MAX_HISTORY_LINES, parseHistoryImport } from '../format'

// 12:00 noon on 2026-09-26 in Manila.
const NOW = new Date('2026-09-26T04:00:00.000Z')
const context = { now: NOW, customers: [], orders: [] as StoredOrder[] }

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    source_ref: 'viber-001',
    customer_name: 'Mika',
    delivery_date: '2026-03-01',
    items: [{ product_slug: 'matcha-latte', quantity: 1, level: 3, powder: 'yumeno' }],
    address: 'Makati',
    ...fields,
  })
}

describe('parseHistoryImport', () => {
  it('turns each JSON line into a prefixed, importable draft priced only from the catalog', () => {
    const smuggled = line({ total_centavos: 1, items: [{ product_slug: 'matcha-latte', quantity: 1, level: 3, powder: 'yumeno', price: 1, unit_price_centavos: 1 }] })
    const { rows, errors } = parseHistoryImport(smuggled, context)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.sourceRef).toBe('viber-001')
    expect(row.draft.rawSource).toBe('history-import:viber-001')
    expect(row.draft.deliveryDate).toBe('2026-03-01')
    expect(isImportableRow(row, NOW)).toBe(true)
    const catalogTotal = priceOrder({ items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 3, powder: 'yumeno' } }], thermalBags: [] }).totals.totalCentavos
    expect(validateDraft(row.draft).totalCentavos).toBe(catalogTotal)
    expect(catalogTotal).not.toBe(1)
  })

  it('keeps real line numbers across blank lines and reports unreadable lines instead of dropping them', () => {
    const text = [line({ source_ref: 'a' }), '', 'not json', '[1,2]', line({ source_ref: 'b' })].join('\n')
    const { rows, errors } = parseHistoryImport(text, context)
    expect(rows.map((row) => row.line)).toEqual([1, 5])
    expect(errors).toEqual([
      { line: 3, message: 'This line is not valid JSON' },
      { line: 4, message: 'Each line must be one JSON object' },
    ])
  })

  it('requires source_ref, customer_name, delivery_date and items', () => {
    const text = [
      line({ source_ref: undefined }),
      line({ source_ref: '   ' }),
      line({ source_ref: 'no-name', customer_name: undefined }),
      line({ source_ref: 'no-date', delivery_date: undefined }),
      line({ source_ref: 'no-items', items: [] }),
      line({ source_ref: 'bad-item', items: ['matcha', { product_slug: 'matcha-latte', quantity: 1 }] }),
    ].join('\n')
    const { rows } = parseHistoryImport(text, context)
    const problems = rows.map((row) => historyRowProblems(row, NOW))
    expect(problems[0].join(' ')).toMatch(/source_ref is required/)
    expect(problems[1].join(' ')).toMatch(/source_ref is required/)
    expect(problems[2]).toContain('Customer name is required')
    expect(problems[3]).toContain('Delivery date is required')
    expect(problems[4]).toContain('At least one order item is required')
    expect(problems[5]).toContain('Every item must be a JSON object')
    expect(rows.every((row) => !isImportableRow(row, NOW))).toBe(true)
  })

  it('accepts today in Manila but rejects future and impossible dates', () => {
    const text = [
      line({ source_ref: 'today', delivery_date: '2026-09-26' }),
      line({ source_ref: 'tomorrow', delivery_date: '2026-09-27' }),
      line({ source_ref: 'impossible', delivery_date: '2026-02-30' }),
      line({ source_ref: 'loose', delivery_date: '3/1/2026' }),
    ].join('\n')
    const { rows } = parseHistoryImport(text, context)
    expect(isImportableRow(rows[0], NOW)).toBe(true)
    expect(historyRowProblems(rows[1], NOW).join(' ')).toMatch(/in the future/)
    expect(historyRowProblems(rows[2], NOW).join(' ')).toMatch(/real date written YYYY-MM-DD/)
    expect(historyRowProblems(rows[3], NOW).join(' ')).toMatch(/real date written YYYY-MM-DD/)
  })

  it('uses the Manila date, not UTC, to decide what counts as today', () => {
    // 2026-09-26T17:00Z is already 01:00 on 2026-09-27 in Manila.
    const lateUtc = new Date('2026-09-26T17:00:00.000Z')
    const { rows } = parseHistoryImport(line({ delivery_date: '2026-09-27' }), { ...context, now: lateUtc })
    expect(isImportableRow(rows[0], lateUtc)).toBe(true)
  })

  it('reports a repeated source_ref as a duplicate instead of dropping it', () => {
    const text = [line({ source_ref: 'same' }), line({ source_ref: 'same', customer_name: 'Aira' })].join('\n')
    const { rows } = parseHistoryImport(text, context)
    expect(rows).toHaveLength(2)
    expect(rows[0].duplicateOfLine).toBeNull()
    expect(rows[1].duplicateOfLine).toBe(1)
    expect(isImportableRow(rows[0], NOW)).toBe(true)
    expect(isImportableRow(rows[1], NOW)).toBe(false)
  })

  it('flags identical orders under different refs for review without blocking them', () => {
    const text = [line({ source_ref: 'one' }), line({ source_ref: 'two' })].join('\n')
    const { rows } = parseHistoryImport(text, context)
    expect(rows[1].looksLikeLine).toBe(1)
    expect(isImportableRow(rows[1], NOW)).toBe(true)
  })

  it('marks rows whose raw source is already saved as already imported', () => {
    const saved = { rawSource: 'history-import:viber-001' } as StoredOrder
    const { rows } = parseHistoryImport(line({}), { ...context, orders: [saved] })
    expect(rows[0].alreadyImported).toBe(true)
    expect(isImportableRow(rows[0], NOW)).toBe(false)
  })

  it('caps one file at the line limit and says so', () => {
    const text = Array.from({ length: MAX_HISTORY_LINES + 2 }, (_, index) => line({ source_ref: `ref-${index}` })).join('\n')
    const { rows, errors } = parseHistoryImport(text, context)
    expect(rows).toHaveLength(MAX_HISTORY_LINES)
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/Split the file/)
  })
})
