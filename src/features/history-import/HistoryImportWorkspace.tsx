import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import type { StorageAdapter, StoredCustomer, StoredOrder } from '../../data/types'
import { GELLY_AUTH_SIGNED_OUT_EVENT } from '../auth/AuthBoundary'
import { DASHBOARD_AUTH_EMAIL, getAuthClient } from '../auth/supabaseAuth'
import {
  clearImportWorkspace,
  HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX,
  loadImportWorkspace,
  saveImportWorkspace,
} from '../import/draft-recovery'
import { summarizeDraftItems } from '../import/draft-summary'
import { validateDraft } from '../import/parser'
import type { ImportDraft } from '../import/types'
import { FieldLabel, OrderEditorCard } from '../order-editor/OrderEditorCard'
import { formatPhp } from '../orders/order-display'
import { loadDashboardSettings } from '../settings/settings-store'
import {
  historyRowProblems,
  isImportableRow,
  parseHistoryImport,
  type HistoryLineError,
  type HistoryRow,
} from './format'
import { importHistoryDraft } from './importHistoryDraft'

type HistoryImportWorkspaceProps = { adapter: StorageAdapter }

type Phase = 'idle' | 'importing' | 'stopped' | 'done'

type Failure = { line: number; message: string }

const MAX_FILE_BYTES = 5 * 1024 * 1024

const EXAMPLE_LINE = '{"source_ref":"viber-2026-03-01-mika","customer_name":"Mika","delivery_date":"2026-03-01","items":[{"product_slug":"matcha-latte","quantity":2,"level":2}],"address":"Makati"}'

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

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('The file could not be read.'))
    reader.readAsText(file)
  })
}

/**
 * Re-parses the saved text and lays the saved drafts back over their rows, so
 * edits and in-flight confirmation keys survive a reload. A saved draft that
 * already has a key is resumable, even though its order may already exist.
 */
function restoreRows(rows: HistoryRow[], saved: ImportDraft[]): { rows: HistoryRow[]; selected: Set<string> } {
  const bySource = new Map(saved.map((draft) => [draft.rawSource, draft]))
  const selected = new Set<string>()
  const restored = rows.map((row) => {
    const draft = row.duplicateOfLine === null ? bySource.get(row.draft.rawSource) : undefined
    if (!draft) return row
    selected.add(draft.id)
    return { ...row, draft, alreadyImported: draft.confirmationSnapshot ? false : row.alreadyImported }
  })
  return { rows: restored, selected }
}

export function HistoryImportWorkspace({ adapter }: HistoryImportWorkspaceProps) {
  const [rawText, setRawText] = useState('')
  const [rows, setRows] = useState<HistoryRow[]>([])
  const [lineErrors, setLineErrors] = useState<HistoryLineError[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [customers, setCustomers] = useState<StoredCustomer[]>([])
  const [orders, setOrders] = useState<StoredOrder[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [importedCount, setImportedCount] = useState(0)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [ready, setReady] = useState(false)
  const [ownerKey, setOwnerKey] = useState<string | null>(null)
  const runningRef = useRef(false)
  const persistEnabledRef = useRef(true)
  const rowsRef = useRef<HistoryRow[]>([])
  const selectedRef = useRef<Set<string>>(new Set())
  rowsRef.current = rows
  selectedRef.current = selectedIds

  const saveSnapshot = useCallback((text: string, nextRows: HistoryRow[], selected: Set<string>) => {
    if (!ownerKey || !persistEnabledRef.current) return
    const drafts = nextRows.filter((row) => selected.has(row.draft.id)).map((row) => row.draft)
    // Nothing left to import means nothing worth recovering.
    if (drafts.length === 0) {
      clearImportWorkspace(ownerKey, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)
      return
    }
    saveImportWorkspace(ownerKey, { rawText: text, drafts }, undefined, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)
  }, [ownerKey])

  useEffect(() => {
    let active = true
    void (async () => {
      // Load the owner's menu first so previews and saves price from the current catalog.
      await loadDashboardSettings(adapter)
      const [key, nextCustomers, nextOrders] = await Promise.all([resolveOwnerKey(), adapter.listCustomers(), adapter.listOrders()])
      if (!active) return
      setCustomers(nextCustomers)
      setOrders(nextOrders)
      setOwnerKey(key)
      const snapshot = loadImportWorkspace(key, undefined, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)
      if (snapshot) {
        const parsed = parseHistoryImport(snapshot.rawText, { now: new Date(), customers: nextCustomers, orders: nextOrders })
        const restored = restoreRows(parsed.rows, snapshot.drafts)
        setRawText(snapshot.rawText)
        setRows(restored.rows)
        setLineErrors(parsed.errors)
        setSelectedIds(restored.selected)
        if (restored.rows.some((row) => row.draft.confirmationSnapshot)) {
          setPhase('stopped')
          setMessage('An earlier import was interrupted. Resume to finish it — orders already saved will not be duplicated.')
        }
      }
      setReady(true)
    })()
    return () => { active = false }
  }, [adapter])

  useEffect(() => {
    if (!ready) return
    // ownerKey is set in the same update as ready, so saveSnapshot is already stable here.
    saveSnapshot(rawText, rows, selectedIds)
  }, [ready, rawText, rows, selectedIds, saveSnapshot])

  useEffect(() => {
    const clearForSignOut = () => {
      persistEnabledRef.current = false
      setRawText('')
      setRows([])
      setLineErrors([])
      setSelectedIds(new Set())
      setExpandedIds(new Set())
      setFailure(null)
      setMessage(null)
    }
    const listener = getAuthClient()?.auth.onAuthStateChange?.((event) => {
      if (event === 'SIGNED_OUT') clearForSignOut()
    })
    window.addEventListener(GELLY_AUTH_SIGNED_OUT_EVENT, clearForSignOut)
    return () => {
      listener?.data?.subscription?.unsubscribe?.()
      window.removeEventListener(GELLY_AUTH_SIGNED_OUT_EVENT, clearForSignOut)
    }
  }, [])

  const preview = (text: string) => {
    if (runningRef.current) return
    setMessage(null)
    setFailure(null)
    setPhase('idle')
    setImportedCount(0)
    setExpandedIds(new Set())
    const parsedAt = new Date()
    const parsed = parseHistoryImport(text, { now: parsedAt, customers, orders })
    setRawText(text)
    setRows(parsed.rows)
    setLineErrors(parsed.errors)
    setSelectedIds(new Set(parsed.rows.filter((row) => isImportableRow(row, parsedAt)).map((row) => row.draft.id)))
    if (parsed.rows.length === 0 && parsed.errors.length === 0) setMessage('No orders found. Each line should be one order as a JSON object.')
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_FILE_BYTES) { setMessage('That file is larger than 5 MB. Split it into smaller files.'); return }
    try {
      preview(await readFileAsText(file))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The file could not be read.')
    }
  }

  const now = new Date()
  const importable = rows.filter((row) => isImportableRow(row, now))
  const queue = importable.filter((row) => selectedIds.has(row.draft.id))
  const counts = useMemo(() => {
    const at = new Date()
    return {
      alreadyImported: rows.filter((row) => row.alreadyImported).length,
      duplicates: rows.filter((row) => row.duplicateOfLine !== null).length,
      needFixing: rows.filter((row) => !row.alreadyImported && row.duplicateOfLine === null && historyRowProblems(row, at).length > 0).length,
    }
  }, [rows])

  const setRowDraft = (id: string, draft: ImportDraft) => {
    setRows((current) => current.map((row) => row.draft.id === id ? { ...row, draft } : row))
  }

  const toggleSelected = (row: HistoryRow, checked: boolean) => {
    if (runningRef.current || !isImportableRow(row, new Date())) return
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(row.draft.id)
      else next.delete(row.draft.id)
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

  const runImport = async (batch: HistoryRow[]) => {
    if (runningRef.current || batch.length === 0) return
    runningRef.current = true
    setPhase('importing')
    setFailure(null)
    setMessage(null)
    setProgress({ done: 0, total: batch.length })
    let done = 0
    let stoppedAt: Failure | null = null
    for (const row of batch) {
      const id = row.draft.id
      const current = rowsRef.current.find((entry) => entry.draft.id === id)?.draft ?? row.draft
      try {
        await importHistoryDraft(adapter, current, {
          onPrepared: (prepared) => {
            // Save the key before the write so a reload mid-request resumes instead of duplicating.
            const nextRows = rowsRef.current.map((entry) => entry.draft.id === id ? { ...entry, draft: prepared } : entry)
            rowsRef.current = nextRows
            saveSnapshot(rawText, nextRows, selectedRef.current)
            setRows(nextRows)
          },
        })
        done += 1
        setProgress({ done, total: batch.length })
        setImportedCount((count) => count + 1)
        const nextRows = rowsRef.current.map((entry) => entry.draft.id === id ? { ...entry, alreadyImported: true } : entry)
        const nextSelected = new Set(selectedRef.current)
        nextSelected.delete(id)
        rowsRef.current = nextRows
        selectedRef.current = nextSelected
        saveSnapshot(rawText, nextRows, nextSelected)
        setRows(nextRows)
        setSelectedIds(nextSelected)
      } catch (error) {
        stoppedAt = { line: row.line, message: error instanceof Error ? error.message : 'The order could not be saved.' }
        break
      }
    }
    const [nextCustomers, nextOrders] = await Promise.all([adapter.listCustomers(), adapter.listOrders()])
    setCustomers(nextCustomers)
    setOrders(nextOrders)
    if (stoppedAt) {
      setFailure(stoppedAt)
      setPhase('stopped')
    } else if (selectedRef.current.size === 0 && ownerKey) {
      clearImportWorkspace(ownerKey, HISTORY_IMPORT_RECOVERY_STORAGE_PREFIX)
      setPhase('done')
    } else {
      setPhase('idle')
    }
    runningRef.current = false
  }

  const importing = phase === 'importing'
  const importLabel = phase === 'stopped'
    ? `Resume import (${queue.length} left)`
    : `Import ${queue.length} ${queue.length === 1 ? 'order' : 'orders'}`

  return (
    <section className="space-y-4">
      <header className="motion-fade-up">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#4F74C8]">ONE-TIME SETUP</p>
        <h1 className="mt-1 text-3xl font-black tracking-tight text-[#20242f]">Import history</h1>
        <p className="mt-1 max-w-xl text-sm leading-6 text-[#4A5365]">
          Bring in past orders from a JSON Lines file, one order per line. Each one is saved as paid and delivered. The file is read on this phone; nothing is saved until you press Import.
        </p>
        <Link to="/settings" className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-[#365aa8] underline underline-offset-2">Back to Settings</Link>
      </header>

      <div className="rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm">
        <FieldLabel>
          Choose a JSON Lines file
          <input
            type="file"
            aria-label="Choose a JSON Lines file"
            accept=".jsonl,.ndjson,.json,.txt,application/json,application/x-ndjson,text/plain"
            disabled={!ready || importing}
            onChange={(event) => void onFile(event)}
            className="mt-1 block min-h-11 w-full rounded-xl border border-[#4F74C8]/25 bg-white p-2 text-sm text-[#20242f] file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-[#4F74C8] file:px-3 file:font-bold file:text-white disabled:opacity-50"
          />
        </FieldLabel>
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold text-[#365aa8]">Or paste the lines</summary>
          <textarea
            aria-label="Paste JSON Lines"
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder={EXAMPLE_LINE}
            disabled={importing}
            className="mt-1 min-h-40 w-full rounded-xl border border-[#4F74C8]/25 bg-white p-3 font-mono text-xs outline-none transition-colors focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/20"
          />
          <button
            type="button"
            disabled={!ready || importing}
            onClick={() => preview(rawText)}
            className="mt-2 flex min-h-12 w-full items-center justify-center rounded-xl border border-[#4F74C8]/35 px-4 font-bold text-[#36579E] transition-colors duration-200 hover:bg-[#4F74C8]/10 disabled:opacity-50"
          >
            Preview orders
          </button>
        </details>
        <p className="mt-3 text-xs leading-5 text-[#4A5365]">
          Each line needs <code>source_ref</code> (your unique reference for the order), <code>customer_name</code>, a past <code>delivery_date</code> (YYYY-MM-DD) and <code>items</code>. Prices in the file are ignored; every order is priced from the current menu.
        </p>
      </div>

      {message && <p role="status" className="motion-fade-in rounded-xl bg-[#4F74C8]/10 p-3 text-sm text-[#263d70]">{message}</p>}

      {phase === 'done' && (
        <div role="status" className="motion-fade-in rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm">
          <p className="font-bold text-[#20242f]">Imported {importedCount} {importedCount === 1 ? 'order' : 'orders'}.</p>
          <p className="mt-1 text-sm text-[#4A5365]">They now show in Orders and Customers as delivered.</p>
          {(counts.duplicates > 0 || counts.needFixing > 0 || lineErrors.length > 0) && (
            <p className="mt-1 text-sm text-amber-900">
              Not imported: {counts.needFixing} to fix, {counts.duplicates} repeated, {lineErrors.length} unreadable {lineErrors.length === 1 ? 'line' : 'lines'}.
            </p>
          )}
          <Link to="/orders" className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-[#365aa8] underline underline-offset-2">Open Orders</Link>
        </div>
      )}

      {(rows.length > 0 || lineErrors.length > 0) && (
        <div className="rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm">
          <p className="text-sm font-bold text-[#20242f]">
            {rows.length} {rows.length === 1 ? 'order' : 'orders'} found · {importable.length} ready
          </p>
          <p className="mt-0.5 text-sm text-[#4A5365]">
            {counts.alreadyImported} already imported · {counts.duplicates} repeated · {counts.needFixing} to fix{lineErrors.length > 0 ? ` · ${lineErrors.length} unreadable` : ''}
          </p>

          {importing && (
            <p role="status" className="mt-3 flex items-center text-sm font-semibold text-[#365aa8]">
              <LoaderCircle className="mr-2 motion-safe:animate-spin" size={17} />
              Importing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
            </p>
          )}
          {failure && (
            <p role="alert" className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              Stopped at line {failure.line}: {failure.message} Resume to try it again, or deselect it and resume.
            </p>
          )}

          <button
            type="button"
            disabled={importing || queue.length === 0}
            onClick={() => void runImport(queue)}
            className="mt-3 flex min-h-12 w-full items-center justify-center rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
          >
            {importing && <LoaderCircle className="mr-2 motion-safe:animate-spin" size={17} />}
            {importLabel}
          </button>

          {lineErrors.length > 0 && (
            <ul className="mt-3 space-y-1" aria-label="Unreadable lines">
              {lineErrors.map((error) => (
                <li key={error.line} className="text-sm text-red-800">Line {error.line}: {error.message}</li>
              ))}
            </ul>
          )}

          <ul className="mt-3 space-y-3">
            {rows.map((row) => {
              const problems = historyRowProblems(row, now)
              const rowImportable = isImportableRow(row, now)
              const validation = validateDraft(row.draft)
              const expanded = expandedIds.has(row.draft.id)
              const editable = !row.alreadyImported && row.duplicateOfLine === null && !row.draft.confirmationSnapshot
              const name = row.draft.customerName ?? 'Unnamed customer'
              return (
                <li key={row.draft.id} className="rounded-xl border border-[#4F74C8]/15 bg-white p-3">
                  <div className="flex items-start gap-2">
                    <label className="-m-2 flex size-11 shrink-0 items-center justify-center">
                      <input
                        type="checkbox"
                        className="size-4 accent-[#4F74C8]"
                        aria-label={`Include line ${row.line}, ${name}`}
                        checked={selectedIds.has(row.draft.id)}
                        disabled={!rowImportable || importing}
                        onChange={(event) => toggleSelected(row, event.target.checked)}
                      />
                    </label>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-[#20242f]">{name}</p>
                      <p className="mt-0.5 break-words text-sm text-[#4A5365]">{summarizeDraftItems(row.draft)}</p>
                      <p className="mt-0.5 text-sm text-[#4A5365]">
                        Line {row.line} · {row.draft.deliveryDate ?? 'No date'}
                        {validation.totalCentavos !== null ? ` · ${formatPhp(validation.totalCentavos)}` : ''}
                      </p>
                      {row.alreadyImported && <p className="mt-1 text-sm font-semibold text-[#365aa8]">Already imported</p>}
                      {row.duplicateOfLine !== null && (
                        <p className="mt-1 text-sm font-semibold text-amber-900">Repeats the source_ref on line {row.duplicateOfLine} — skipped</p>
                      )}
                      {row.looksLikeLine !== null && !row.alreadyImported && (
                        <p className="mt-1 text-sm text-amber-900">Looks the same as line {row.looksLikeLine} — check before importing</p>
                      )}
                      {!row.alreadyImported && row.duplicateOfLine === null && problems.map((problem) => (
                        <p key={problem} className="mt-1 text-sm text-red-800">{problem}</p>
                      ))}
                      {failure?.line === row.line && <p role="alert" className="mt-1 text-sm text-red-800">{failure.message}</p>}
                    </div>
                    {editable && (
                      <button
                        type="button"
                        disabled={importing}
                        className="min-h-11 shrink-0 rounded-xl border border-[#4F74C8]/35 px-3 text-sm font-semibold text-[#36579E] hover:bg-[#4F74C8]/10 disabled:opacity-50"
                        aria-expanded={expanded}
                        aria-label={`Edit line ${row.line}`}
                        onClick={() => toggleExpanded(row.draft.id)}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {expanded && editable && (
                    <div className="mt-3">
                      <OrderEditorCard
                        draft={row.draft}
                        customers={customers}
                        orders={orders}
                        confirming={importing}
                        onChange={(draft) => setRowDraft(row.draft.id, draft)}
                        onConfirm={() => { if (rowImportable) void runImport([row]) }}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
