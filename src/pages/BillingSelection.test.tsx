import { beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BillingSelection } from './BillingSelection'
import { readBillingIntent } from '@/lib/billing/intent'
let jwt: string | null = 'active'
const list = vi.fn()
vi.mock('@/hooks/useFrontierSession', () => ({ useFrontierSession: () => ({ session: jwt ? { jwt } : null, loading: false }) }))
vi.mock('@/lib/frontier/auth', () => ({ isJwtExpired: (value: string) => value === 'expired' }))
vi.mock('@/lib/frontier/orgs', () => ({ listMyOrgs: (...args: unknown[]) => list(...args) }))
vi.mock('@/components/org/BillingPlanReview', () => ({ BillingPlanReview: ({ orgId, selection }: { orgId: number; selection: unknown }) =>
  <div data-testid="review">{JSON.stringify({ orgId, selection })}</div> }))
const path = '/billing/select?offer=team-20x&interval=annual&quantity=1&audience=team'
function view(url = path) { return <MemoryRouter initialEntries={[url]}><BillingSelection /></MemoryRouter> }
beforeEach(() => { jwt = 'active'; list.mockReset(); list.mockResolvedValue([
  { id: 1, name: 'Personal', role: { level: 700 } },
  { id: 2, name: 'Team', role: { level: 600 } },
  { id: 3, name: 'Guest org', role: { level: 400 } },
]) })
it.each([null, 'expired'])('preserves selection in login and signup links for %s session', async value => {
  jwt = value
  render(view())
  const login = new URL(screen.getByRole('link', { name: 'Sign in to review plan' }).getAttribute('href')!, 'https://test')
  const next = new URL(login.searchParams.get('next')!, 'https://test')
  expect(readBillingIntent(next.searchParams)).toEqual({ kind: 'paid', selection: { offer: 'team_20x', interval: 'year', quantity: 1 } })
  const signup = new URL(screen.getByRole('link', { name: 'Create an account' }).getAttribute('href')!, 'https://test')
  expect(readBillingIntent(signup.searchParams)).toEqual(readBillingIntent(next.searchParams))
  expect(list).not.toHaveBeenCalled()
})
it('requires an explicit workspace choice and filters users without billing authority', async () => {
  const user = userEvent.setup()
  render(view())
  expect(await screen.findByRole('button', { name: 'Review for Team' })).toBeVisible()
  expect(screen.queryByTestId('review')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Review for Guest org' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Review for Team' }))
  expect(screen.getByTestId('review')).toHaveTextContent('"orgId":2')
  expect(screen.getByTestId('review')).toHaveTextContent('"offer":"team_20x"')
})
it('rejects malformed links before loading workspaces', () => {
  render(view('/billing/select?offer=pro&interval=year&quantity=999'))
  expect(screen.getByRole('heading', { name: 'Plan selection unavailable' })).toBeVisible()
  expect(list).not.toHaveBeenCalled()
})
it('drops a previous account’s late workspace response', async () => {
  let resolve!: (orgs: unknown[]) => void
  list.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const { rerender } = render(view())
  jwt = 'second'
  list.mockResolvedValueOnce([])
  rerender(view())
  expect(await screen.findByText(/No workspace grants you billing authority/)).toBeVisible()
  await act(async () => resolve([{ id: 8, name: 'Old account', role: { level: 700 } }]))
  expect(screen.queryByRole('button', { name: 'Review for Old account' })).not.toBeInTheDocument()
})
