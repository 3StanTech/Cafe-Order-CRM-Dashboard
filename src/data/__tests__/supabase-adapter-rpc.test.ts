import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakePostgrest, fakeCreateClient, type Row } from './fake-postgrest'
import type { OrderConfirmationInput, StoredCustomer, StoredOrder, StoredOrderItem, StoredProduct } from '../types'

const fake = createFakePostgrest()

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeCreateClient() }))

const { SupabaseAdapter } = await import('../supabase-adapter')

const createdAt = '2026-07-16T10:00:00.000Z'
const CUSTOMER_ID = '70000000-0000-4000-8000-000000000001'
const PRODUCT_ID = '10000000-0000-4000-8000-000000000001'
const ORDER_ID = '70000000-0000-4000-8000-000000000003'
const ITEM_ID = '70000000-0000-4000-8000-000000000002'

const customer: StoredCustomer = {
  id: CUSTOMER_ID, name: 'Test Customer', phone: null, createdAt, updatedAt: createdAt,
}
const product: StoredProduct = {
  id: PRODUCT_ID, name: 'Matcha Latte', priceCentavos: 20000, active: true, createdAt, updatedAt: createdAt,
}
const item: StoredOrderItem = {
  id: ITEM_ID, orderId: ORDER_ID, productId: PRODUCT_ID, productName: 'Matcha Latte', quantity: 1,
  modifiers: { level: 1, powder: 'yumeno' }, unitPriceCentavos: 20000, lineTotalCentavos: 20000,
  createdAt, updatedAt: createdAt,
}
const order: StoredOrder = {
  id: ORDER_ID, customerId: CUSTOMER_ID, status: 'new', items: [item],
  subtotalCentavos: 20000, deliveryFeeCentavos: 2500, totalCentavos: 22500,
  deliveryDate: '2026-07-16', paymentReceived: false, rawSource: 'rpc-test',
  addressSnapshot: 'Walnut 33', notes: null, routePosition: null,
  paidAt: null, deliveredAt: null, createdAt, updatedAt: createdAt,
}

describe('SupabaseAdapter aggregate RPCs', () => {
  beforeEach(() => {
    fake.reset()
  })

  it('falls back to table inserts when create_order_with_items is missing', async () => {
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await adapter.createCustomer(customer)
    await adapter.createProduct(product)
    const created = await adapter.createOrder(order)
    expect(created.id).toBe(ORDER_ID)
    expect(created.items).toHaveLength(1)
    expect(fake.rpcCalls.map((call) => call.name)).toContain('create_order_with_items')
    expect(fake.inserts.some((row) => row.id === ORDER_ID)).toBe(true)
  })

  it('uses create_order_with_items when the RPC exists', async () => {
    fake.rpcHandlers.create_order_with_items = (args) => {
      const pOrder = args.p_order as Row
      const pItems = args.p_items as Row[]
      fake.tables.orders = [...(fake.tables.orders ?? []), pOrder]
      fake.tables.order_items = [...(fake.tables.order_items ?? []), ...pItems]
      return { data: pOrder, error: null }
    }
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await adapter.createCustomer(customer)
    await adapter.createProduct(product)
    const created = await adapter.createOrder(order)
    expect(created.id).toBe(ORDER_ID)
    expect(created.items).toHaveLength(1)
    expect(fake.inserts.some((row) => row.id === ORDER_ID)).toBe(false)
    expect(fake.rpcCalls.filter((call) => call.name === 'create_order_with_items')).toHaveLength(1)
  })

  it('uses delete_customer_cascade when the RPC exists', async () => {
    fake.rpcHandlers.delete_customer_cascade = (args) => {
      const id = args.p_customer_id
      fake.tables.orders = (fake.tables.orders ?? []).filter((row) => row.customer_id !== id)
      fake.tables.settings = (fake.tables.settings ?? []).filter((row) => row.key !== `customer:${id}:profile`)
      fake.tables.customers = (fake.tables.customers ?? []).filter((row) => row.id !== id)
      return { data: null, error: null }
    }
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await adapter.createCustomer(customer)
    await adapter.deleteCustomerCascade!(customer.id)
    expect(await adapter.getCustomer(customer.id)).toBeNull()
    expect(fake.rpcCalls.map((call) => call.name)).toContain('delete_customer_cascade')
  })

  it('falls back to delete+insert when replace_order_items is missing', async () => {
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await adapter.createCustomer(customer)
    await adapter.createProduct(product)
    await adapter.createOrder(order)
    const replacement = { ...item, id: '70000000-0000-4000-8000-000000000009', quantity: 2, lineTotalCentavos: 40000 }
    const updated = await adapter.updateOrder(ORDER_ID, { items: [replacement], subtotalCentavos: 40000, totalCentavos: 42500 })
    expect(updated.items).toHaveLength(1)
    expect(updated.items[0].id).toBe(replacement.id)
    expect(fake.rpcCalls.map((call) => call.name)).toContain('replace_order_items')
    expect(fake.inserts.some((row) => row.id === replacement.id)).toBe(true)
  })

  it('uses replace_order_items when the RPC exists and does not table-insert items', async () => {
    fake.rpcHandlers.replace_order_items = (args) => {
      const pOrder = args.p_order as Row
      const pItems = args.p_items as Row[]
      const orderId = args.p_order_id
      fake.tables.orders = (fake.tables.orders ?? []).map((row) => (row.id === orderId ? pOrder : row))
      fake.tables.order_items = [
        ...(fake.tables.order_items ?? []).filter((row) => row.order_id !== orderId),
        ...pItems,
      ]
      return { data: pOrder, error: null }
    }
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await adapter.createCustomer(customer)
    await adapter.createProduct(product)
    await adapter.createOrder(order)
    const replacement = { ...item, id: '70000000-0000-4000-8000-000000000009', quantity: 2, lineTotalCentavos: 40000 }
    const insertsBefore = fake.inserts.length
    const updated = await adapter.updateOrder(ORDER_ID, { items: [replacement], subtotalCentavos: 40000, totalCentavos: 42500 })
    expect(updated.items).toHaveLength(1)
    expect(updated.items[0].id).toBe(replacement.id)
    expect(fake.rpcCalls.filter((call) => call.name === 'replace_order_items')).toHaveLength(1)
    expect(fake.inserts.slice(insertsBefore).some((row) => row.id === replacement.id || row.order_id === ORDER_ID)).toBe(false)
  })

  const confirmationInput: OrderConfirmationInput = {
    order,
    customer: { id: null, name: 'Imported Customer', phone: '09170000999' },
    confirmationKey: 'durable-confirm-01',
    requestHash: 'ab'.repeat(32),
  }

  it('maps create_order_with_confirmation RPC errors to a safe message without interpolating result.message', async () => {
    const leaked = 'duplicate key value violates unique constraint for victim@example.com 0917SECRET'
    fake.rpcHandlers.create_order_with_confirmation = () => ({
      data: null,
      error: { message: leaked, code: '23505' },
    })
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    const insertsBefore = fake.inserts.length
    const error = await adapter.confirmOrderWithResolution(confirmationInput).then(
      () => { throw new Error('expected confirmation RPC to fail') },
      (reason: unknown) => reason as Error,
    )
    expect(error.message).toBe('Durable order confirmation failed. Review the customer and order details, then try again.')
    expect(error.message).not.toMatch(/victim@example.com|0917SECRET|duplicate key/)
    expect(fake.inserts).toHaveLength(insertsBefore)
    expect(fake.tables.customers ?? []).toHaveLength(0)
    expect(fake.rpcCalls.some((call) => call.name === 'create_order_with_items')).toBe(false)
  })

  it('keeps the missing-RPC confirmation message and does not create a customer first', async () => {
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await expect(adapter.confirmOrderWithResolution(confirmationInput)).rejects.toThrow(
      'Durable order confirmation is not available. Apply the pending confirmation migration before importing Viber orders.',
    )
    expect(fake.tables.customers ?? []).toHaveLength(0)
    expect(fake.inserts).toHaveLength(0)
  })

  it('maps create_order_with_items RPC errors to a safe message without interpolating result.message', async () => {
    fake.rpcHandlers.create_order_with_items = () => ({
      data: null,
      error: { message: 'new row for relation orders violates check for victim@example.com', code: '23514' },
    })
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    const error = await adapter.createOrder(order).then(
      () => { throw new Error('expected create_order_with_items to fail') },
      (reason: unknown) => reason as Error,
    )
    expect(error.message).toBe('Supabase create_order_with_items failed.')
    expect(error.message).not.toMatch(/victim@example.com/)
  })

  it('maps replace_order_items RPC errors to a safe message without interpolating result.message', async () => {
    fake.rpcHandlers.replace_order_items = () => ({
      data: null,
      error: { message: 'update order_items failed for victim@example.com', code: 'PGRST116' },
    })
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    await adapter.createCustomer(customer)
    await adapter.createProduct(product)
    await adapter.createOrder(order)
    const error = await adapter.updateOrder(ORDER_ID, { items: [item] }).then(
      () => { throw new Error('expected replace_order_items to fail') },
      (reason: unknown) => reason as Error,
    )
    expect(error.message).toBe('Supabase replace_order_items failed.')
    expect(error.message).not.toMatch(/victim@example.com/)
  })

  it('maps delete_customer_cascade RPC errors to a safe message without interpolating result.message', async () => {
    fake.rpcHandlers.delete_customer_cascade = () => ({
      data: null,
      error: { message: 'delete failed for customer victim@example.com', code: '42501' },
    })
    const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
    const error = await adapter.deleteCustomerCascade!(CUSTOMER_ID).then(
      () => { throw new Error('expected delete_customer_cascade to fail') },
      (reason: unknown) => reason as Error,
    )
    expect(error.message).toBe('Supabase delete_customer_cascade failed.')
    expect(error.message).not.toMatch(/victim@example.com/)
  })
})
