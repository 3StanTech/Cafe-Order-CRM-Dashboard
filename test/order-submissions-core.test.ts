import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getPublicOrderMenu, submitPublicOrder, updatePendingSubmission } from '../server/order-submissions-core'
import { priceOrder } from '../src/domain'
import { DEFAULT_DASHBOARD_SETTINGS, type DashboardSettings } from '../src/features/settings/settings-store'

const SUBMISSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const IDEMPOTENCY_KEY = 'owner-edit-key-0001'
const REVIEW_HASH = 'a'.repeat(64)
const BEFORE_CUTOFF = new Date('2026-09-07T10:00:00Z')
const AFTER_CUTOFF = new Date('2026-09-07T12:01:00Z')
const SUBMITTED_DATE = '2026-09-08'

const items = [{ productSlug: 'matcha-latte' as const, quantity: 1, modifiers: { level: 1 as const, powder: 'yumeno' as const } }]
const thermalBags = [{ coveredCupCount: 1 as const }]

function settingsWith(overrides: Partial<DashboardSettings> = {}): DashboardSettings {
  return {
    ...DEFAULT_DASHBOARD_SETTINGS,
    gCashNumber: '09171234567',
    openDays: ['tuesday', 'wednesday', 'friday'],
    orderCutoff: '20:00',
    ...overrides,
    productBasePrices: { ...DEFAULT_DASHBOARD_SETTINGS.productBasePrices, ...overrides.productBasePrices },
  }
}

function orderFields(args: {
  deliveryDate: string
  quoteRevision: string
  quotedTotalCentavos: number
  address?: string
  idempotencyKey?: string
  honeypot?: string
}) {
  return {
    customerName: 'Test Customer',
    customerPhone: '09170000000',
    address: args.address ?? 'Quezon City',
    deliveryDate: args.deliveryDate,
    notes: null,
    items,
    thermalBags,
    quoteRevision: args.quoteRevision,
    quotedTotalCentavos: args.quotedTotalCentavos,
    idempotencyKey: args.idempotencyKey ?? IDEMPOTENCY_KEY,
    ...(args.honeypot !== undefined ? { honeypot: args.honeypot } : {}),
  }
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBMISSION_ID,
    status: 'pending',
    total_centavos: 22500,
    delivery_date: SUBMITTED_DATE,
    idempotency_key: IDEMPOTENCY_KEY,
    review_version: 0,
    review_hash: REVIEW_HASH,
    ...overrides,
  }
}

function createMockClient(options: { settings: DashboardSettings; current?: Record<string, unknown> | null }) {
  const updates: Record<string, unknown>[] = []
  const inserts: Record<string, unknown>[] = []
  const done = (data: unknown, error: unknown = null) => Promise.resolve({ data, error })

  const client = {
    rpc: () => done(true),
    from(table: string) {
      const state: { op: 'select' | 'insert' | 'update'; payload?: Record<string, unknown> } = { op: 'select' }
      const builder = {
        select() { return builder },
        insert(payload: Record<string, unknown>) {
          state.op = 'insert'
          state.payload = payload
          inserts.push(payload)
          return builder
        },
        update(payload: Record<string, unknown>) {
          state.op = 'update'
          state.payload = payload
          updates.push(payload)
          return builder
        },
        eq() { return builder },
        order() { return builder },
        maybeSingle() {
          if (table === 'settings') return done({ value: options.settings })
          if (state.op === 'update') {
            return done({
              id: SUBMISSION_ID,
              reference: 'CB-TEST0001',
              request_hash: 'b'.repeat(64),
              quote_revision: options.settings && state.payload?.quote_revision,
              status: 'pending',
              accepted_order_id: null,
              ...state.payload,
            })
          }
          return done(options.current ?? null)
        },
        single() {
          if (state.op === 'insert' && state.payload) {
            return done({
              id: SUBMISSION_ID,
              reference: 'CB-TEST0001',
              request_hash: state.payload.request_hash,
              quote_revision: state.payload.quote_revision,
              status: 'pending',
              delivery_date: state.payload.delivery_date,
              total_centavos: state.payload.total_centavos,
              accepted_order_id: null,
              idempotency_key: state.payload.idempotency_key,
              review_hash: state.payload.review_hash,
              review_version: state.payload.review_version,
            })
          }
          return done(null)
        },
      }
      return builder
    },
  }

  return { client: client as unknown as SupabaseClient, updates, inserts }
}

async function quoteRevisionFor(client: SupabaseClient, now: Date): Promise<string> {
  const menu = await getPublicOrderMenu(client, now)
  expect(menu.status).toBe(200)
  expect(typeof menu.body.quoteRevision).toBe('string')
  return menu.body.quoteRevision as string
}

describe('order submissions core', () => {
  it('hashes owner-edit reviews with the priced total so identical items at different totals diverge', async () => {
    const settingsA = settingsWith()
    const settingsB = settingsWith({
      productBasePrices: { ...DEFAULT_DASHBOARD_SETTINGS.productBasePrices, 'matcha-latte': 21000 },
    })

    async function edit(settings: DashboardSettings) {
      const { client, updates } = createMockClient({ settings, current: pendingRow() })
      const priced = priceOrder({ items, thermalBags }, settings)
      const result = await updatePendingSubmission(client, SUBMISSION_ID, JSON.stringify({
        ...orderFields({
          deliveryDate: SUBMITTED_DATE,
          quoteRevision: await quoteRevisionFor(client, BEFORE_CUTOFF),
          quotedTotalCentavos: priced.totals.totalCentavos,
        }),
        expectedReviewVersion: 0,
        expectedReviewHash: REVIEW_HASH,
      }), BEFORE_CUTOFF)
      expect(result.status).toBe(200)
      expect(updates).toHaveLength(1)
      return updates[0]
    }

    const first = await edit(settingsA)
    const second = await edit(settingsB)
    expect(first.total_centavos).toBe(22500)
    expect(second.total_centavos).toBe(23500)
    expect(first.review_hash).not.toBe(second.review_hash)
    expect(first).not.toHaveProperty('request_hash')
    expect(first).not.toHaveProperty('idempotency_key')
    expect(first).not.toHaveProperty('submitted_snapshot')
  })

  it('keeps the submitted delivery date for an address-only owner edit after cutoff', async () => {
    const settings = settingsWith()
    const { client, updates } = createMockClient({ settings, current: pendingRow() })
    const menu = await getPublicOrderMenu(client, AFTER_CUTOFF)
    const delivery = menu.body.delivery as { deliveryDate: string }
    expect(delivery.deliveryDate).toBe('2026-09-09')
    const priced = priceOrder({ items, thermalBags }, settings)
    const result = await updatePendingSubmission(client, SUBMISSION_ID, JSON.stringify({
      ...orderFields({
        deliveryDate: SUBMITTED_DATE,
        address: 'Makati',
        quoteRevision: menu.body.quoteRevision as string,
        quotedTotalCentavos: priced.totals.totalCentavos,
      }),
      expectedReviewVersion: 0,
      expectedReviewHash: REVIEW_HASH,
    }), AFTER_CUTOFF)
    expect(result.status).toBe(200)
    expect(updates[0]?.delivery_date).toBe(SUBMITTED_DATE)
    expect(updates[0]?.address_snapshot).toBe('Makati')
  })

  it('returns 409 RECONFIRM_REQUIRED when the quoted total does not match the priced total', async () => {
    const settings = settingsWith()
    const { client, updates } = createMockClient({ settings, current: pendingRow() })
    const priced = priceOrder({ items, thermalBags }, settings)
    const result = await updatePendingSubmission(client, SUBMISSION_ID, JSON.stringify({
      ...orderFields({
        deliveryDate: SUBMITTED_DATE,
        quoteRevision: await quoteRevisionFor(client, BEFORE_CUTOFF),
        quotedTotalCentavos: priced.totals.totalCentavos + 1,
      }),
      expectedReviewVersion: 0,
      expectedReviewHash: REVIEW_HASH,
    }), BEFORE_CUTOFF)
    expect(result.status).toBe(409)
    expect(result.body.code).toBe('RECONFIRM_REQUIRED')
    expect(updates).toHaveLength(0)
  })

  it('rejects a non-empty honeypot on public submit', async () => {
    const settings = settingsWith()
    const { client, inserts } = createMockClient({ settings })
    const priced = priceOrder({ items, thermalBags }, settings)
    const result = await submitPublicOrder(client, JSON.stringify(orderFields({
      deliveryDate: SUBMITTED_DATE,
      quoteRevision: await quoteRevisionFor(client, BEFORE_CUTOFF),
      quotedTotalCentavos: priced.totals.totalCentavos,
      honeypot: 'spam',
    })), '198.51.100.10', BEFORE_CUTOFF)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('The order could not be submitted.')
    expect(inserts).toHaveLength(0)
  })

  it('rejects an unknown public order field', async () => {
    const settings = settingsWith()
    const { client, inserts } = createMockClient({ settings })
    const priced = priceOrder({ items, thermalBags }, settings)
    const result = await submitPublicOrder(client, JSON.stringify({
      ...orderFields({
        deliveryDate: SUBMITTED_DATE,
        quoteRevision: await quoteRevisionFor(client, BEFORE_CUTOFF),
        quotedTotalCentavos: priced.totals.totalCentavos,
      }),
      website: 'https://example.test',
    }), '198.51.100.10', BEFORE_CUTOFF)
    expect(result.status).toBe(400)
    expect(result.body.error).toBe('The order form contains an unsupported field.')
    expect(inserts).toHaveLength(0)
  })
})
