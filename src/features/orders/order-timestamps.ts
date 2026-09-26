import type { StoredOrder } from '../../data/types'
import { isHistoryImport } from '../../domain/order-source'

const lifecycleTimestampFormatter = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/**
 * Formats a storage-owned lifecycle timestamp for card/history display.
 * Returns `null` for a null input so call sites can render conditionally.
 * Normalizes ICU narrow no-break spaces (U+202F) to plain spaces so the
 * string is stable across Node/ICU builds.
 */
export function formatLifecycleTimestamp(iso: string | null): string | null {
  if (iso == null) return null
  return lifecycleTimestampFormatter.format(new Date(iso)).replaceAll('\u202f', ' ')
}

/**
 * Label lines for an order's lifecycle timestamps (`Paid …` / `Delivered …`).
 * Omits any line whose underlying value is absent. History-imported orders
 * show `Imported` instead: their timestamps are the import day, not the
 * real payment or delivery.
 */
export function lifecycleTimestampLines(
  order: Pick<StoredOrder, 'paidAt' | 'deliveredAt'> & Partial<Pick<StoredOrder, 'rawSource'>>,
): string[] {
  if (isHistoryImport(order)) return ['Imported']
  const lines: string[] = []
  const paid = formatLifecycleTimestamp(order.paidAt)
  if (paid) lines.push(`Paid ${paid}`)
  const delivered = formatLifecycleTimestamp(order.deliveredAt)
  if (delivered) lines.push(`Delivered ${delivered}`)
  return lines
}
