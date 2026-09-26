import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../../../data/local-adapter'
import { priceOrder } from '../../../domain/pricing'
import type { ImportDraft } from '../../import/types'
import { advancePatch } from '../../orders/orderLifecycle'
import { parseHistoryImport } from '../format'
import { importHistoryDraft } from '../importHistoryDraft'

const NOW = new Date('2026-09-26T04:00:00.000Z')
const LINE = JSON.stringify({
  source_ref: 'viber-2026-03-01-lia',
  customer_name: 'History Lia',
  delivery_date: '2026-03-01',
  total_centavos: 1,
  items: [{ product_slug: 'hojicha-latte', quantity: 2, level: 2, powder: 'yumeno', price: 1 }],
  address: 'Makati',
})

async function setup() {
  resetLocalAdapterMemoryForTests()
  const adapter = await LocalAdapter.create()
  const { rows } = parseHistoryImport(LINE, { now: NOW, customers: await adapter.listCustomers(), orders: await adapter.listOrders() })
  return { adapter, draft: rows[0].draft }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('advancePatch', () => {
  it('marks payment on the step to Paid and only changes status after that', () => {
    expect(advancePatch('new')).toEqual({ status: 'paid', paymentReceived: true })
    expect(advancePatch('paid')).toEqual({ status: 'delivered' })
    expect(advancePatch('delivered')).toBeNull()
    expect(advancePatch('cancelled')).toBeNull()
  })
})

describe('importHistoryDraft', () => {
  it('saves a past order as delivered and paid, re-priced from the catalog, with storage-owned timestamps', async () => {
    const { adapter, draft } = await setup()
    const update = vi.spyOn(adapter, 'updateOrder')
    let prepared: ImportDraft | undefined
    const before = await adapter.listOrders()

    const order = await importHistoryDraft(adapter, draft, { onPrepared: (next) => { prepared = next } })

    expect(order.status).toBe('delivered')
    expect(order.paymentReceived).toBe(true)
    expect(order.rawSource).toBe('history-import:viber-2026-03-01-lia')
    expect(order.deliveryDate).toBe('2026-03-01')
    expect(order.paidAt).not.toBeNull()
    expect(order.deliveredAt).not.toBeNull()
    const expected = priceOrder({ items: [{ productSlug: 'hojicha-latte', quantity: 2, modifiers: { level: 2, powder: 'yumeno' } }] }).totals.totalCentavos
    expect(order.totalCentavos).toBe(expected)
    expect(order.totalCentavos).not.toBe(1)

    expect(prepared?.confirmationKey).toMatch(/^history-/)
    expect(prepared?.confirmationKey).toMatch(/^[A-Za-z0-9._:-]{16,100}$/)
    expect(prepared?.confirmationSnapshot?.input.order.paidAt).toBeNull()
    expect(prepared?.confirmationSnapshot?.input.order.deliveredAt).toBeNull()

    expect(update.mock.calls.map(([, patch]) => patch)).toEqual([
      { status: 'paid', paymentReceived: true },
      { status: 'delivered' },
    ])
    expect(await adapter.listOrders()).toHaveLength(before.length + 1)
    await adapter.close()
  })

  it('resumes after an interruption between steps without creating a second order', async () => {
    const { adapter, draft } = await setup()
    const before = await adapter.listOrders()
    const original = adapter.updateOrder.bind(adapter)
    let calls = 0
    vi.spyOn(adapter, 'updateOrder').mockImplementation(async (id, patch) => {
      calls += 1
      if (calls === 2) throw new Error('connection dropped')
      return original(id, patch)
    })
    let prepared: ImportDraft | undefined

    await expect(importHistoryDraft(adapter, draft, { onPrepared: (next) => { prepared = next } })).rejects.toThrow('connection dropped')
    const stuck = (await adapter.listOrders()).find((order) => order.rawSource === draft.rawSource)
    expect(stuck?.status).toBe('paid')

    const resumed = await importHistoryDraft(adapter, prepared!)
    expect(resumed.id).toBe(stuck?.id)
    expect(resumed.status).toBe('delivered')
    const after = await adapter.listOrders()
    expect(after).toHaveLength(before.length + 1)
    expect(after.filter((order) => order.rawSource === draft.rawSource)).toHaveLength(1)
    await adapter.close()
  })

  it('resumes after the save itself was interrupted by reusing the saved key', async () => {
    const { adapter, draft } = await setup()
    const before = await adapter.listOrders()
    const original = adapter.confirmOrderWithResolution!.bind(adapter)
    let attempts = 0
    adapter.confirmOrderWithResolution = async (input) => {
      attempts += 1
      const saved = await original(input)
      if (attempts === 1) throw new Error('response lost')
      return saved
    }
    let prepared: ImportDraft | undefined

    await expect(importHistoryDraft(adapter, draft, { onPrepared: (next) => { prepared = next } })).rejects.toThrow('response lost')
    const resumed = await importHistoryDraft(adapter, prepared!)
    expect(resumed.status).toBe('delivered')
    expect(await adapter.listOrders()).toHaveLength(before.length + 1)
    await adapter.close()
  })

  it('refuses a draft that is not a history row', async () => {
    const { adapter, draft } = await setup()
    await expect(importHistoryDraft(adapter, { ...draft, rawSource: 'Mika: one matcha' })).rejects.toThrow(/Only history rows/)
    await expect(importHistoryDraft(adapter, { ...draft, rawSource: 'history-import:' })).rejects.toThrow(/Only history rows/)
    await adapter.close()
  })

  it('stops on an order the key resolves to as cancelled instead of reviving it', async () => {
    const { adapter, draft } = await setup()
    const original = adapter.confirmOrderWithResolution!.bind(adapter)
    adapter.confirmOrderWithResolution = async (input) => ({ ...(await original(input)), status: 'cancelled' as const })
    const update = vi.spyOn(adapter, 'updateOrder')
    await expect(importHistoryDraft(adapter, draft)).rejects.toThrow(/already cancelled/)
    expect(update).not.toHaveBeenCalled()
    await adapter.close()
  })
})
