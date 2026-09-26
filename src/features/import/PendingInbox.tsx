import { Clipboard, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoredCustomer, StoredOrder } from '../../data/types'
import type { ProductSlug } from '../../domain/contracts'
import { formatDeliveryDate } from '../../domain/delivery-schedule'
import { formatPhp } from '../orders/order-display'
import { FieldLabel, OrderEditorCard } from '../order-editor/OrderEditorCard'
import { validateDraft } from './parser'
import {
  acceptPendingSubmission,
  getPendingReconfirmation,
  listPendingSubmissions,
  pendingSubmissionErrorMessage,
  rejectPendingSubmission,
  submittedSnapshotTotalCentavos,
  updatePendingSubmission,
  type PendingSubmissionRow,
} from './pending-api'
import { summarizeDraftItems } from './draft-summary'
import type { ImportDraft, ImportItem, ImportThermalBag } from './types'
import { getPublicOrderMenu, menuDeliveryOptions, type PublicOrderDelivery, type PublicOrderInput, type PublicOrderReconfirmation } from '../public-order/api'

type PendingInboxProps = {
  customers: StoredCustomer[]
  orders: StoredOrder[]
  onCountChange?: (count: number) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asImportItems(value: unknown): ImportItem[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const item = isRecord(entry) ? entry : {}
    const modifiers = isRecord(item.modifiers) ? item.modifiers : item
    const productSlug = typeof item.productSlug === 'string' ? item.productSlug : typeof item.product_slug === 'string' ? item.product_slug : null
    const quantity = typeof item.quantity === 'number' && Number.isSafeInteger(item.quantity) ? item.quantity : null
    const level = modifiers.level === 1 || modifiers.level === 2 || modifiers.level === 3 ? modifiers.level : null
    const powder = modifiers.powder === 'yumeno' || modifiers.powder === 'mk_isuzu' ? modifiers.powder : null
    const sweetness = modifiers.sweetness === 'none' || modifiers.sweetness === 'light' || modifiers.sweetness === 'regular' || modifiers.sweetness === 'extra'
      ? modifiers.sweetness
      : undefined
    const rawNames = Array.isArray(item.cupNames) ? item.cupNames : Array.isArray(item.cup_names) ? item.cup_names : Array.isArray(modifiers.cupNames) ? modifiers.cupNames : []
    const cupNames = rawNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    return {
      id: crypto.randomUUID(),
      productSlug,
      quantity,
      level,
      powder,
      ...(sweetness ? { sweetness } : {}),
      ...(cupNames.length > 0 ? { cupNames } : {}),
    }
  })
}

function asBags(value: unknown): ImportThermalBag[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const bag = isRecord(entry) ? entry : {}
    const count = bag.coveredCupCount ?? bag.covered_cup_count
    return {
      id: crypto.randomUUID(),
      coveredCupCount: count === 1 || count === 2 || count === 3 || count === 4 ? count : null,
    }
  })
}

function submissionToImportDraft(row: PendingSubmissionRow): ImportDraft {
  return {
    id: row.id,
    rawSource: `public-order:${row.reference}`,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    matchedCustomerId: null,
    items: asImportItems(row.items),
    thermalBags: asBags(row.thermal_bags),
    deliveryDate: row.delivery_date,
    address: row.address_snapshot,
    notes: row.notes,
    sourceConfidence: 1,
    unresolvedFields: [],
    sameAsLastTime: false,
  }
}

type FrozenEditorBase = {
  draft: ImportDraft
  expectedReviewVersion: number
  expectedReviewHash: string
  quoteRevision: string
  quotedTotalCentavos: number
  originalDeliveryDate: string
  idempotencyKey: string
}

type SaveQuote = {
  quoteRevision: string
  quotedTotalCentavos: number
  deliveryDate?: string
}

function freezeEditorBase(row: PendingSubmissionRow, draft: ImportDraft): FrozenEditorBase {
  return {
    draft,
    expectedReviewVersion: row.review_version,
    expectedReviewHash: row.review_hash,
    quoteRevision: row.quote_revision,
    quotedTotalCentavos: row.total_centavos,
    originalDeliveryDate: row.delivery_date,
    idempotencyKey: row.idempotency_key,
  }
}

function draftFingerprint(draft: ImportDraft): string {
  return JSON.stringify({
    customerName: draft.customerName,
    customerPhone: draft.customerPhone ?? null,
    items: draft.items.map(({ productSlug, quantity, level, powder, sweetness, cupNames }) => ({
      productSlug,
      quantity,
      level,
      powder,
      sweetness: sweetness ?? null,
      cupNames: cupNames ?? [],
    })),
    thermalBags: draft.thermalBags.map(({ coveredCupCount }) => coveredCupCount),
    deliveryDate: draft.deliveryDate,
    address: draft.address,
    notes: draft.notes,
  })
}

function draftToPublicOrderInput(
  draft: ImportDraft,
  target: { quoteRevision: string; quotedTotalCentavos: number; deliveryDate: string; idempotencyKey: string },
): PublicOrderInput | { error: string } {
  if (!draft.customerName || !draft.customerPhone || !draft.address || !draft.deliveryDate) {
    return { error: 'Name, Viber number, address, and a valid delivery date are required.' }
  }
  const items: PublicOrderInput['items'] = []
  for (const item of draft.items) {
    if (!item.productSlug || !item.quantity || !item.level || !item.powder) {
      return { error: 'Resolve every drink before saving.' }
    }
    items.push({
      productSlug: item.productSlug as ProductSlug,
      quantity: item.quantity,
      modifiers: {
        level: item.level,
        powder: item.powder,
        ...(item.sweetness ? { sweetness: item.sweetness } : {}),
      },
      ...(item.cupNames && item.cupNames.length > 0 ? { cupNames: item.cupNames } : {}),
    })
  }
  const thermalBags: PublicOrderInput['thermalBags'] = []
  for (const bag of draft.thermalBags) {
    if (bag.coveredCupCount !== 1 && bag.coveredCupCount !== 2 && bag.coveredCupCount !== 3 && bag.coveredCupCount !== 4) {
      return { error: 'Thermal bag selections are invalid.' }
    }
    thermalBags.push({ coveredCupCount: bag.coveredCupCount })
  }
  return {
    customerName: draft.customerName,
    customerPhone: draft.customerPhone,
    address: draft.address,
    deliveryDate: target.deliveryDate,
    notes: draft.notes,
    items,
    thermalBags,
    quoteRevision: target.quoteRevision,
    quotedTotalCentavos: target.quotedTotalCentavos,
    idempotencyKey: target.idempotencyKey,
    honeypot: '',
  }
}

function editorDraftInvalid(draft: ImportDraft): boolean {
  if (validateDraft(draft).errors.length > 0) return true
  return !draft.customerName || !draft.customerPhone || !draft.address || !draft.deliveryDate
    || draft.items.some((item) => !item.productSlug || !item.quantity || !item.level || !item.powder)
    || draft.thermalBags.some((bag) => bag.coveredCupCount !== 1 && bag.coveredCupCount !== 2 && bag.coveredCupCount !== 3 && bag.coveredCupCount !== 4)
}

function viberAcceptReply(row: PendingSubmissionRow, drinks: string): string {
  return [
    `Hi ${row.customer_name}!`,
    `Order ${row.reference} is accepted for ${row.delivery_date}.`,
    drinks,
    `Total: ${formatPhp(row.total_centavos)}.`,
    'Please send your GCash screenshot in Viber.',
  ].join('\n')
}

function viberRejectReply(row: PendingSubmissionRow): string {
  return [
    `Hi ${row.customer_name},`,
    `We need to decline order ${row.reference}.`,
    'Please message us in Viber so we can sort it out.',
  ].join('\n')
}

/** The submitted day stays selectable (keeping it needs no reconfirm); any other day must be offered. */
function deliveryDayChoices(offered: readonly PublicOrderDelivery[], submitted: string, current: string | null): { value: string; label: string }[] {
  const choices = offered.map((option) => ({ value: option.deliveryDate, label: formatDeliveryDate(option.deliveryDate) }))
  const has = (date: string) => choices.some((choice) => choice.value === date)
  if (!has(submitted)) choices.unshift({ value: submitted, label: `${formatDeliveryDate(submitted)} · submitted` })
  if (current && !has(current)) choices.push({ value: current, label: `${formatDeliveryDate(current)} · not offered` })
  return choices
}

function formatSignedPhp(centavos: number): string {
  if (centavos === 0) return formatPhp(0)
  const formatted = formatPhp(Math.abs(centavos))
  return centavos > 0 ? `+${formatted}` : `−${formatted}`
}

export function PendingInbox({ customers, orders, onCountChange }: PendingInboxProps) {
  const [rows, setRows] = useState<PendingSubmissionRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, ImportDraft>>({})
  const [editorBases, setEditorBases] = useState<Record<string, FrozenEditorBase>>({})
  const [reconfirmById, setReconfirmById] = useState<Record<string, PublicOrderReconfirmation>>({})
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({})
  const [differences, setDifferences] = useState<Record<string, { previous: number; next: number; delta: number }>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [accepting, setAccepting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<Record<string, string>>({})
  // Days customers can currently pick; a changed date must be one of them.
  const [offeredDates, setOfferedDates] = useState<PublicOrderDelivery[] | null>(null)
  const [offeredDatesFailed, setOfferedDatesFailed] = useState(false)
  const expandedIdRef = useRef<string | null>(null)
  expandedIdRef.current = expandedId
  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange

  const refresh = useCallback(async () => {
    try {
      const next = await listPendingSubmissions()
      const expanded = expandedIdRef.current
      setRows(next)
      // Compact rows may move to a newer review_version/hash. The open editor
      // keeps the draft and CAS tokens frozen at Edit (or last successful save).
      setDrafts((current) => {
        const mapped: Record<string, ImportDraft> = {}
        for (const row of next) {
          mapped[row.id] = current[row.id] && expanded === row.id ? current[row.id] : submissionToImportDraft(row)
        }
        return mapped
      })
      setEditorBases((current) => {
        if (!expanded || !current[expanded] || !next.some((row) => row.id === expanded)) return {}
        return { [expanded]: current[expanded] }
      })
      setReconfirmById((current) => {
        if (!expanded || !current[expanded] || !next.some((row) => row.id === expanded)) return {}
        return { [expanded]: current[expanded] }
      })
      setSelectedIds((current) => new Set([...current].filter((id) => next.some((row) => row.id === id))))
      onCountChangeRef.current?.(next.length)
      setMessage(null)
    } catch (error) {
      setMessage(pendingSubmissionErrorMessage(error))
      onCountChangeRef.current?.(0)
    }
  }, [])

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
    const run = () => { if (active && document.visibilityState === 'visible') void refresh() }
    run()
    timer = setInterval(run, 30_000)
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      active = false
      if (timer) clearInterval(timer)
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [refresh])

  const setDraft = (next: ImportDraft) => {
    setDrafts((current) => ({ ...current, [next.id]: next }))
  }

  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.has(row.id)), [rows, selectedIds])

  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const loadOfferedDates = () => {
    getPublicOrderMenu()
      .then((menu) => { setOfferedDates(menuDeliveryOptions(menu)); setOfferedDatesFailed(false) })
      .catch(() => setOfferedDatesFailed(true))
  }

  const openEditor = (row: PendingSubmissionRow) => {
    loadOfferedDates()
    const draft = drafts[row.id] ?? submissionToImportDraft(row)
    setExpandedId(row.id)
    setDrafts((current) => current[row.id] ? current : { ...current, [row.id]: draft })
    setEditorBases((current) => current[row.id] ? current : { ...current, [row.id]: freezeEditorBase(row, draft) })
  }

  const dropEditorState = (id: string) => {
    setDrafts((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setEditorBases((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setReconfirmById((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setExpandedId((current) => current === id ? null : current)
  }

  const saveEdit = async (row: PendingSubmissionRow, quote?: SaveQuote) => {
    const base = editorBases[row.id]
    if (!base) {
      setItemErrors((current) => ({ ...current, [row.id]: 'Open the editor before saving.' }))
      return
    }
    if (!quote && reconfirmById[row.id]) return
    const draft = drafts[row.id] ?? base.draft
    const validation = validateDraft(draft)
    const quotedTotalCentavos = quote?.quotedTotalCentavos ?? validation.totalCentavos ?? base.quotedTotalCentavos
    const quoteRevision = quote?.quoteRevision ?? base.quoteRevision
    const dateChanged = Boolean(draft.deliveryDate && draft.deliveryDate !== base.originalDeliveryDate)
    const deliveryDate = quote?.deliveryDate ?? (dateChanged ? draft.deliveryDate! : base.originalDeliveryDate)
    if (dateChanged && offeredDates && !offeredDates.some((option) => option.deliveryDate === deliveryDate)) {
      setItemErrors((current) => ({ ...current, [row.id]: 'Choose one of the offered delivery days, or keep the submitted date.' }))
      return
    }
    const input = draftToPublicOrderInput(draft, {
      quoteRevision,
      quotedTotalCentavos,
      deliveryDate,
      idempotencyKey: base.idempotencyKey,
    })
    if ('error' in input) {
      setItemErrors((current) => ({ ...current, [row.id]: input.error }))
      return
    }
    setBusyId(row.id)
    setItemErrors((current) => {
      const next = { ...current }
      delete next[row.id]
      return next
    })
    try {
      const result = await updatePendingSubmission(row.id, {
        ...input,
        expectedReviewVersion: base.expectedReviewVersion,
        expectedReviewHash: base.expectedReviewHash,
      })
      const savedDraft = submissionToImportDraft(result.submission)
      setRows((current) => current.map((entry) => entry.id === row.id ? result.submission : entry))
      setDrafts((current) => ({ ...current, [row.id]: savedDraft }))
      setEditorBases((current) => ({ ...current, [row.id]: freezeEditorBase(result.submission, savedDraft) }))
      setReconfirmById((current) => {
        const next = { ...current }
        delete next[row.id]
        return next
      })
      setDifferences((current) => ({
        ...current,
        [row.id]: {
          previous: result.previousTotalCentavos,
          next: result.newTotalCentavos,
          delta: result.differenceCentavos,
        },
      }))
    } catch (error) {
      const reconfirm = getPendingReconfirmation(error)
      if (reconfirm) {
        setOfferedDates(reconfirm.deliveryOptions)
        setReconfirmById((current) => ({ ...current, [row.id]: reconfirm }))
        return
      }
      setItemErrors((current) => ({ ...current, [row.id]: pendingSubmissionErrorMessage(error) }))
    } finally {
      setBusyId(null)
    }
  }

  const confirmUpdatedQuote = (row: PendingSubmissionRow) => {
    const reconfirm = reconfirmById[row.id]
    const base = editorBases[row.id]
    if (!reconfirm || !base) return
    const draft = drafts[row.id] ?? base.draft
    const dateChanged = Boolean(draft.deliveryDate && draft.deliveryDate !== base.originalDeliveryDate)
    // Keep the owner's new day while it is still offered; otherwise move to the first offered day.
    const deliveryDate = dateChanged
      ? (reconfirm.deliveryOptions.find((option) => option.deliveryDate === draft.deliveryDate) ?? reconfirm.delivery).deliveryDate
      : base.originalDeliveryDate
    setEditorBases((current) => {
      const existing = current[row.id]
      if (!existing) return current
      return {
        ...current,
        [row.id]: {
          ...existing,
          quoteRevision: reconfirm.quoteRevision,
          quotedTotalCentavos: reconfirm.quote.totalCentavos,
        },
      }
    })
    if (dateChanged && draft.deliveryDate !== deliveryDate) {
      setDraft({ ...draft, deliveryDate })
    }
    setReconfirmById((current) => {
      const next = { ...current }
      delete next[row.id]
      return next
    })
    void saveEdit(row, {
      quoteRevision: reconfirm.quoteRevision,
      quotedTotalCentavos: reconfirm.quote.totalCentavos,
      deliveryDate,
    })
  }

  const acceptBlockReason = (row: PendingSubmissionRow): string | null => {
    const draft = drafts[row.id] ?? submissionToImportDraft(row)
    const dirty = draftFingerprint(draft) !== draftFingerprint(submissionToImportDraft(row))
      || (editorBases[row.id] ? draftFingerprint(draft) !== draftFingerprint(editorBases[row.id].draft) : false)
    const invalid = editorDraftInvalid(draft)
    if (dirty) return 'This submission has unsaved editor changes. Save or discard them before accepting.'
    if (invalid && editorBases[row.id]) return 'This submission has incomplete required fields. Save or discard the editor draft before accepting.'
    return null
  }

  const acceptSelected = async () => {
    if (accepting || selectedRows.length === 0) return
    const blocked: Record<string, string> = {}
    for (const row of selectedRows) {
      const reason = acceptBlockReason(row)
      if (reason) blocked[row.id] = reason
    }
    if (Object.keys(blocked).length > 0) {
      setItemErrors((current) => ({ ...current, ...blocked }))
      setMessage('Save or discard unsaved editor changes before accepting.')
      return
    }
    setAccepting(true)
    const succeeded = new Set<string>()
    const nextErrors: Record<string, string> = {}
    for (const row of selectedRows) {
      try {
        await acceptPendingSubmission(row.id, row.review_hash)
        succeeded.add(row.id)
      } catch (error) {
        nextErrors[row.id] = pendingSubmissionErrorMessage(error)
      }
    }
    setRows((current) => current.filter((row) => !succeeded.has(row.id)))
    setSelectedIds((current) => new Set([...current].filter((id) => !succeeded.has(id))))
    setItemErrors((current) => ({ ...current, ...nextErrors }))
    setDrafts((current) => {
      const next = { ...current }
      for (const id of succeeded) delete next[id]
      return next
    })
    setEditorBases((current) => {
      const next = { ...current }
      for (const id of succeeded) delete next[id]
      return next
    })
    setReconfirmById((current) => {
      const next = { ...current }
      for (const id of succeeded) delete next[id]
      return next
    })
    if (expandedId && succeeded.has(expandedId)) setExpandedId(null)
    onCountChange?.(rows.length - succeeded.size)
    setAccepting(false)
    if (succeeded.size > 0) setMessage(`Accepted ${succeeded.size} submission${succeeded.size === 1 ? '' : 's'}.`)
  }

  const rejectOne = async (row: PendingSubmissionRow) => {
    setBusyId(row.id)
    try {
      await rejectPendingSubmission(row.id)
      setRows((current) => current.filter((entry) => entry.id !== row.id))
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(row.id)
        return next
      })
      dropEditorState(row.id)
      onCountChange?.(Math.max(0, rows.length - 1))
    } catch (error) {
      setItemErrors((current) => ({ ...current, [row.id]: pendingSubmissionErrorMessage(error) }))
    } finally {
      setBusyId(null)
    }
  }

  const copyReply = async (key: string, text: string) => {
    if (!navigator.clipboard?.writeText) {
      setCopyState((current) => ({ ...current, [key]: 'failed' }))
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopyState((current) => ({ ...current, [key]: 'copied' }))
    } catch {
      setCopyState((current) => ({ ...current, [key]: 'failed' }))
    }
  }

  return (
    <section className="rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm" aria-labelledby="pending-submissions-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="pending-submissions-heading" className="text-lg font-black tracking-tight text-[#20242f]">Pending submissions</h2>
          <p className="mt-0.5 text-sm text-[#4A5365]">Review before Today.</p>
        </div>
        <span className="rounded-full bg-[#4F74C8] px-2.5 py-1 text-xs font-bold text-white">{rows.length} pending</span>
      </div>
      <button
        type="button"
        disabled={accepting || selectedRows.length === 0}
        onClick={() => void acceptSelected()}
        className="mt-3 flex min-h-12 w-full items-center justify-center rounded-xl bg-[#4F74C8] px-4 font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
      >
        {accepting && <LoaderCircle className="mr-2 motion-safe:animate-spin" size={17} />}
        Accept selected ({selectedRows.length})
      </button>
      {message && <p role="status" className="mt-3 rounded-xl bg-[#4F74C8]/10 p-3 text-sm text-[#263d70]">{message}</p>}
      {rows.length === 0 && !message && <p className="mt-3 text-sm text-[#4A5365]">No pending submissions.</p>}
      <ul className="mt-3 space-y-3">
        {rows.map((row) => {
          const draft = drafts[row.id] ?? submissionToImportDraft(row)
          const drinks = summarizeDraftItems(draft)
          const submittedTotal = submittedSnapshotTotalCentavos(row.submitted_snapshot)
          const diff = differences[row.id]
          const delta = diff?.delta ?? (submittedTotal === null ? 0 : row.total_centavos - submittedTotal)
          const previous = diff?.previous ?? submittedTotal
          const acceptReply = viberAcceptReply(row, drinks)
          const rejectReply = viberRejectReply(row)
          const expanded = expandedId === row.id
          return (
            <li key={row.id} className="rounded-xl border border-[#4F74C8]/15 bg-white p-3">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[#4F74C8]"
                  aria-label={`Select ${row.customer_name}`}
                  checked={selectedIds.has(row.id)}
                  onChange={(event) => toggleSelected(row.id, event.target.checked)}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-[#20242f]">{row.customer_name}</p>
                  <p className="mt-0.5 break-words text-sm text-[#4A5365]">Viber {row.customer_phone}</p>
                  <p className="mt-0.5 break-words text-sm text-[#4A5365]">{row.address_snapshot}</p>
                  <p className="mt-0.5 text-sm text-[#4A5365]">{row.delivery_date} · {drinks} · {formatPhp(row.total_centavos)}</p>
                  <p className="mt-0.5 text-xs font-semibold text-[#365aa8]">Ref {row.reference}</p>
                  {delta !== 0 && previous !== null && (
                    <p className="mt-1 text-sm font-semibold text-amber-900">
                      Total {formatSignedPhp(delta)} vs submitted {formatPhp(previous)}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-[#4F74C8]/35 px-3 py-2 text-sm font-semibold text-[#36579E] transition-colors hover:bg-[#4F74C8]/10"
                  aria-expanded={expanded}
                  onClick={() => expanded ? setExpandedId(null) : openEditor(row)}
                >
                  {expanded ? 'Hide editor' : 'Edit'}
                </button>
                <button
                  type="button"
                  disabled={busyId === row.id}
                  className="rounded-xl px-3 py-2 text-sm font-semibold text-rose-700 underline underline-offset-2 hover:bg-rose-50 disabled:opacity-50"
                  onClick={() => void rejectOne(row)}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="inline-flex items-center rounded-xl border border-[#4F74C8]/30 px-3 py-2 text-sm font-semibold text-[#365aa8] hover:bg-[#4F74C8]/10"
                  onClick={() => void copyReply(`${row.id}-accept`, acceptReply)}
                >
                  <Clipboard className="mr-1" size={14} />Copy Viber accept reply
                </button>
                <button
                  type="button"
                  className="inline-flex items-center rounded-xl border border-[#4F74C8]/30 px-3 py-2 text-sm font-semibold text-[#365aa8] hover:bg-[#4F74C8]/10"
                  onClick={() => void copyReply(`${row.id}-reject`, rejectReply)}
                >
                  <Clipboard className="mr-1" size={14} />Copy Viber reject reply
                </button>
              </div>
              <div className="mt-2">
                <FieldLabel>Viber accept reply</FieldLabel>
                <textarea readOnly aria-label={`Viber accept reply for ${row.customer_name}`} value={acceptReply} className="mt-1 min-h-24 w-full rounded-xl border border-[#4F74C8]/20 bg-[#FBF3D5] p-2 text-xs text-[#20242f]" />
              </div>
              <div className="mt-2">
                <FieldLabel>Viber reject reply</FieldLabel>
                <textarea readOnly aria-label={`Viber reject reply for ${row.customer_name}`} value={rejectReply} className="mt-1 min-h-20 w-full rounded-xl border border-[#4F74C8]/20 bg-[#FBF3D5] p-2 text-xs text-[#20242f]" />
              </div>
              {copyState[`${row.id}-accept`] === 'copied' && <p role="status" className="mt-1 text-xs text-[#365aa8]">Accept reply copied.</p>}
              {copyState[`${row.id}-reject`] === 'copied' && <p role="status" className="mt-1 text-xs text-[#365aa8]">Reject reply copied.</p>}
              {copyState[`${row.id}-accept`] === 'failed' || copyState[`${row.id}-reject`] === 'failed' ? <p role="alert" className="mt-1 text-xs text-rose-700">Copying was unavailable. The reply is still selectable above.</p> : null}
              {itemErrors[row.id] && <p role="alert" className="mt-2 rounded-xl bg-red-50 p-2 text-sm text-red-800">{itemErrors[row.id]}</p>}
              {reconfirmById[row.id] && (
                <div className="mt-2 rounded-xl border border-[#4F74C8]/30 bg-[#EAF0FF] p-3" aria-labelledby={`review-updated-quote-${row.id}`}>
                  <h3 id={`review-updated-quote-${row.id}`} className="text-sm font-black text-[#20242f]">Review updated quote</h3>
                  <p className="mt-1 text-sm text-[#263d70]">
                    New delivery date {reconfirmById[row.id].delivery.deliveryDate} · New total {formatPhp(reconfirmById[row.id].quote.totalCentavos)}
                  </p>
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    className="mt-2 min-h-11 rounded-xl bg-[#4F74C8] px-3 text-sm font-bold text-white transition-colors hover:bg-[#365AA9] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => confirmUpdatedQuote(row)}
                  >
                    Confirm updated quote
                  </button>
                </div>
              )}
              {expanded && (
                <div className="mt-3">
                  <div className="mb-3">
                    {offeredDates ? (
                      <FieldLabel>
                        Offered delivery day
                        <select
                          aria-label="Offered delivery day"
                          className="mt-1 min-h-11 w-full rounded-xl border border-[#4F74C8]/25 bg-white px-3 text-sm normal-case tracking-normal text-[#20242f] outline-none transition-colors focus:border-[#4F74C8] focus:ring-2 focus:ring-[#4F74C8]/20"
                          value={draft.deliveryDate ?? ''}
                          onChange={(event) => setDraft({ ...draft, deliveryDate: event.target.value || null })}
                        >
                          {deliveryDayChoices(offeredDates, editorBases[row.id]?.originalDeliveryDate ?? row.delivery_date, draft.deliveryDate).map((choice) => (
                            <option key={choice.value} value={choice.value}>{choice.label}</option>
                          ))}
                        </select>
                      </FieldLabel>
                    ) : (
                      <p className="text-sm text-[#4A5365]">{offeredDatesFailed ? 'Offered delivery days could not be loaded. The date is still checked when you save.' : 'Loading offered delivery days…'}</p>
                    )}
                  </div>
                  <OrderEditorCard
                    draft={draft}
                    customers={customers}
                    orders={orders}
                    confirming={busyId === row.id}
                    onChange={setDraft}
                    onConfirm={() => void saveEdit(row)}
                    hideDeliveryDate={Boolean(offeredDates)}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
