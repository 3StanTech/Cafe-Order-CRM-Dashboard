import type {
  DrinkFamily,
  ModifierGroup,
  Powder,
  ProductFlavor,
  ProductSlug,
  Sweetness,
} from '../../domain/contracts'

export const PUBLIC_ORDER_ENDPOINT = '/.netlify/functions/order-submissions'

export type PublicOrderDelivery = {
  deliveryDate: string
  deliveryWindowStart: string
  deliveryWindowEnd: string
}

export type PublicOrderProduct = {
  slug: ProductSlug
  name: string
  family: DrinkFamily
  flavor: ProductFlavor
  milk: 'oat_milk'
  basePriceCentavos: number
  modifierGroups: ModifierGroup[]
  levelUpcharges: Record<1 | 2 | 3, number>
  powderUpcharges: Record<Powder, number>
  thermalBagPrices: Record<1 | 2 | 3 | 4, number>
  sweetnessOptions: Sweetness[]
}

export type PublicOrderMenu = {
  business: {
    name: string
    description: string
    contact: string
  }
  payment: {
    method: 'GCash'
    account: string
    instructions: string
  }
  delivery: PublicOrderDelivery
  /** Every day the customer may pick; the parser always fills it, falling back to `[delivery]`. */
  deliveryOptions?: PublicOrderDelivery[]
  quoteRevision: string
  products: PublicOrderProduct[]
}

export type PublicOrderDraftItem = {
  productSlug: ProductSlug
  quantity: number
  modifiers: {
    level: 1 | 2 | 3
    powder: Powder
    sweetness?: Sweetness
  }
  cupNames?: string[]
}

export type PublicOrderInput = {
  customerName: string
  customerPhone: string
  address: string
  deliveryDate: string
  notes: string | null
  items: PublicOrderDraftItem[]
  thermalBags: { coveredCupCount: 1 | 2 | 3 | 4 }[]
  quoteRevision: string
  quotedTotalCentavos: number
  idempotencyKey: string
  honeypot: string
}

export type PublicOrderReceipt = {
  submitted: true
  status: 'pending' | 'accepted' | 'rejected'
  reference: string
  deliveryDate: string
  totalCentavos: number
  pendingAngelaAcceptance: boolean
}

export type PublicOrderReconfirmation = {
  code: 'RECONFIRM_REQUIRED'
  error: string
  delivery: PublicOrderDelivery
  deliveryOptions: PublicOrderDelivery[]
  quoteRevision: string
  quote: {
    itemsSubtotalCentavos: number
    thermalBagsTotalCentavos: number
    totalCentavos: number
  }
  items: unknown[]
  thermalBags: unknown[]
}

export type PublicOrderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class PublicOrderApiError extends Error {
  readonly status: number
  readonly payload: unknown

  constructor(status: number, message: string, payload: unknown) {
    super(message)
    this.name = 'PublicOrderApiError'
    this.status = status
    this.payload = payload
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isSafeCentavos(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isProductSlug(value: unknown): value is ProductSlug {
  return value === 'matcha-latte'
    || value === 'strawberry-matcha'
    || value === 'salted-maple-matcha'
    || value === 'hojicha-latte'
    || value === 'strawberry-hojicha'
    || value === 'salted-maple-hojicha'
}

function isDrinkFamily(value: unknown): value is DrinkFamily {
  return value === 'matcha' || value === 'hojicha'
}

function isProductFlavor(value: unknown): value is ProductFlavor {
  return value === 'plain' || value === 'strawberry' || value === 'salted_maple'
}

function isSweetness(value: unknown): value is Sweetness {
  return value === 'none' || value === 'light' || value === 'regular' || value === 'extra'
}

function isModifierGroup(value: unknown): value is ModifierGroup {
  return value === 'matcha_level'
    || value === 'hojicha_level'
    || value === 'powder'
    || value === 'sweetness'
}

function isCharges(value: unknown): value is Record<1 | 2 | 3, number> {
  if (!isRecord(value)) return false
  return isSafeCentavos(value['1']) && isSafeCentavos(value['2']) && isSafeCentavos(value['3'])
}

function isPowderCharges(value: unknown): value is Record<Powder, number> {
  if (!isRecord(value)) return false
  return isSafeCentavos(value.yumeno) && isSafeCentavos(value.mk_isuzu)
}

function isBagCharges(value: unknown): value is Record<1 | 2 | 3 | 4, number> {
  if (!isRecord(value)) return false
  return isSafeCentavos(value['1'])
    && isSafeCentavos(value['2'])
    && isSafeCentavos(value['3'])
    && isSafeCentavos(value['4'])
}

function isDelivery(value: unknown): value is PublicOrderDelivery {
  if (!isRecord(value)) return false
  return isString(value.deliveryDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(value.deliveryDate)
    && isString(value.deliveryWindowStart)
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.deliveryWindowStart)
    && isString(value.deliveryWindowEnd)
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.deliveryWindowEnd)
}

/** Offered days from a menu or reconfirm payload; an absent or malformed list falls back to `[delivery]`. */
function parseDeliveryOptions(value: unknown, delivery: PublicOrderDelivery): PublicOrderDelivery[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isDelivery)) return [delivery]
  const unique = new Map(value.map((option) => [option.deliveryDate, { deliveryDate: option.deliveryDate, deliveryWindowStart: option.deliveryWindowStart, deliveryWindowEnd: option.deliveryWindowEnd }]))
  return [...unique.values()]
}

export function menuDeliveryOptions(menu: Pick<PublicOrderMenu, 'delivery' | 'deliveryOptions'>): PublicOrderDelivery[] {
  return menu.deliveryOptions?.length ? menu.deliveryOptions : [menu.delivery]
}

function parseProduct(value: unknown): PublicOrderProduct | null {
  if (!isRecord(value)) return null
  if (!isProductSlug(value.slug) || !isString(value.name) || !isDrinkFamily(value.family) || !isProductFlavor(value.flavor) || value.milk !== 'oat_milk') return null
  if (!isSafeCentavos(value.basePriceCentavos) || !Array.isArray(value.modifierGroups) || !value.modifierGroups.every(isModifierGroup)) return null
  if (!isCharges(value.levelUpcharges) || !isPowderCharges(value.powderUpcharges) || !isBagCharges(value.thermalBagPrices)) return null
  if (!Array.isArray(value.sweetnessOptions) || !value.sweetnessOptions.every(isSweetness)) return null
  return {
    slug: value.slug,
    name: value.name,
    family: value.family,
    flavor: value.flavor,
    milk: 'oat_milk',
    basePriceCentavos: value.basePriceCentavos,
    modifierGroups: [...value.modifierGroups],
    levelUpcharges: { 1: value.levelUpcharges['1'], 2: value.levelUpcharges['2'], 3: value.levelUpcharges['3'] },
    powderUpcharges: { yumeno: value.powderUpcharges.yumeno, mk_isuzu: value.powderUpcharges.mk_isuzu },
    thermalBagPrices: { 1: value.thermalBagPrices['1'], 2: value.thermalBagPrices['2'], 3: value.thermalBagPrices['3'], 4: value.thermalBagPrices['4'] },
    sweetnessOptions: [...value.sweetnessOptions],
  }
}

export function parsePublicOrderMenu(value: unknown): PublicOrderMenu | null {
  if (!isRecord(value)) return null
  const business = value.business
  const payment = value.payment
  if (!isRecord(business) || !isString(business.name) || !isString(business.description) || !isString(business.contact)) return null
  if (!isRecord(payment) || payment.method !== 'GCash' || !isString(payment.account) || !isString(payment.instructions)) return null
  if (!isDelivery(value.delivery) || !isString(value.quoteRevision) || !/^[0-9a-f]{64}$/i.test(value.quoteRevision)) return null
  if (!Array.isArray(value.products)) return null
  const products = value.products.map(parseProduct)
  if (products.some((product): product is null => product === null) || products.length === 0) return null
  const uniqueSlugs = new Set(products.map((product) => product!.slug))
  if (uniqueSlugs.size !== products.length) return null
  return {
    business: { name: business.name, description: business.description, contact: business.contact },
    payment: { method: 'GCash', account: payment.account, instructions: payment.instructions },
    delivery: value.delivery,
    deliveryOptions: parseDeliveryOptions(value.deliveryOptions, value.delivery),
    quoteRevision: value.quoteRevision,
    products: products as PublicOrderProduct[],
  }
}

function actionUrl(endpoint: string, action: 'menu' | 'submit'): string {
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}action=${action}`
}

async function responseJson(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new PublicOrderApiError(response.status, 'The ordering service returned an unreadable response.', null)
  }
}

function serverMessage(payload: unknown, fallback: string): string {
  return isRecord(payload) && isString(payload.error) && payload.error.trim() ? payload.error : fallback
}

export async function getPublicOrderMenu(
  options: { fetcher?: PublicOrderFetch; endpoint?: string } = {},
): Promise<PublicOrderMenu> {
  const fetcher = options.fetcher ?? globalThis.fetch
  const endpoint = options.endpoint ?? PUBLIC_ORDER_ENDPOINT
  let response: Response
  try {
    response = await fetcher(actionUrl(endpoint, 'menu'), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error('The ordering service could not be reached.')
  }
  const payload = await responseJson(response)
  if (!response.ok) throw new PublicOrderApiError(response.status, serverMessage(payload, 'The menu could not be loaded.'), payload)
  const menu = parsePublicOrderMenu(payload)
  if (!menu) throw new PublicOrderApiError(response.status, 'The ordering service returned an invalid menu.', payload)
  return menu
}

export async function submitPublicOrder(
  input: PublicOrderInput,
  options: { fetcher?: PublicOrderFetch; endpoint?: string } = {},
): Promise<PublicOrderReceipt> {
  const fetcher = options.fetcher ?? globalThis.fetch
  const endpoint = options.endpoint ?? PUBLIC_ORDER_ENDPOINT
  let response: Response
  try {
    response = await fetcher(actionUrl(endpoint, 'submit'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(input),
    })
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error('The ordering service could not be reached.')
  }
  const payload = await responseJson(response)
  if (!response.ok) throw new PublicOrderApiError(response.status, serverMessage(payload, 'The order could not be submitted.'), payload)
  if (!isRecord(payload) || payload.submitted !== true || !isString(payload.status) || !['pending', 'accepted', 'rejected'].includes(payload.status) || !isString(payload.reference) || !isString(payload.deliveryDate) || !isSafeCentavos(payload.totalCentavos) || typeof payload.pendingAngelaAcceptance !== 'boolean') {
    throw new PublicOrderApiError(response.status, 'The ordering service returned an invalid receipt.', payload)
  }
  return {
    submitted: true,
    status: payload.status as PublicOrderReceipt['status'],
    reference: payload.reference,
    deliveryDate: payload.deliveryDate,
    totalCentavos: payload.totalCentavos,
    pendingAngelaAcceptance: payload.pendingAngelaAcceptance,
  }
}

export function getReconfirmation(error: unknown): PublicOrderReconfirmation | null {
  if (!(error instanceof PublicOrderApiError) || error.status !== 409 || !isRecord(error.payload) || error.payload.code !== 'RECONFIRM_REQUIRED') return null
  const payload = error.payload
  const quote = payload.quote
  if (!isString(payload.error) || !isDelivery(payload.delivery) || !isString(payload.quoteRevision) || !/^[0-9a-f]{64}$/i.test(payload.quoteRevision) || !isRecord(quote) || !isSafeCentavos(quote.itemsSubtotalCentavos) || !isSafeCentavos(quote.thermalBagsTotalCentavos) || !isSafeCentavos(quote.totalCentavos) || !Array.isArray(payload.items) || !Array.isArray(payload.thermalBags)) return null
  return {
    code: 'RECONFIRM_REQUIRED',
    error: payload.error,
    delivery: payload.delivery,
    deliveryOptions: parseDeliveryOptions(payload.deliveryOptions, payload.delivery),
    quoteRevision: payload.quoteRevision,
    quote: {
      itemsSubtotalCentavos: quote.itemsSubtotalCentavos,
      thermalBagsTotalCentavos: quote.thermalBagsTotalCentavos,
      totalCentavos: quote.totalCentavos,
    },
    items: payload.items,
    thermalBags: payload.thermalBags,
  }
}

export function publicOrderErrorMessage(error: unknown): string {
  if (error instanceof PublicOrderApiError) {
    if (error.status === 429) return 'Too many attempts. Please wait a minute before trying again.'
    if (error.status === 503) return error.message || 'Online ordering is temporarily unavailable. Please try again.'
    return error.message
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'The request was interrupted. Please try again.'
  if (error instanceof Error && error.message) return 'We could not reach online ordering. Check your connection and try again.'
  return 'We could not reach online ordering. Check your connection and try again.'
}
