import { lazy, Suspense, type ComponentType } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { DemoBanner } from './components/DemoBanner'
import { ErrorBoundary } from './components/ErrorBoundary'
import { InstallPrompt } from './components/InstallPrompt'
import { AppShell } from './components/layout/AppShell'
import { StorageProvider } from './data/StorageProvider'
import { AuthBoundary } from './features/auth/AuthBoundary'
import { isDemoMode } from './features/auth/supabaseAuth'

/**
 * Production: React.lazy so each page is its own async chunk.
 * Vitest: top-level await resolves the same modules before tests run, so existing
 * sync getByRole assertions in App.test.tsx keep working. Vite DCE removes the
 * test branch (and the await) from the production bundle.
 */
let TodayPage: ComponentType
let InboxPage: ComponentType
let OrdersPage: ComponentType
let CustomersPage: ComponentType
let InsightsPage: ComponentType
let SettingsPage: ComponentType
let HistoryImportPage: ComponentType
let PublicOrderPage: ComponentType

if (import.meta.env.MODE === 'test') {
  const [today, inbox, orders, customers, insights, settings, historyImport, publicOrder] = await Promise.all([
    import('./pages/TodayPage'),
    import('./pages/InboxPage'),
    import('./pages/OrdersPage'),
    import('./pages/CustomersPage'),
    import('./pages/InsightsPage'),
    import('./pages/SettingsPage'),
    import('./pages/HistoryImportPage'),
    import('./pages/PublicOrderPage'),
  ])
  TodayPage = today.TodayPage
  InboxPage = inbox.InboxPage
  OrdersPage = orders.OrdersPage
  CustomersPage = customers.CustomersPage
  InsightsPage = insights.InsightsPage
  SettingsPage = settings.SettingsPage
  HistoryImportPage = historyImport.HistoryImportPage
  PublicOrderPage = publicOrder.PublicOrderPage
} else {
  TodayPage = lazy(() =>
    import('./pages/TodayPage').then((m) => ({ default: m.TodayPage })),
  )
  InboxPage = lazy(() =>
    import('./pages/InboxPage').then((m) => ({ default: m.InboxPage })),
  )
  OrdersPage = lazy(() =>
    import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage })),
  )
  CustomersPage = lazy(() =>
    import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage })),
  )
  InsightsPage = lazy(() =>
    import('./pages/InsightsPage').then((m) => ({ default: m.InsightsPage })),
  )
  SettingsPage = lazy(() =>
    import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
  )
  HistoryImportPage = lazy(() =>
    import('./pages/HistoryImportPage').then((m) => ({ default: m.HistoryImportPage })),
  )
  PublicOrderPage = lazy(() =>
    import('./pages/PublicOrderPage').then((m) => ({ default: m.PublicOrderPage })),
  )
}

function RouteFallback() {
  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-xl bg-[#FBF3D5] p-4 text-sm font-medium text-[#4F74C8]"
    >
      Loading…
    </p>
  )
}

/** Single Suspense around the nested outlet so AppShell stays mounted while pages load. */
function SuspenseOutlet() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Outlet />
    </Suspense>
  )
}

function PrivateLayout() {
  return (
    <AuthBoundary>
      <StorageProvider>
        <ErrorBoundary>
          {isDemoMode && <DemoBanner />}
          <div className={isDemoMode ? 'pt-9' : undefined}>
            <Outlet />
          </div>
          <InstallPrompt />
        </ErrorBoundary>
      </StorageProvider>
    </AuthBoundary>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/order"
          element={
            <Suspense fallback={<RouteFallback />}>
              <PublicOrderPage />
            </Suspense>
          }
        />
        <Route element={<PrivateLayout />}>
          <Route element={<AppShell />}>
            <Route element={<SuspenseOutlet />}>
              <Route path="/today" element={<TodayPage />} />
              <Route path="/inbox" element={<InboxPage />} />
              <Route path="/import" element={<Navigate to="/inbox" replace />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/insights" element={<InsightsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/import-history" element={<HistoryImportPage />} />
              <Route path="/" element={<Navigate to="/today" replace />} />
              <Route path="*" element={<Navigate to="/today" replace />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
