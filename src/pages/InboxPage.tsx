import { Inbox } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { StoredCustomer, StoredOrder } from '../data/types'
import { useStorageAdapter } from '../data/useStorageAdapter'
import { PendingInbox } from '../features/import/PendingInbox'

export function InboxPage() {
  const { adapter, error } = useStorageAdapter()
  const [customers, setCustomers] = useState<StoredCustomer[]>([])
  const [orders, setOrders] = useState<StoredOrder[]>([])
  const [pendingCount, setPendingCount] = useState<number | null>(null)

  useEffect(() => {
    if (!adapter) return
    let active = true
    const refresh = () => {
      void Promise.all([adapter.listCustomers(), adapter.listOrders()]).then(([nextCustomers, nextOrders]) => {
        if (!active) return
        setCustomers(nextCustomers)
        setOrders(nextOrders)
      })
    }
    refresh()
    const unsubscribe = adapter.subscribe((change) => {
      if (change.collection === 'customers' || change.collection === 'orders') refresh()
    })
    return () => { active = false; unsubscribe() }
  }, [adapter])

  return (
    <section className="space-y-4">
      <header className="motion-fade-up">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-black tracking-tight text-[#20242f]">Inbox</h1>
          {pendingCount !== null && pendingCount > 0 && (
            <span className="rounded-full bg-[#4F74C8] px-2.5 py-1 text-xs font-bold text-white">{pendingCount} pending</span>
          )}
        </div>
        <p className="mt-1 max-w-xl text-sm leading-6 text-[#4A5365]">Orders sent through the order link wait here until you confirm them.</p>
      </header>

      {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{error}</p>}
      {!error && !adapter && <p className="text-sm text-[#4A5365]">Preparing local order storage…</p>}

      {pendingCount === 0 && (
        <div className="motion-fade-in flex items-center gap-3 rounded-2xl border border-[#4F74C8]/20 bg-[#FFFDF6] p-4 shadow-sm">
          <Inbox aria-hidden="true" size={22} className="shrink-0 text-[#4F74C8]" />
          <div>
            <p className="font-bold text-[#20242f]">All caught up</p>
            <p className="text-sm text-[#4A5365]">New orders from the order link will show up here.</p>
          </div>
        </div>
      )}

      {adapter && <PendingInbox customers={customers} orders={orders} onCountChange={setPendingCount} />}
    </section>
  )
}
