import { viberThreads } from './viber-threads'

export const BENCHMARK_CURRENT_DATE = '2026-09-07'

export type ExpectedItem = {
  product_slug: string
  quantity: number
  level?: number | null
  powder?: string | null
  sweetness?: string | null
  cup_names?: string[]
}

export type ExpectedOrder = {
  customer_name: string
  items: ExpectedItem[]
  thermal_bags?: { covered_cup_count: number }[]
  delivery_date?: string | null
  address?: string | null
  unresolved?: boolean
}

export type BenchmarkFixture = {
  name: string
  text: string
  expectedOrders: ExpectedOrder[]
}

function viberText(name: string): string {
  const thread = viberThreads.find((entry) => entry.name === name)
  if (!thread) throw new Error(`Missing Viber conversation: ${name}`)
  return thread.text
}

export const openRouterBenchmarkFixtures: readonly BenchmarkFixture[] = [
  {
    name: 'single order',
    text: viberText('single order'),
    expectedOrders: [{
      customer_name: 'Mika Santos',
      items: [{ product_slug: 'matcha-latte', quantity: 1 }],
      delivery_date: '2026-09-08',
      address: 'Makati City',
    }],
  },
  {
    name: 'multi-drink order',
    text: viberText('multi-drink order'),
    expectedOrders: [{
      customer_name: 'Paolo',
      items: [
        { product_slug: 'strawberry-matcha', quantity: 2, level: 2 },
        { product_slug: 'hojicha-latte', quantity: 1, level: 3 },
      ],
      delivery_date: null,
      address: 'QC',
    }],
  },
  {
    name: 'misspelled drink',
    text: viberText('misspelled drink'),
    expectedOrders: [{
      customer_name: 'Aira',
      items: [{ product_slug: 'strawberry-matcha', quantity: 1, level: 1 }],
      delivery_date: null,
      address: null,
    }],
  },
  {
    name: 'emoji and casual punctuation',
    text: viberText('emoji and casual punctuation'),
    expectedOrders: [{
      customer_name: 'Mika',
      items: [{ product_slug: 'matcha-latte', quantity: 1, sweetness: 'extra' }],
      delivery_date: null,
      address: 'BGC',
    }],
  },
  {
    name: 'customer correction',
    text: viberText('customer correction'),
    expectedOrders: [{
      customer_name: 'Jenny Cruz',
      items: [{ product_slug: 'hojicha-latte', quantity: 1 }],
      delivery_date: null,
      address: null,
    }],
  },
  {
    name: 'split messages',
    text: viberText('split messages'),
    expectedOrders: [{
      customer_name: 'Paolo',
      items: [{ product_slug: 'matcha-latte', quantity: 2, level: 2, powder: 'mk_isuzu' }],
      delivery_date: '2026-09-11',
      address: 'Makati',
    }],
  },
  {
    name: 'missing address',
    text: viberText('missing address'),
    expectedOrders: [{
      customer_name: 'Aira Cruz',
      items: [{ product_slug: 'salted-maple-hojicha', quantity: 1, level: 1 }],
      delivery_date: '2026-09-08',
      address: null,
      unresolved: true,
    }],
  },
  {
    name: 'plain latte sweetness',
    text: viberText('plain latte sweetness'),
    expectedOrders: [{
      customer_name: 'Mika',
      items: [{ product_slug: 'hojicha-latte', quantity: 1, level: 2, sweetness: 'light' }],
      delivery_date: null,
      address: 'BGC',
    }],
  },
  {
    name: 'flavored invalid sweetness',
    text: viberText('flavored invalid sweetness'),
    expectedOrders: [{
      customer_name: 'Paolo',
      items: [{ product_slug: 'strawberry-matcha', quantity: 1, sweetness: null }],
      delivery_date: null,
      address: 'Quezon City',
      unresolved: true,
    }],
  },
  {
    name: 'thermal bag',
    text: viberText('thermal bag'),
    expectedOrders: [{
      customer_name: 'Mika',
      items: [{ product_slug: 'matcha-latte', quantity: 3, level: 1 }],
      thermal_bags: [{ covered_cup_count: 3 }],
      delivery_date: null,
      address: 'Makati',
    }],
  },
  {
    name: 'attempted fake amount',
    text: viberText('attempted fake amount'),
    expectedOrders: [{
      customer_name: 'Aira',
      items: [{ product_slug: 'matcha-latte', quantity: 1, level: 3 }],
      delivery_date: null,
      address: 'QC',
    }],
  },
  {
    name: 'two customers in one paste',
    text: 'Mika Santos: 2 Matcha Latte, one for Ana, one for Ben. Makati.\nPaolo Reyes: 1 hojicha latte L2, QC.',
    expectedOrders: [
      {
        customer_name: 'Mika Santos',
        items: [{ product_slug: 'matcha-latte', quantity: 2, cup_names: ['Ana', 'Ben'] }],
        delivery_date: null,
        address: 'Makati',
      },
      {
        customer_name: 'Paolo Reyes',
        items: [{ product_slug: 'hojicha-latte', quantity: 1, level: 2 }],
        delivery_date: null,
        address: 'QC',
      },
    ],
  },
]
