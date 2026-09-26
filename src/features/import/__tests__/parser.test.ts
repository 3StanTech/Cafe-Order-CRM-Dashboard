import { describe, expect, it, vi } from 'vitest'
import { parseLocalInput, validateDraft } from '../parser'
import { viberThreads } from '../../../../test/fixtures/import/builder/viber-threads'

describe('deterministic import parsing', () => {
  it('parses valid JSON without touching fetch and ignores supplied money fields', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = parseLocalInput(JSON.stringify({ customer_name: 'Mika Santos', items: [{ product_slug: 'matcha-latte', quantity: 1, level: 3, powder: 'yumeno', price: 1, total: 1 }], address: 'Makati' }))
    expect(result.kind).toBe('local')
    if (result.kind !== 'local') throw new Error('Expected local parse')
    expect(validateDraft(result.drafts[0]).totalCentavos).toBe(25000)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('parses JSON Lines locally', () => {
    const result = parseLocalInput('{"customer_name":"Mika","items":[{"product_slug":"matcha-latte","quantity":1}]}\n{"customer_name":"Aira","items":[{"product_slug":"hojicha-latte","quantity":1}]}')
    expect(result.kind).toBe('local')
    if (result.kind === 'local') expect(result.drafts).toHaveLength(2)
  })

  it('uses only explicit aliases and surfaces invalid flavored sweetness', () => {
    const result = parseLocalInput(JSON.stringify({ customer_name: 'Mika', items: [{ product_slug: 'strawberry macha', quantity: 1, sweetness: 'extra' }], address: 'QC' }))
    if (result.kind !== 'local') throw new Error('Expected local parse')
    const validation = validateDraft(result.drafts[0])
    expect(result.drafts[0].items[0].productSlug).toBe('strawberry-matcha')
    expect(validation.errors.join(' ')).toMatch(/does not allow a sweetness/i)
  })

  it('keeps free text out of the local path', () => {
    expect(parseLocalInput('Mika: 1 Matcha Latte please')).toEqual({ kind: 'free-text' })
  })

  it('turns every documented messy Viber fixture into an editable deterministically priced draft or a visible review state', () => {
    expect(viberThreads.length).toBeGreaterThanOrEqual(8)
    for (const fixture of viberThreads) {
      const result = parseLocalInput(JSON.stringify(fixture.extracted))
      if (result.kind !== 'local') throw new Error(`Fixture ${fixture.name} was not parsed locally`)
      const draft = result.drafts[0]
      const validation = validateDraft(draft)
      expect(draft.items[0].productSlug, fixture.name).toBe(fixture.expected?.product)
      if (fixture.expected?.totalCentavos !== undefined) expect(validation.totalCentavos, fixture.name).toBe(fixture.expected.totalCentavos)
      if (fixture.expected?.unresolved) expect(validation.errors.length + validation.warnings.length, fixture.name).toBeGreaterThan(0)
    }
  })
})
