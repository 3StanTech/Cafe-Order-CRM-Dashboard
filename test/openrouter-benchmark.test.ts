import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptProviderExtraction,
  BENCHMARK_CURRENT_DATE,
  conversations,
  essentialFieldsPass,
  isJsonCapableFree,
  listFreeJsonCandidates,
  MAX_CANDIDATES,
  openRouterBenchmarkFixtures,
  parseModelShortlist,
  resolveOutputPath,
  runBenchmark,
  runConversation,
  TARGET_MEDIAN_MS,
  type BenchmarkFixture,
} from '../scripts/openrouter-benchmark'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function completeItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_slug: 'matcha-latte',
    quantity: 1,
    level: null,
    powder: null,
    sweetness: null,
    cup_names: [],
    ...overrides,
  }
}

function completeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customer_name: 'Mika Santos',
    items: [completeItem()],
    thermal_bags: [],
    delivery_date: null,
    address: 'Makati',
    notes: null,
    source_confidence: null,
    unresolved_fields: [],
    ...overrides,
  }
}

function twoCustomerParsed(overrides: { orders?: Record<string, unknown>[] } = {}) {
  return {
    orders: overrides.orders ?? [
      completeOrder({
        items: [completeItem({ product_slug: 'matcha-latte', quantity: 2, cup_names: ['Ana', 'Ben'] })],
      }),
      completeOrder({
        customer_name: 'Paolo Reyes',
        items: [completeItem({ product_slug: 'hojicha-latte', quantity: 1, level: 2 })],
        address: 'QC',
      }),
    ],
  }
}

function twoCustomerFixture(): BenchmarkFixture {
  const fixture = openRouterBenchmarkFixtures.find((entry) => entry.name === 'two customers in one paste')
  if (!fixture) throw new Error('Missing two-customer fixture')
  return fixture
}

function providerEnvelope(content: unknown, extras: Record<string, unknown> = {}) {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return {
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: text },
      ...extras,
    }],
  }
}

describe('OpenRouter benchmark fixtures', () => {
  it('ships exactly 12 complete multi-field expected orders', () => {
    expect(conversations()).toHaveLength(12)
    expect(openRouterBenchmarkFixtures).toHaveLength(12)
    expect(new Set(openRouterBenchmarkFixtures.map((fixture) => fixture.name)).size).toBe(12)
    for (const fixture of openRouterBenchmarkFixtures) {
      expect(fixture.text.trim().length, fixture.name).toBeGreaterThan(0)
      expect(fixture.expectedOrders.length, fixture.name).toBeGreaterThan(0)
      for (const order of fixture.expectedOrders) {
        expect(order.customer_name.trim(), fixture.name).not.toBe('')
        expect(order.items.length, fixture.name).toBeGreaterThan(0)
        for (const item of order.items) {
          expect(item.product_slug, fixture.name).toMatch(/^[a-z0-9-]+$/)
          expect(item.quantity, fixture.name).toBeGreaterThan(0)
        }
      }
    }
    const twoCustomers = twoCustomerFixture()
    expect(twoCustomers.expectedOrders).toHaveLength(2)
    expect(twoCustomers.expectedOrders.map((order) => order.customer_name)).toEqual(['Mika Santos', 'Paolo Reyes'])
    expect(twoCustomers.expectedOrders[0].items[0].cup_names).toEqual(['Ana', 'Ben'])
    expect(twoCustomers.expectedOrders[1].items[0]).toMatchObject({ product_slug: 'hojicha-latte', quantity: 1, level: 2 })
    expect(BENCHMARK_CURRENT_DATE).toBe('2026-09-07')
    expect(TARGET_MEDIAN_MS).toBe(10_000)
    expect(MAX_CANDIDATES).toBe(3)
  })
})

describe('essentialFieldsPass', () => {
  it('requires every customer, drink, quantity, cup name, and address on a two-customer paste', () => {
    expect(essentialFieldsPass(twoCustomerParsed(), twoCustomerFixture())).toBe(true)
  })

  it('rejects each essential-field corruption', () => {
    const fixture = twoCustomerFixture()
    const cases: Array<[string, unknown]> = [
      ['wrong name', twoCustomerParsed({
        orders: [
          completeOrder({
            customer_name: 'Mika',
            items: [completeItem({ product_slug: 'matcha-latte', quantity: 2, cup_names: ['Ana', 'Ben'] })],
          }),
          completeOrder({
            customer_name: 'Paolo Reyes',
            items: [completeItem({ product_slug: 'hojicha-latte', quantity: 1, level: 2 })],
            address: 'QC',
          }),
        ],
      })],
      ['missing customer', twoCustomerParsed({
        orders: [
          completeOrder({
            items: [completeItem({ product_slug: 'matcha-latte', quantity: 2, cup_names: ['Ana', 'Ben'] })],
          }),
        ],
      })],
      ['wrong quantity', twoCustomerParsed({
        orders: [
          completeOrder({
            items: [completeItem({ product_slug: 'matcha-latte', quantity: 1, cup_names: ['Ana', 'Ben'] })],
          }),
          completeOrder({
            customer_name: 'Paolo Reyes',
            items: [completeItem({ product_slug: 'hojicha-latte', quantity: 1, level: 2 })],
            address: 'QC',
          }),
        ],
      })],
      ['dropped cup name', twoCustomerParsed({
        orders: [
          completeOrder({
            items: [completeItem({ product_slug: 'matcha-latte', quantity: 2, cup_names: ['Ana'] })],
          }),
          completeOrder({
            customer_name: 'Paolo Reyes',
            items: [completeItem({ product_slug: 'hojicha-latte', quantity: 1, level: 2 })],
            address: 'QC',
          }),
        ],
      })],
      ['extra order', twoCustomerParsed({
        orders: [
          ...twoCustomerParsed().orders,
          completeOrder({ customer_name: 'Aira Cruz', address: 'BGC' }),
        ],
      })],
    ]
    for (const [label, parsed] of cases) {
      expect(essentialFieldsPass(parsed, fixture), label).toBe(false)
    }
  })

  it('does not pass on the first product alone', () => {
    const fixture = twoCustomerFixture()
    expect(essentialFieldsPass({
      orders: [completeOrder({
        items: [completeItem({ product_slug: 'matcha-latte', quantity: 2, cup_names: ['Ana', 'Ben'] })],
      })],
    }, fixture)).toBe(false)
  })

  it('requires thermal bags, unresolved flags, and refused sweetness when those fields are essential', () => {
    const thermal = openRouterBenchmarkFixtures.find((entry) => entry.name === 'thermal bag')
    const missingAddress = openRouterBenchmarkFixtures.find((entry) => entry.name === 'missing address')
    const flavored = openRouterBenchmarkFixtures.find((entry) => entry.name === 'flavored invalid sweetness')
    if (!thermal || !missingAddress || !flavored) throw new Error('Missing modifier fixtures')

    expect(essentialFieldsPass({
      orders: [completeOrder({
        customer_name: 'Mika',
        items: [completeItem({ product_slug: 'matcha-latte', quantity: 3, level: 1 })],
        thermal_bags: [{ covered_cup_count: 3 }],
        address: 'Makati',
      })],
    }, thermal)).toBe(true)
    expect(essentialFieldsPass({
      orders: [completeOrder({
        customer_name: 'Mika',
        items: [completeItem({ product_slug: 'matcha-latte', quantity: 3, level: 1 })],
        address: 'Makati',
      })],
    }, thermal)).toBe(false)

    expect(essentialFieldsPass({
      orders: [completeOrder({
        customer_name: 'Aira Cruz',
        items: [completeItem({ product_slug: 'salted-maple-hojicha', quantity: 1, level: 1 })],
        delivery_date: '2026-09-08',
        address: null,
        unresolved_fields: ['address'],
      })],
    }, missingAddress)).toBe(true)
    expect(essentialFieldsPass({
      orders: [completeOrder({
        customer_name: 'Aira Cruz',
        items: [completeItem({ product_slug: 'salted-maple-hojicha', quantity: 1, level: 1 })],
        delivery_date: '2026-09-08',
        address: null,
      })],
    }, missingAddress)).toBe(false)

    expect(essentialFieldsPass({
      orders: [completeOrder({
        customer_name: 'Paolo',
        items: [completeItem({ product_slug: 'strawberry-matcha', quantity: 1, sweetness: null })],
        address: 'Quezon City',
        unresolved_fields: ['sweetness is not allowed for flavored drinks'],
      })],
    }, flavored)).toBe(true)
    expect(essentialFieldsPass({
      orders: [completeOrder({
        customer_name: 'Paolo',
        items: [completeItem({ product_slug: 'strawberry-matcha', quantity: 1, sweetness: 'extra' })],
        address: 'Quezon City',
        unresolved_fields: ['sweetness is not allowed for flavored drinks'],
      })],
    }, flavored)).toBe(false)
  })
})

describe('finish_reason handling', () => {
  it('rejects refusal and truncated envelopes the same way production does', () => {
    const valid = twoCustomerParsed()
    expect(acceptProviderExtraction(providerEnvelope(valid))).toEqual({ ok: true, parsed: valid })
    expect(acceptProviderExtraction(providerEnvelope(valid, { refusal: 'cannot comply' })).ok).toBe(false)
    expect(acceptProviderExtraction({
      choices: [{ finish_reason: 'stop', message: { refusal: 'cannot comply', content: JSON.stringify(valid) } }],
    }).ok).toBe(false)
    expect(acceptProviderExtraction({
      choices: [{ finish_reason: 'length', message: { content: JSON.stringify(valid) } }],
    })).toEqual({ ok: false, error: 'truncated' })
    expect(acceptProviderExtraction({
      choices: [{ message: { content: JSON.stringify(valid) } }],
    }).ok).toBe(false)
    expect(acceptProviderExtraction({
      error: { message: 'quota' },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }],
    }).ok).toBe(false)
    expect(acceptProviderExtraction({
      error: null,
      choices: [{ finish_reason: 'stop', refusal: null, message: { refusal: null, content: JSON.stringify(valid) } }],
    })).toEqual({ ok: true, parsed: valid })
  })

  it('rejects truncated and refused payloads even when essential fields would otherwise pass', () => {
    const fixture = twoCustomerFixture()
    const valid = twoCustomerParsed()
    const truncated = acceptProviderExtraction({
      choices: [{ finish_reason: 'length', message: { content: JSON.stringify(valid) } }],
    })
    const refused = acceptProviderExtraction(providerEnvelope(valid, { refusal: 'no' }))
    expect(truncated.ok).toBe(false)
    expect(refused.ok).toBe(false)
    expect(essentialFieldsPass(valid, fixture)).toBe(true)
  })
})

function zeroPrice(overrides: Record<string, unknown> = {}) {
  return { prompt: '0', completion: '0', ...overrides }
}

describe('JSON capability', () => {
  it('requires response_format or structured_outputs, a pinned :free id, and zero prompt and completion price', () => {
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: zeroPrice(), architecture: { output_modalities: ['text'] } })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: zeroPrice(), supported_parameters: ['temperature'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: zeroPrice(), supported_parameters: ['response_format'] })).toBe('prov/a:free')
    expect(isJsonCapableFree({ id: 'prov/b:free', pricing: zeroPrice(), supported_parameters: ['structured_outputs'] })).toBe('prov/b:free')
    expect(isJsonCapableFree({
      id: 'prov/c:free',
      pricing: { prompt: 0, completion: '0.000000' },
      supported_parameters: ['response_format'],
      architecture: { output_modalities: ['text'] },
    })).toBe('prov/c:free')
    expect(isJsonCapableFree({ id: 'prov/a:free', supported_parameters: ['response_format'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: { prompt: '0' }, supported_parameters: ['response_format'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: { prompt: '0', completion: '0.000001' }, supported_parameters: ['response_format'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: { prompt: '1', completion: '0' }, supported_parameters: ['structured_outputs'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/a:free', pricing: { prompt: 'free', completion: '0' }, supported_parameters: ['response_format'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'anthropic/claude-3.5-sonnet', pricing: zeroPrice(), supported_parameters: ['response_format'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'openrouter/auto', pricing: zeroPrice(), supported_parameters: ['response_format'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'openrouter/auto:free', pricing: zeroPrice(), supported_parameters: ['structured_outputs'] })).toBeNull()
    expect(isJsonCapableFree({ id: 'prov/paid', pricing: zeroPrice(), supported_parameters: ['response_format'] })).toBeNull()
  })

  it('lists at most three live free JSON-capable candidates independent of provider order', async () => {
    const models = [
      { id: 'paid/model', pricing: zeroPrice(), supported_parameters: ['response_format'] },
      { id: 'openrouter/auto:free', pricing: zeroPrice(), supported_parameters: ['response_format'] },
      { id: 'prov/text:free', pricing: zeroPrice(), architecture: { output_modalities: ['text'] } },
      { id: 'prov/temp:free', pricing: zeroPrice(), supported_parameters: ['temperature'] },
      { id: 'prov/priced:free', pricing: { prompt: '0', completion: '0.000002' }, supported_parameters: ['response_format', 'structured_outputs'], context_length: 1_000_000 },
      { id: 'prov/one:free', pricing: zeroPrice(), supported_parameters: ['response_format'] },
      { id: 'prov/two:free', pricing: { prompt: '0.0', completion: 0 }, supported_parameters: ['structured_outputs'] },
      { id: 'prov/three:free', pricing: zeroPrice(), supported_parameters: ['response_format', 'structured_outputs'] },
      { id: 'prov/four:free', pricing: zeroPrice(), supported_parameters: ['response_format'] },
    ]
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: models,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const expected = ['prov/three:free', 'prov/four:free', 'prov/one:free']
    await expect(listFreeJsonCandidates('test-key')).resolves.toEqual(expected)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [...models].reverse() }), { status: 200 }))
    await expect(listFreeJsonCandidates('test-key')).resolves.toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses only an explicit live-listed JSON-capable free shortlist', async () => {
    const data = [
      { id: 'prov/one:free', pricing: zeroPrice(), supported_parameters: ['response_format'] },
      { id: 'prov/two:free', pricing: zeroPrice(), supported_parameters: ['structured_outputs'] },
      { id: 'prov/text:free', pricing: zeroPrice(), supported_parameters: ['temperature'] },
      { id: 'prov/priced:free', pricing: { prompt: '0', completion: '0.000002' }, supported_parameters: ['response_format'] },
    ]
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(listFreeJsonCandidates('test-key', ['prov/two:free', 'prov/one:free'])).resolves.toEqual(['prov/two:free', 'prov/one:free'])
    await expect(listFreeJsonCandidates('test-key', ['prov/text:free'])).resolves.toMatchObject({ error: expect.stringMatching(/not live-listed with JSON support/) })
    await expect(listFreeJsonCandidates('test-key', ['prov/priced:free'])).resolves.toMatchObject({ error: expect.stringMatching(/zero prompt and completion price/) })
    await expect(listFreeJsonCandidates('test-key', ['prov/missing:free'])).resolves.toMatchObject({ error: expect.stringMatching(/not live-listed/) })
    await expect(listFreeJsonCandidates('test-key', ['paid/model'])).resolves.toMatchObject({ error: expect.stringMatching(/pinned :free/) })
    await expect(listFreeJsonCandidates('test-key', ['prov/one:free', 'prov/one:free'])).resolves.toMatchObject({ error: expect.stringMatching(/distinct/) })
    await expect(listFreeJsonCandidates('test-key', ['prov/one:free', 'prov/two:free', 'prov/three:free', 'prov/four:free'])).resolves.toMatchObject({ error: expect.stringMatching(/at most 3/) })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('parses a maximum-three distinct pinned free shortlist before any network call', () => {
    expect(parseModelShortlist(undefined)).toEqual([])
    expect(parseModelShortlist(' prov/one:free , prov/two:free ')).toEqual(['prov/one:free', 'prov/two:free'])
    expect(parseModelShortlist('prov/one:free,prov/one:free')).toMatchObject({ error: expect.stringMatching(/distinct/) })
    expect(parseModelShortlist('openrouter/auto:free')).toMatchObject({ error: expect.stringMatching(/pinned :free/) })
    expect(parseModelShortlist('paid/model')).toMatchObject({ error: expect.stringMatching(/pinned :free/) })
    expect(parseModelShortlist('prov/a:free,prov/b:free,prov/c:free,prov/d:free')).toMatchObject({ error: expect.stringMatching(/one to 3/) })
  })
})

describe('benchmark output path and offline readiness', () => {
  it('stops a candidate after its first failed fixture to conserve free requests', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    vi.stubEnv('OPENROUTER_BENCHMARK_MODELS', 'prov/one:free')
    vi.stubEnv('OPENROUTER_BENCHMARK_OUT', join(tmpdir(), `openrouter-benchmark-${Date.now()}.json`))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'prov/one:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['response_format'] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const payload = await runBenchmark(['node', 'scripts/openrouter-benchmark.ts'])
    expect(payload.status).toBe('unresolved')
    expect(payload.results).toHaveLength(1)
    expect(payload.results[0].error).toBe('HTTP 429')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('resolves CLI, env, or a temp default and never a personal absolute path', () => {
    vi.stubEnv('OPENROUTER_BENCHMARK_OUT', '')
    expect(resolveOutputPath([])).toBe(join(tmpdir(), 'openrouter-benchmark.json'))
    expect(resolveOutputPath([])).not.toMatch(/\/Users\/tristandmac/)
    expect(resolveOutputPath(['--out', '/tmp/custom-or.json'])).toBe('/tmp/custom-or.json')
    expect(resolveOutputPath(['--out=./from-flag.json'])).toBe('./from-flag.json')
    expect(resolveOutputPath(['./from-arg.json'])).toBe('./from-arg.json')
    expect(resolveOutputPath([], 'from-env.json')).toBe('from-env.json')
  })

  it('prints unresolved readiness and makes no network calls when the API key is unset', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('OPENROUTER_BENCHMARK_OUT', join(tmpdir(), `openrouter-benchmark-${Date.now()}.json`))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    const payload = await runBenchmark(['node', 'scripts/openrouter-benchmark.ts'])
    expect(payload.status).toBe('unresolved')
    expect(payload.networkCalled).toBe(false)
    expect(payload.keyPresent).toBe(false)
    expect(payload.conversations).toBe(12)
    expect(payload.reason).toMatch(/OPENROUTER_API_KEY is unset/i)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/unresolved/i)
    expect(logs.join('\n')).not.toMatch(/sk-|OPENROUTER_API_KEY=\S+/)
  })
})

describe('latency measurement', () => {
  it('includes full body decode, JSON parse, and structural validation', async () => {
    const body = JSON.stringify(providerEnvelope(twoCustomerParsed()))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      async arrayBuffer() {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return new TextEncoder().encode(body).buffer
      },
    }))
    const result = await runConversation('test-key', 'prov/model:free', twoCustomerFixture())
    expect(result.ok).toBe(true)
    expect(result.latencyMs).toBeGreaterThanOrEqual(35)
  })

  it('rejects paid and auto model ids before any upstream call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(runConversation('test-key', 'openrouter/auto:free', twoCustomerFixture())).resolves.toMatchObject({
      ok: false,
      error: 'paid or auto model rejected',
    })
    await expect(runConversation('test-key', 'anthropic/claude-3.5-sonnet', twoCustomerFixture())).resolves.toMatchObject({
      ok: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
