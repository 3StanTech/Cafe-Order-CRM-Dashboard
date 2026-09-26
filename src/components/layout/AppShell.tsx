import { BarChart3, Home, Inbox, Settings, ShoppingBag, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import gellyLogo from '../../assets/brand/gelly-logo-mark.png'

type NavigationItem = { label: string; path: string; icon: LucideIcon }

const navigationItems: NavigationItem[] = [
  { label: 'Today', path: '/today', icon: Home },
  { label: 'Inbox', path: '/inbox', icon: Inbox },
  { label: 'Orders', path: '/orders', icon: ShoppingBag },
  { label: 'Customers', path: '/customers', icon: Users },
  { label: 'Insights', path: '/insights', icon: BarChart3 },
  { label: 'Settings', path: '/settings', icon: Settings },
]

export function AppShell() {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-3xl bg-[#FBF3D5] shadow-[0_0_0_1px_rgba(79,116,200,0.08)]">
      <header className="flex min-h-9 items-center gap-2.5 px-5 pb-3 pr-24 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <img src={gellyLogo} alt="" className="size-8 shrink-0 rounded-full ring-1 ring-[#4F74C8]/15" height={32} width={32} />
        <p className="min-w-0 truncate text-[15px] font-black leading-none tracking-tight text-[#20242F]">
          Gelly <span className="text-[#4F74C8]">Dashboard</span>
        </p>
      </header>
      <main className="min-h-dvh px-5 pb-[calc(7.25rem+env(safe-area-inset-bottom))] pt-2">
        <Outlet />
      </main>
      <nav aria-label="Primary navigation" className="fixed inset-x-0 bottom-0 z-10 mx-auto w-full max-w-3xl border-t border-[#4F74C8]/20 bg-[#FBF3D5]/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        <ul className="grid grid-cols-6 gap-0.5" role="list">
          {navigationItems.map(({ label, path, icon: Icon }) => (
            <li key={path}>
              <NavLink
                to={path}
                className={({ isActive }) => `group flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold leading-none transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4F74C8] active:scale-95 motion-safe:transition-transform ${isActive ? 'bg-[#4F74C8] text-white' : 'text-[#4A5365] hover:bg-[#4F74C8]/10'}`}
              >
                <Icon aria-hidden="true" size={19} strokeWidth={2} className="transition-transform duration-200 group-active:scale-90" />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}
