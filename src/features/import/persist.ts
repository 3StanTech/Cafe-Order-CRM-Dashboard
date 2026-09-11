import type {
  OrderConfirmationCustomer,
  OrderConfirmationInput,
  StorageAdapter,
  StoredOrder,
} from '../../data/types'
import { ensureCatalogProducts } from '../../data/ensure-catalog-products'
import { priceDraftItems } from './priceDraftItems'
import { validateDraft } from './parser'
import type { ImportDraft } from './types'

export type PreparedImportConfirmation = {
  draft: ImportDraft
  input: OrderConfirmationInput
}

export type ConfirmImportOptions = {
  /** Called synchronously after the key/hash are prepared and before the RPC. */
  onPrepared?: (draft: ImportDraft) => void
}

function now(): string { return new Date().toISOString() }

function confirmationKey(): string {
  // Keep this within the server-side key grammar while making it recognizable
  // in a browser's local storage during an uncertain retry.
  return `viber-${crypto.randomUUID()}`
}

export function ensureConfirmationKey(draft: ImportDraft): string {
  return draft.confirmationKey && /^[A-Za-z0-9._:-]{16,100}$/.test(draft.confirmationKey)
    ? draft.confirmationKey
    : confirmationKey()
}

function canonicalConfirmationInput(input: OrderConfirmationInput): string {
  // IDs and timestamps are intentionally excluded. The server owns persisted
  // IDs and timestamps, while this logical payload remains stable across a
  // refresh so an uncertain response can safely be retried with the same key.
  return JSON.stringify({
    customer: input.customer,
    order: {
      status: input.order.status,
      deliveryDate: input.order.deliveryDate,
      paymentReceived: input.order.paymentReceived,
      rawSource: input.order.rawSource,
      addressSnapshot: input.order.addressSnapshot,
      notes: input.order.notes,
      subtotalCentavos: input.order.subtotalCentavos,
      deliveryFeeCentavos: input.order.deliveryFeeCentavos,
      totalCentavos: input.order.totalCentavos,
      items: input.order.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        modifiers: item.modifiers,
        unitPriceCentavos: item.unitPriceCentavos,
        lineTotalCentavos: item.lineTotalCentavos,
      })),
    },
  })
}

async function requestHash(input: OrderConfirmationInput): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Durable order confirmation requires Web Crypto support.')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalConfirmationInput(input)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function invalidDraftMessage(draft: ImportDraft): string {
  const errors = validateDraft(draft).errors
  return `Cannot confirm an invalid draft: ${errors.join('; ') || 'required fields are missing'}`
}

/**
 * Builds the exact aggregate payload once, re-pricing every item from the
 * runtime catalog. It performs no customer or order writes.
 */
export async function prepareImportConfirmation(adapter: StorageAdapter, draft: ImportDraft): Promise<PreparedImportConfirmation> {
  const validation = validateDraft(draft)
  if (validation.errors.length > 0 || validation.totalCentavos === null || !draft.customerName) throw new Error(invalidDraftMessage(draft))

  const [customers, productByName] = await Promise.all([adapter.listCustomers(), ensureCatalogProducts(adapter)])
  const matched = draft.matchedCustomerId
    ? customers.find((customer) => customer.id === draft.matchedCustomerId)
    : undefined
  if (draft.matchedCustomerId && !matched) throw new Error('The selected customer no longer exists. Refresh the draft and resolve it again.')

  const timestamp = now()
  // The aggregate adapter owns the durable order ID. The empty ID here is a
  // transport placeholder required by the existing StoredOrder shape; the
  // confirmation RPC ignores it and mints a UUID in the transaction.
  const orderId = ''
  const { priced, items } = priceDraftItems({
    items: draft.items,
    thermalBags: draft.thermalBags,
    productByName,
    orderId,
    timestamp,
    customerName: draft.customerName,
  })
  const customer: OrderConfirmationCustomer = {
    id: matched?.id ?? null,
    name: draft.customerName,
    phone: draft.customerPhone ?? matched?.phone ?? null,
  }
  const order: StoredOrder = {
    id: orderId,
    customerId: matched?.id ?? '',
    status: 'new',
    items,
    subtotalCentavos: priced.totals.itemsSubtotalCentavos,
    deliveryFeeCentavos: priced.totals.thermalBagsTotalCentavos,
    totalCentavos: priced.totals.totalCentavos,
    deliveryDate: draft.deliveryDate,
    paymentReceived: false,
    rawSource: draft.rawSource,
    addressSnapshot: draft.address,
    notes: draft.notes,
    routePosition: null,
    paidAt: null,
    deliveredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const inputWithoutHash: Omit<OrderConfirmationInput, 'requestHash'> = {
    order,
    customer,
    confirmationKey: ensureConfirmationKey(draft),
  }
  const input = { ...inputWithoutHash, requestHash: '' }
  input.requestHash = await requestHash(input)

  if (draft.confirmationAttemptedAt !== undefined && draft.confirmationRequestHash && draft.confirmationRequestHash !== input.requestHash) {
    throw new Error('This draft changed after a confirmation attempt. Restore the original fields to retry safely, or remove and re-import it as a new order.')
  }

  const preparedDraft: ImportDraft = {
    ...draft,
    confirmationKey: input.confirmationKey,
    confirmationRequestHash: input.requestHash,
    confirmationAttemptedAt: Date.now(),
  }
  return { draft: preparedDraft, input }
}

/**
 * Confirms through the transactional adapter method only. There is
 * intentionally no createCustomer/createOrder fallback: those separate calls
 * can leave an orphan customer or duplicate order after an uncertain retry.
 */
export async function confirmImportDraft(
  adapter: StorageAdapter,
  draft: ImportDraft,
  options: ConfirmImportOptions = {},
): Promise<StoredOrder> {
  const prepared = await prepareImportConfirmation(adapter, draft)
  options.onPrepared?.(prepared.draft)
  if (!adapter.confirmOrderWithResolution) {
    throw new Error('Durable order confirmation is not available. Apply the pending confirmation migration before importing Viber orders.')
  }
  return adapter.confirmOrderWithResolution(prepared.input)
}
