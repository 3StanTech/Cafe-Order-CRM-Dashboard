/**
 * Host-neutral HTTP dispatcher for public order submissions.
 *
 * Netlify and Vercel adapters resolve a trusted client IP, then call this so
 * routing, auth, and cache headers cannot drift between hosts.
 */

import { authorizeExtractionRequest, createOwnerUserClient } from './parse-orders-auth'
import {
  acceptSubmission,
  createOrderServerClient,
  getPublicOrderMenu,
  listPendingSubmissions,
  MAX_SUBMISSION_BODY_BYTES,
  rejectSubmission,
  submitPublicOrder,
  updatePendingSubmission,
} from './order-submissions-core'

/** Same-origin only — no Access-Control-Allow-Origin wildcard. */
export const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
} as const

type CoreResult = { status: number; body: Record<string, unknown> }

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders })
}

function trimmedIp(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const ip = value.trim()
  return ip ? ip : null
}

/** Modern Netlify Context.ip only. Never x-forwarded-for. */
export function netlifyClientIp(context: unknown): string | null {
  if (context && typeof context === 'object' && 'ip' in context) {
    const ip = trimmedIp((context as { ip?: unknown }).ip)
    if (ip) return ip
  }
  return null
}

/** Vercel overwrites this header. Never fall back to x-forwarded-for. */
export function vercelClientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-vercel-forwarded-for')
  if (!forwarded) return null
  return trimmedIp(forwarded.split(',')[0])
}

function actionFrom(request: Request): string | null {
  try {
    return new URL(request.url).searchParams.get('action')
  } catch {
    return null
  }
}

function idFrom(request: Request): string {
  try {
    return new URL(request.url).searchParams.get('id') ?? ''
  } catch {
    return ''
  }
}

function contentLengthOverLimit(request: Request): boolean {
  const raw = request.headers.get('content-length')
  if (!raw) return false
  const length = Number(raw)
  return Number.isFinite(length) && length > MAX_SUBMISSION_BODY_BYTES
}

async function readBody(request: Request): Promise<{ oversized: true } | { oversized: false; body: string }> {
  if (contentLengthOverLimit(request)) return { oversized: true }
  return { oversized: false, body: await request.text() }
}

function requestHashFromBody(rawBody: string): string {
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'requestHash' in parsed) {
      const requestHash = (parsed as { requestHash: unknown }).requestHash
      return typeof requestHash === 'string' ? requestHash : ''
    }
  } catch {
    return ''
  }
  return ''
}

function accessTokenFromRequest(request: Request): string | null {
  const raw = request.headers.get('authorization')
  if (!raw) return null
  const match = /^Bearer\s+(\S+)/i.exec(raw.trim())
  return match?.[1] ?? null
}

async function withConfiguredClient(run: (client: NonNullable<ReturnType<typeof createOrderServerClient>>) => Promise<CoreResult>): Promise<Response> {
  const client = createOrderServerClient()
  if (!client) {
    return jsonResponse(503, { error: 'Online ordering is not configured.' })
  }
  const { status, body } = await run(client)
  return jsonResponse(status, body)
}

/** Owner JWT client for SELECT/RPCs that require auth.uid() = dashboard_owner_uid(). */
async function withOwnerUserClient(
  request: Request,
  run: (client: NonNullable<ReturnType<typeof createOwnerUserClient>>) => Promise<CoreResult>,
): Promise<Response> {
  const auth = await authorizeExtractionRequest(request.headers)
  if (!auth.ok) return jsonResponse(auth.status, auth.body)
  const token = accessTokenFromRequest(request)
  if (!token) return jsonResponse(401, { error: 'Authorization required.' })
  const client = createOwnerUserClient(token)
  if (!client) return jsonResponse(503, { error: 'Online ordering is not configured.' })
  const { status, body } = await run(client)
  return jsonResponse(status, body)
}

/** Service-role client after owner bearer auth. order_submissions has no authenticated UPDATE policy. */
async function withOwnerServiceClient(
  request: Request,
  run: (client: NonNullable<ReturnType<typeof createOrderServerClient>>) => Promise<CoreResult>,
): Promise<Response> {
  const auth = await authorizeExtractionRequest(request.headers)
  if (!auth.ok) return jsonResponse(auth.status, auth.body)
  return withConfiguredClient(run)
}

/**
 * Dispatch one order-submissions request. `clientIp` must already be a
 * host-trusted address or null — adapters must not pass x-forwarded-for.
 */
export async function handleOrderSubmissionsRequest(request: Request, clientIp: string | null): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: jsonHeaders })
  }

  const action = actionFrom(request)
  if (!action) {
    return jsonResponse(400, { error: 'Unknown order-submissions action.' })
  }

  switch (action) {
    case 'menu': {
      if (request.method !== 'GET') return jsonResponse(405, { error: 'Use GET to load the public menu.' })
      return withConfiguredClient((client) => getPublicOrderMenu(client))
    }
    case 'submit': {
      if (request.method !== 'POST') return jsonResponse(405, { error: 'Use POST to submit an order.' })
      const payload = await readBody(request)
      if (payload.oversized) return jsonResponse(413, { error: 'The order form is too large.' })
      return withConfiguredClient((client) => submitPublicOrder(client, payload.body, clientIp))
    }
    case 'pending': {
      if (request.method !== 'GET') return jsonResponse(405, { error: 'Use GET to list pending submissions.' })
      return withOwnerUserClient(request, (client) => listPendingSubmissions(client))
    }
    case 'update': {
      if (request.method !== 'POST') return jsonResponse(405, { error: 'Use POST to update a pending submission.' })
      const payload = await readBody(request)
      if (payload.oversized) return jsonResponse(413, { error: 'The order form is too large.' })
      return withOwnerServiceClient(request, (client) => updatePendingSubmission(client, idFrom(request), payload.body))
    }
    case 'accept': {
      if (request.method !== 'POST') return jsonResponse(405, { error: 'Use POST to accept a pending submission.' })
      const payload = await readBody(request)
      if (payload.oversized) return jsonResponse(413, { error: 'The order form is too large.' })
      return withOwnerUserClient(request, (client) => acceptSubmission(client, idFrom(request), requestHashFromBody(payload.body)))
    }
    case 'reject': {
      if (request.method !== 'POST') return jsonResponse(405, { error: 'Use POST to reject a pending submission.' })
      return withOwnerUserClient(request, (client) => rejectSubmission(client, idFrom(request)))
    }
    default:
      return jsonResponse(400, { error: 'Unknown order-submissions action.' })
  }
}
