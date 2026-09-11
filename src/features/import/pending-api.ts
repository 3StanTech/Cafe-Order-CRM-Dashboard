import { useEffect, useState } from 'react'
import { getAuthClient } from '../auth/supabaseAuth'
import { getReconfirmation, PublicOrderApiError, type PublicOrderInput, type PublicOrderReconfirmation } from '../public-order/api'

export const OWNER_SUBMISSIONS_ENDPOINT = '/.netlify/functions/order-submissions'

export type PendingSubmissionRow = {
  id: string
  reference: string
  idempotency_key: string
  request_hash: string
  quote_revision: string
  review_hash: string
  review_version: number
  status: 'pending' | 'accepted' | 'rejected'
  customer_name: string
  customer_phone: string
  address_snapshot: string
  delivery_date: string
  notes: string | null
  items: unknown
  thermal_bags: unknown
  catalog_snapshot: unknown
  priced_items: unknown
  subtotal_centavos: number
  delivery_fee_centavos: number
  total_centavos: number
  submitted_snapshot: unknown
  accepted_order_id: string | null
  created_at: string
  updated_at: string
}

export type PendingUpdateResult = {
  submission: PendingSubmissionRow
  previousTotalCentavos: number
  newTotalCentavos: number
  differenceCentavos: number
}

export class PendingSubmissionApiError extends Error {
  readonly status: number
  readonly payload: unknown

  constructor(status: number, message: string, payload: unknown) {
    super(message)
    this.name = 'PendingSubmissionApiError'
    this.status = status
    this.payload = payload
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isSafeCentavos(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function ownerAccessToken(): Promise<string | null> {
  const client = getAuthClient()
  if (!client) return null
  try {
    const { data } = await client.auth.getSession()
    const session = data.session
    const token = session?.access_token
    const email = session?.user?.email
    if (!token || typeof email !== 'string' || !email.trim()) return null
    return token
  } catch {
    return null
  }
}

function actionUrl(action: string, id?: string): string {
  const params = new URLSearchParams({ action })
  if (id) params.set('id', id)
  return `${OWNER_SUBMISSIONS_ENDPOINT}?${params.toString()}`
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new PendingSubmissionApiError(response.status, 'The submissions service returned an unreadable response.', null)
  }
}

function serverMessage(payload: unknown, fallback: string): string {
  return isRecord(payload) && isString(payload.error) && payload.error.trim() ? payload.error : fallback
}

function parseRow(value: unknown): PendingSubmissionRow | null {
  if (!isRecord(value)) return null
  if (!isString(value.id) || !isString(value.reference) || !isString(value.idempotency_key)) return null
  if (!isString(value.request_hash) || !isString(value.quote_revision)) return null
  if (!isString(value.review_hash) || !Number.isSafeInteger(value.review_version)) return null
  if (value.status !== 'pending' && value.status !== 'accepted' && value.status !== 'rejected') return null
  if (!isString(value.customer_name) || !isString(value.customer_phone) || !isString(value.address_snapshot)) return null
  if (!isString(value.delivery_date) || (value.notes !== null && !isString(value.notes))) return null
  if (!isSafeCentavos(value.subtotal_centavos) || !isSafeCentavos(value.delivery_fee_centavos) || !isSafeCentavos(value.total_centavos)) return null
  if (!isString(value.created_at) || !isString(value.updated_at)) return null
  if (value.accepted_order_id !== null && !isString(value.accepted_order_id)) return null
  return {
    id: value.id,
    reference: value.reference,
    idempotency_key: value.idempotency_key,
    request_hash: value.request_hash,
    quote_revision: value.quote_revision,
    review_hash: value.review_hash,
    review_version: value.review_version as number,
    status: value.status,
    customer_name: value.customer_name,
    customer_phone: value.customer_phone,
    address_snapshot: value.address_snapshot,
    delivery_date: value.delivery_date,
    notes: value.notes,
    items: value.items,
    thermal_bags: value.thermal_bags,
    catalog_snapshot: value.catalog_snapshot,
    priced_items: value.priced_items,
    subtotal_centavos: value.subtotal_centavos,
    delivery_fee_centavos: value.delivery_fee_centavos,
    total_centavos: value.total_centavos,
    submitted_snapshot: value.submitted_snapshot,
    accepted_order_id: value.accepted_order_id,
    created_at: value.created_at,
    updated_at: value.updated_at,
  }
}

async function ownerFetch(url: string, init: RequestInit): Promise<unknown> {
  const token = await ownerAccessToken()
  if (!token) throw new PendingSubmissionApiError(401, 'Sign in is required to review pending submissions.', null)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error('The submissions service could not be reached.')
  }
  const payload = await readJson(response)
  if (!response.ok) throw new PendingSubmissionApiError(response.status, serverMessage(payload, 'The pending submission could not be updated.'), payload)
  return payload
}

export async function listPendingSubmissions(): Promise<PendingSubmissionRow[]> {
  const token = await ownerAccessToken()
  if (!token) return []
  const payload = await ownerFetch(actionUrl('pending'), { method: 'GET' })
  if (!isRecord(payload) || !Array.isArray(payload.submissions)) {
    throw new PendingSubmissionApiError(200, 'The submissions service returned an invalid pending list.', payload)
  }
  const rows = payload.submissions.map(parseRow)
  if (rows.some((row) => row === null)) {
    throw new PendingSubmissionApiError(200, 'The submissions service returned an invalid pending list.', payload)
  }
  return rows as PendingSubmissionRow[]
}

export async function acceptPendingSubmission(id: string, requestHash: string): Promise<unknown> {
  return ownerFetch(actionUrl('accept', id), {
    method: 'POST',
    body: JSON.stringify({ requestHash }),
  })
}

export async function rejectPendingSubmission(id: string): Promise<unknown> {
  return ownerFetch(actionUrl('reject', id), { method: 'POST' })
}

export async function updatePendingSubmission(
  id: string,
  input: PublicOrderInput & { expectedReviewVersion: number; expectedReviewHash: string },
): Promise<PendingUpdateResult> {
  const payload = await ownerFetch(actionUrl('update', id), {
    method: 'POST',
    body: JSON.stringify(input),
  })
  if (!isRecord(payload) || !isSafeCentavos(payload.previousTotalCentavos) || !isSafeCentavos(payload.newTotalCentavos) || typeof payload.differenceCentavos !== 'number' || !Number.isSafeInteger(payload.differenceCentavos)) {
    throw new PendingSubmissionApiError(200, 'The submissions service returned an invalid edit result.', payload)
  }
  const submission = parseRow(payload.submission)
  if (!submission) throw new PendingSubmissionApiError(200, 'The submissions service returned an invalid edit result.', payload)
  return {
    submission,
    previousTotalCentavos: payload.previousTotalCentavos,
    newTotalCentavos: payload.newTotalCentavos,
    differenceCentavos: payload.differenceCentavos,
  }
}

export function submittedSnapshotTotalCentavos(snapshot: unknown): number | null {
  if (!isRecord(snapshot)) return null
  if (isSafeCentavos(snapshot.quotedTotalCentavos)) return snapshot.quotedTotalCentavos
  if (isSafeCentavos(snapshot.total)) return snapshot.total
  if (isSafeCentavos(snapshot.total_centavos)) return snapshot.total_centavos
  return null
}

export function pendingSubmissionErrorMessage(error: unknown): string {
  if (error instanceof PendingSubmissionApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return 'Pending submissions could not be loaded.'
}

export function getPendingReconfirmation(error: unknown): PublicOrderReconfirmation | null {
  if (!(error instanceof PendingSubmissionApiError) || error.status !== 409) return null
  return getReconfirmation(new PublicOrderApiError(error.status, error.message, error.payload))
}

/** Count for Today or other owner surfaces. Returns null when unsigned-in or the list cannot be read. */
export function usePendingSubmissionCount(): number | null {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined

    const refresh = async () => {
      try {
        const rows = await listPendingSubmissions()
        if (active) setCount(rows.length)
      } catch {
        if (active) setCount(null)
      }
    }

    const startPolling = () => {
      void refresh()
      if (timer) clearInterval(timer)
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') void refresh()
      }, 30_000)
    }

    startPolling()
    const onFocus = () => { void refresh() }
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      if (timer) clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return count
}
