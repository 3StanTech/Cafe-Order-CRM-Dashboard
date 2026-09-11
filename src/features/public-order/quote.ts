import {
  HOJICHA_LEVEL_UPCHARGES,
  MATCHA_LEVEL_UPCHARGES,
  POWDER_UPCHARGES,
  PRODUCT_CATALOG,
  THERMAL_BAG_PRICES,
} from '../../domain/catalog'
import { priceOrder, type PricingCatalogSnapshot } from '../../domain/pricing'
import type { PricedOrder, ProductSlug } from '../../domain/contracts'
import type { PublicOrderDraftItem, PublicOrderMenu } from './api'

export type PublicOrderDraft = {
  items: PublicOrderDraftItem[]
  thermalBags: { coveredCupCount: 1 | 2 | 3 | 4 }[]
}

function sameCharges(left: Readonly<Record<1 | 2 | 3, number>>, right: Readonly<Record<1 | 2 | 3, number>>): boolean {
  return left[1] === right[1] && left[2] === right[2] && left[3] === right[3]
}

/**
 * Converts the server's whitelisted menu response into an isolated pricing
 * snapshot. `priceOrder` receives this snapshot directly, so public ordering
 * never changes the dashboard's process-wide runtime catalog.
 */
export function menuToPricingSnapshot(menu: PublicOrderMenu): PricingCatalogSnapshot {
  const productBasePrices = Object.fromEntries(
    (Object.keys(PRODUCT_CATALOG) as ProductSlug[]).map((slug) => [slug, PRODUCT_CATALOG[slug].basePriceCentavos]),
  ) as Record<ProductSlug, number>
  const productAvailability = Object.fromEntries(
    (Object.keys(PRODUCT_CATALOG) as ProductSlug[]).map((slug) => [slug, false]),
  ) as Record<ProductSlug, boolean>
  let matchaLevelUpcharges = { ...MATCHA_LEVEL_UPCHARGES }
  let hojichaLevelUpcharges = { ...HOJICHA_LEVEL_UPCHARGES }
  let matchaChargesSeen = false
  let hojichaChargesSeen = false

  for (const product of menu.products) {
    productBasePrices[product.slug] = product.basePriceCentavos
    productAvailability[product.slug] = true
    if (product.family === 'matcha') {
      if (matchaChargesSeen && !sameCharges(matchaLevelUpcharges, product.levelUpcharges)) throw new Error('The menu returned inconsistent matcha level pricing.')
      matchaLevelUpcharges = { ...product.levelUpcharges }
      matchaChargesSeen = true
    } else {
      if (hojichaChargesSeen && !sameCharges(hojichaLevelUpcharges, product.levelUpcharges)) throw new Error('The menu returned inconsistent hojicha level pricing.')
      hojichaLevelUpcharges = { ...product.levelUpcharges }
      hojichaChargesSeen = true
    }
  }

  const firstProduct = menu.products[0]
  return {
    productBasePrices,
    productAvailability,
    matchaLevelUpcharges,
    hojichaLevelUpcharges,
    powderUpcharges: { ...firstProduct.powderUpcharges },
    thermalBagPrices: { ...firstProduct.thermalBagPrices },
  }
}

/** Display-only quote. The server remains the authority at submission time. */
export function pricePublicOrder(draft: PublicOrderDraft, menu: PublicOrderMenu): PricedOrder {
  const snapshot = menuToPricingSnapshot(menu)
  return priceOrder({
    items: draft.items.map(({ productSlug, quantity, modifiers }) => ({ productSlug, quantity, modifiers })),
    thermalBags: draft.thermalBags,
  }, snapshot)
}
