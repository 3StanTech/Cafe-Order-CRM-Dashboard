import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getPublicOrderMenu,
  publicOrderErrorMessage,
  PUBLIC_ORDER_ENDPOINT,
  type PublicOrderFetch,
  type PublicOrderMenu,
} from '../features/public-order/api'
import { PublicOrderForm } from '../features/public-order/PublicOrderForm'

export type PublicOrderPageProps = {
  endpoint?: string
  fetcher?: PublicOrderFetch
  storage?: Storage | null
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

export function PublicOrderPage({ endpoint = PUBLIC_ORDER_ENDPOINT, fetcher, storage }: PublicOrderPageProps) {
  const [menu, setMenu] = useState<PublicOrderMenu | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const resolvedFetcher = useMemo(() => fetcher ?? globalThis.fetch, [fetcher])
  const resolvedStorage = useMemo(() => storage === undefined ? browserStorage() : storage, [storage])

  const loadMenu = useCallback(() => {
    let active = true
    setLoading(true)
    setError(null)
    void getPublicOrderMenu({ endpoint, fetcher: resolvedFetcher })
      .then((loaded) => { if (active) setMenu(loaded) })
      .catch((cause) => { if (active) setError(publicOrderErrorMessage(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [endpoint, resolvedFetcher])

  useEffect(() => loadMenu(), [loadMenu])

  return <div className="public-order-page min-h-dvh bg-[#FFFDF6] text-[#20242F]">
    <header className="border-b border-[#4F74C8]/15 bg-[#FFFDF6]">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <div className="flex min-w-0 items-center gap-2.5"><span aria-hidden="true" className="size-8 shrink-0 rounded-full bg-[#4F74C8] ring-1 ring-[#4F74C8]/15" /><p className="min-w-0 truncate text-base font-black tracking-tight">{menu?.business.name ?? 'Order link'}</p></div>
        <p className="hidden shrink-0 text-sm font-semibold text-[#586782] sm:block">Matcha &amp; hojicha · Metro Manila</p>
      </div>
    </header>
    <main className="mx-auto w-full max-w-6xl px-5 pb-12 pt-8 sm:px-8 sm:pt-10" aria-busy={loading}>
      {loading && <section className="mx-auto max-w-5xl rounded-2xl border border-[#4F74C8]/20 bg-[#FBF3D5]/55 p-5" role="status"><p className="text-sm font-semibold text-[#4F74C8]">Loading today’s menu…</p></section>}
      {!loading && error && <section className="mx-auto max-w-2xl rounded-2xl border border-red-200 bg-red-50 p-5" role="alert"><h1 className="text-xl font-black text-[#20242F]">Online ordering is unavailable</h1><p className="mt-2 text-sm leading-6 text-red-800">{error}</p><button type="button" onClick={() => loadMenu()} className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl bg-[#4F74C8] px-4 text-sm font-bold text-white transition-colors hover:bg-[#365AA9]">Try again</button></section>}
      {!loading && !error && menu && <PublicOrderForm menu={menu} endpoint={endpoint} fetcher={resolvedFetcher} storage={resolvedStorage} onMenuRevisionChange={setMenu} />}
    </main>
  </div>
}
