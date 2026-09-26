import { manilaToday } from '../../domain/delivery-schedule'
import { HISTORY_IMPORT_SOURCE_PREFIX } from '../../domain/order-source'
import type { StoredCustomer, StoredOrder } from '../../data/types'
import { applyCustomerMatch } from '../import/customer-matching'
import { draftDuplicateIdentity } from '../import/draft-summary'
import { normalizeCandidate, validateDraft } from '../import/parser'
import type { ImportDraft, StructuralOrder } from '../import/types'

export const MAX_SOURCE_REF_LENGTH = 120
export const MAX_HISTORY_LINES = 2000

/** One JSON-object line. Lines that are not JSON objects are reported as errors instead. */
export type HistoryRow = {
  line: number
  sourceRef: string | null
  draft: ImportDraft
  /** Set when an order with this `raw_source` is already saved. */
  alreadyImported: boolean
  /** Line number of the first row with the same `source_ref`, when this row repeats it. */
  duplicateOfLine: number | null
  /** Line number of an earlier row with the same customer, date and drinks. */
  looksLikeLine: number | null
}

export type HistoryLineError = { line: number; message: string }

export type HistoryParseResult = {
  rows: HistoryRow[]
  errors: HistoryLineError[]
}

type ParseContext = {
  now: Date
  customers: readonly StoredCustomer[]
  orders: readonly StoredOrder[]
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function sourceRefOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_SOURCE_REF_LENGTH ? trimmed : null
}

export function historyRawSource(sourceRef: string): string {
  return `${HISTORY_IMPORT_SOURCE_PREFIX}${sourceRef}`
}

/**
 * Copies only the fields the history format defines. Price, subtotal, total and
 * any other money a line carries are never read: every order is re-priced from
 * the catalog when it is saved.
 */
function structuralOrder(object: Record<string, unknown>): StructuralOrder {
  const entries = Array.isArray(object.items) ? object.items : []
  const items = entries.map(asObject).filter((item): item is Record<string, unknown> => item !== null).map((item) => ({
    product_slug: item.product_slug,
    quantity: item.quantity,
    level: item.level,
    powder: item.powder,
    sweetness: item.sweetness,
    cup_names: item.cup_names,
  }))
  // The shared normalizer skips non-object items; surface them instead of losing a drink.
  const unresolved = items.length < entries.length ? ['Every item must be a JSON object'] : []
  return {
    unresolved_fields: unresolved,
    customer_name: object.customer_name,
    customer_phone: object.customer_phone,
    items,
    thermal_bags: object.thermal_bags,
    delivery_date: object.delivery_date,
    address: object.address,
    notes: object.notes,
  }
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Row-level problems that block import, on top of the draft's own validation. */
export function historyRowProblems(row: HistoryRow, now: Date): string[] {
  const problems: string[] = []
  if (!row.sourceRef) problems.push(`source_ref is required (up to ${MAX_SOURCE_REF_LENGTH} characters)`)
  const date = row.draft.deliveryDate
  if (!date) problems.push('Delivery date is required')
  else if (!isCalendarDate(date)) problems.push('Delivery date must be a real date written YYYY-MM-DD')
  else if (date > manilaToday(now)) problems.push('Delivery date is in the future — history import only takes past orders')
  problems.push(...validateDraft(row.draft).errors)
  return [...new Set(problems)]
}

/** A row can be imported when it is new, not a repeat, and has no problems. */
export function isImportableRow(row: HistoryRow, now: Date): boolean {
  return !row.alreadyImported && row.duplicateOfLine === null && historyRowProblems(row, now).length === 0
}

/**
 * Parses JSON Lines, one past order per line. Blank lines are skipped. Nothing
 * is dropped silently: a line that is not a JSON object becomes an error, and
 * a repeated `source_ref` stays in the list marked as a duplicate.
 */
export function parseHistoryImport(text: string, context: ParseContext): HistoryParseResult {
  const rows: HistoryRow[] = []
  const errors: HistoryLineError[] = []
  const existingSources = new Set(context.orders.map((order) => order.rawSource))
  const firstLineByRef = new Map<string, number>()
  const firstLineByIdentity = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  let counted = 0

  lines.forEach((rawLine, index) => {
    const line = index + 1
    const trimmed = rawLine.trim()
    if (!trimmed) return
    counted += 1
    if (counted > MAX_HISTORY_LINES) {
      if (counted === MAX_HISTORY_LINES + 1) errors.push({ line, message: `Only ${MAX_HISTORY_LINES} orders can be imported at once. Split the file and import the rest separately.` })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      errors.push({ line, message: 'This line is not valid JSON' })
      return
    }
    const object = asObject(parsed)
    if (!object) {
      errors.push({ line, message: 'Each line must be one JSON object' })
      return
    }
    const sourceRef = sourceRefOf(object.source_ref)
    const rawSource = sourceRef ? historyRawSource(sourceRef) : HISTORY_IMPORT_SOURCE_PREFIX
    const draft = applyCustomerMatch(normalizeCandidate(structuralOrder(object), rawSource), context.customers, context.orders)
    const duplicateOfLine = sourceRef ? firstLineByRef.get(sourceRef) ?? null : null
    if (sourceRef && duplicateOfLine === null) firstLineByRef.set(sourceRef, line)
    const identity = draftDuplicateIdentity(draft)
    const looksLikeLine = firstLineByIdentity.get(identity) ?? null
    if (looksLikeLine === null) firstLineByIdentity.set(identity, line)
    rows.push({
      line,
      sourceRef,
      draft,
      alreadyImported: sourceRef !== null && existingSources.has(rawSource),
      duplicateOfLine,
      looksLikeLine: duplicateOfLine === null ? looksLikeLine : null,
    })
  })

  return { rows, errors }
}
