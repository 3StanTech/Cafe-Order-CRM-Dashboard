import { getRuntimeCatalog } from '../../domain/catalog'
import type { ProductSlug } from '../../domain/contracts'
import { validateDraft } from './parser'
import type { ImportDraft } from './types'

/** Customer + date + items only — used to flag probable duplicate pastes. */
export function draftDuplicateIdentity(draft: ImportDraft): string {
  return JSON.stringify({
    customerName: draft.customerName,
    deliveryDate: draft.deliveryDate,
    items: draft.items.map(({ productSlug, quantity, level, powder, sweetness, cupNames }) => ({
      productSlug,
      quantity,
      level,
      powder,
      sweetness: sweetness ?? null,
      cupNames: cupNames ?? [],
    })),
  })
}

export function duplicateDraftIds(drafts: readonly ImportDraft[]): Set<string> {
  const grouped = new Map<string, string[]>()
  for (const draft of drafts) {
    const key = draftDuplicateIdentity(draft)
    const ids = grouped.get(key)
    if (ids) ids.push(draft.id)
    else grouped.set(key, [draft.id])
  }
  const flagged = new Set<string>()
  for (const ids of grouped.values()) {
    if (ids.length > 1) ids.forEach((id) => flagged.add(id))
  }
  return flagged
}

export function summarizeDraftItems(draft: ImportDraft): string {
  const catalog = getRuntimeCatalog()
  if (draft.items.length === 0) return 'No drinks'
  return draft.items.map((item) => {
    const name = item.productSlug && item.productSlug in catalog
      ? catalog[item.productSlug as ProductSlug].name
      : (item.productSlug ?? 'Unresolved drink')
    const quantity = item.quantity ?? '?'
    const level = item.level ? ` L${item.level}` : ''
    return `${quantity}× ${name}${level}`
  }).join(', ')
}

export function draftHasBlockingErrors(draft: ImportDraft): boolean {
  return validateDraft(draft).errors.length > 0
}
