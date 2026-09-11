import { Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { StorageAdapter, StoredCustomer, StoredOrder } from '../../data/types'
import { OrderCard } from '../orders/OrderCard'
import { customerFor } from '../orders/order-display'
import { operationalStatuses, statusLabels } from '../orders/orderLifecycle'
import { useOrderActions } from '../orders/useOrderActions'
import { useOrdersData } from '../orders/useOrdersData'
import { OrderEditorModal } from '../order-editor/OrderEditorModal'
import { blankImportDraft, storedOrderToImportDraft } from '../order-editor/orderDraftMapping'
import { usePendingSubmissionCount } from '../import/pending-api'
import { relevantDeliveryDate } from './delivery-dates'

function routeSort(left: StoredOrder, right: StoredOrder): number {
  const leftPosition = left.routePosition ?? Number.MAX_SAFE_INTEGER
  const rightPosition = right.routePosition ?? Number.MAX_SAFE_INTEGER
  return leftPosition - rightPosition || left.createdAt.localeCompare(right.createdAt)
}

type TodayBoardProps = { adapter?: StorageAdapter; initialDeliveryDate?: string }

type EditorState = { mode: 'create' } | { mode: 'edit'; order: StoredOrder }

function customerName(customers: StoredCustomer[], order: StoredOrder): string | null {
  return customerFor(customers, order)?.name ?? null
}

export function TodayBoard({ adapter: providedAdapter, initialDeliveryDate }: TodayBoardProps) {
  const [deliveryDate, setDeliveryDate] = useState(initialDeliveryDate ?? relevantDeliveryDate)
  const { adapter, customers, orders, loading, error } = useOrdersData(providedAdapter, { deliveryDate })
  const [view, setView] = useState<'board' | 'run'>('board')
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const { busyOrderId, setBusyOrderId, advance, cancel, deleteOrder } = useOrderActions(adapter)
  const pendingCount = usePendingSubmissionCount()

  const selectedOrders = useMemo(
    () => orders.filter((order) => order.deliveryDate === deliveryDate),
    [deliveryDate, orders],
  )
  const routeOrders = useMemo(
    () => selectedOrders.filter((order) => order.status !== 'cancelled').sort(routeSort),
    [selectedOrders],
  )

  const moveRouteOrder = async (fromIndex: number, direction: -1 | 1) => {
    if (!adapter) return
    const toIndex = fromIndex + direction
    if (toIndex < 0 || toIndex >= routeOrders.length) return
    const reordered = [...routeOrders]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)
    setBusyOrderId(moved.id)
    try {
      await Promise.all(reordered.map((order, index) => (
        order.routePosition === index + 1 ? Promise.resolve(order) : adapter.updateOrder(order.id, { routePosition: index + 1 })
      )))
    } finally {
      setBusyOrderId(null)
    }
  }

  return (
    <section className="min-w-0">
      <header className="motion-fade-up flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-3xl font-black tracking-tight text-[#20242F]">Today</h1>
          <p className="mt-1.5 text-sm leading-5 text-[#4A5365]">8–9 AM delivery run · orders close at 8 PM for the next morning.</p>
        </div>
        <label className="grid gap-1 text-sm font-semibold text-[#20242F]">
          Delivery date
          <input aria-label="Delivery date" type="date" value={deliveryDate} onChange={(event) => setDeliveryDate(event.target.value)} className="rounded-xl border border-[#4F74C8]/30 bg-white px-3 py-2 text-[#20242F] transition-colors focus:border-[#4F74C8]" />
        </label>
      </header>

      {pendingCount !== null && pendingCount > 0 && (
        <a
          href="/import"
          className="mt-4 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-[#4F74C8]/30 bg-[#EAF0FF] px-4 text-sm font-bold text-[#365AA9] transition-colors hover:bg-[#4F74C8]/10"
        >
          <span>{pendingCount} pending {pendingCount === 1 ? 'submission' : 'submissions'} to review</span>
          <span>Open Import</span>
        </a>
      )}

      <button
        type="button"
        disabled={!adapter}
        onClick={() => setEditorState({ mode: 'create' })}
        className="mt-4 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#4F74C8] px-4 text-sm font-bold text-white shadow-sm transition duration-200 hover:bg-[#365AA9] active:scale-[0.98] motion-safe:transition-transform disabled:opacity-50 disabled:active:scale-100"
      >
        <Plus size={16} /> New order
      </button>

      <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-[#4F74C8]/20 bg-white/60 p-1">
        <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')} className={`rounded-xl px-3 py-2 text-sm font-bold transition-colors duration-200 active:scale-[0.98] motion-safe:transition-transform ${view === 'board' ? 'bg-[#4F74C8] text-white shadow-sm' : 'text-[#36579E] hover:bg-[#4F74C8]/10'}`}>Board</button>
        <button type="button" aria-pressed={view === 'run'} onClick={() => setView('run')} className={`rounded-xl px-3 py-2 text-sm font-bold transition-colors duration-200 active:scale-[0.98] motion-safe:transition-transform ${view === 'run' ? 'bg-[#4F74C8] text-white shadow-sm' : 'text-[#36579E] hover:bg-[#4F74C8]/10'}`}>Run list</button>
      </div>

      {loading && (
        <div className="mt-6 space-y-3" aria-hidden="true">
          {[0, 1].map((key) => <div key={key} className="h-24 animate-pulse rounded-2xl border border-[#4F74C8]/15 bg-white/60" />)}
          <p className="sr-only" role="status">Loading orders…</p>
        </div>
      )}
      {error && <p role="alert" className="motion-fade-in mt-6 rounded-xl bg-rose-100 p-3 text-sm text-rose-900">{error.message}</p>}
      {!loading && !error && view === 'board' && (
        <div className="motion-fade-in mt-5 space-y-5" aria-label="Order status board">
          {operationalStatuses.map((status) => {
            const statusOrders = selectedOrders.filter((order) => order.status === status)
            return (
              <section key={status} aria-labelledby={`status-${status}`} className="min-w-0">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h2 id={`status-${status}`} className="text-sm font-black uppercase tracking-[0.1em] text-[#36579E]">{statusLabels[status]}</h2>
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#4F74C8]/12 text-xs font-bold text-[#36579E]">{statusOrders.length}</span>
                </div>
                {statusOrders.length > 0 ? (
                  <div className="space-y-3">
                    {statusOrders.map((order) => <OrderCard key={order.id} order={order} customer={customerFor(customers, order)} busy={busyOrderId === order.id} onAdvance={advance} onCancel={cancel} onEdit={(current) => setEditorState({ mode: 'edit', order: current })} onDelete={deleteOrder} />)}
                  </div>
                ) : <p className="rounded-xl border border-dashed border-[#4F74C8]/25 bg-white/40 px-3 py-2.5 text-sm text-[#697386]">No orders</p>}
              </section>
            )
          })}
        </div>
      )}

      {!loading && !error && view === 'run' && (
        <section className="motion-fade-in mt-5" aria-labelledby="run-list-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="run-list-heading" className="text-xl font-black text-[#20242F]">Delivery run</h2>
            <span className="text-sm text-[#4A5365]">{routeOrders.length} stops</span>
          </div>
          <p className="mt-1 text-sm text-[#4A5365]">Use the controls to set the route order.</p>
          <ol className="mt-4 space-y-3">
            {routeOrders.map((order, index) => {
              const customer = customerFor(customers, order)
              return (
                <li key={order.id} className="flex min-w-0 gap-3 rounded-2xl border border-[#4F74C8]/20 bg-white p-4 shadow-sm transition-shadow duration-200 hover:shadow-md">
                  <span aria-label={`Stop ${index + 1}`} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#4F74C8] text-sm font-black text-white">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-bold text-[#20242F]">{customer?.name ?? 'Unknown customer'}</h3>
                    {customer?.phone && <p className="mt-1 text-sm text-[#4A5365]">{customer.phone}</p>}
                    <p className="mt-1 break-words text-sm text-[#4A5365]">{order.addressSnapshot || 'Address not provided'}</p>
                    <p className="mt-2 text-sm font-semibold text-[#36579E]">{statusLabels[order.status]} · {order.items.reduce((cups, item) => cups + item.quantity, 0)} cups</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <button type="button" aria-label={`Move ${customer?.name ?? 'order'} up`} disabled={index === 0 || busyOrderId !== null} onClick={() => void moveRouteOrder(index, -1)} className="rounded-lg border border-[#4F74C8]/30 px-2 py-1 text-sm font-bold text-[#36579E] transition-colors duration-200 hover:bg-[#4F74C8]/10 active:scale-95 motion-safe:transition-transform disabled:opacity-35 disabled:active:scale-100">↑</button>
                    <button type="button" aria-label={`Move ${customer?.name ?? 'order'} down`} disabled={index === routeOrders.length - 1 || busyOrderId !== null} onClick={() => void moveRouteOrder(index, 1)} className="rounded-lg border border-[#4F74C8]/30 px-2 py-1 text-sm font-bold text-[#36579E] transition-colors duration-200 hover:bg-[#4F74C8]/10 active:scale-95 motion-safe:transition-transform disabled:opacity-35 disabled:active:scale-100">↓</button>
                  </div>
                </li>
              )
            })}
          </ol>
          {routeOrders.length === 0 && <p className="mt-4 rounded-xl border border-dashed border-[#4F74C8]/25 bg-white/40 p-3 text-sm text-[#4A5365]">No active delivery stops for this date.</p>}
        </section>
      )}

      {adapter && editorState && (
        <OrderEditorModal
          adapter={adapter}
          customers={customers}
          orders={orders}
          editingOrder={editorState.mode === 'edit' ? editorState.order : null}
          initialDraft={editorState.mode === 'edit' ? storedOrderToImportDraft(editorState.order, customerName(customers, editorState.order)) : blankImportDraft(deliveryDate)}
          title={editorState.mode === 'edit' ? 'Edit order' : 'New order'}
          onClose={() => setEditorState(null)}
          onSaved={() => setEditorState(null)}
        />
      )}
    </section>
  )
}
