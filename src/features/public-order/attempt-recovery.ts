import type { PublicOrderDelivery, PublicOrderDraftItem, PublicOrderInput } from './api'

export const PUBLIC_ORDER_ATTEMPT_STORAGE_KEY = 'gelly-public-order-attempt-v1'
export const PUBLIC_ORDER_ATTEMPT_TTL_MS = 45 * 60 * 1000

export type PublicOrderAttempt = {
  idempotencyKey: string
  payload: PublicOrderInput
  uncertain: boolean
  savedAt: number
}

const PRODUCT_SLUGS = new Set([
  'matcha-latte',
  'strawberry-matcha',
  'salted-maple-matcha',
  'hojicha-latte',
  'strawberry-hojicha',
  'salted-maple-hojicha',
])

function sessionStore(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProductSlug(value: unknown): value is PublicOrderDraftItem['productSlug'] {
  return typeof value === 'string' && PRODUCT_SLUGS.has(value)
}

function parseItem(value: unknown): PublicOrderDraftItem | null {
  if (!isRecord(value) || !isProductSlug(value.productSlug) || !Number.isSafeInteger(value.quantity) || (value.quantity as number) < 1) return null
  const modifiers = value.modifiers
  if (!isRecord(modifiers) || ![1, 2, 3].includes(modifiers.level as number) || (modifiers.powder !== 'yumeno' && modifiers.powder !== 'mk_isuzu')) return null
  if (modifiers.sweetness !== undefined && modifiers.sweetness !== 'none' && modifiers.sweetness !== 'light' && modifiers.sweetness !== 'regular' && modifiers.sweetness !== 'extra') return null
  const item: PublicOrderDraftItem = {
    productSlug: value.productSlug,
    quantity: value.quantity as number,
    modifiers: {
      level: modifiers.level as 1 | 2 | 3,
      powder: modifiers.powder,
      ...(modifiers.sweetness ? { sweetness: modifiers.sweetness } : {}),
    },
  }
  if (value.cupNames === undefined) return item
  if (!Array.isArray(value.cupNames) || value.cupNames.some((name) => typeof name !== 'string')) return null
  return { ...item, cupNames: value.cupNames.map((name) => name.trim()).filter(Boolean) }
}

function parseBag(value: unknown): PublicOrderInput['thermalBags'][number] | null {
  if (!isRecord(value) || ![1, 2, 3, 4].includes(value.coveredCupCount as number)) return null
  return { coveredCupCount: value.coveredCupCount as 1 | 2 | 3 | 4 }
}

function parsePayload(value: unknown): PublicOrderInput | null {
  if (!isRecord(value)) return null
  if (typeof value.customerName !== 'string' || typeof value.customerPhone !== 'string' || typeof value.address !== 'string') return null
  if (typeof value.deliveryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.deliveryDate)) return null
  if (value.notes !== null && typeof value.notes !== 'string') return null
  if (typeof value.quoteRevision !== 'string' || !/^[0-9a-f]{64}$/i.test(value.quoteRevision)) return null
  if (!Number.isSafeInteger(value.quotedTotalCentavos) || (value.quotedTotalCentavos as number) < 0) return null
  if (typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,100}$/.test(value.idempotencyKey)) return null
  if (typeof value.honeypot !== 'string') return null
  if (!Array.isArray(value.items) || value.items.length === 0) return null
  const items = value.items.map(parseItem)
  if (items.some((item) => item === null)) return null
  if (!Array.isArray(value.thermalBags)) return null
  const thermalBags = value.thermalBags.map(parseBag)
  if (thermalBags.some((bag) => bag === null)) return null
  return {
    customerName: value.customerName,
    customerPhone: value.customerPhone,
    address: value.address,
    deliveryDate: value.deliveryDate,
    notes: value.notes,
    items: items as PublicOrderDraftItem[],
    thermalBags: thermalBags as PublicOrderInput['thermalBags'],
    quoteRevision: value.quoteRevision,
    quotedTotalCentavos: value.quotedTotalCentavos as number,
    idempotencyKey: value.idempotencyKey,
    honeypot: value.honeypot,
  }
}

function parseAttempt(value: unknown): PublicOrderAttempt | null {
  if (!isRecord(value) || typeof value.idempotencyKey !== 'string' || typeof value.uncertain !== 'boolean' || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
  const payload = parsePayload(value.payload)
  if (!payload || payload.idempotencyKey !== value.idempotencyKey) return null
  return { idempotencyKey: value.idempotencyKey, payload, uncertain: value.uncertain, savedAt: value.savedAt }
}

export function readPublicOrderAttempt(now = Date.now()): PublicOrderAttempt | null {
  const storage = sessionStore()
  if (!storage) return null
  try {
    const raw = storage.getItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)
    if (!raw) return null
    const parsed = parseAttempt(JSON.parse(raw) as unknown)
    if (!parsed || parsed.savedAt > now || now - parsed.savedAt > PUBLIC_ORDER_ATTEMPT_TTL_MS) {
      storage.removeItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    try { storage.removeItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY) } catch { /* best effort */ }
    return null
  }
}

export function savePublicOrderAttempt(attempt: PublicOrderAttempt): void {
  const storage = sessionStore()
  if (!storage) return
  try {
    storage.setItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY, JSON.stringify({
      idempotencyKey: attempt.idempotencyKey,
      payload: attempt.payload,
      uncertain: attempt.uncertain,
      savedAt: attempt.savedAt,
    }))
  } catch {
    // Session storage can be unavailable in private browsing. The in-memory retry still works.
  }
}

/**
 * The delivery day to show after a reload: the saved attempt's day while it is
 * still offered, otherwise the first offered day.
 */
export function restoredDeliveryDate(attempt: PublicOrderAttempt | null, options: readonly PublicOrderDelivery[]): string | null {
  const saved = attempt?.payload.deliveryDate
  if (saved && options.some((option) => option.deliveryDate === saved)) return saved
  return options[0]?.deliveryDate ?? null
}

export function clearPublicOrderAttempt(): void {
  const storage = sessionStore()
  if (!storage) return
  try { storage.removeItem(PUBLIC_ORDER_ATTEMPT_STORAGE_KEY) } catch { /* best effort */ }
}
