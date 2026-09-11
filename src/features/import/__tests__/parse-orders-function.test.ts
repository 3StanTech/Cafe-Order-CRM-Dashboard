import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handler as netlifyHandler } from '../../../../netlify/functions/parse-orders'
import vercelHandler from '../../../../api/parse-orders'
import { DASHBOARD_AUTH_EMAIL } from '../../../../server/dashboard-auth-email'
import {
  OPENROUTER_TIMEOUT_MS,
  extractOrders,
  MAX_RAW_BODY_BYTES,
  MAX_RAW_TEXT_CHARS,
} from '../../../../server/parse-orders-core'
import { DASHBOARD_AUTH_EMAIL as clientOwnerEmail } from '../../auth/supabaseAuth'

const OWNER_TOKEN = 'owner-access-token'
const OTHER_TOKEN = 'other-access-token'

const getUserMock = vi.fn()

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>()
  return {
    ...actual,
    createClient: vi.fn(() => ({
      auth: {
        getUser: getUserMock,
      },
    })),
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  getUserMock.mockReset()
})

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

function configuredEnv() {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
  vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key')
}

function ownerUser() {
  getUserMock.mockResolvedValue({ data: { user: { email: DASHBOARD_AUTH_EMAIL } }, error: null })
}

function otherUser() {
  getUserMock.mockResolvedValue({ data: { user: { email: 'intruder@example.com' } }, error: null })
}

function invalidUser() {
  getUserMock.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } })
}

const sampleStructure = {
  choices: [{
    finish_reason: 'stop',
    message: { role: 'assistant', content: '{"orders":[{"customer_name":"Mika","items":[{"product_slug":"matcha-latte","quantity":1,"level":1,"powder":"yumeno","sweetness":null,"cup_names":[]}],"thermal_bags":[],"delivery_date":null,"address":"Makati","notes":null,"source_confidence":0.9,"unresolved_fields":[]}]}' },
  }],
}

describe('dashboard owner email lockstep', () => {
  it('keeps client PIN auth email identical to the extraction auth gate', () => {
    expect(clientOwnerEmail).toBe(DASHBOARD_AUTH_EMAIL)
  })
})

describe('parse-orders Netlify function authorization', () => {
  it('fails closed when Supabase server config is missing', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key')
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    vi.stubEnv('VITE_SUPABASE_URL', '')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: authHeaders(OWNER_TOKEN),
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 503 })
    expect(JSON.parse((response as { body: string }).body).error).toMatch(/not configured/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects missing Authorization header', async () => {
    configuredEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 401 })
    expect(JSON.parse((response as { body: string }).body).error).toMatch(/authorization required/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a malformed Authorization header', async () => {
    configuredEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: { authorization: 'Basic abc' },
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid or expired token', async () => {
    configuredEnv()
    invalidUser()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: authHeaders(OWNER_TOKEN),
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 401 })
    expect(JSON.parse((response as { body: string }).body).error).toMatch(/invalid or expired/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a valid token for a non-owner email', async () => {
    configuredEnv()
    otherUser()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: authHeaders(OTHER_TOKEN),
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 403 })
    expect(JSON.parse((response as { body: string }).body).error).toMatch(/not authorized/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a clear configuration error and makes no upstream call without the OpenRouter key', async () => {
    configuredEnv()
    ownerUser()
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: authHeaders(OWNER_TOKEN),
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 503 })
    expect(JSON.parse((response as { body: string }).body).error).toMatch(/not configured/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the structural schema to a pinned free OpenRouter model and returns validated structure', async () => {
    configuredEnv()
    ownerUser()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sampleStructure), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: authHeaders(OWNER_TOKEN),
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte, Makati' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 200 })
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(request.model).toBe('provider/model:free')
    expect(request.max_tokens).toBe(2400)
    expect(request.messages[0].content).toContain('unresolved_fields')
    expect(request.messages[0].content).not.toMatch(/price|total/i)
    expect(request.response_format).toEqual({ type: 'json_object' })
    expect(request.provider).toMatchObject({ data_collection: 'deny', sort: 'latency', require_parameters: true })
  })

  it('does not emit Access-Control-Allow-Origin', async () => {
    configuredEnv()
    ownerUser()
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: authHeaders(OWNER_TOKEN),
      body: JSON.stringify({ raw_text: 'x' }),
    } as never, {} as never)
    const responseHeaders = (response as { headers?: Record<string, string> }).headers ?? {}
    expect(responseHeaders['access-control-allow-origin']).toBeUndefined()
  })

  it('rejects Content-Length over 64 KiB before extraction', async () => {
    configuredEnv()
    ownerUser()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await netlifyHandler({
      httpMethod: 'POST',
      headers: { ...authHeaders(OWNER_TOKEN), 'content-length': String(MAX_RAW_BODY_BYTES + 1) },
      body: JSON.stringify({ raw_text: 'small' }),
    } as never, {} as never)
    expect(response).toMatchObject({ statusCode: 413 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('parse-orders Vercel adapter authorization', () => {
  it('rejects missing Authorization', async () => {
    configuredEnv()
    const response = await vercelHandler(new Request('https://example.test/api/parse-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ raw_text: 'Mika: one matcha' }),
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('rejects wrong-owner token', async () => {
    configuredEnv()
    otherUser()
    const response = await vercelHandler(new Request('https://example.test/api/parse-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OTHER_TOKEN}` },
      body: JSON.stringify({ raw_text: 'Mika: one matcha' }),
    }))
    expect(response.status).toBe(403)
  })

  it('accepts a valid owner token and proxies extraction', async () => {
    configuredEnv()
    ownerUser()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sampleStructure), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await vercelHandler(new Request('https://example.test/api/parse-orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` },
      body: JSON.stringify({ raw_text: 'Mika: one matcha latte, Makati' }),
    }))
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('rejects Content-Length over the limit without calling OpenRouter', async () => {
    configuredEnv()
    ownerUser()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const response = await vercelHandler(new Request('https://example.test/api/parse-orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-length': String(MAX_RAW_BODY_BYTES + 10),
      },
      body: JSON.stringify({ raw_text: 'x' }),
    }))
    expect(response.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('extractOrders bounds', () => {
  beforeEach(() => {
    getUserMock.mockReset()
  })

  it('rejects a raw body over 64 KiB after reading', async () => {
    const rawBody = JSON.stringify({ raw_text: 'x'.repeat(MAX_RAW_BODY_BYTES) })
    expect(rawBody.length).toBeGreaterThan(MAX_RAW_BODY_BYTES)
    const result = await extractOrders(rawBody, 'test-key')
    expect(result).toMatchObject({ status: 413 })
    expect((result.body as { error: string }).error).toMatch(/too large/i)
  })

  it('rejects raw_text over 50,000 characters', async () => {
    const result = await extractOrders(JSON.stringify({ raw_text: 'a'.repeat(MAX_RAW_TEXT_CHARS + 1) }), 'test-key')
    expect(result).toMatchObject({ status: 413 })
    expect((result.body as { error: string }).error).toMatch(/maximum length/i)
  })

  it('aborts a hung OpenRouter fetch after the timeout and returns 504', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
      const pending = extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
      await vi.advanceTimersByTimeAsync(OPENROUTER_TIMEOUT_MS)
      const result = await pending
      expect(result).toMatchObject({ status: 504 })
      expect((result.body as { error: string }).error).toMatch(/timed out/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the bounded 2,400 output-token cap on successful requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sampleStructure), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.max_tokens).toBe(2400)
  })

  it('rejects a missing or non-stop finish reason as incomplete', async () => {
    for (const finishReason of [undefined, 'length']) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        choices: [{ ...(finishReason ? { finish_reason: finishReason } : {}), message: { content: sampleStructure.choices[0].message.content } }],
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
      const result = await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
      expect(result).toMatchObject({ status: 502 })
      expect((result.body as { error: string }).error).toMatch(/incomplete/i)
    }
  })

  it('rejects provider error and refusal envelopes even when they include text', async () => {
    for (const payload of [
      { error: { message: 'quota' }, choices: [{ finish_reason: 'stop', message: { content: sampleStructure.choices[0].message.content } }] },
      { choices: [{ finish_reason: 'stop', refusal: 'cannot comply', message: { content: sampleStructure.choices[0].message.content } }] },
      { choices: [{ finish_reason: 'stop', message: { refusal: 'cannot comply', content: sampleStructure.choices[0].message.content } }] },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
      const result = await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
      expect(result).toMatchObject({ status: 502 })
    }
  })

  it('accepts optional null error and refusal fields when the response is complete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: null,
      choices: [{ finish_reason: 'stop', refusal: null, message: { refusal: null, content: sampleStructure.choices[0].message.content } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    expect(await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')).toMatchObject({ status: 200 })
  })

  it('rejects structurally invalid scalar values and impossible dates', async () => {
    const invalid = JSON.parse(sampleStructure.choices[0].message.content)
    invalid.orders[0].delivery_date = 'tomorrow'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalid) } }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model:free')
    const result = await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')
    expect(result).toMatchObject({ status: 502 })
  })

  it('fails closed for an absent or paid OpenRouter model before making an upstream call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('OPENROUTER_MODEL', '')
    expect(await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')).toMatchObject({ status: 503 })
    vi.stubEnv('OPENROUTER_MODEL', 'provider/model')
    expect(await extractOrders(JSON.stringify({ raw_text: 'Mika: one matcha' }), 'test-key')).toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
