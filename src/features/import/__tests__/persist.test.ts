import { describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../../data/local-adapter'
import { normalizeCandidate } from '../parser'
import { applyCustomerMatch } from '../customer-matching'
import { confirmImportDraft, prepareImportConfirmation } from '../persist'
import type { ImportDraft } from '../types'

async function matchedMikaDraft() {
  resetLocalAdapterMemoryForTests()
  const adapter = await LocalAdapter.create()
  const rawSource = 'Mika Santos: one matcha latte, Makati'
  const parsed = normalizeCandidate({
    customer_name: '  mika santos ',
    items: [{ product_slug: 'matcha-latte', quantity: 1, level: 1, powder: 'yumeno' }],
    address: 'Makati',
  }, rawSource)
  const matched = applyCustomerMatch(parsed, await adapter.listCustomers(), await adapter.listOrders())
  return { adapter, matched, rawSource }
}

describe('import confirmation', () => {
  it('matches a normalized customer and creates one aggregate order with preserved raw source', async () => {
    resetLocalAdapterMemoryForTests()
    const adapter = await LocalAdapter.create()
    const rawSource = 'Mika Santos: one matcha latte, Makati'
    const parsed = normalizeCandidate({ customer_name: '  mika santos ', items: [{ product_slug: 'matcha-latte', quantity: 1 }], address: 'Makati' }, rawSource)
    const matched = applyCustomerMatch(parsed, await adapter.listCustomers(), await adapter.listOrders())
    expect(matched.matchedCustomerId).not.toBeNull()
    const before = await adapter.listOrders()
    const saved = await confirmImportDraft(adapter, matched)
    const after = await adapter.listOrders()
    expect(after).toHaveLength(before.length + 1)
    expect(saved.rawSource).toBe(rawSource)
    expect(saved.items).toHaveLength(1)
    await adapter.close()
  })

  it('reuses the first-attempt confirmationSnapshot on retry instead of rebuilding the payload', async () => {
    const { adapter, matched } = await matchedMikaDraft()
    const originalConfirm = adapter.confirmOrderWithResolution!.bind(adapter)
    let attempts = 0
    adapter.confirmOrderWithResolution = async (input) => {
      attempts += 1
      if (attempts === 1) throw new Error('transport interrupted')
      return originalConfirm(input)
    }

    let prepared: ImportDraft | undefined
    await expect(confirmImportDraft(adapter, matched, { onPrepared: (draft) => { prepared = draft } })).rejects.toThrow(/transport interrupted/)
    expect(prepared?.confirmationSnapshot).toBeDefined()
    const snapshotInput = prepared!.confirmationSnapshot!.input

    const listCustomers = vi.spyOn(adapter, 'listCustomers')
    const createCustomer = vi.spyOn(adapter, 'createCustomer')
    const retriedPrepare = await prepareImportConfirmation(adapter, prepared!)
    expect(retriedPrepare.input).toBe(snapshotInput)
    expect(retriedPrepare.input.confirmationKey).toBe(snapshotInput.confirmationKey)
    expect(retriedPrepare.input.requestHash).toBe(snapshotInput.requestHash)
    expect(listCustomers).not.toHaveBeenCalled()

    const saved = await confirmImportDraft(adapter, prepared!)
    const again = await confirmImportDraft(adapter, prepared!)
    expect(again.id).toBe(saved.id)
    expect(createCustomer).not.toHaveBeenCalled()
    expect(attempts).toBe(3)
    await adapter.close()
  })

  it('throws the restore-original message when the draft identity changes after an attempt', async () => {
    const { adapter, matched } = await matchedMikaDraft()
    const prepared = await prepareImportConfirmation(adapter, matched)
    expect(prepared.draft.confirmationSnapshot).toBeDefined()

    await expect(confirmImportDraft(adapter, { ...prepared.draft, customerName: 'Different Person' })).rejects.toThrow(
      /Restore the original fields before retrying so the durable key can resolve the earlier attempt/,
    )
    await adapter.close()
  })

  it('does not fall back to createCustomer or createOrder when durable confirmation is unavailable', async () => {
    const { adapter, matched } = await matchedMikaDraft()
    const createCustomer = vi.spyOn(adapter, 'createCustomer')
    const createOrder = vi.spyOn(adapter, 'createOrder')
    const limited = { ...adapter } as typeof adapter
    delete (limited as { confirmOrderWithResolution?: unknown }).confirmOrderWithResolution

    await expect(confirmImportDraft(limited, matched)).rejects.toThrow(/Durable order confirmation is not available/)
    expect(createCustomer).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
    await adapter.close()
  })
})
