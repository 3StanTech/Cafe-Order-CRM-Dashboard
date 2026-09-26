import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setRuntimeCatalogSettings } from '../../../domain/catalog'
import { formatPhp } from '../../orders/order-display'
import type { ImportDraft } from '../../import/types'
import {
  DEFAULT_DASHBOARD_SETTINGS,
  applyDashboardSettings,
} from '../../settings/settings-store'
import { OrderEditorCard } from '../OrderEditorCard'
import { blankImportDraft } from '../orderDraftMapping'

/**
 * Regression guard: while the order editor is mounted, a Settings price save
 * must update the displayed validation total on the next re-render.
 *
 * Settings applies prices via applyDashboardSettings → setRuntimeCatalogSettings
 * (the same path saveDashboardSettings uses). Any parent that re-renders after
 * a settings change then re-renders OrderEditorCard with the draft unchanged.
 */
function validDraft(): ImportDraft {
  const base = blankImportDraft()
  return {
    ...base,
    customerName: 'Mika',
    address: 'Makati',
    items: [{ ...base.items[0], productSlug: 'matcha-latte', quantity: 1, level: 1, powder: 'yumeno' }],
  }
}

describe('OrderEditorCard catalog price live update', () => {
  beforeEach(() => {
    setRuntimeCatalogSettings(null)
  })

  afterEach(() => {
    setRuntimeCatalogSettings(null)
  })

  it('reflects a Settings price change while the editor stays mounted', () => {
    const draft = validDraft()
    const props = {
      draft,
      customers: [],
      orders: [],
      confirming: false,
      onChange: () => {},
      onConfirm: () => {},
    }

    const { rerender } = render(<OrderEditorCard {...props} />)

    // Default Matcha Latte base is 20000 centavos.
    expect(screen.getByText(formatPhp(20_000))).toBeInTheDocument()

    // Same mechanism Settings uses on save (applyDashboardSettings → setRuntimeCatalogSettings).
    applyDashboardSettings({
      ...DEFAULT_DASHBOARD_SETTINGS,
      productBasePrices: {
        ...DEFAULT_DASHBOARD_SETTINGS.productBasePrices,
        'matcha-latte': 25_000,
      },
    })

    // Parent re-render with draft unchanged, as after a settings change.
    rerender(<OrderEditorCard {...props} />)

    expect(screen.getByText(formatPhp(25_000))).toBeInTheDocument()
    expect(screen.queryByText(formatPhp(20_000))).not.toBeInTheDocument()
  })
})
