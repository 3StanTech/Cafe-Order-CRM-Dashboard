import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

describe('application shell', () => {
  it('renders all six routes and updates the active tab', async () => {
    window.history.pushState({}, '', '/today')
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page')
    for (const route of ['Inbox', 'Orders', 'Customers', 'Insights', 'Settings']) {
      await user.click(screen.getByRole('link', { name: route }))
      expect(screen.getByRole('heading', { name: route })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: route })).toHaveAttribute('aria-current', 'page')
    }
  })

  it('keeps /order outside primary navigation, PIN, and operator tabs', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    window.history.pushState({}, '', '/order')
    render(<App />)

    expect(screen.getByText('Order link')).toBeInTheDocument()
    expect(screen.getByText(/Loading today/i)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Primary navigation' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('PIN')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Today' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Inbox' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()

    fetchSpy.mockRestore()
  })

  it('redirects the old /import link to the Inbox', async () => {
    window.history.pushState({}, '', '/import')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/inbox')
    expect(screen.getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument()
  })

  it('serves the one-time history import under Settings', async () => {
    window.history.pushState({}, '', '/settings/import-history')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })
})
