import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImportDraft } from '../types'
import {
  HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX,
  IMPORT_RECOVERY_STORAGE_PREFIX,
  IMPORT_RECOVERY_TTL_MS,
  IMPORT_RECOVERY_VERSION,
  clearAllImportWorkspaces,
  clearImportWorkspace,
  getImportRecoveryStorageKey,
  loadImportWorkspace,
  purgeExpiredImportWorkspace,
  saveImportWorkspace,
} from '../draft-recovery'

const OWNER = 'owner-angela'

function nullableDraft(overrides: Partial<ImportDraft> = {}): ImportDraft {
  return {
    id: 'draft-1',
    rawSource: 'Mika: one matcha, maybe a bag?',
    customerName: null,
    customerPhone: null,
    matchedCustomerId: null,
    items: [{ id: 'item-1', productSlug: null, quantity: null, level: null, powder: null, sweetness: null }],
    thermalBags: [{ id: 'bag-1', coveredCupCount: null }],
    deliveryDate: null,
    address: null,
    notes: null,
    sourceConfidence: null,
    unresolvedFields: ['drink is unclear'],
    sameAsLastTime: false,
    ...overrides,
  }
}

function storedEnvelope(drafts: ImportDraft[], savedAt: number, extras: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: IMPORT_RECOVERY_VERSION,
    ownerKey: OWNER,
    savedAt,
    rawText: 'pasted viber',
    drafts,
    ...extras,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  try { localStorage.clear() } catch { /* blocked storage tests restore this */ }
})

describe('import draft recovery', () => {
  it('round-trips nested nullable item and bag fields', () => {
    const snapshot = { rawText: 'pasted viber', drafts: [nullableDraft()] }
    expect(saveImportWorkspace(OWNER, snapshot, 1_000)).toBe(true)
    const loaded = loadImportWorkspace(OWNER, 1_000)
    expect(loaded).toEqual(snapshot)
    expect(loaded?.drafts).not.toBe(snapshot.drafts)
    expect(loaded?.drafts[0].items[0]).toMatchObject({
      productSlug: null, quantity: null, level: null, powder: null, sweetness: null,
    })
    expect(loaded?.drafts[0].thermalBags[0].coveredCupCount).toBeNull()
  })

  it('clears structurally corrupt JSON instead of returning a partial workspace', () => {
    const key = getImportRecoveryStorageKey(OWNER)
    localStorage.setItem(key, storedEnvelope([{
      ...nullableDraft(),
      items: [{ id: 'item-1', productSlug: 12, quantity: 'two', level: 9, powder: 'dirt' } as never],
    }], Date.now()))
    expect(loadImportWorkspace(OWNER)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('clears a readable envelope whose version or drafts are invalid', () => {
    const key = getImportRecoveryStorageKey(OWNER)
    localStorage.setItem(key, JSON.stringify({
      version: IMPORT_RECOVERY_VERSION + 1,
      ownerKey: OWNER,
      savedAt: Date.now(),
      rawText: 'pasted viber',
      drafts: [nullableDraft()],
    }))
    expect(loadImportWorkspace(OWNER)).toBeNull()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('returns null for unreadable JSON and does not invent a workspace', () => {
    const key = getImportRecoveryStorageKey(OWNER)
    localStorage.setItem(key, '{not-json')
    expect(loadImportWorkspace(OWNER)).toBeNull()
  })

  it('expires after seven days and removes the stored snapshot', () => {
    const savedAt = 1_700_000_000_000
    expect(saveImportWorkspace(OWNER, { rawText: 'pasted viber', drafts: [nullableDraft()] }, savedAt)).toBe(true)
    expect(loadImportWorkspace(OWNER, savedAt + IMPORT_RECOVERY_TTL_MS - 1)?.rawText).toBe('pasted viber')
    expect(loadImportWorkspace(OWNER, savedAt + IMPORT_RECOVERY_TTL_MS + 1)).toBeNull()
    expect(localStorage.getItem(getImportRecoveryStorageKey(OWNER))).toBeNull()
  })

  it('purgeExpiredImportWorkspace only removes snapshots past the seven-day window', () => {
    const savedAt = 1_700_000_000_000
    saveImportWorkspace(OWNER, { rawText: 'pasted viber', drafts: [nullableDraft()] }, savedAt)
    expect(purgeExpiredImportWorkspace(OWNER, savedAt + IMPORT_RECOVERY_TTL_MS - 1)).toBe(false)
    expect(purgeExpiredImportWorkspace(OWNER, savedAt + IMPORT_RECOVERY_TTL_MS + 1)).toBe(true)
    expect(loadImportWorkspace(OWNER, savedAt + IMPORT_RECOVERY_TTL_MS + 1)).toBeNull()
  })

  it('returns null when storage is blocked', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    try {
      expect(loadImportWorkspace(OWNER)).toBeNull()
      expect(saveImportWorkspace(OWNER, { rawText: 'x', drafts: [] })).toBe(false)
      expect(() => clearImportWorkspace(OWNER)).not.toThrow()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('clears the stored snapshot when cloning the recovered drafts fails', () => {
    const key = getImportRecoveryStorageKey(OWNER)
    expect(saveImportWorkspace(OWNER, { rawText: 'pasted viber', drafts: [nullableDraft()] }, 1_000)).toBe(true)
    expect(localStorage.getItem(key)).toBeTruthy()
    vi.stubGlobal('structuredClone', () => { throw new Error('clone failed') })
    expect(loadImportWorkspace(OWNER, 1_000)).toBeNull()
    vi.unstubAllGlobals()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('scopes keys per owner and rejects a blank owner key', () => {
    expect(getImportRecoveryStorageKey(OWNER).startsWith(IMPORT_RECOVERY_STORAGE_PREFIX)).toBe(true)
    expect(saveImportWorkspace('   ', { rawText: 'x', drafts: [] })).toBe(false)
    expect(loadImportWorkspace('   ')).toBeNull()
  })

  it('clearAllImportWorkspaces removes every prefixed recovery key and leaves other keys', () => {
    expect(saveImportWorkspace('owner-a', { rawText: 'a', drafts: [nullableDraft({ id: 'draft-a' })] })).toBe(true)
    expect(saveImportWorkspace('owner-b', { rawText: 'b', drafts: [nullableDraft({ id: 'draft-b' })] })).toBe(true)
    localStorage.setItem('unrelated-dashboard-key', 'keep-me')
    localStorage.setItem(`${IMPORT_RECOVERY_STORAGE_PREFIX}raw-corrupt`, '{not-json')
    clearAllImportWorkspaces()
    expect(localStorage.getItem(getImportRecoveryStorageKey('owner-a'))).toBeNull()
    expect(localStorage.getItem(getImportRecoveryStorageKey('owner-b'))).toBeNull()
    expect(localStorage.getItem(`${IMPORT_RECOVERY_STORAGE_PREFIX}raw-corrupt`)).toBeNull()
    expect(localStorage.getItem('unrelated-dashboard-key')).toBe('keep-me')
  })

  it('keeps the history import snapshot under its own key, apart from intake drafts', () => {
    const history = { rawText: 'history lines', drafts: [nullableDraft({ id: 'history-draft' })] }
    const intake = { rawText: 'intake paste', drafts: [nullableDraft({ id: 'intake-draft' })] }
    expect(saveImportWorkspace(OWNER, history, 1_000, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)).toBe(true)
    expect(saveImportWorkspace(OWNER, intake, 1_000)).toBe(true)
    expect(getImportRecoveryStorageKey(OWNER, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)).toBe(`gelly-history-import:${OWNER}`)
    expect(loadImportWorkspace(OWNER, 1_000, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)?.drafts[0].id).toBe('history-draft')
    expect(loadImportWorkspace(OWNER, 1_000)?.drafts[0].id).toBe('intake-draft')
    clearImportWorkspace(OWNER, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)
    expect(loadImportWorkspace(OWNER, 1_000, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)).toBeNull()
    expect(loadImportWorkspace(OWNER, 1_000)?.drafts[0].id).toBe('intake-draft')
  })

  it('clearAllImportWorkspaces also wipes history import snapshots on sign-out', () => {
    expect(saveImportWorkspace(OWNER, { rawText: 'h', drafts: [nullableDraft()] }, undefined, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)).toBe(true)
    clearAllImportWorkspaces()
    expect(localStorage.getItem(getImportRecoveryStorageKey(OWNER, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX))).toBeNull()
  })

  it('clearAllImportWorkspaces does not throw when storage is blocked', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('blocked') },
    })
    try {
      expect(() => clearAllImportWorkspaces()).not.toThrow()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })
})
