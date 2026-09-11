const REMEMBERED_DETAILS_KEY = 'public-order-details-v1'

export type RememberedPublicOrderDetails = {
  customerName: string
  customerPhone: string
  address: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maximum ? trimmed : null
}

export function readRememberedPublicOrderDetails(storage: Storage | null | undefined): RememberedPublicOrderDetails | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(REMEMBERED_DETAILS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const customerName = storedText(parsed.customerName, 120)
    const customerPhone = storedText(parsed.customerPhone, 40)
    const address = storedText(parsed.address, 300)
    return customerName && customerPhone && address ? { customerName, customerPhone, address } : null
  } catch {
    return null
  }
}

export function saveRememberedPublicOrderDetails(storage: Storage | null | undefined, details: RememberedPublicOrderDetails): void {
  if (!storage) return
  try {
    storage.setItem(REMEMBERED_DETAILS_KEY, JSON.stringify({
      customerName: details.customerName.trim().slice(0, 120),
      customerPhone: details.customerPhone.trim().slice(0, 40),
      address: details.address.trim().slice(0, 300),
    }))
  } catch {
    // Storage can be unavailable in private browsing. The form still works.
  }
}

export function clearRememberedPublicOrderDetails(storage: Storage | null | undefined): void {
  if (!storage) return
  try { storage.removeItem(REMEMBERED_DETAILS_KEY) } catch { /* best effort */ }
}
