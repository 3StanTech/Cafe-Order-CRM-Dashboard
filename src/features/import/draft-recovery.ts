import type { ImportDraft } from './types'

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
  if (typeof localStorage === 'undefined') return null
  try {
    // Accessing localStorage can throw in a blocked/private browser context.
    return localStorage
  } catch {
    return null
  }
}

function safeOwnerKey(ownerKey: string): string | null {
  const trimmed = ownerKey.trim()
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null
}

export function getImportRecoveryStorageKey(ownerKey: string): string {
  return `${IMPORT_RECOVERY_STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`
}

function isDraft(value: unknown): value is ImportDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<ImportDraft>
  return typeof candidate.id === 'string'
    && typeof candidate.rawSource === 'string'
    && (candidate.customerName === null || typeof candidate.customerName === 'string')
    && (candidate.customerPhone === undefined || candidate.customerPhone === null || typeof candidate.customerPhone === 'string')
    && (typeof candidate.matchedCustomerId === 'string' || candidate.matchedCustomerId === null)
    && Array.isArray(candidate.items)
    && Array.isArray(candidate.thermalBags)
    && (typeof candidate.deliveryDate === 'string' || candidate.deliveryDate === null)
    && (typeof candidate.address === 'string' || candidate.address === null)
    && (typeof candidate.notes === 'string' || candidate.notes === null)
    && (typeof candidate.sourceConfidence === 'number' || candidate.sourceConfidence === null)
    && Array.isArray(candidate.unresolvedFields)
    && candidate.unresolvedFields.every((field) => typeof field === 'string')
    && typeof candidate.sameAsLastTime === 'boolean'
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
    if (candidate.version !== IMPORT_RECOVERY_VERSION || candidate.ownerKey !== normalizedOwnerKey || typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt) || typeof candidate.rawText !== 'string' || !Array.isArray(candidate.drafts)) return null
    if (!candidate.drafts.every(isDraft)) return null
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
  return { rawText: stored.rawText, drafts: structuredClone(stored.drafts) }
}

export function saveImportWorkspace(ownerKey: string, snapshot: ImportWorkspaceSnapshot, now = Date.now()): boolean {
  const storage = getStorage()
  const normalizedOwnerKey = safeOwnerKey(ownerKey)
  if (!storage || !normalizedOwnerKey || !Number.isFinite(now)) return false
  const stored: StoredImportWorkspace = {
    version: IMPORT_RECOVERY_VERSION,
    ownerKey: normalizedOwnerKey,
    savedAt: now,
    rawText: snapshot.rawText,
    drafts: structuredClone(snapshot.drafts),
  }
  try {
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

export function purgeExpiredImportWorkspace(ownerKey: string, now = Date.now()): boolean {
  const stored = readStored(ownerKey)
  if (!stored || now - stored.savedAt <= IMPORT_RECOVERY_TTL_MS) return false
  clearImportWorkspace(ownerKey)
  return true
}
