import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getNextAvailableDeliveryDate } from '../src/domain/delivery-schedule'
import { PRODUCT_CATALOG, priceOrder, type OrderDraft, type ProductSlug, type Powder, type Sweetness } from '../src/domain'
import { ORDER_DASHBOARD_SETTINGS_KEY, parseDashboardSettings, type DashboardSettings } from '../src/features/settings/settings-store'
import { PricingError } from '../src/domain/pricing-error'

export const MAX_SUBMISSION_BODY_BYTES = 32 * 1024
export const MAX_SUBMISSION_ITEMS = 50
export const MAX_SUBMISSION_CUPS = 100
export const SUBMISSION_RATE_LIMIT = 12

export type PublicOrderItemInput = {
  productSlug: ProductSlug
  quantity: number
  modifiers: { level: 1 | 2 | 3; powder: Powder; sweetness?: Sweetness }
  cupNames?: string[]
}

export type PublicOrderInput = {
  customerName: string
  customerPhone: string
  address: string
  deliveryDate: string
  notes: string | null
  items: PublicOrderItemInput[]
  thermalBags: { coveredCupCount: 1 | 2 | 3 | 4 }[]
  quoteRevision: string
  quotedTotalCentavos: number
  idempotencyKey: string
  honeypot?: string
}

type CoreResult = { status: number; body: Record<string, unknown> }

type SubmissionRow = {
  id: string
  reference: string
  idempotency_key?: string
  request_hash: string
  quote_revision: string
  review_hash?: string
  review_version?: number
  status: 'pending' | 'accepted' | 'rejected'
  delivery_date: string
  total_centavos: number
  accepted_order_id: string | null
  submitted_snapshot?: Record<string, unknown>
}

type PublicConfig = {
  settings: DashboardSettings
  revision: string
  nextDelivery: ReturnType<typeof getNextAvailableDeliveryDate>
}

type ServerEnv = { process?: { env?: Record<string, string | undefined> } }

function env(name: string): string | undefined {
  const value = (globalThis as typeof globalThis & ServerEnv).process?.env?.[name]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function orderServerConfig(): { url: string; serviceRoleKey: string } | null {
  const url = env('VITE_SUPABASE_URL')
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY')
  return url && serviceRoleKey ? { url, serviceRoleKey } : null
}

export function createOrderServerClient(): SupabaseClient | null {
  const config = orderServerConfig()
  return config
    ? createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function hasCatalogProduct(value: string): value is ProductSlug {
  return Object.prototype.hasOwnProperty.call(PRODUCT_CATALOG, value)
}

function text(value: unknown, maximum: number, required = true): string | null {
  if (typeof value !== 'string') return required ? null : ''
  const trimmed = value.trim()
  if (required && !trimmed) return null
  return trimmed.length <= maximum ? trimmed : null
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null
}

function sha256(value: string): Promise<string> {
  return globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''))
}

function canonicalInput(input: PublicOrderInput): string {
  return JSON.stringify({
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    address: input.address,
    deliveryDate: input.deliveryDate,
    notes: input.notes,
    items: input.items,
    thermalBags: input.thermalBags,
    idempotencyKey: input.idempotencyKey,
  })
}

export function parsePublicOrderInput(value: unknown): { input: PublicOrderInput } | { error: string } {
  if (!isRecord(value) || !onlyKeys(value, ['customerName', 'customerPhone', 'address', 'deliveryDate', 'notes', 'items', 'thermalBags', 'quoteRevision', 'quotedTotalCentavos', 'idempotencyKey', 'honeypot'])) {
    return { error: 'The order form contains an unsupported field.' }
  }
  if (typeof value.honeypot === 'string' && value.honeypot.trim()) return { error: 'The order could not be submitted.' }
  const customerName = text(value.customerName, 120)
  const customerPhone = text(value.customerPhone, 40)
  const address = text(value.address, 300)
  const deliveryDate = isoDate(value.deliveryDate)
  const notesValue = value.notes == null ? null : text(value.notes, 500, false)
  if (!customerName || !customerPhone || !address || !deliveryDate || notesValue === null && value.notes != null) return { error: 'Name, Viber number, address, and a valid delivery date are required.' }
  if (!/^[+0-9() .-]{7,40}$/.test(customerPhone) || customerPhone.replace(/\D/g, '').length < 7) return { error: 'Enter a valid Viber contact number.' }
  if (typeof value.quoteRevision !== 'string' || !/^[0-9a-f]{64}$/i.test(value.quoteRevision) || !Number.isSafeInteger(value.quotedTotalCentavos) || (value.quotedTotalCentavos as number) < 0) return { error: 'The displayed quote is stale. Please refresh the menu and review it again.' }
  if (typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,100}$/.test(value.idempotencyKey)) return { error: 'A valid confirmation key is required. Please reload and try again.' }
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAX_SUBMISSION_ITEMS) return { error: 'Add at least one drink before submitting.' }

  const items: PublicOrderItemInput[] = []
  let cups = 0
  for (const candidate of value.items) {
    if (!isRecord(candidate) || !onlyKeys(candidate, ['productSlug', 'quantity', 'modifiers', 'cupNames'])) return { error: 'One drink selection is invalid.' }
    const slug = candidate.productSlug
    const modifiers = candidate.modifiers
    if (typeof slug !== 'string' || !hasCatalogProduct(slug) || !isRecord(modifiers) || !onlyKeys(modifiers, ['level', 'powder', 'sweetness'])) return { error: 'One drink selection is invalid.' }
    const quantity = candidate.quantity
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > MAX_SUBMISSION_CUPS) return { error: 'Drink quantities must be whole numbers.' }
    if (!Number.isSafeInteger(modifiers.level) || ![1, 2, 3].includes(modifiers.level as number) || !['yumeno', 'mk_isuzu'].includes(modifiers.powder as string)) return { error: 'One drink modifier is invalid.' }
    if (modifiers.sweetness !== undefined && !['none', 'light', 'regular', 'extra'].includes(modifiers.sweetness as string)) return { error: 'One sweetness selection is invalid.' }
    let cupNames: string[] | undefined
    if (candidate.cupNames !== undefined) {
      if (!Array.isArray(candidate.cupNames) || candidate.cupNames.length > (quantity as number) || candidate.cupNames.some((name) => typeof name !== 'string' || name.trim().length > 80)) return { error: 'Cup names must match the selected quantities.' }
      cupNames = candidate.cupNames.map((name) => name.trim()).filter(Boolean)
    }
    cups += quantity as number
    if (cups > MAX_SUBMISSION_CUPS) return { error: `An order cannot exceed ${MAX_SUBMISSION_CUPS} cups.` }
    items.push({
      productSlug: slug as ProductSlug,
      quantity: quantity as number,
      modifiers: { level: modifiers.level as 1 | 2 | 3, powder: modifiers.powder as Powder, ...(modifiers.sweetness === undefined ? {} : { sweetness: modifiers.sweetness as Sweetness }) },
      ...(cupNames && cupNames.length > 0 ? { cupNames } : {}),
    })
  }

  if (!Array.isArray(value.thermalBags) || value.thermalBags.length > Math.ceil(cups / 1)) return { error: 'Thermal bag selections are invalid.' }
  const thermalBags: PublicOrderInput['thermalBags'] = []
  let coveredCups = 0
  for (const candidate of value.thermalBags) {
    if (!isRecord(candidate) || !onlyKeys(candidate, ['coveredCupCount']) || !Number.isSafeInteger(candidate.coveredCupCount) || ![1, 2, 3, 4].includes(candidate.coveredCupCount as number)) return { error: 'Thermal bag selections are invalid.' }
    coveredCups += candidate.coveredCupCount as number
    thermalBags.push({ coveredCupCount: candidate.coveredCupCount as 1 | 2 | 3 | 4 })
  }
  if (coveredCups > cups) return { error: 'Thermal bags cannot cover more cups than ordered.' }

  return { input: { customerName, customerPhone, address, deliveryDate, notes: notesValue, items, thermalBags, quoteRevision: value.quoteRevision, quotedTotalCentavos: value.quotedTotalCentavos as number, idempotencyKey: value.idempotencyKey } }
}

async function publicConfig(client: SupabaseClient, now: Date): Promise<PublicConfig | null> {
  const { data, error } = await client.from('settings').select('value').eq('key', ORDER_DASHBOARD_SETTINGS_KEY).maybeSingle()
  if (error || !data) return null
  const settings = parseDashboardSettings(data.value)
  if (!settings.gCashNumber || settings.openDays.length === 0) return null
  const nextDelivery = getNextAvailableDeliveryDate(now, settings)
  return nextDelivery ? { settings, revision: await sha256(JSON.stringify(settings)), nextDelivery } : null
}

function publicProducts(settings: DashboardSettings): Record<string, unknown>[] {
  return Object.values(PRODUCT_CATALOG).filter((product) => settings.productAvailability[product.slug]).map((product) => ({
    slug: product.slug,
    name: product.name,
    family: product.family,
    flavor: product.flavor,
    milk: product.milk,
    basePriceCentavos: settings.productBasePrices[product.slug],
    modifierGroups: product.modifierGroups,
    levelUpcharges: product.family === 'matcha' ? settings.matchaLevelUpcharges : settings.hojichaLevelUpcharges,
    powderUpcharges: settings.powderUpcharges,
    thermalBagPrices: settings.thermalBagPrices,
    sweetnessOptions: product.flavor === 'plain' ? ['none', 'light', 'regular', 'extra'] : [],
  }))
}

export async function getPublicOrderMenu(client: SupabaseClient, now = new Date()): Promise<CoreResult> {
  const config = await publicConfig(client, now)
  if (!config) return { status: 503, body: { error: 'Online ordering is not configured yet.' } }
  return {
    status: 200,
    body: {
      business: { name: config.settings.businessName, description: config.settings.businessDescription, contact: config.settings.businessContact },
      payment: { method: 'GCash', account: config.settings.gCashNumber, instructions: `Pay via GCash to ${config.settings.gCashNumber} after submitting, then send your screenshot in Viber.` },
      delivery: config.nextDelivery,
      quoteRevision: config.revision,
      products: publicProducts(config.settings),
    },
  }
}

function quoteBody(config: PublicConfig, priced: ReturnType<typeof priceOrder>): Record<string, unknown> {
  return { delivery: config.nextDelivery, quoteRevision: config.revision, quote: priced.totals, items: priced.items, thermalBags: priced.thermalBags }
}

function storagePrice(priced: ReturnType<typeof priceOrder>, input: PublicOrderInput): Record<string, unknown> {
  return {
    items: priced.items.map((item, index) => ({
      product_slug: item.productSlug,
      product_name: item.productName,
      quantity: item.quantity,
      modifiers: { ...item.modifiers, ...(input.items[index]?.cupNames?.length ? { cupNames: input.items[index]?.cupNames } : {}) },
      unit_price_centavos: item.unitPriceCentavos,
      line_total_centavos: item.lineTotalCentavos,
    })),
    thermal_bags: priced.thermalBags,
    totals: priced.totals,
  }
}

function isUniqueViolation(error: { code?: string } | null): boolean { return error?.code === '23505' }

function submissionSelect(): string {
  return 'id,reference,idempotency_key,request_hash,quote_revision,review_hash,review_version,status,customer_name,customer_phone,address_snapshot,delivery_date,notes,items,thermal_bags,catalog_snapshot,priced_items,subtotal_centavos,delivery_fee_centavos,total_centavos,submitted_snapshot,accepted_order_id,created_at,updated_at'
}

async function existingSubmission(client: SupabaseClient, key: string): Promise<{ row: SubmissionRow | null; error: unknown }> {
  const result = await client.from('order_submissions').select(submissionSelect()).eq('idempotency_key', key).maybeSingle()
  return { row: result.data as SubmissionRow | null, error: result.error }
}

function receipt(row: SubmissionRow): Record<string, unknown> {
  return { submitted: true, status: row.status, reference: row.reference, deliveryDate: row.delivery_date, totalCentavos: row.total_centavos, pendingAngelaAcceptance: row.status === 'pending' }
}

/** Anonymous boundary: service-role access is kept here and never returned to the client. */
export async function submitPublicOrder(client: SupabaseClient, rawBody: string | null | undefined, clientIp: string | null, now = new Date()): Promise<CoreResult> {
  if (!rawBody || new TextEncoder().encode(rawBody).byteLength > MAX_SUBMISSION_BODY_BYTES) return { status: 413, body: { error: 'The order form is too large.' } }
  let parsedBody: unknown
  try { parsedBody = JSON.parse(rawBody) } catch { return { status: 400, body: { error: 'The order form must be valid JSON.' } } }
  const parsed = parsePublicOrderInput(parsedBody)
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
  if (!clientIp || clientIp.length > 200) return { status: 503, body: { error: 'Online ordering is temporarily unavailable.' } }
  const config = await publicConfig(client, now)
  if (!config) return { status: 503, body: { error: 'Online ordering is not configured yet.' } }
  const requestHash = await sha256(canonicalInput(parsed.input))
  const rateKeyHash = await sha256(`${orderServerConfig()?.serviceRoleKey ?? 'server'}:${clientIp}`)
  const rate = await client.rpc('consume_order_submission_rate_limit', { p_key_hash: rateKeyHash, p_limit: SUBMISSION_RATE_LIMIT })
  if (rate.error) return { status: 503, body: { error: 'Online ordering is temporarily unavailable.' } }
  if (rate.data !== true) return { status: 429, body: { error: 'Too many attempts. Please try again in a minute.' } }

  const existing = await existingSubmission(client, parsed.input.idempotencyKey)
  if (existing.error) return { status: 503, body: { error: 'Online ordering is temporarily unavailable.' } }
  if (existing.row) {
    if (existing.row.request_hash !== requestHash) return { status: 409, body: { error: 'This confirmation key was already used for a different order.' } }
    return { status: existing.row.status === 'rejected' ? 409 : 200, body: receipt(existing.row) }
  }

  const orderDraft: OrderDraft = { items: parsed.input.items.map(({ productSlug, quantity, modifiers }) => ({ productSlug, quantity, modifiers })), thermalBags: parsed.input.thermalBags }
  let priced: ReturnType<typeof priceOrder>
  try { priced = priceOrder(orderDraft, config.settings) } catch (error) {
    return { status: 422, body: { error: error instanceof PricingError ? error.message : 'The order selections are no longer available.' } }
  }
  if (parsed.input.deliveryDate !== config.nextDelivery?.deliveryDate || parsed.input.quoteRevision !== config.revision || parsed.input.quotedTotalCentavos !== priced.totals.totalCentavos) {
    return { status: 409, body: { code: 'RECONFIRM_REQUIRED', error: 'The delivery date or total changed. Please review the updated quote before submitting.', ...quoteBody(config, priced) } }
  }
  const pricedItems = storagePrice(priced, parsed.input)
  const payload = {
    request_hash: requestHash,
    idempotency_key: parsed.input.idempotencyKey,
    quote_revision: config.revision,
    customer_name: parsed.input.customerName,
    customer_phone: parsed.input.customerPhone,
    address_snapshot: parsed.input.address,
    delivery_date: parsed.input.deliveryDate,
    notes: parsed.input.notes,
    items: parsed.input.items,
    thermal_bags: parsed.input.thermalBags,
    catalog_snapshot: { revision: config.revision, ...config.settings },
    priced_items: pricedItems,
    subtotal_centavos: priced.totals.itemsSubtotalCentavos,
    delivery_fee_centavos: priced.totals.thermalBagsTotalCentavos,
    total_centavos: priced.totals.totalCentavos,
    review_hash: requestHash,
    review_version: 0,
    submitted_snapshot: {
      customerName: parsed.input.customerName,
      customerPhone: parsed.input.customerPhone,
      address: parsed.input.address,
      deliveryDate: parsed.input.deliveryDate,
      notes: parsed.input.notes,
      items: parsed.input.items,
      thermalBags: parsed.input.thermalBags,
      quoteRevision: config.revision,
      quotedTotalCentavos: priced.totals.totalCentavos,
      catalogSnapshot: { revision: config.revision, ...config.settings },
      pricedItems,
    },
  }
  const inserted = await client.from('order_submissions').insert(payload).select(submissionSelect()).single()
  if (inserted.error && isUniqueViolation(inserted.error)) {
    const raced = await existingSubmission(client, parsed.input.idempotencyKey)
    if (raced.row?.request_hash === requestHash) return { status: 200, body: receipt(raced.row) }
    return { status: 409, body: { error: 'This confirmation key was already used for a different order.' } }
  }
  if (inserted.error || !inserted.data) return { status: 503, body: { error: 'Online ordering is temporarily unavailable.' } }
  return { status: 201, body: receipt(inserted.data as SubmissionRow) }
}

export async function listPendingSubmissions(client: SupabaseClient): Promise<CoreResult> {
  const result = await client.from('order_submissions').select(submissionSelect()).eq('status', 'pending').order('created_at', { ascending: true })
  if (result.error) return { status: 503, body: { error: 'Pending submissions are temporarily unavailable.' } }
  return { status: 200, body: { submissions: result.data ?? [] } }
}

/** Owner-only edit path. Adapters must authenticate Angela before calling this elevated write. */
export async function updatePendingSubmission(client: SupabaseClient, id: string, rawBody: string | null | undefined, now = new Date()): Promise<CoreResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !rawBody || new TextEncoder().encode(rawBody).byteLength > MAX_SUBMISSION_BODY_BYTES) return { status: 400, body: { error: 'The pending submission edit is invalid.' } }
  let body: unknown
  try { body = JSON.parse(rawBody) } catch { return { status: 400, body: { error: 'The pending submission edit must be valid JSON.' } } }
  const parsed = parsePublicOrderInput(body)
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
  const current = await client.from('order_submissions').select('id,status,total_centavos,request_hash').eq('id', id).maybeSingle()
  if (current.error) return { status: 503, body: { error: 'Pending submissions are temporarily unavailable.' } }
  if (!current.data) return { status: 404, body: { error: 'Pending submission not found.' } }
  if (current.data.status !== 'pending') return { status: 409, body: { error: 'Only pending submissions can be edited.' } }
  const config = await publicConfig(client, now)
  if (!config) return { status: 503, body: { error: 'Online ordering is not configured yet.' } }
  const draft: OrderDraft = { items: parsed.input.items.map(({ productSlug, quantity, modifiers }) => ({ productSlug, quantity, modifiers })), thermalBags: parsed.input.thermalBags }
  let priced: ReturnType<typeof priceOrder>
  try { priced = priceOrder(draft, config.settings) } catch (error) { return { status: 422, body: { error: error instanceof PricingError ? error.message : 'The edited selections are unavailable.' } } }
  if (parsed.input.deliveryDate !== config.nextDelivery?.deliveryDate || parsed.input.quoteRevision !== config.revision || parsed.input.quotedTotalCentavos !== priced.totals.totalCentavos) {
    return { status: 409, body: { code: 'RECONFIRM_REQUIRED', error: 'The edited delivery date or total changed. Review the updated quote.', ...quoteBody(config, priced) } }
  }
  const requestHash = await sha256(canonicalInput(parsed.input))
  const update = await client.from('order_submissions').update({
    request_hash: requestHash,
    quote_revision: config.revision,
    customer_name: parsed.input.customerName,
    customer_phone: parsed.input.customerPhone,
    address_snapshot: parsed.input.address,
    delivery_date: parsed.input.deliveryDate,
    notes: parsed.input.notes,
    items: parsed.input.items,
    thermal_bags: parsed.input.thermalBags,
    catalog_snapshot: { revision: config.revision, ...config.settings },
    priced_items: storagePrice(priced, parsed.input),
    subtotal_centavos: priced.totals.itemsSubtotalCentavos,
    delivery_fee_centavos: priced.totals.thermalBagsTotalCentavos,
    total_centavos: priced.totals.totalCentavos,
  }).eq('id', id).eq('status', 'pending').select('id,reference,request_hash,quote_revision,status,customer_name,customer_phone,address_snapshot,delivery_date,notes,items,thermal_bags,priced_items,total_centavos,created_at').single()
  if (update.error || !update.data) return { status: 503, body: { error: 'The pending submission could not be updated.' } }
  return { status: 200, body: { submission: update.data, previousTotalCentavos: current.data.total_centavos, newTotalCentavos: priced.totals.totalCentavos, differenceCentavos: priced.totals.totalCentavos - current.data.total_centavos } }
}

export async function acceptSubmission(client: SupabaseClient, id: string, requestHash: string): Promise<CoreResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(requestHash)) return { status: 400, body: { error: 'Invalid submission confirmation.' } }
  const result = await client.rpc('accept_order_submission', { p_submission_id: id, p_request_hash: requestHash })
  if (result.error) return { status: result.error.code === '42501' ? 403 : result.error.code === 'P0002' ? 404 : 409, body: { error: 'This submission could not be accepted. Review it in Viber and try again.' } }
  return { status: 200, body: result.data as Record<string, unknown> }
}

export async function rejectSubmission(client: SupabaseClient, id: string): Promise<CoreResult> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 400, body: { error: 'Invalid submission.' } }
  const result = await client.rpc('reject_order_submission', { p_submission_id: id })
  if (result.error) return { status: result.error.code === '42501' ? 403 : result.error.code === 'P0002' ? 404 : 409, body: { error: 'This submission could not be rejected.' } }
  return { status: 200, body: result.data as Record<string, unknown> }
}
