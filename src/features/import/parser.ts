import { MAX_CUPS_PER_ORDER, priceOrder } from '../../domain/pricing'
import type { OrderDraft, ProductSlug } from '../../domain/contracts'
import { PricingError } from '../../domain/pricing-error'
import { defaultLevel, normalizeLevel, normalizePowder, normalizeProductSlug, normalizeSweetness } from './catalog'
import { normalizeCupNames } from './cup-names'
import type { DraftValidation, ImportDraft, ImportItem, ImportThermalBag, StructuralItem, StructuralOrder } from './types'

function id(): string { return crypto.randomUUID() }
function stringOrNull(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) ? value : null }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [] }

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function structuralItems(value: unknown): StructuralItem[] {
  return Array.isArray(value) ? value.map(asObject).filter((item): item is StructuralItem => item !== null) : []
}

function thermalBags(value: unknown): ImportThermalBag[] {
  if (typeof value === 'number') return [{ id: id(), coveredCupCount: numberOrNull(value) }]
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const object = asObject(entry)
    return { id: id(), coveredCupCount: numberOrNull(object?.covered_cup_count ?? object?.coveredCupCount ?? entry) }
  })
}

function normalizeItem(item: StructuralItem, index: number, unresolved: string[]): ImportItem {
  const productSlug = normalizeProductSlug(item.product_slug)
  if (!productSlug) unresolved.push(`Item ${index + 1}: unknown product "${String(item.product_slug ?? '')}"`)
  const quantity = numberOrNull(item.quantity)
  if (!quantity || quantity < 1) unresolved.push(`Item ${index + 1}: quantity must be a positive integer`)
  else if (quantity > MAX_CUPS_PER_ORDER) {
    unresolved.push(`Item ${index + 1}: quantity cannot exceed ${MAX_CUPS_PER_ORDER} cups`)
  }
  const level = item.level === undefined || item.level === null || item.level === '' ? defaultLevel(productSlug) : normalizeLevel(item.level)
  if (!level) unresolved.push(`Item ${index + 1}: unknown level "${String(item.level ?? '')}"`)
  const powder = item.powder === undefined || item.powder === null || item.powder === '' ? 'yumeno' : normalizePowder(item.powder)
  if (!powder) unresolved.push(`Item ${index + 1}: unknown powder "${String(item.powder ?? '')}"`)
  const sweetness = normalizeSweetness(item.sweetness)
  if (sweetness === null) unresolved.push(`Item ${index + 1}: unknown sweetness "${String(item.sweetness ?? '')}"`)
  const cupNames = normalizeCupNames(item.cup_names)
  // Quantity is retained for error display; padCupNames hard-caps Array.from size.
  return { id: id(), productSlug, quantity, level, powder, ...(sweetness === undefined ? {} : { sweetness }), ...(cupNames.length > 0 ? { cupNames } : {}) }
}

export function normalizeCandidate(candidate: StructuralOrder, rawSource: string): ImportDraft {
  const unresolved = arrayOfStrings(candidate.unresolved_fields)
  const items = structuralItems(candidate.items)
  if (items.length === 0) unresolved.push('At least one order item is required')
  const importedItems = items.map((item, index) => normalizeItem(item, index, unresolved))
  const totalCups = importedItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0)
  if (totalCups > MAX_CUPS_PER_ORDER) {
    unresolved.push(`An order cannot exceed ${MAX_CUPS_PER_ORDER} cups in total`)
  }
  const bags = thermalBags(candidate.thermal_bags)
  bags.forEach((bag, index) => {
    if (!bag.coveredCupCount || bag.coveredCupCount < 1 || bag.coveredCupCount > 4) unresolved.push(`Thermal bag ${index + 1}: it must cover 1, 2, 3, or 4 cups`)
  })
  const confidence = typeof candidate.source_confidence === 'number' && candidate.source_confidence >= 0 && candidate.source_confidence <= 1
    ? candidate.source_confidence : null
  return {
    id: id(), rawSource,
    customerName: stringOrNull(candidate.customer_name),
    customerPhone: stringOrNull(candidate.customer_phone),
    matchedCustomerId: null,
    items: importedItems,
    thermalBags: bags,
    deliveryDate: stringOrNull(candidate.delivery_date),
    address: stringOrNull(candidate.address),
    notes: stringOrNull(candidate.notes),
    sourceConfidence: confidence,
    unresolvedFields: [...new Set(unresolved)],
    sameAsLastTime: /same\s+as\s+(?:last\s+time|usual)|pareho\s+(?:ng|sa)\s+dati/i.test(rawSource),
  }
}

function candidatesFromParsed(value: unknown): StructuralOrder[] {
  if (Array.isArray(value)) return value.map(asObject).filter((entry): entry is StructuralOrder => entry !== null)
  const object = asObject(value)
  if (!object) return [{}]
  if (Array.isArray(object.orders)) return object.orders.map(asObject).filter((entry): entry is StructuralOrder => entry !== null)
  return [object]
}

function structuralDraftKey(draft: ImportDraft): string {
  return JSON.stringify({
    customerName: draft.customerName,
    // cupNames participate in the key: two otherwise-identical orders naming
    // different people are genuinely different orders, not a duplicate paste.
    items: draft.items.map(({ productSlug, quantity, level, powder, sweetness, cupNames }) => ({ productSlug, quantity, level, powder, sweetness, cupNames })),
    thermalBags: draft.thermalBags.map(({ coveredCupCount }) => ({ coveredCupCount })),
    deliveryDate: draft.deliveryDate,
    address: draft.address,
    notes: draft.notes,
  })
}

function deduplicateStructuralDrafts(drafts: ImportDraft[]): ImportDraft[] {
  const seen = new Set<string>()
  return drafts.filter((draft) => {
    const key = structuralDraftKey(draft)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type LocalParseResult = { kind: 'local'; drafts: ImportDraft[] } | { kind: 'free-text' } | { kind: 'empty' }

/** Parses JSON only; callers use this result to guarantee local input does not reach fetch. */
export function parseLocalInput(rawText: string): LocalParseResult {
  const trimmed = rawText.trim()
  if (!trimmed) return { kind: 'empty' }
  try {
    return { kind: 'local', drafts: candidatesFromParsed(JSON.parse(trimmed)).map((candidate) => normalizeCandidate(candidate, rawText)) }
  } catch {
    const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) return { kind: 'empty' }
    try {
      const candidates = lines.map((line) => {
        const candidate = JSON.parse(line)
        if (!asObject(candidate)) throw new Error('A JSON line must be an object')
        return candidate
      })
      return { kind: 'local', drafts: deduplicateStructuralDrafts(candidates.map((candidate, index) => normalizeCandidate(candidate, lines[index]))) }
    } catch {
      return { kind: 'free-text' }
    }
  }
}

export function normalizeFunctionResponse(value: unknown, rawText: string): ImportDraft[] {
  return candidatesFromParsed(value).map((candidate) => normalizeCandidate(candidate, rawText))
}

function asPricedOrderDraft(draft: ImportDraft): OrderDraft | null {
  if (draft.items.some((item) => !item.productSlug || !item.quantity || !item.level || !item.powder)) return null
  return {
    customer: draft.customerName ? { name: draft.customerName } : undefined,
    items: draft.items.map((item) => ({
      productSlug: item.productSlug! as ProductSlug, quantity: item.quantity!,
      modifiers: { level: item.level!, powder: item.powder!, ...(item.sweetness ? { sweetness: item.sweetness } : {}) },
    })),
    thermalBags: draft.thermalBags.map((bag) => ({ coveredCupCount: bag.coveredCupCount! })),
  }
}

export function validateDraft(draft: ImportDraft): DraftValidation {
  const errors = [...draft.unresolvedFields]
  const warnings: string[] = []
  if (!draft.customerName) errors.push('Customer name is required')
  draft.items.forEach((item, index) => {
    const names = normalizeCupNames(item.cupNames)
    if (item.quantity !== null && names.length > item.quantity) {
      errors.push(`Item ${index + 1}: ${names.length} cup names for only ${item.quantity} ${item.quantity === 1 ? 'cup' : 'cups'}`)
    }
  })
  if (!draft.address) warnings.push('Delivery address is missing — review before confirming')
  const orderDraft = asPricedOrderDraft(draft)
  if (!orderDraft) return { errors, warnings, totalCentavos: null, itemTotalsCentavos: new Map() }
  try {
    const priced = priceOrder(orderDraft)
    return { errors, warnings, totalCentavos: priced.totals.totalCentavos, itemTotalsCentavos: new Map(priced.items.map((item, index) => [draft.items[index].id, item.lineTotalCentavos])) }
  } catch (error) {
    errors.push(error instanceof PricingError ? error.message : 'The draft could not be priced')
    return { errors, warnings, totalCentavos: null, itemTotalsCentavos: new Map() }
  }
}
