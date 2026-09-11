import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOJICHA_LEVEL,
  DEFAULT_MATCHA_LEVEL,
  DEFAULT_POWDER,
  formatPesos,
  HOJICHA_LEVEL_LABELS,
  MATCHA_LEVEL_LABELS,
  MAX_CUPS_PER_ORDER,
  priceOrder,
  PricingError,
  PRODUCT_CATALOG,
  setRuntimeCatalogSettings,
  type PricingCatalogSnapshot,
  THERMAL_BAG_PRICES,
  type OrderDraft,
} from '../index'

const oneItemOrder = (draft: OrderDraft['items'][number]): OrderDraft => ({ items: [draft] })

describe('authoritative menu catalog', () => {
  it('encodes the fixed oat milk, documented Level 1 amounts, and zero-cost defaults', () => {
    expect(DEFAULT_MATCHA_LEVEL).toBe(1)
    expect(DEFAULT_HOJICHA_LEVEL).toBe(1)
    expect(DEFAULT_POWDER).toBe('yumeno')
    expect(MATCHA_LEVEL_LABELS[1]).toBe('Level 1 · 5g')
    expect(HOJICHA_LEVEL_LABELS[1]).toBe('Level 1 · 6g')
  })

  it('contains every menu row at its authoritative base price in centavos', () => {
    expect(Object.values(PRODUCT_CATALOG).map(({ slug, name, basePriceCentavos, milk }) => ({ slug, name, basePriceCentavos, milk }))).toEqual([
      { slug: 'matcha-latte', name: 'Matcha Latte', basePriceCentavos: 20000, milk: 'oat_milk' },
      { slug: 'strawberry-matcha', name: 'Strawberry Matcha', basePriceCentavos: 22000, milk: 'oat_milk' },
      { slug: 'salted-maple-matcha', name: 'Salted Maple Matcha', basePriceCentavos: 22000, milk: 'oat_milk' },
      { slug: 'hojicha-latte', name: 'Hojicha Latte', basePriceCentavos: 18000, milk: 'oat_milk' },
      { slug: 'strawberry-hojicha', name: 'Strawberry Hojicha', basePriceCentavos: 20000, milk: 'oat_milk' },
      { slug: 'salted-maple-hojicha', name: 'Salted Maple Hojicha', basePriceCentavos: 20000, milk: 'oat_milk' },
    ])
  })
})

describe('priceOrder', () => {
  it.each([
    ['Matcha Latte, L1, Yumeno', { productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno' } }, 20000],
    ['Strawberry Matcha, L2, Yumeno', { productSlug: 'strawberry-matcha', quantity: 1, modifiers: { level: 2, powder: 'yumeno' } }, 24500],
    ['Salted Maple Matcha, L3, MK Isuzu', { productSlug: 'salted-maple-matcha', quantity: 1, modifiers: { level: 3, powder: 'mk_isuzu' } }, 33000],
    ['Hojicha Latte, L1, Yumeno', { productSlug: 'hojicha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno' } }, 18000],
    ['Strawberry Hojicha, L2, MK Isuzu', { productSlug: 'strawberry-hojicha', quantity: 1, modifiers: { level: 2, powder: 'mk_isuzu' } }, 28000],
    ['Salted Maple Hojicha, L3, Yumeno', { productSlug: 'salted-maple-hojicha', quantity: 1, modifiers: { level: 3, powder: 'yumeno' } }, 24000],
  ] as const)('computes the hand-checked price for %s', (_name, item, expectedCentavos) => {
    const priced = priceOrder(oneItemOrder(item))

    expect(priced.items[0]?.unitPriceCentavos).toBe(expectedCentavos)
    expect(priced.totals.totalCentavos).toBe(expectedCentavos)
  })

  it.each([
    ['matcha', 'matcha-latte', [20000, 22500, 25000]],
    ['hojicha', 'hojicha-latte', [18000, 20000, 22000]],
  ] as const)('applies all %s level upcharges', (_family, productSlug, expectedPrices) => {
    for (const [index, expectedPrice] of expectedPrices.entries()) {
      const priced = priceOrder(oneItemOrder({
        productSlug,
        quantity: 1,
        modifiers: { level: index + 1 as 1 | 2 | 3, powder: 'yumeno' },
      }))
      expect(priced.items[0]?.unitPriceCentavos).toBe(expectedPrice)
    }
  })

  it.each([
    ['matcha-latte', 1, 20000, 26000],
    ['hojicha-latte', 1, 18000, 24000],
  ] as const)('applies both powder options to %s', (productSlug, level, yumenoPrice, mkIsuzuPrice) => {
    expect(priceOrder(oneItemOrder({ productSlug, quantity: 1, modifiers: { level, powder: 'yumeno' } })).items[0]?.unitPriceCentavos).toBe(yumenoPrice)
    expect(priceOrder(oneItemOrder({ productSlug, quantity: 1, modifiers: { level, powder: 'mk_isuzu' } })).items[0]?.unitPriceCentavos).toBe(mkIsuzuPrice)
  })

  it.each(['none', 'light', 'regular', 'extra'] as const)('accepts %s sweetness on a plain drink at no charge', (sweetness) => {
    const priced = priceOrder(oneItemOrder({
      productSlug: 'matcha-latte',
      quantity: 1,
      modifiers: { level: 1, powder: 'yumeno', sweetness },
    }))

    expect(priced.items[0]?.unitPriceCentavos).toBe(20000)
    expect(priced.items[0]?.modifiers.sweetness).toBe(sweetness)
  })

  it.each(['strawberry-matcha', 'salted-maple-matcha', 'strawberry-hojicha', 'salted-maple-hojicha'] as const)(
    'rejects a sweetness selection on %s',
    (productSlug) => {
      expect(() => priceOrder(oneItemOrder({
        productSlug,
        quantity: 1,
        modifiers: { level: 1, powder: 'yumeno', sweetness: 'light' },
      }))).toThrow(expect.objectContaining({ name: 'PricingError', code: 'INVALID_MODIFIER_COMBINATION' }))
    },
  )

  it('multiplies the deterministic unit price by a positive integer quantity', () => {
    const priced = priceOrder(oneItemOrder({
      productSlug: 'matcha-latte',
      quantity: 3,
      modifiers: { level: 2, powder: 'mk_isuzu' },
    }))

    expect(priced.items[0]).toMatchObject({ unitPriceCentavos: 28500, lineTotalCentavos: 85500 })
    expect(priced.totals.itemsSubtotalCentavos).toBe(85500)
  })

  it.each([
    [1, 2500],
    [2, 3000],
    [3, 3500],
    [4, 3500],
  ] as const)('uses the authoritative %s-cup thermal bag tier', (coveredCupCount, priceCentavos) => {
    const priced = priceOrder({
      items: [{ productSlug: 'matcha-latte', quantity: coveredCupCount, modifiers: { level: 1, powder: 'yumeno' } }],
      thermalBags: [{ coveredCupCount }],
    })

    expect(THERMAL_BAG_PRICES[coveredCupCount]).toBe(priceCentavos)
    expect(priced.thermalBags[0]?.priceCentavos).toBe(priceCentavos)
  })

  it('adds multiple explicit bags once at order level', () => {
    const priced = priceOrder({
      items: [{ productSlug: 'hojicha-latte', quantity: 6, modifiers: { level: 1, powder: 'yumeno' } }],
      thermalBags: [{ coveredCupCount: 4 }, { coveredCupCount: 2 }],
    })

    expect(priced.totals).toEqual({
      itemsSubtotalCentavos: 108000,
      thermalBagsTotalCentavos: 6500,
      totalCentavos: 114500,
    })
  })

  it('ignores supplied LLM prices and totals', () => {
    const honest = priceOrder(oneItemOrder({
      productSlug: 'matcha-latte',
      quantity: 2,
      modifiers: { level: 1, powder: 'yumeno' },
    }))
    const manipulated = priceOrder({
      items: [{
        productSlug: 'matcha-latte',
        quantity: 2,
        modifiers: { level: 1, powder: 'yumeno' },
        priceCentavos: 1,
        unitPriceCentavos: 1,
        lineTotalCentavos: 1,
      }],
      subtotalCentavos: 1,
      totalCentavos: 1,
    })

    expect(manipulated).toEqual(honest)
    expect(manipulated.totals.totalCentavos).toBe(40000)
  })

  it('keeps explicit catalog snapshots isolated from mutable runtime settings', () => {
    const snapshot = (basePrice: number, levelTwo: number, bagPrice: number): PricingCatalogSnapshot => ({
      productBasePrices: Object.fromEntries(Object.entries(PRODUCT_CATALOG).map(([slug, product]) => [slug, slug === 'matcha-latte' ? basePrice : product.basePriceCentavos])) as PricingCatalogSnapshot['productBasePrices'],
      productAvailability: Object.fromEntries(Object.keys(PRODUCT_CATALOG).map((slug) => [slug, true])) as PricingCatalogSnapshot['productAvailability'],
      matchaLevelUpcharges: { 1: 0, 2: levelTwo, 3: levelTwo * 2 },
      hojichaLevelUpcharges: { 1: 0, 2: 2000, 3: 4000 },
      powderUpcharges: { yumeno: 0, mk_isuzu: 6000 },
      thermalBagPrices: { 1: bagPrice, 2: bagPrice + 500, 3: bagPrice + 1000, 4: bagPrice + 1000 },
    })
    const order = oneItemOrder({ productSlug: 'matcha-latte', quantity: 2, modifiers: { level: 2, powder: 'yumeno' } })
    const snapshotA = snapshot(21000, 100, 9100)
    const snapshotB = snapshot(31000, 900, 1900)
    const legacy = priceOrder(order)

    try {
      setRuntimeCatalogSettings({
        ...snapshot(99000, 5000, 30000),
      })
      const pricedA = priceOrder(order, snapshotA)
      const pricedB = priceOrder(order, snapshotB)
      const pricedAAgain = priceOrder(order, snapshotA)

      expect(pricedA.items[0]?.unitPriceCentavos).toBe(21100)
      expect(pricedB.items[0]?.unitPriceCentavos).toBe(31900)
      expect(pricedAAgain).toEqual(pricedA)
      expect(priceOrder(order).items[0]?.unitPriceCentavos).toBe(104000)
    } finally {
      setRuntimeCatalogSettings(null)
    }

    expect(priceOrder(order)).toEqual(legacy)
  })
})

describe('pricing validation', () => {
  it.each([
    ['unknown product', { productSlug: 'espresso', quantity: 1, modifiers: { level: 1, powder: 'yumeno' } }, 'UNKNOWN_PRODUCT'],
    ['unknown level', { productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 4, powder: 'yumeno' } }, 'UNKNOWN_MODIFIER_OPTION'],
    ['unknown powder', { productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'ceremonial' } }, 'UNKNOWN_MODIFIER_OPTION'],
    ['unknown sweetness', { productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno', sweetness: 'medium' } }, 'UNKNOWN_MODIFIER_OPTION'],
    ['zero quantity', { productSlug: 'matcha-latte', quantity: 0, modifiers: { level: 1, powder: 'yumeno' } }, 'INVALID_QUANTITY'],
    ['fractional quantity', { productSlug: 'matcha-latte', quantity: 1.5, modifiers: { level: 1, powder: 'yumeno' } }, 'INVALID_QUANTITY'],
  ] as const)('throws PricingError for %s', (_caseName, item, code) => {
    expect(() => priceOrder(oneItemOrder(item as never))).toThrow(expect.objectContaining({ name: 'PricingError', code }))
  })

  it.each([0, 5, 1.5])('rejects a non-tier thermal bag count of %s', (coveredCupCount) => {
    expect(() => priceOrder({
      items: [{ productSlug: 'matcha-latte', quantity: 5, modifiers: { level: 1, powder: 'yumeno' } }],
      thermalBags: [{ coveredCupCount }],
    })).toThrow(expect.objectContaining({ name: 'PricingError', code: 'INVALID_THERMAL_BAG' }))
  })

  it('rejects thermal bags that cover more cups than ordered', () => {
    expect(() => priceOrder({
      items: [{ productSlug: 'matcha-latte', quantity: 1, modifiers: { level: 1, powder: 'yumeno' } }],
      thermalBags: [{ coveredCupCount: 2 }],
    })).toThrow(expect.objectContaining({ name: 'PricingError', code: 'THERMAL_BAGS_EXCEED_CUPS' }))
  })

  it(`accepts exactly ${100} cups (the MAX_CUPS_PER_ORDER ceiling)`, () => {
    expect(MAX_CUPS_PER_ORDER).toBe(100)
    const priced = priceOrder(oneItemOrder({
      productSlug: 'matcha-latte',
      quantity: MAX_CUPS_PER_ORDER,
      modifiers: { level: 1, powder: 'yumeno' },
    }))
    expect(priced.items[0]?.quantity).toBe(100)
    expect(priced.totals.itemsSubtotalCentavos).toBe(20000 * 100)
  })

  it('fails fast when total item quantity exceeds MAX_CUPS_PER_ORDER', () => {
    expect(() => priceOrder(oneItemOrder({
      productSlug: 'matcha-latte',
      quantity: MAX_CUPS_PER_ORDER + 1,
      modifiers: { level: 1, powder: 'yumeno' },
    }))).toThrow(expect.objectContaining({
      name: 'PricingError',
      code: 'TOO_MANY_CUPS',
      message: expect.stringMatching(/100 cups/i),
    }))
  })

  it('fails fast when multiple lines sum past the cup ceiling', () => {
    expect(() => priceOrder({
      items: [
        { productSlug: 'matcha-latte', quantity: 60, modifiers: { level: 1, powder: 'yumeno' } },
        { productSlug: 'hojicha-latte', quantity: 41, modifiers: { level: 1, powder: 'yumeno' } },
      ],
    })).toThrow(expect.objectContaining({ code: 'TOO_MANY_CUPS' }))
  })

  it('throws PricingError for malformed centavo values', () => {
    expect(() => formatPesos(200.5)).toThrow(PricingError)
    expect(() => formatPesos(Number.NaN)).toThrow(expect.objectContaining({ code: 'MALFORMED_MONEY' }))
  })

  it('formats calculated integer-centavo values as Philippine pesos', () => {
    expect(formatPesos(24500)).toBe('₱245.00')
  })
})
