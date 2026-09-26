/**
 * Orders brought in by the one-time history import carry this prefix on
 * `raw_source`, followed by the row's `source_ref`. Their storage-owned
 * `paid_at` / `delivered_at` record the day of the import, not the real
 * payment or delivery, so displays must not present them as such.
 */
export const HISTORY_IMPORT_SOURCE_PREFIX = 'history-import:'

export function isHistoryImport(order: { rawSource?: string | null }): boolean {
  return typeof order.rawSource === 'string' && order.rawSource.startsWith(HISTORY_IMPORT_SOURCE_PREFIX)
}
