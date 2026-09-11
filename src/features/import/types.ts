import type { DrinkLevel, Powder, ProductSlug, Sweetness } from '../../domain/contracts'

export type ImportItem = {
  id: string
  productSlug: string | null
  quantity: number | null
  level: DrinkLevel | null
  powder: Powder | null
  sweetness?: Sweetness | null
  /** Optional per-cup names, at most one per cup in `quantity`. */
  cupNames?: string[]
}

export type ImportThermalBag = {
  id: string
  coveredCupCount: number | null
}

export type ImportDraft = {
  id: string
  rawSource: string
  customerName: string | null
  customerPhone?: string | null
  matchedCustomerId: string | null
  items: ImportItem[]
  thermalBags: ImportThermalBag[]
  deliveryDate: string | null
  address: string | null
  notes: string | null
  sourceConfidence: number | null
  unresolvedFields: string[]
  sameAsLastTime: boolean
  /** Stable key used by the storage transaction across refreshes/retries. */
  confirmationKey?: string
  /** Hash of the last attempted logical payload for the stable key. */
  confirmationRequestHash?: string
  confirmationAttemptedAt?: number
}

export type StructuralItem = {
  product_slug?: unknown
  quantity?: unknown
  level?: unknown
  powder?: unknown
  sweetness?: unknown
  cup_names?: unknown
}

export type StructuralOrder = {
  customer_name?: unknown
  customer_phone?: unknown
  items?: unknown
  thermal_bags?: unknown
  delivery_date?: unknown
  address?: unknown
  notes?: unknown
  source_confidence?: unknown
  unresolved_fields?: unknown
}

export type DraftValidation = {
  errors: string[]
  warnings: string[]
  totalCentavos: number | null
  itemTotalsCentavos: ReadonlyMap<string, number>
}

export type ProductAliasDictionary = Readonly<Record<string, ProductSlug>>
