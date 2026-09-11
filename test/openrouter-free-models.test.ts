import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertFallbackModelId,
  assertPrimaryModelId,
  isPinnedFreeModelId,
  openRouterFallbackModel,
  openRouterModel,
} from '../server/openrouter'
import {
  extractOrders,
  extractionInstruction,
  OPENROUTER_TIMEOUT_MS,
  validateStructuralResponse,
} from '../server/parse-orders-core'

const validOrder = {
  customer_name: 'Mika',
  items: [{ product_slug: 'matcha-latte', quantity: 1, level: 1, powder: 'yumeno', sweetness: null, cup_names: ['Ana'] }],
  thermal_bags: [{ covered_cup_count: 1 }],
  delivery_date: null,
  address: 'Makati',
  notes: null,
  source_confidence: 0.4,
  unresolved_fields: ['level guessed from usual order'],
}

function providerPayload(orders: unknown, extras: Record<string, unknown> = {}) {
  return {
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: JSON.stringify({ orders }) },
      ...extras,
    }],
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('OpenRouter free-only model ids', () => {
  it('accepts pinned provider/model:free ids and rejects paid or auto routing', () => {
    expect(isPinnedFreeModelId('meta-llama/llama-3.1-8b-instruct:free')).toBe(true)
    expect(assertPrimaryModelId(' google/gemma-2-9b-it:free ')).toBe('google/gemma-2-9b-it:free')
    expect(assertFallbackModelId('qwen/qwen-2.5-7b-instruct:free')).toBe('qwen/qwen-2.5-7b-instruct:free')
    expect(isPinnedFreeModelId('anthropic/claude-3.5-sonnet')).toBe(false)
    expect(isPinnedFreeModelId('openrouter/auto')).toBe(false)
    expect(isPinnedFreeModelId('openrouter/auto:free')).toBe(false)
    expect(isPinnedFreeModelId('provider/model')).toBe(false)
    expect(() => assertPrimaryModelId('openrouter/auto:free')).toThrow(/pinned free model/)
    expect(() => assertFallbackModelId('openai/gpt-4o')).toThrow(/pinned free model/)
  })

  it('reads only pinned free env models and drops a fallback that duplicates the primary', () => {
    vi.stubEnv('OPENROUTER_MODEL', 'provider/primary:free')
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'provider/primary:free')
    expect(openRouterModel()).toBe('provider/primary:free')
    expect(openRouterFallbackModel()).toBeUndefined()
    vi.stubEnv('OPENROUTER_FALLBACK_MODEL', 'provider/backup:free')
    expect(openRouterFallbackModel()).toBe('provider/backup:free')
    vi.stubEnv('OPENROUTER_MODEL', 'openrouter/auto:free')
    expect(() => openRouterModel()).toThrow(/pinned free model/)
  })
})

describe('extractOrders OpenRouter contract', () => {
  it('requires an API key and a qualified free model before any network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    expect(await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }))).toMatchObject({ status: 503 })
    vi.stubEnv('OPENROUTER_MODEL', 'anthropic/claude-3.5-sonnet')
    expect(await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')).toMatchObject({ status: 503 })
    vi.stubEnv('OPENROUTER_MODEL', 'openrouter/auto:free')
    expect(await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')).toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a 429 quota response without accepting a partial batch', async () => {
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'rate' } }), { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
    expect(result).toMatchObject({ status: 429 })
    expect((result.body as { error: string }).error).toMatch(/quota/i)
    expect(result.body).not.toHaveProperty('orders')
  })

  it('rejects malformed, refused, or truncated completions with no orders payload', async () => {
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    const cases = [
      { choices: [{ finish_reason: 'stop', message: { content: '{not-json' } }] },
      { choices: [{ finish_reason: 'stop', refusal: 'no', message: { content: JSON.stringify({ orders: [validOrder] }) } }] },
      { choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ orders: [validOrder] }) } }] },
      { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ orders: [validOrder, { ...validOrder, items: [] }] }) } }] },
    ]
    for (const payload of cases) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      const result = await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
      expect(result.status).toBe(502)
      expect(result.body).not.toHaveProperty('orders')
    }
  })

  it('preserves uncertainty, cup names, and multiple customers when the envelope is complete', async () => {
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    const second = {
      ...validOrder,
      customer_name: 'Paolo',
      items: [{ product_slug: null, quantity: 2, level: null, powder: null, sweetness: null, cup_names: ['Ben', 'Cara'] }],
      unresolved_fields: ['product is unclear'],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(providerPayload([validOrder, second])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await extractOrders(JSON.stringify({ raw_text: 'Mika and Paolo orders' }), 'test-key')
    expect(result.status).toBe(200)
    const body = result.body as { orders: typeof validOrder[] }
    expect(body.orders).toHaveLength(2)
    expect(body.orders[0].unresolved_fields).toEqual(['level guessed from usual order'])
    expect(body.orders[0].source_confidence).toBe(0.4)
    expect(body.orders[0].items[0].cup_names).toEqual(['Ana'])
    expect(body.orders[1].customer_name).toBe('Paolo')
    expect(body.orders[1].items[0].product_slug).toBeNull()
  })

  it('rejects monetary extra keys so priceOrder remains the authority', async () => {
    expect(extractionInstruction).toMatch(/Ignore monetary claims/)
    expect(extractionInstruction).not.toMatch(/priceOrder/)
    const withPrice = {
      ...validOrder,
      items: [{ ...validOrder.items[0], price: 20, total: 20 }],
    }
    expect(validateStructuralResponse({ orders: [withPrice] })).toBe(false)
    expect(validateStructuralResponse({ orders: [validOrder], total: 20 })).toBe(false)
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(providerPayload([withPrice])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await extractOrders(JSON.stringify({ raw_text: 'Mika: 20 pesos only' }), 'test-key')
    expect(result).toMatchObject({ status: 502 })
    expect(result.body).not.toHaveProperty('orders')
  })

  it('aborts at the overall deadline', async () => {
    vi.useFakeTimers()
    try {
      vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }))
      vi.stubGlobal('fetch', fetchMock)
      const pending = extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
      await vi.advanceTimersByTimeAsync(OPENROUTER_TIMEOUT_MS)
      expect(await pending).toMatchObject({ status: 504 })
    } finally {
      vi.useRealTimers()
    }
  })
})
