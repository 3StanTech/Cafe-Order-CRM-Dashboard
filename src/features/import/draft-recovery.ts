import type { ImportDraft } from './types'
import type { OrderConfirmationInput } from '../../data/types'

export const IMPORT_RECOVERY_VERSION = 1
export const IMPORT_RECOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const IMPORT_RECOVERY_STORAGE_PREFIX = 'gelly-import-recovery:'

export type ImportWorkspaceSnapshot = {
  rawText: string
  drafts: ImportDraft[]
}

type StoredImportWorkspace = ImportWorkspaceSnapshot & {
  version: typeof IMPORT_RECOVERY_VERSION
  ownerKey: string
  savedAt: number
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    // Accessing localStorage can throw in a blocked/private browser context.
    return localStorage
  } catch {
    return null
  }
}

function safeOwnerKey(ownerKey: string): string | null {
  if (typeof ownerKey !== 'string') return null
  const trimmed = ownerKey.trim()
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null
}

export function getImportRecoveryStorageKey(ownerKey: string): string {
  return `${IMPORT_RECOVERY_STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`
}

function isDraft(value: unknown): value is ImportDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<ImportDraft>
  const stringOrNull = (field: unknown): field is string | null => field === null || typeof field === 'string'
  const validItem = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const item = value as ImportDraft['items'][number]
    const validCupNames = item.cupNames === undefined || (Array.isArray(item.cupNames)
      && item.cupNames.length <= (typeof item.quantity === 'number' ? item.quantity : 100)
      && item.cupNames.every((name) => typeof name === 'string' && name.length <= 40))
    return typeof item.id === 'string'
      && (item.productSlug === null || typeof item.productSlug === 'string')
      && (item.quantity === null || (Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 100))
      && (item.level === null || item.level === 1 || item.level === 2 || item.level === 3)
      && (item.powder === null || item.powder === 'yumeno' || item.powder === 'mk_isuzu')
      && (item.sweetness === undefined || item.sweetness === null || ['none', 'light', 'regular', 'extra'].includes(item.sweetness))
      && validCupNames
  }
  const validBag = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const bag = value as ImportDraft['thermalBags'][number]
    return typeof bag.id === 'string'
      && (bag.coveredCupCount === null || bag.coveredCupCount === 1 || bag.coveredCupCount === 2 || bag.coveredCupCount === 3 || bag.coveredCupCount === 4)
  }
  const validConfirmationInput = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const input = value as OrderConfirmationInput
    const customer = input.customer
    const order = input.order
    if (typeof input.confirmationKey !== 'string' || !/^[A-Za-z0-9._:-]{16,100}$/.test(input.confirmationKey)
      || typeof input.requestHash !== 'string' || !/^[0-9a-f]{64}$/i.test(input.requestHash)
      || typeof customer !== 'object' || customer === null
      || (customer.id !== null && typeof customer.id !== 'string')
      || typeof customer.name !== 'string'
      || (customer.phone !== null && typeof customer.phone !== 'string')
      || typeof order !== 'object' || order === null || Array.isArray(order)) return false
    const validMoney = (amount: unknown): boolean => Number.isSafeInteger(amount) && typeof amount === 'number' && amount >= 0
    const validStoredItem = (item: unknown): boolean => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
      const candidate = item as OrderConfirmationInput['order']['items'][number]
      return typeof candidate.id === 'string'
        && typeof candidate.orderId === 'string'
        && typeof candidate.productId === 'string'
        && typeof candidate.productName === 'string'
        && Number.isSafeInteger(candidate.quantity) && candidate.quantity >= 1 && candidate.quantity <= 100
        && typeof candidate.modifiers === 'object' && candidate.modifiers !== null && !Array.isArray(candidate.modifiers)
        && validMoney(candidate.unitPriceCentavos) && validMoney(candidate.lineTotalCentavos)
        && typeof candidate.createdAt === 'string' && typeof candidate.updatedAt === 'string'
    }
    return typeof order.id === 'string'
      && typeof order.customerId === 'string'
      && order.status === 'new'
      && Array.isArray(order.items) && order.items.length <= 100 && order.items.every(validStoredItem)
      && validMoney(order.subtotalCentavos) && validMoney(order.deliveryFeeCentavos) && validMoney(order.totalCentavos)
      && (order.deliveryDate === null || typeof order.deliveryDate === 'string')
      && order.paymentReceived === false
      && typeof order.rawSource === 'string'
      && (order.addressSnapshot === null || typeof order.addressSnapshot === 'string')
      && (order.notes === null || typeof order.notes === 'string')
      && (order.routePosition === null || Number.isSafeInteger(order.routePosition))
      && order.paidAt === null && order.deliveredAt === null
      && typeof order.createdAt === 'string' && typeof order.updatedAt === 'string'
  }
  const validSnapshot = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const snapshot = value as NonNullable<ImportDraft['confirmationSnapshot']>
    return typeof snapshot.draftIdentity === 'string' && snapshot.draftIdentity.length > 0 && validConfirmationInput(snapshot.input)
  }
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.rawSource === 'string'
    && stringOrNull(candidate.customerName)
    && (candidate.customerPhone === undefined || candidate.customerPhone === null || typeof candidate.customerPhone === 'string')
    && (typeof candidate.matchedCustomerId === 'string' || candidate.matchedCustomerId === null)
    && Array.isArray(candidate.items) && candidate.items.length <= 100 && candidate.items.every(validItem)
    && Array.isArray(candidate.thermalBags) && candidate.thermalBags.length <= 100 && candidate.thermalBags.every(validBag)
    && (typeof candidate.deliveryDate === 'string' || candidate.deliveryDate === null)
    && (typeof candidate.address === 'string' || candidate.address === null)
    && (typeof candidate.notes === 'string' || candidate.notes === null)
    && (candidate.sourceConfidence === null || (typeof candidate.sourceConfidence === 'number' && Number.isFinite(candidate.sourceConfidence) && candidate.sourceConfidence >= 0 && candidate.sourceConfidence <= 1))
    && Array.isArray(candidate.unresolvedFields) && candidate.unresolvedFields.length <= 100
    && candidate.unresolvedFields.every((field) => typeof field === 'string' && field.length <= 300)
    && typeof candidate.sameAsLastTime === 'boolean'
    && (candidate.confirmationKey === undefined || (typeof candidate.confirmationKey === 'string' && /^[A-Za-z0-9._:-]{16,100}$/.test(candidate.confirmationKey)))
    && (candidate.confirmationRequestHash === undefined || (typeof candidate.confirmationRequestHash === 'string' && /^[0-9a-f]{64}$/i.test(candidate.confirmationRequestHash)))
    && (candidate.confirmationAttemptedAt === undefined || (typeof candidate.confirmationAttemptedAt === 'number' && Number.isFinite(candidate.confirmationAttemptedAt)))
    && (candidate.confirmationSnapshot === undefined || validSnapshot(candidate.confirmationSnapshot))
}

function readStored(ownerKey: string): StoredImportWorkspace | null {
  const storage = getStorage()
  const normalizedOwnerKey = safeOwnerKey(ownerKey)
  if (!storage || !normalizedOwnerKey) return null
  try {
    const raw = storage.getItem(getImportRecoveryStorageKey(normalizedOwnerKey))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const candidate = value as Partial<StoredImportWorkspace>
    if (candidate.version !== IMPORT_RECOVERY_VERSION || candidate.ownerKey !== normalizedOwnerKey || typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt) || typeof candidate.rawText !== 'string' || !Array.isArray(candidate.drafts)) {
      clearImportWorkspace(normalizedOwnerKey)
      return null
    }
    if (!candidate.drafts.every(isDraft)) {
      clearImportWorkspace(normalizedOwnerKey)
      return null
    }
    return candidate as StoredImportWorkspace
  } catch {
    return null
  }
}

export function loadImportWorkspace(ownerKey: string, now = Date.now()): ImportWorkspaceSnapshot | null {
  const stored = readStored(ownerKey)
  if (!stored) return null
  if (now - stored.savedAt > IMPORT_RECOVERY_TTL_MS) {
    clearImportWorkspace(ownerKey)
    return null
  }
  try {
    return { rawText: stored.rawText, drafts: structuredClone(stored.drafts) }
  } catch {
    clearImportWorkspace(ownerKey)
    return null
  }
}

export function saveImportWorkspace(ownerKey: string, snapshot: ImportWorkspaceSnapshot, now = Date.now()): boolean {
  const storage = getStorage()
  const normalizedOwnerKey = safeOwnerKey(ownerKey)
  if (!storage || !normalizedOwnerKey || !Number.isFinite(now)) return false
  try {
    const stored: StoredImportWorkspace = {
      version: IMPORT_RECOVERY_VERSION,
      ownerKey: normalizedOwnerKey,
      savedAt: now,
      rawText: snapshot.rawText,
      drafts: structuredClone(snapshot.drafts),
    }
    storage.setItem(getImportRecoveryStorageKey(normalizedOwnerKey), JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}

export function clearImportWorkspace(ownerKey: string): void {
  const storage = getStorage()
  const normalizedOwnerKey = safeOwnerKey(ownerKey)
  if (!storage || !normalizedOwnerKey) return
  try { storage.removeItem(getImportRecoveryStorageKey(normalizedOwnerKey)) } catch { /* storage may be unavailable */ }
}

export function clearAllImportWorkspaces(): void {
  const storage = getStorage()
  if (!storage) return
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(IMPORT_RECOVERY_STORAGE_PREFIX)) keys.push(key)
    }
    keys.forEach((key) => storage.removeItem(key))
  } catch {
    /* storage may be unavailable */
  }
}

export function purgeExpiredImportWorkspace(ownerKey: string, now = Date.now()): boolean {
  const stored = readStored(ownerKey)
  if (!stored || now - stored.savedAt <= IMPORT_RECOVERY_TTL_MS) return false
  clearImportWorkspace(ownerKey)
  return true
}
