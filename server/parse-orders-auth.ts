/**
 * Host-neutral authorization for the paid order-extraction endpoint.
 *
 * Both Netlify and Vercel wrappers must call this before extractOrders so the
 * two hosts cannot drift. Tokens are never logged.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { DASHBOARD_AUTH_EMAIL } from './dashboard-auth-email'

export { DASHBOARD_AUTH_EMAIL }

export type AuthResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string } }

type EnvBag = { process?: { env?: Record<string, string | undefined> } }

function env(name: string): string | undefined {
  const value = (globalThis as typeof globalThis & EnvBag).process?.env?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Netlify exposes the existing VITE-prefixed Supabase values to Functions scope.
 * Keep one literal configuration path so client and function deployments cannot drift.
 */
export function supabaseServerConfig(): { url: string; anonKey: string } | null {
  const url = env('VITE_SUPABASE_URL')
  const anonKey = env('VITE_SUPABASE_ANON_KEY')
  if (!url || !anonKey) return null
  return { url, anonKey }
}

/**
 * Authenticated owner client. PostgREST receives the user JWT so auth.uid()
 * matches dashboard_owner_uid() on accept/reject RPCs. Fails closed without
 * anon config or an access token. Never uses the service-role key.
 */
export function createOwnerUserClient(token: string): SupabaseClient | null {
  const config = supabaseServerConfig()
  const accessToken = token.trim()
  if (!config || !accessToken) return null
  return createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: config.anonKey,
      },
    },
    accessToken: async () => accessToken,
  })
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name)
    return value === null ? undefined : value
  }
  const record = headers as Record<string, string | string[] | undefined>
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== lower) continue
    if (Array.isArray(value)) return value[0]
    return value
  }
  return undefined
}

function bearerToken(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
): string | null {
  const raw = headerValue(headers, 'authorization')
  if (!raw) return null
  const match = /^Bearer\s+(\S+)/i.exec(raw.trim())
  return match?.[1] ?? null
}

/**
 * Validates Authorization: Bearer <Supabase access token> and requires the
 * authenticated email to be the dashboard owner. Fails closed on missing
 * Supabase config or any validation failure.
 */
export async function authorizeExtractionRequest(
  headers: Headers | Record<string, string | string[] | undefined> | null | undefined,
): Promise<AuthResult> {
  const config = supabaseServerConfig()
  if (!config) {
    return { ok: false, status: 503, body: { error: 'Extraction authorization is not configured.' } }
  }

  const token = bearerToken(headers)
  if (!token) {
    return { ok: false, status: 401, body: { error: 'Authorization required.' } }
  }

  try {
    const client = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data, error } = await client.auth.getUser(token)
    if (error || !data.user?.email) {
      return { ok: false, status: 401, body: { error: 'Invalid or expired session.' } }
    }
    if (data.user.email.toLowerCase() !== DASHBOARD_AUTH_EMAIL.toLowerCase()) {
      return { ok: false, status: 403, body: { error: 'Not authorized for extraction.' } }
    }
    return { ok: true }
  } catch {
    return { ok: false, status: 401, body: { error: 'Invalid or expired session.' } }
  }
}
