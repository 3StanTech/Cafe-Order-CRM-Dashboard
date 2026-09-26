/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test'

const SEEDED_DELIVERY_DATE = '2026-07-16'
const NEW_ORDER_CUSTOMER = 'Paolo Reyes'
const PAID_ORDER_CUSTOMER = 'Mika Santos'

/** Collect uncaught page errors and console errors; assert empty at end of each test. */
function trackPageHealth(page: Page) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []

  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })

  return {
    assertClean() {
      expect(pageErrors, `Unexpected page errors:\n${pageErrors.join('\n')}`).toEqual([])
      expect(consoleErrors, `Unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([])
    },
  }
}

async function openTodayBoard(page: Page) {
  await page.goto('/today')
  await page.getByLabel('Delivery date').fill(SEEDED_DELIVERY_DATE)
  await expect(page.getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()
  await expect(page.getByRole('heading', { name: PAID_ORDER_CUSTOMER })).toBeVisible()
}

function statusRegion(page: Page, label: string) {
  return page.getByRole('region', { name: label })
}

function orderCard(page: Page, customerName: string) {
  return page.getByRole('article').filter({ has: page.getByRole('heading', { name: customerName }) })
}

// Vitest's default include matches **/*.spec.ts. This file is Playwright-only. Under Vitest we
// register a skipped placeholder so the empty-suite collector does not fail `npx vitest run`
// (vite.config is out of scope for this task, so we cannot exclude e2e/ there).
if (process.env.VITEST) {
  const vitest = globalThis as unknown as {
    describe: { skip: (title: string, fn: () => void) => void }
    it: (title: string, fn: () => void) => void
  }
  vitest.describe.skip('playwright demo-mode smoke (run via npm run test:e2e)', () => {
    vitest.it('placeholder — not executed under Vitest', () => {})
  })
} else {
  test.describe('demo-mode smoke', () => {
    test('today board shows demo banner and seeded sections for 2026-07-16', async ({ page }) => {
      const health = trackPageHealth(page)

      await page.goto('/today')
      await page.getByLabel('Delivery date').fill(SEEDED_DELIVERY_DATE)

      await expect(
        page.getByRole('status').filter({ hasText: /Demo \/ offline mode/i }),
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: 'New', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Paid', exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Delivered', exact: true })).toBeVisible()

      await expect(statusRegion(page, 'New').getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()
      await expect(statusRegion(page, 'Paid').getByRole('heading', { name: PAID_ORDER_CUSTOMER })).toBeVisible()

      health.assertClean()
    })

    test('advances the seeded New order through Paid to Delivered', async ({ page }) => {
      const health = trackPageHealth(page)
      await openTodayBoard(page)

      const newCard = orderCard(page, NEW_ORDER_CUSTOMER)
      await expect(statusRegion(page, 'New').getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()
      await expect(newCard.getByText('Next: Mark paid')).toBeVisible()
      await expect(newCard.getByRole('button', { name: 'Mark Paid' })).toBeVisible()

      await newCard.getByRole('button', { name: 'Mark Paid' }).click()

      const paidCard = orderCard(page, NEW_ORDER_CUSTOMER)
      await expect(statusRegion(page, 'Paid').getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()
      await expect(paidCard.getByText('Next: Mark delivered')).toBeVisible()
      await expect(paidCard.getByRole('button', { name: 'Mark Delivered' })).toBeVisible()
      // paymentReceived is set true on the New → Paid transition; next legal action is deliver only
      await expect(paidCard.getByRole('button', { name: 'Mark Paid' })).toHaveCount(0)

      await paidCard.getByRole('button', { name: 'Mark Delivered' }).click()

      const deliveredCard = orderCard(page, NEW_ORDER_CUSTOMER)
      await expect(statusRegion(page, 'Delivered').getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()
      await expect(deliveredCard.getByText('Next: Delivered — complete')).toBeVisible()
      await expect(deliveredCard.getByRole('button', { name: /Mark / })).toHaveCount(0)
      await expect(deliveredCard.getByRole('button', { name: 'Cancel order' })).toHaveCount(0)

      health.assertClean()
    })

    test('cancels the seeded Paid order; delivered and cancelled are terminal and cancelled is off the run list', async ({ page }) => {
      const health = trackPageHealth(page)
      await openTodayBoard(page)

      // Produce a Delivered order in this fresh context so terminal affordances can be asserted.
      await orderCard(page, NEW_ORDER_CUSTOMER).getByRole('button', { name: 'Mark Paid' }).click()
      await orderCard(page, NEW_ORDER_CUSTOMER).getByRole('button', { name: 'Mark Delivered' }).click()
      await expect(statusRegion(page, 'Delivered').getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()

      const paidSeed = orderCard(page, PAID_ORDER_CUSTOMER)
      await expect(statusRegion(page, 'Paid').getByRole('heading', { name: PAID_ORDER_CUSTOMER })).toBeVisible()
      await paidSeed.getByRole('button', { name: 'Cancel order' }).click()

      const cancelledCard = orderCard(page, PAID_ORDER_CUSTOMER)
      await expect(statusRegion(page, 'Cancelled').getByRole('heading', { name: PAID_ORDER_CUSTOMER })).toBeVisible()
      await expect(cancelledCard.getByText('Next: Cancelled — no further action')).toBeVisible()
      await expect(cancelledCard.getByRole('button', { name: /Mark / })).toHaveCount(0)
      await expect(cancelledCard.getByRole('button', { name: 'Cancel order' })).toHaveCount(0)

      const deliveredCard = orderCard(page, NEW_ORDER_CUSTOMER)
      await expect(deliveredCard.getByText('Next: Delivered — complete')).toBeVisible()
      await expect(deliveredCard.getByRole('button', { name: /Mark / })).toHaveCount(0)
      await expect(deliveredCard.getByRole('button', { name: 'Cancel order' })).toHaveCount(0)

      await page.getByRole('button', { name: 'Run list' }).click()
      await expect(page.getByRole('heading', { name: 'Delivery run' })).toBeVisible()
      await expect(page.getByRole('heading', { name: NEW_ORDER_CUSTOMER })).toBeVisible()
      await expect(page.getByRole('heading', { name: PAID_ORDER_CUSTOMER })).toHaveCount(0)

      health.assertClean()
    })

    test('primary navigation reaches every feature page without error banners', async ({ page }) => {
      const health = trackPageHealth(page)
      await page.goto('/today')
      await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()

      const nav = page.getByRole('navigation', { name: 'Primary navigation' })

      const pages: { link: string; heading: string }[] = [
        { link: 'Orders', heading: 'Orders' },
        { link: 'Customers', heading: 'Customers' },
        { link: 'Insights', heading: 'Insights' },
        { link: 'Inbox', heading: 'Inbox' },
        { link: 'Settings', heading: 'Settings' },
      ]

      for (const { link, heading } of pages) {
        await nav.getByRole('link', { name: link }).click()
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
        await expect(page.getByRole('alert')).toHaveCount(0)
      }

      health.assertClean()
    })

    test('PWA manifest link and dev service worker assets respond successfully', async ({ page }) => {
      const health = trackPageHealth(page)
      await page.goto('/today')

      const manifestHref = await page.evaluate(() => {
        const link = document.head.querySelector('link[rel="manifest"]')
        return link?.getAttribute('href') ?? null
      })
      expect(manifestHref, 'manifest link must be present in document head').toBeTruthy()

      const manifestResponse = await page.request.get('/manifest.webmanifest')
      expect(manifestResponse.ok(), `manifest status ${manifestResponse.status()}`).toBeTruthy()

      const swResponse = await page.request.get('/sw.js')
      expect(swResponse.ok(), `sw.js status ${swResponse.status()}`).toBeTruthy()

      health.assertClean()
    })
  })
}
