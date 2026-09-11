import { afterEach, describe, expect, it, vi } from 'vitest'
import netlifyHandler from '../../netlify/functions/order-submissions'
import vercelHandler from '../../api/order-submissions'
import {
  acceptSubmission,
  createOrderServerClient,
  getPublicOrderMenu,
  listPendingSubmissions,
  rejectSubmission,
  submitPublicOrder,
  updatePendingSubmission,
} from '../order-submissions-core'
import { authorizeExtractionRequest, createOwnerUserClient } from '../parse-orders-auth'
import { handleOrderSubmissionsRequest } from '../order-submissions-http'

const fakeClient = { kind: 'order-server-client' }
const fakeOwnerClient = { kind: 'owner-user-client' }

vi.mock('../order-submissions-core', () => ({
  MAX_SUBMISSION_BODY_BYTES: 32 * 1024,
  createOrderServerClient: vi.fn(),
  getPublicOrderMenu: vi.fn(),
  submitPublicOrder: vi.fn(),
  listPendingSubmissions: vi.fn(),
  updatePendingSubmission: vi.fn(),
  acceptSubmission: vi.fn(),
  rejectSubmission: vi.fn(),
}))

vi.mock('../parse-orders-auth', () => ({
  authorizeExtractionRequest: vi.fn(async (headers: Headers) => {
    const authorization = headers.get('authorization')
    if (!authorization) {
      return { ok: false, status: 401, body: { error: 'Authorization required.' } }
    }
    return { ok: true }
  }),
  createOwnerUserClient: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

function configuredClient() {
  vi.mocked(createOrderServerClient).mockReturnValue(fakeClient as never)
}

function configuredOwnerClient() {
  vi.mocked(createOwnerUserClient).mockReturnValue(fakeOwnerClient as never)
}

function menuRequest() {
  return new Request('https://example.test/.netlify/functions/order-submissions?action=menu')
}

const submissionId = '11111111-1111-4111-8111-111111111111'

describe('order-submissions HTTP dispatcher', () => {
  it('serves the public menu on GET action=menu without auth', async () => {
    configuredClient()
    vi.mocked(getPublicOrderMenu).mockResolvedValue({
      status: 200,
      body: { quoteRevision: 'abc', products: [] },
    })

    const response = await handleOrderSubmissionsRequest(menuRequest(), null)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toEqual({ quoteRevision: 'abc', products: [] })
    expect(authorizeExtractionRequest).not.toHaveBeenCalled()
    expect(createOwnerUserClient).not.toHaveBeenCalled()
    expect(getPublicOrderMenu).toHaveBeenCalledWith(fakeClient)
  })

  it('submits with the host-trusted IP and never reads x-forwarded-for', async () => {
    configuredClient()
    vi.mocked(submitPublicOrder).mockResolvedValue({
      status: 201,
      body: { submitted: true, reference: 'GEL-1' },
    })
    const body = JSON.stringify({ customerName: 'Mika' })

    const response = await handleOrderSubmissionsRequest(
      new Request('https://example.test/.netlify/functions/order-submissions?action=submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.9',
        },
        body,
      }),
      '198.51.100.10',
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(submitPublicOrder).toHaveBeenCalledWith(fakeClient, body, '198.51.100.10')
    expect(createOwnerUserClient).not.toHaveBeenCalled()
  })

  it('requires owner auth for pending submissions', async () => {
    const response = await handleOrderSubmissionsRequest(
      new Request('https://example.test/.netlify/functions/order-submissions?action=pending'),
      null,
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ error: 'Authorization required.' })
    expect(listPendingSubmissions).not.toHaveBeenCalled()
    expect(createOrderServerClient).not.toHaveBeenCalled()
    expect(createOwnerUserClient).not.toHaveBeenCalled()
  })

  it('rejects a missing Authorization header on reject', async () => {
    const response = await handleOrderSubmissionsRequest(
      new Request(`https://example.test/.netlify/functions/order-submissions?action=reject&id=${submissionId}`, {
        method: 'POST',
      }),
      null,
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'Authorization required.' })
    expect(rejectSubmission).not.toHaveBeenCalled()
    expect(createOrderServerClient).not.toHaveBeenCalled()
    expect(createOwnerUserClient).not.toHaveBeenCalled()
  })

  it('rejects a missing Authorization header on accept', async () => {
    const response = await handleOrderSubmissionsRequest(
      new Request(`https://example.test/.netlify/functions/order-submissions?action=accept&id=${submissionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestHash: 'a'.repeat(64) }),
      }),
      null,
    )

    expect(response.status).toBe(401)
    expect(acceptSubmission).not.toHaveBeenCalled()
    expect(createOrderServerClient).not.toHaveBeenCalled()
    expect(createOwnerUserClient).not.toHaveBeenCalled()
  })

  it('returns 400 for an unknown action', async () => {
    const response = await handleOrderSubmissionsRequest(
      new Request('https://example.test/.netlify/functions/order-submissions?action=explode'),
      null,
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json()).error).toMatch(/unknown/i)
    expect(createOrderServerClient).not.toHaveBeenCalled()
    expect(createOwnerUserClient).not.toHaveBeenCalled()
  })

  it('returns 503 when the server client is not configured', async () => {
    vi.mocked(createOrderServerClient).mockReturnValue(null)

    const response = await handleOrderSubmissionsRequest(menuRequest(), null)

    expect(response.status).toBe(503)
    expect((await response.json()).error).toMatch(/not configured/i)
    expect(getPublicOrderMenu).not.toHaveBeenCalled()
  })
})

describe('order-submissions Netlify adapter', () => {
  it('passes Context.ip into submit and ignores x-forwarded-for', async () => {
    configuredClient()
    vi.mocked(submitPublicOrder).mockResolvedValue({ status: 201, body: { submitted: true } })

    const response = await netlifyHandler(
      new Request('https://example.test/.netlify/functions/order-submissions?action=submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.9',
        },
        body: '{"ok":true}',
      }),
      { ip: '198.51.100.10' } as never,
    )

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(submitPublicOrder).toHaveBeenCalledWith(fakeClient, '{"ok":true}', '198.51.100.10')
  })

  it('passes null when Context.ip is missing', async () => {
    configuredClient()
    vi.mocked(submitPublicOrder).mockResolvedValue({
      status: 503,
      body: { error: 'Online ordering is temporarily unavailable.' },
    })

    await netlifyHandler(
      new Request('https://example.test/.netlify/functions/order-submissions?action=submit', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.9' },
        body: '{}',
      }),
      {} as never,
    )

    expect(submitPublicOrder).toHaveBeenCalledWith(fakeClient, '{}', null)
  })
})

describe('order-submissions Vercel adapter', () => {
  it('uses x-vercel-forwarded-for only', async () => {
    configuredClient()
    vi.mocked(submitPublicOrder).mockResolvedValue({ status: 201, body: { submitted: true } })

    const response = await vercelHandler(new Request('https://example.test/api/order-submissions?action=submit', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vercel-forwarded-for': '198.51.100.20, 127.0.0.1',
        'x-forwarded-for': '203.0.113.9',
      },
      body: '{"ok":true}',
    }))

    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(submitPublicOrder).toHaveBeenCalledWith(fakeClient, '{"ok":true}', '198.51.100.20')
  })

  it('passes null when the Vercel IP header is absent', async () => {
    configuredClient()
    vi.mocked(submitPublicOrder).mockResolvedValue({
      status: 503,
      body: { error: 'Online ordering is temporarily unavailable.' },
    })

    await vercelHandler(new Request('https://example.test/api/order-submissions?action=submit', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      body: '{}',
    }))

    expect(submitPublicOrder).toHaveBeenCalledWith(fakeClient, '{}', null)
  })
})

describe('order-submissions owner write wiring', () => {
  it('lists pending submissions with the owner user client after auth', async () => {
    configuredOwnerClient()
    vi.mocked(listPendingSubmissions).mockResolvedValue({ status: 200, body: { submissions: [] } })

    const response = await handleOrderSubmissionsRequest(
      new Request('https://example.test/.netlify/functions/order-submissions?action=pending', {
        headers: { authorization: 'Bearer owner-token' },
      }),
      null,
    )

    expect(response.status).toBe(200)
    expect(createOwnerUserClient).toHaveBeenCalledWith('owner-token')
    expect(listPendingSubmissions).toHaveBeenCalledWith(fakeOwnerClient)
    expect(createOrderServerClient).not.toHaveBeenCalled()
  })

  it('forwards accept requestHash after owner auth with the owner user client', async () => {
    configuredOwnerClient()
    vi.mocked(acceptSubmission).mockResolvedValue({ status: 200, body: { accepted: true } })

    const requestHash = 'a'.repeat(64)
    const response = await handleOrderSubmissionsRequest(
      new Request(`https://example.test/.netlify/functions/order-submissions?action=accept&id=${submissionId}`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
        body: JSON.stringify({ requestHash }),
      }),
      null,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(createOwnerUserClient).toHaveBeenCalledWith('owner-token')
    expect(acceptSubmission).toHaveBeenCalledWith(fakeOwnerClient, submissionId, requestHash)
    expect(createOrderServerClient).not.toHaveBeenCalled()
    expect(updatePendingSubmission).not.toHaveBeenCalled()
  })

  it('rejects with the owner user client after owner auth', async () => {
    configuredOwnerClient()
    vi.mocked(rejectSubmission).mockResolvedValue({ status: 200, body: { rejected: true } })

    const response = await handleOrderSubmissionsRequest(
      new Request(`https://example.test/.netlify/functions/order-submissions?action=reject&id=${submissionId}`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token' },
      }),
      null,
    )

    expect(response.status).toBe(200)
    expect(createOwnerUserClient).toHaveBeenCalledWith('owner-token')
    expect(rejectSubmission).toHaveBeenCalledWith(fakeOwnerClient, submissionId)
    expect(createOrderServerClient).not.toHaveBeenCalled()
  })

  it('updates a pending submission with the service-role client after owner auth', async () => {
    configuredClient()
    const body = JSON.stringify({ expectedReviewVersion: 0, expectedReviewHash: 'b'.repeat(64) })
    vi.mocked(updatePendingSubmission).mockResolvedValue({ status: 200, body: { updated: true } })

    const response = await handleOrderSubmissionsRequest(
      new Request(`https://example.test/.netlify/functions/order-submissions?action=update&id=${submissionId}`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
        body,
      }),
      null,
    )

    expect(response.status).toBe(200)
    expect(authorizeExtractionRequest).toHaveBeenCalled()
    expect(updatePendingSubmission).toHaveBeenCalledWith(fakeClient, submissionId, body)
    expect(createOrderServerClient).toHaveBeenCalled()
    expect(createOwnerUserClient).not.toHaveBeenCalled()
  })

  it('returns 503 when the owner user client is not configured', async () => {
    vi.mocked(createOwnerUserClient).mockReturnValue(null)

    const response = await handleOrderSubmissionsRequest(
      new Request(`https://example.test/.netlify/functions/order-submissions?action=accept&id=${submissionId}`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' },
        body: JSON.stringify({ requestHash: 'a'.repeat(64) }),
      }),
      null,
    )

    expect(response.status).toBe(503)
    expect((await response.json()).error).toMatch(/not configured/i)
    expect(acceptSubmission).not.toHaveBeenCalled()
    expect(createOrderServerClient).not.toHaveBeenCalled()
  })
})
