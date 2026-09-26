import { useEffect, useState } from 'react'
import type { StorageAdapter } from '../../data/types'
import { DEFAULT_DASHBOARD_SETTINGS, ORDER_DASHBOARD_SETTINGS_KEY, loadDashboardSettings, type DashboardSettings } from './settings-store'

/**
 * Owner settings for screens that only read them (schedule, subtitle copy).
 * Returns defaults until the stored row loads, then follows later saves from
 * any device. `loaded` lets callers avoid acting on the defaults.
 */
export function useDashboardSettings(adapter: StorageAdapter | null | undefined): { settings: DashboardSettings; loaded: boolean } {
  const [state, setState] = useState<{ settings: DashboardSettings; loaded: boolean }>({ settings: DEFAULT_DASHBOARD_SETTINGS, loaded: false })

  useEffect(() => {
    if (!adapter) return
    let active = true
    const load = () => {
      void loadDashboardSettings(adapter)
        .then((settings) => { if (active) setState({ settings, loaded: true }) })
        .catch(() => { if (active) setState((current) => ({ ...current, loaded: true })) })
    }
    load()
    const unsubscribe = adapter.subscribe((change) => {
      if (change.collection === 'settings' && 'key' in change.entity && change.entity.key === ORDER_DASHBOARD_SETTINGS_KEY) load()
    })
    return () => { active = false; unsubscribe() }
  }, [adapter])

  return state
}
