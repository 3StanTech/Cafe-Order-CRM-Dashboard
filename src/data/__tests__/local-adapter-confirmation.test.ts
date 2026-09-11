import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAdapter, resetLocalAdapterMemoryForTests } from '../local-adapter'
import type { OrderConfirmationInput, StoredCustomer, StoredOrder, StoredOrderItem, StorageChange } from '../types'

const createdAt = '2026-07-16T10:00:00.000Z'
const confirmationKey = 'durable-confirm-01'
const requestHash = 'ab'.repeat(32)
const otherHash = 'cd'.repeat(32)

const item: StoredOrderItem = {
  id: '70000000-0000-4000-8000-000000000002',
  orderId: '70000000-0000-4000-8000-000000000003',
  productId: '10000000-0000-4000-8000-000000000001',
  productName: 'Matcha Latte',
  quantity: 1,
  modifiers: { level: 1, powder: 'yumeno', sweetness: 'regular' },
  unitPriceCentavos: 20000,
  lineTotalCentavos: 20000,
  createdAt,
  updatedAt: createdAt,
}

const order: StoredOrder = {
  id: item.orderId,
  customerId: 'ignored-customer',
  status: 'paid',
  items: [item],
  subtotalCentavos: 20000,
  deliveryFeeCentavos: 2500,
  totalCentavos: 22500,
  deliveryDate: '2026-07-16',
  paymentReceived: true,
  rawSource: 'confirmation-test',
  addressSnapshot: null,
  notes: null,
  routePosition: null,
  paidAt: createdAt,
  deliveredAt: createdAt,
  createdAt,
  updatedAt: createdAt,
}

function input(overrides: Partial<OrderConfirmationInput> = {}): OrderConfirmationInput {
  return {
    order,
    customer: { id: null, name: 'Confirm Customer', phone: '09170000099' },
    confirmationKey,
    requestHash,
    ...overrides,
  }
}

describe('LocalAdapter confirmOrderWithResolution', () => {
  beforeEach(() => resetLocalAdapterMemoryForTests())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('forces status new/unpaid and returns the same order on an identical retry', async () => {
    const adapter = await LocalAdapter.create()
    const first = await adapter.confirmOrderWithResolution(input())
    expect(first.status).toBe('new')
    expect(first.paymentReceived).toBe(false)
    expect(first.paidAt).toBeNull()
    expect(first.deliveredAt).toBeNull()
    expect(first.customerId).toBeTruthy()
    expect(first.items).toHaveLength(1)

    const second = await adapter.confirmOrderWithResolution(input())
    expect(second.id).toBe(first.id)
    expect((await adapter.listOrders()).filter((entry) => entry.id === first.id)).toHaveLength(1)
    await adapter.close()
  })

  it('rejects a reused key with a different hash and does not create another order', async () => {
    const adapter = await LocalAdapter.create()
    const first = await adapter.confirmOrderWithResolution(input())
    const before = await adapter.listOrders()
    await expect(adapter.confirmOrderWithResolution(input({ requestHash: otherHash }))).rejects.toThrow(
      'Confirmation key was already used for another payload.',
    )
    expect(await adapter.listOrders()).toHaveLength(before.length)
    expect(await adapter.getOrder(first.id)).toMatchObject({ id: first.id })
    await adapter.close()
  })

  it('throws a tombstone error for a deleted order and does not recreate it', async () => {
    const adapter = await LocalAdapter.create()
    const created = await adapter.confirmOrderWithResolution(input())
    const customerId = created.customerId
    await adapter.deleteOrder(created.id)
    const ordersBefore = await adapter.listOrders()
    await expect(adapter.confirmOrderWithResolution(input())).rejects.toThrow('Confirmation key points to a deleted order.')
    expect((await adapter.listOrders()).map((entry) => entry.id)).toEqual(ordersBefore.map((entry) => entry.id))
    expect(await adapter.getOrder(created.id)).toBeNull()
    expect(await adapter.getCustomer(customerId)).not.toBeNull()
    await adapter.close()
  })

  it('rolls memory maps back when clone throws after the customer is staged', async () => {
    const adapter = await LocalAdapter.create()
    const customersBefore = await adapter.listCustomers()
    const ordersBefore = await adapter.listOrders()
    const changes: StorageChange[] = []
    adapter.subscribe((change) => changes.push(change))

    const nativeClone = globalThis.structuredClone.bind(globalThis)
    let sawStagedCustomer = false
    let injected = false
    vi.stubGlobal('structuredClone', (value: unknown) => {
      if (!injected && sawStagedCustomer && value && typeof value === 'object' && 'status' in value) {
        injected = true
        throw new Error('injected confirmation fault')
      }
      const cloned = nativeClone(value)
      if (value && typeof value === 'object' && 'name' in value && (value as StoredCustomer).name === 'Fault Injection Customer') {
        sawStagedCustomer = true
      }
      return cloned
    })

    await expect(
      adapter.confirmOrderWithResolution(input({ customer: { id: null, name: 'Fault Injection Customer', phone: '09170000111' } })),
    ).rejects.toThrow('injected confirmation fault')

    expect((await adapter.listCustomers()).map((customer) => customer.name)).toEqual(customersBefore.map((customer) => customer.name))
    expect((await adapter.listOrders()).map((entry) => entry.id)).toEqual(ordersBefore.map((entry) => entry.id))
    expect(changes).toEqual([])

    vi.unstubAllGlobals()
    const retried = await adapter.confirmOrderWithResolution(input({
      customer: { id: null, name: 'Fault Injection Customer', phone: '09170000111' },
    }))
    expect(retried.status).toBe('new')
    expect(retried.id).not.toBe(order.id)
    expect((await adapter.listCustomers()).some((customer) => customer.name === 'Fault Injection Customer')).toBe(true)
    await adapter.close()
  })

  it('aborts the IDB transaction when confirmation work throws after customer.put', async () => {
    const adapter = await LocalAdapter.create()
    const abort = vi.fn()
    const done = Promise.resolve()
    let puts = 0
    const store = {
      get: vi.fn(async () => undefined),
      getAll: vi.fn(async () => []),
      put: vi.fn(async () => {
        puts += 1
        if (puts === 1) return undefined
        throw new Error('injected put failure')
      }),
    }
    Object.assign(adapter, {
      database: {
        transaction: () => ({ objectStore: () => store, abort, done }),
        close: () => undefined,
      },
    })

    await expect(adapter.confirmOrderWithResolution(input())).rejects.toThrow('injected put failure')
    expect(puts).toBe(2)
    expect(abort).toHaveBeenCalled()
    expect(store.put).toHaveBeenCalled()
    await adapter.close()
  })
})
