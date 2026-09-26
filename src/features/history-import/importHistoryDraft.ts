import type { StorageAdapter, StoredOrder } from '../../data/types'
import { HISTORY_IMPORT_SOURCE_PREFIX, isHistoryImport } from '../../domain/order-source'
import { confirmImportDraft } from '../import/persist'
import type { ImportDraft } from '../import/types'
import { advancePatch, statusLabels } from '../orders/orderLifecycle'

export const HISTORY_CONFIRMATION_KEY_PREFIX = 'history'

export type ImportHistoryOptions = {
  /** Called with the key-bearing draft before anything is written, so a retry reuses the key. */
  onPrepared?: (draft: ImportDraft) => void
}

/**
 * Saves one past order and walks it New → Paid → Delivered.
 *
 * The order is created through the same durable confirmation as every other
 * intake path, so it is re-priced from the catalog and a retry with the same
 * key returns the order already saved. The walk then only sends status and
 * payment-received changes; the storage trigger stamps `paid_at` /
 * `delivered_at`. Running this again after an interruption resumes from the
 * order's current status.
 */
export async function importHistoryDraft(
  adapter: StorageAdapter,
  draft: ImportDraft,
  options: ImportHistoryOptions = {},
): Promise<StoredOrder> {
  if (!isHistoryImport(draft) || draft.rawSource.length <= HISTORY_IMPORT_SOURCE_PREFIX.length) {
    throw new Error('Only history rows with a source_ref can be imported here.')
  }
  let order = await confirmImportDraft(adapter, draft, {
    onPrepared: options.onPrepared,
    keyPrefix: HISTORY_CONFIRMATION_KEY_PREFIX,
  })
  while (order.status !== 'delivered') {
    const patch = advancePatch(order.status)
    if (!patch) throw new Error(`This order is already ${statusLabels[order.status].toLowerCase()} and cannot be marked delivered.`)
    order = await adapter.updateOrder(order.id, patch)
  }
  return order
}
