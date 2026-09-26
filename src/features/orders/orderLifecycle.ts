import type { OrderStatus } from '../../domain/contracts'
import type { StoredOrder } from '../../data/types'

export const operationalStatuses: readonly OrderStatus[] = [
  'new',
  'paid',
  'delivered',
  'cancelled',
]

export const statusLabels: Readonly<Record<OrderStatus, string>> = {
  new: 'New',
  paid: 'Paid',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

const forwardTransitions: Readonly<Partial<Record<OrderStatus, OrderStatus>>> = {
  new: 'paid',
  paid: 'delivered',
}

export function nextStatus(status: OrderStatus): OrderStatus | null {
  return forwardTransitions[status] ?? null
}

export type AdvancePatch = { status: OrderStatus; paymentReceived?: true }

/**
 * The only fields a forward step writes. `paid_at` / `delivered_at` are never
 * part of it: the storage trigger owns them.
 */
export function advancePatch(status: OrderStatus): AdvancePatch | null {
  const next = nextStatus(status)
  if (!next) return null
  return next === 'paid' ? { status: next, paymentReceived: true } : { status: next }
}

export function canCancel(status: OrderStatus): boolean {
  return status !== 'delivered' && status !== 'cancelled'
}

export function canAdvance(order: StoredOrder): boolean {
  return nextStatus(order.status) !== null
}

export function nextAction(order: StoredOrder): string {
  const next = nextStatus(order.status)
  if (!next) return order.status === 'cancelled' ? 'Cancelled — no further action' : 'Delivered — complete'
  return `Mark ${statusLabels[next].toLowerCase()}`
}
