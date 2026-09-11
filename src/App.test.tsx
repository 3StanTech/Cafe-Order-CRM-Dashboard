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
    for (const route of ['Import', 'Orders', 'Customers', 'Insights', 'Settings']) {
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
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()

    fetchSpy.mockRestore()
  })

  it('still shows the Import heading and operator nav on /import', async () => {
    window.history.pushState({}, '', '/import')
    render(<App />)
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByRole('heading', { name: 'Import' })).toBeInTheDocument()
  })
})
