import { Clipboard, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getRuntimeCatalog } from '../../domain/catalog'
import { getNextAvailableDeliveryDate } from '../../domain/delivery-schedule'
import type { StorageAdapter, StoredCustomer, StoredOrder } from '../../data/types'
import { GELLY_AUTH_SIGNED_OUT_EVENT } from '../auth/AuthBoundary'
import { DASHBOARD_AUTH_EMAIL, getAuthClient } from '../auth/supabaseAuth'
import { loadDashboardSettings } from '../settings/settings-store'
import { FieldLabel, OrderEditorCard } from '../order-editor/OrderEditorCard'
import { formatPhp } from '../orders/order-display'
import { applyCustomerMatch } from './customer-matching'
import {
  clearAllImportWorkspaces,
  getImportRecoveryStorageKey,
  loadImportWorkspace,
  saveImportWorkspace,
} from './draft-recovery'
import { draftHasBlockingErrors, duplicateDraftIds, summarizeDraftItems } from './draft-summary'
import { PendingInbox } from './PendingInbox'
import { normalizeFunctionResponse, parseLocalInput, validateDraft } from './parser'
import { confirmImportDraft } from './persist'
import { buildViberChatGptPrompt } from './prompt'
import type { ImportDraft } from './types'

type ImportWorkspaceProps = { adapter: StorageAdapter }

async function resolveOwnerKey(): Promise<string> {
  const client = getAuthClient()
  if (!client) return 'demo-owner'
  try {
    const { data } = await client.auth.getSession()
    const email = data.session?.user?.email
    if (typeof email === 'string' && email.trim()) return email.trim()
  } catch {
    /* blocked or unavailable session */
  }
  return DASHBOARD_AUTH_EMAIL
}

function applyDefaultDeliveryDate(draft: ImportDraft, nextDate: string | null): ImportDraft {
  return draft.deliveryDate || !nextDate ? draft : { ...draft, deliveryDate: nextDate }
}

export function ImportWorkspace({ adapter }: ImportWorkspaceProps) {
  const [rawText, setRawText] = useState('')
  const [drafts, setDrafts] = useState<ImportDraft[]>([])
  const [customers, setCustomers] = useState<StoredCustomer[]>([])
  const [orders, setOrders] = useState<StoredOrder[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [batchConfirming, setBatchConfirming] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [confirmErrors, setConfirmErrors] = useState<Record<string, string>>({})
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  const [ownerKey, setOwnerKey] = useState<string | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const confirmingIdRef = useRef<string | null>(null)
  const ownerKeyRef = useRef<string | null>(null)
  const persistEnabledRef = useRef(true)
  const [, setCatalogVersion] = useState(0)

  useEffect(() => {
    let active = true
    const refreshCatalog = () => { void loadDashboardSettings(adapter).then(() => { if (active) setCatalogVersion((version) => version + 1) }) }
    refreshCatalog()
    const unsubscribe = adapter.subscribe((change) => { if (change.collection === 'settings') refreshCatalog() })
    return () => { active = false; unsubscribe() }
  }, [adapter])

  useEffect(() => {
    void Promise.all([adapter.listCustomers(), adapter.listOrders()]).then(([nextCustomers, nextOrders]) => {
      setCustomers(nextCustomers)
      setOrders(nextOrders)
    })
  }, [adapter])

  useEffect(() => {
    let active = true
    void resolveOwnerKey().then((key) => {
      if (!active) return
      ownerKeyRef.current = key
      setOwnerKey(key)
      const snapshot = loadImportWorkspace(key)
      if (snapshot) {
        setRawText(snapshot.rawText)
        setDrafts(snapshot.drafts)
      }
      setHydrated(true)
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!hydrated || !ownerKey || !persistEnabledRef.current) return
    saveImportWorkspace(ownerKey, { rawText, drafts })
  }, [hydrated, ownerKey, rawText, drafts])

  useEffect(() => {
    const clearLocalState = () => {
      persistEnabledRef.current = false
      setRawText('')
      setDrafts([])
      setSelectedIds(new Set())
      setExpandedIds(new Set())
      setConfirmErrors({})
    }

    const clearForSignOut = () => {
      persistEnabledRef.current = false
      clearAllImportWorkspaces()
      clearLocalState()
    }

    const client = getAuthClient()
    const listener = client?.auth.onAuthStateChange?.((event) => {
      if (event !== 'SIGNED_OUT') return
      clearForSignOut()
    })

    const onStorage = (event: StorageEvent) => {
      const key = ownerKeyRef.current
      if (!key) return
      const recoveryKey = getImportRecoveryStorageKey(key)
      if (event.key === recoveryKey && !event.newValue) {
        clearLocalState()
        return
      }
      if (event.key && event.key !== recoveryKey && event.newValue === null && /auth-token/i.test(event.key)) {
        persistEnabledRef.current = false
        clearAllImportWorkspaces()
        clearLocalState()
      }
    }

    window.addEventListener('storage', onStorage)
    window.addEventListener(GELLY_AUTH_SIGNED_OUT_EVENT, clearForSignOut)
    return () => {
      listener?.data?.subscription?.unsubscribe?.()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(GELLY_AUTH_SIGNED_OUT_EVENT, clearForSignOut)
    }
  }, [])

  const setDraft = (next: ImportDraft) => {
    setDrafts((current) => current.map((draft) => draft.id === next.id ? next : draft))
    if (draftHasBlockingErrors(next)) {
      setSelectedIds((current) => {
        if (!current.has(next.id)) return current
        const copy = new Set(current)
        copy.delete(next.id)
        return copy
      })
    }
  }

  const decorateIncoming = async (incoming: ImportDraft[]): Promise<ImportDraft[]> => {
    const settings = await loadDashboardSettings(adapter)
    const nextDate = getNextAvailableDeliveryDate(new Date(), settings)?.deliveryDate ?? null
    const [nextCustomers, nextOrders] = await Promise.all([adapter.listCustomers(), adapter.listOrders()])
    setCustomers(nextCustomers)
    setOrders(nextOrders)
    return incoming.map((draft) => applyCustomerMatch(applyDefaultDeliveryDate(draft, nextDate), nextCustomers, nextOrders))
  }

  const appendDrafts = (incoming: ImportDraft[]) => {
    setDrafts((current) => [...current, ...incoming])
  }

  const parse = async () => {
    setMessage(null)
    const local = parseLocalInput(rawText)
    if (local.kind === 'empty') { setMessage('Paste an order conversation, JSON object, or JSON Lines first.'); return }
    if (local.kind === 'local') {
      const decorated = await decorateIncoming(local.drafts)
      appendDrafts(decorated)
      setMessage('Parsed locally — no network request was made.')
      return
    }

    const authClient = getAuthClient()
    if (!authClient) {
      setMessage('Sign in is required to use the extraction service.')
      return
    }
    let accessToken: string | undefined
    try {
      const { data } = await authClient.auth.getSession()
      accessToken = data.session?.access_token
    } catch {
      accessToken = undefined
    }
    if (!accessToken) {
      setMessage('Sign in is required to use the extraction service.')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/.netlify/functions/parse-orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ raw_text: rawText }),
      })
      const body: unknown = await response.json()
      if (!response.ok) throw new Error(typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : 'The extraction service failed')
      const decorated = await decorateIncoming(normalizeFunctionResponse(body, rawText))
      appendDrafts(decorated)
      setMessage('Parsed through the extraction service. Review every field before confirming.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The extraction service failed') } finally { setLoading(false) }
  }

  const copyPrompt = async () => {
    await navigator.clipboard.writeText(buildViberChatGptPrompt(getRuntimeCatalog()))
    setMessage('The @ChatGPT-in-Viber extraction prompt is copied.')
  }

  const persistPrepared = (prepared: ImportDraft) => {
    setDrafts((current) => current.map((draft) => draft.id === prepared.id ? prepared : draft))
  }

  const confirm = async (draft: ImportDraft) => {
    if (confirmingIdRef.current || batchConfirming) return
    confirmingIdRef.current = draft.id
    setConfirmingId(draft.id)
    setMessage(null)
    try {
      const order = await confirmImportDraft(adapter, draft, { onPrepared: persistPrepared })
      const [nextCustomers, nextOrders] = await Promise.all([adapter.listCustomers(), adapter.listOrders()])
      setCustomers(nextCustomers)
      setOrders(nextOrders)
      setDrafts((current) => current.filter((entry) => entry.id !== draft.id))
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(draft.id)
        return next
      })
      setConfirmErrors((current) => {
        const next = { ...current }
        delete next[draft.id]
        return next
      })
      setMessage(`Order ${order.id.slice(0, 8)} was created as new.`)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Order confirmation failed'
      setConfirmErrors((current) => ({ ...current, [draft.id]: text }))
      setMessage(text)
    } finally {
      confirmingIdRef.current = null
      setConfirmingId(null)
    }
  }

  const readyDrafts = useMemo(() => drafts.filter((draft) => !draftHasBlockingErrors(draft)), [drafts])
  const selectedReady = useMemo(() => readyDrafts.filter((draft) => selectedIds.has(draft.id)), [readyDrafts, selectedIds])
  const duplicates = useMemo(() => duplicateDraftIds(drafts), [drafts])

  const selectAllReady = () => {
    setSelectedIds(new Set(readyDrafts.map((draft) => draft.id)))
  }

  const toggleSelected = (draft: ImportDraft, checked: boolean) => {
    if (draftHasBlockingErrors(draft)) return
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(draft.id)
      else next.delete(draft.id)
      return next
    })
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const confirmSelected = async () => {
    if (batchConfirming || confirmingIdRef.current || selectedReady.length === 0) return
    setBatchConfirming(true)
    setMessage(null)
    const succeeded = new Set<string>()
    const nextErrors: Record<string, string> = {}
    let lastSuccess: string | null = null
    for (const draft of selectedReady) {
      confirmingIdRef.current = draft.id
      setConfirmingId(draft.id)
      try {
        const order = await confirmImportDraft(adapter, draft, { onPrepared: persistPrepared })
        succeeded.add(draft.id)
        lastSuccess = `Order ${order.id.slice(0, 8)} was created as new.`
      } catch (error) {
        nextErrors[draft.id] = error instanceof Error ? error.message : 'Order confirmation failed'
      }
    }
    confirmingIdRef.current = null
    setConfirmingId(null)
    if (succeeded.size > 0) {
      const [nextCustomers, nextOrders] = await Promise.all([adapter.listCustomers(), adapter.listOrders()])
      setCustomers(nextCustomers)
      setOrders(nextOrders)
      setDrafts((current) => current.filter((draft) => !succeeded.has(draft.id)))
      setSelectedIds((current) => new Set([...current].filter((id) => !succeeded.has(id))))
      setExpandedIds((current) => {
        const next = new Set(current)
        succeeded.forEach((id) => next.delete(id))
        return next
      })
    }
    setConfirmErrors((current) => {
      const merged = { ...current, ...nextErrors }
      succeeded.forEach((id) => { delete merged[id] })
      return merged
    })
    if (Object.keys(nextErrors).length > 0) {
      const firstError = Object.values(nextErrors)[0]
      setMessage(succeeded.size > 0 ? `${succeeded.size} confirmed. ${firstError}` : firstError)
    } else if (lastSuccess) {
      setMessage(succeeded.size === 1 ? lastSuccess : `${succeeded.size} orders were created as new.`)
    }
    setBatchConfirming(false)
  }

  return (
    <section className="space-y-4">
      <header className="motion-fade-up">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#4F74C8]">OPERATOR INTAKE</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-black tracking-tight text-[#20242f]">Import</h1>
          {pendingCount !== null && pendingCount > 0 && (
            <span className="rounded-full bg-[#4F74C8] px-2.5 py-1 text-xs font-bold text-white">{pendingCount} pending</span>
          )}
        </div>
        <p className="mt-1 text-base font-semibold text-[#20242f]">Import Viber orders</p>
        <p className="mt-1 max-w-xl text-sm leading-6 text-[#4A5365]">Paste, review, confirm.</p>
      </header>

      <div className="rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm">
        <FieldLabel>
          Paste Viber orders
          <textarea
            aria-label="Paste Viber orders"
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder={'Mika: 1 matcha latte L2\nAira: 2 strawberry hojicha\nBen: same as last time'}
            className="mt-1 min-h-44 w-full rounded-xl border border-[#4F74C8]/25 bg-white p-3 text-sm outline-none transition-colors focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/20"
          />
        </FieldLabel>
        <button
          type="button"
          disabled={loading}
          onClick={() => parse()}
          className="mt-3 flex min-h-12 w-full items-center justify-center rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:opacity-50 disabled:active:scale-100"
        >
          {loading && <LoaderCircle className="mr-2 motion-safe:animate-spin" size={17} />}
          {loading ? 'Extracting structure…' : 'Create editable drafts'}
        </button>
        <button
          type="button"
          onClick={() => void copyPrompt()}
          className="mt-2 flex min-h-11 w-full items-center justify-center rounded-xl border border-[#4F74C8]/30 px-4 text-sm font-bold text-[#365aa8] transition-colors duration-200 hover:bg-[#4F74C8]/10 active:scale-[0.98] motion-safe:transition-transform"
        >
          <Clipboard className="mr-2" size={16} />Copy @ChatGPT-in-Viber prompt
        </button>
      </div>

      {message && <p role="status" className="motion-fade-in rounded-xl bg-[#4F74C8]/10 p-3 text-sm text-[#263d70]">{message}</p>}

      {drafts.length > 0 && (
        <div className="rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold text-[#20242f]">{drafts.length} {drafts.length === 1 ? 'draft' : 'drafts'} ready</p>
            <p className="text-sm font-semibold text-[#365aa8]">{selectedReady.length} selected</p>
          </div>
          <button
            type="button"
            onClick={selectAllReady}
            className="mt-2 text-sm font-bold text-[#365aa8] underline underline-offset-2"
          >
            Select all ready orders
          </button>
          <button
            type="button"
            disabled={batchConfirming || selectedReady.length === 0}
            onClick={() => void confirmSelected()}
            className="mt-3 flex min-h-12 w-full items-center justify-center rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            {batchConfirming && <LoaderCircle className="mr-2 motion-safe:animate-spin" size={17} />}
            Confirm selected ({selectedReady.length})
          </button>
          <ul className="mt-3 space-y-3">
            {drafts.map((draft) => {
              const blocked = draftHasBlockingErrors(draft)
              const validation = validateDraft(draft)
              const expanded = expandedIds.has(draft.id)
              return (
                <li key={draft.id} className="rounded-xl border border-[#4F74C8]/15 bg-white p-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-[#4F74C8]"
                      aria-label={`Select ${draft.customerName ?? 'untitled draft'}`}
                      checked={selectedIds.has(draft.id)}
                      disabled={blocked}
                      onChange={(event) => toggleSelected(draft, event.target.checked)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-[#20242f]">{draft.customerName ?? 'Unnamed customer'}</p>
                      <p className="mt-0.5 break-words text-sm text-[#4A5365]">{summarizeDraftItems(draft)}</p>
                      <p className="mt-0.5 text-sm text-[#4A5365]">
                        {draft.deliveryDate ?? 'No delivery date'}
                        {validation.totalCentavos !== null ? ` · ${formatPhp(validation.totalCentavos)}` : ' · Needs review'}
                      </p>
                      {validation.warnings.map((warning) => (
                        <p key={warning} className="mt-1 text-sm text-amber-900">{warning}</p>
                      ))}
                      {duplicates.has(draft.id) && (
                        <p className="mt-1 text-sm font-semibold text-amber-900">Probable duplicate — review before confirming.</p>
                      )}
                      {confirmErrors[draft.id] && (
                        <p role="alert" className="mt-1 text-sm text-red-800">{confirmErrors[draft.id]}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-xl border border-[#4F74C8]/35 px-3 py-2 text-sm font-semibold text-[#36579E] hover:bg-[#4F74C8]/10"
                      aria-expanded={expanded}
                      onClick={() => toggleExpanded(draft.id)}
                    >
                      Edit
                    </button>
                  </div>
                  {expanded && (
                    <div className="mt-3">
                      <OrderEditorCard
                        draft={draft}
                        customers={customers}
                        orders={orders}
                        confirming={confirmingId === draft.id}
                        onChange={setDraft}
                        onConfirm={() => void confirm(draft)}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <PendingInbox customers={customers} orders={orders} onCountChange={setPendingCount} />
    </section>
  )
}
