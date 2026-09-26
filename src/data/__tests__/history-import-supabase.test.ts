import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakePostgrest, fakeCreateClient, type Row } from './fake-postgrest'
import { parseHistoryImport } from '../../features/history-import/format'
import { importHistoryDraft } from '../../features/history-import/importHistoryDraft'
import type { ImportDraft } from '../../features/import/types'

const fake = createFakePostgrest()

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeCreateClient() }))

const { SupabaseAdapter } = await import('../supabase-adapter')

const NOW = new Date('2026-09-26T04:00:00.000Z')
const LINE = JSON.stringify({
  source_ref: 'viber-2026-03-01-dana',
  customer_name: 'Parity Dana',
  customer_phone: '09170000123',
  delivery_date: '2026-03-01',
  total_centavos: 1,
  items: [{ product_slug: 'matcha-latte', quantity: 2, level: 1, powder: 'yumeno', price: 1 }],
  address: 'Makati',
})

/**
 * Mirrors `create_order_with_confirmation`: one key per payload, the customer
 * resolved or created by name, and an order inserted from an explicit column
 * list — status `new`, unpaid, with no client lifecycle timestamps — so the
 * fake's uuid, FK and lifecycle checks run on every row.
 */
function installConfirmationRpc() {
  const keys = new Map<string, { hash: string; orderId: string }>()
  fake.rpcHandlers.create_order_with_confirmation = (args) => {
    const key = String(args.p_confirmation_key)
    const hash = String(args.p_request_hash)
    const claimed = keys.get(key)
    if (claimed) {
      if (claimed.hash !== hash) return { data: null, error: { message: 'confirmation key was already used for another payload', code: '22023' } }
      return { data: (fake.tables.orders ?? []).find((row) => row.id === claimed.orderId) ?? null, error: null }
    }
    const order = args.p_order as Row
    let customerId = typeof order.customer_id === 'string' && order.customer_id ? order.customer_id : null
    if (!customerId) {
      const name = String(order.customer_name).trim()
      const found = (fake.tables.customers ?? []).find((row) => String(row.name).trim().toLowerCase() === name.toLowerCase())
      customerId = found ? String(found.id) : crypto.randomUUID()
      if (!found) void fake.client.from('customers').insert({ id: customerId, name, phone: order.customer_phone ?? null })
    }
    const orderId = crypto.randomUUID()
    void fake.client.from('orders').insert({
      id: orderId,
      customer_id: customerId,
      status: 'new',
      delivery_date: order.delivery_date,
      payment_received: false,
      subtotal_centavos: order.subtotal_centavos,
      delivery_fee_centavos: order.delivery_fee_centavos,
      total_centavos: order.total_centavos,
      raw_source: order.raw_source ?? 'viber_import',
      address_snapshot: order.address_snapshot,
      notes: order.notes,
      route_position: order.route_position,
    })
    const inserted = (fake.tables.orders ?? []).find((row) => row.id === orderId)
    if (!inserted) return { data: null, error: { message: 'order insert rejected', code: '23514' } }
    for (const item of args.p_items as Row[]) {
      void fake.client.from('order_items').insert({
        id: crypto.randomUUID(),
        order_id: orderId,
        product_id: item.product_id,
        product_name_snapshot: item.product_name_snapshot,
        quantity: item.quantity,
        modifiers: item.modifiers,
        unit_price_centavos: item.unit_price_centavos,
        line_total_centavos: item.line_total_centavos,
      })
    }
    keys.set(key, { hash, orderId })
    return { data: inserted, error: null }
  }
}

async function setup() {
  installConfirmationRpc()
  const adapter = await SupabaseAdapter.create('https://example.supabase.co', 'anon-key')
  const { rows } = parseHistoryImport(LINE, { now: NOW, customers: await adapter.listCustomers(), orders: await adapter.listOrders() })
  return { adapter, draft: rows[0].draft }
}

const LIFECYCLE_COLUMNS = ['paid_at', 'delivered_at', 'created_at', 'updated_at']

describe('history import on SupabaseAdapter', () => {
  beforeEach(() => {
    fake.reset()
  })

  it('confirms a prefixed, unpaid new order and lets storage stamp the lifecycle', async () => {
    const { adapter, draft } = await setup()

    const order = await importHistoryDraft(adapter, draft)

    const confirm = fake.rpcCalls.filter((call) => call.name === 'create_order_with_confirmation')
    expect(confirm).toHaveLength(1)
    const pOrder = confirm[0].args.p_order as Row
    expect(pOrder.raw_source).toBe('history-import:viber-2026-03-01-dana')
    expect(pOrder.status).toBe('new')
    expect(pOrder.payment_received).toBe(false)
    expect(pOrder.paid_at).toBeNull()
    expect(pOrder.delivered_at).toBeNull()
    expect(pOrder.total_centavos).not.toBe(1)
    expect(String(confirm[0].args.p_confirmation_key)).toMatch(/^history-[A-Za-z0-9._:-]+$/)

    const stored = (fake.tables.orders ?? []).find((row) => row.id === order.id)!
    expect(stored.status).toBe('delivered')
    expect(stored.payment_received).toBe(true)
    expect(stored.raw_source).toBe('history-import:viber-2026-03-01-dana')
    expect(stored.paid_at).toEqual(expect.any(String))
    expect(stored.delivered_at).toEqual(expect.any(String))
    expect(order.status).toBe('delivered')
  })

  it('sends only status and payment changes in its updates, never a lifecycle timestamp', async () => {
    const { adapter, draft } = await setup()
    const patches: unknown[] = []
    const original = adapter.updateOrder.bind(adapter)
    adapter.updateOrder = async (id, patch) => {
      patches.push(patch)
      return original(id, patch)
    }
    await importHistoryDraft(adapter, draft)

    expect(patches).toEqual([{ status: 'paid', paymentReceived: true }, { status: 'delivered' }])
    expect(fake.updates).toHaveLength(2)
    for (const payload of fake.updates) {
      for (const column of LIFECYCLE_COLUMNS) expect(payload).not.toHaveProperty(column)
    }
    expect(fake.updates.map((payload) => [payload.status, payload.payment_received])).toEqual([['paid', true], ['delivered', true]])

    // The adapter writes whole rows; every column besides status and payment
    // must carry the stored value unchanged.
    const stored = (fake.tables.orders ?? [])[0]
    for (const payload of fake.updates) {
      for (const [column, value] of Object.entries(payload)) {
        if (column === 'status' || column === 'payment_received') continue
        expect(value, column).toEqual(stored[column])
      }
    }
  })

  it('resumes with the same key after an interrupted update and leaves one order', async () => {
    const { adapter, draft } = await setup()
    const original = adapter.updateOrder.bind(adapter)
    let calls = 0
    adapter.updateOrder = async (id, patch) => {
      calls += 1
      if (calls === 2) throw new Error('network lost')
      return original(id, patch)
    }
    let prepared: ImportDraft | undefined

    await expect(importHistoryDraft(adapter, draft, { onPrepared: (next) => { prepared = next } })).rejects.toThrow('network lost')
    expect((fake.tables.orders ?? [])[0].status).toBe('paid')

    const resumed = await importHistoryDraft(adapter, prepared!)

    expect(resumed.status).toBe('delivered')
    expect(fake.tables.orders ?? []).toHaveLength(1)
    expect(fake.tables.customers ?? []).toHaveLength(1)
    const keys = fake.rpcCalls.filter((call) => call.name === 'create_order_with_confirmation').map((call) => call.args.p_confirmation_key)
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(1)
  })
})
