// @vitest-environment jsdom
//
// Covers scanMutation's onSuccess wiring in DeckDetail.jsx — specifically
// which toast fires for which combination of isAutoSave and the backend's
// deck_scan_status (see backend services/deck_progress.py's SCAN_*
// constants). This is the one piece of the "warn on an off-deck/duplicate
// scan" feature that DeckCardScanner.test.jsx and the backend's own tests
// don't reach: DeckCardScanner only asserts on ITS OWN overlay, and the
// backend only asserts on the response shape — neither exercises this
// page's own branch that decides which toast the user actually sees.
//
// DeckCardScanner itself is mocked to a stub that hands back its onConfirm
// prop so tests can invoke it directly with whatever {isAutoSave, traceId}
// combination they're covering, without needing to drive the real
// camera/detection pipeline (that's DeckCardScanner.test.jsx's job, not
// this file's). react-hot-toast is mocked so calls can be inspected
// directly instead of rendering a real <Toaster> and waiting on its
// animations.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DeckDetail from './DeckDetail'
import { addToCollection, getDeckInstance } from '../api/client'
import toast from 'react-hot-toast'

vi.mock('react-router-dom', () => ({
  useParams: () => ({ instanceId: '3' }),
  useNavigate: () => vi.fn(),
}))

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: (key) => key }),
}))

vi.mock('../contexts/ConfirmDialogContext', () => ({
  useConfirmDialog: () => vi.fn().mockResolvedValue(true),
}))

vi.mock('../api/client', () => ({
  getDeckInstance: vi.fn(),
  resetDeckInstance: vi.fn(),
  deleteDeckInstance: vi.fn(),
  addToCollection: vi.fn(),
  undoLastScan: vi.fn(),
}))

vi.mock('react-hot-toast', () => {
  const fn = vi.fn()
  fn.success = vi.fn()
  fn.error = vi.fn()
  fn.dismiss = vi.fn()
  return { default: fn }
})

// Stands in for the real live-camera component — captures whatever
// onConfirm DeckDetail passes it so each test can call it directly with
// the exact {isAutoSave, traceId} combination it's covering.
let capturedOnConfirm = null
vi.mock('../components/DeckCardScanner', () => ({
  default: (props) => {
    capturedOnConfirm = props.onConfirm
    return null
  },
}))

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
}

async function renderLoaded() {
  const queryClient = makeQueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <DeckDetail />
    </QueryClientProvider>,
  )
  // Empty cards list — this file is only exercising scanMutation's toast
  // branch, not the card-list rendering (already covered by
  // utils/deckChecklist.test.js), so there's nothing else here worth
  // rendering real card rows for. Waits for the loading skeleton to clear
  // (DeckCardScanner, and so capturedOnConfirm, only renders once
  // useQuery's getDeckInstance() call has actually resolved).
  await waitFor(() => expect(capturedOnConfirm).toBeInstanceOf(Function))
}

describe('DeckDetail scan confirmation toasts', () => {
  beforeEach(() => {
    capturedOnConfirm = null
    getDeckInstance.mockResolvedValue({
      name: 'Test Deck', progress: 50, total_count: 2, scanned_count: 1,
      is_complete: false, cards: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows the plain success toast for a manual pick that counted toward the deck', async () => {
    addToCollection.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'counted' } })
    await renderLoaded()

    await act(async () => {
      await capturedOnConfirm({ id: 'p1', name: 'Pikachu' }, { isAutoSave: false, traceId: null })
    })

    expect(toast.success).toHaveBeenCalledWith('decks.scan.scanned: Pikachu')
    expect(toast).not.toHaveBeenCalled()
  })

  it('shows the Undo-capable toast for an auto-save that counted toward the deck', async () => {
    addToCollection.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'counted' } })
    await renderLoaded()

    await act(async () => {
      await capturedOnConfirm({ id: 'p1', name: 'Pikachu' }, { isAutoSave: true, traceId: 'trace-1' })
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    const ToastContent = toast.mock.calls[0][0]
    render(<ToastContent />)
    expect(screen.getByText('decks.scan.undo')).toBeInTheDocument()
  })

  it('shows a warning toast, not the Undo toast, for an auto-save of a card not in this deck', async () => {
    addToCollection.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'not_in_deck' } })
    await renderLoaded()

    await act(async () => {
      await capturedOnConfirm({ id: 'p1', name: 'Mewtwo' }, { isAutoSave: true, traceId: 'trace-1' })
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    const [ToastContent, options] = toast.mock.calls[0]
    expect(options).toMatchObject({ duration: 5000 })
    render(<ToastContent />)
    expect(screen.getByText(/Mewtwo/)).toBeInTheDocument()
    expect(screen.getByText(/decks\.scan\.notInDeckDetail/)).toBeInTheDocument()
    // Nothing meaningful to undo — register_scan never moved deck progress
    // for this scan (see DeckDetail.jsx's own comment on this branch).
    expect(screen.queryByText('decks.scan.undo')).not.toBeInTheDocument()
  })

  it('shows a warning toast for a manual pick already at its expected quantity', async () => {
    addToCollection.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'already_complete' } })
    await renderLoaded()

    await act(async () => {
      await capturedOnConfirm({ id: 'p1', name: 'Charmander' }, { isAutoSave: false, traceId: null })
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    const ToastContent = toast.mock.calls[0][0]
    render(<ToastContent />)
    expect(screen.getByText(/Charmander/)).toBeInTheDocument()
    expect(screen.getByText(/decks\.scan\.alreadyCompleteDetail/)).toBeInTheDocument()
  })

  it('still adds the card to the collection even when the scan does not count toward the deck', async () => {
    addToCollection.mockResolvedValue({ data: { card_id: 'p1', deck_scan_status: 'not_in_deck' } })
    await renderLoaded()

    await act(async () => {
      await capturedOnConfirm({ id: 'p1', name: 'Mewtwo' }, { isAutoSave: true, traceId: 'trace-1' })
    })

    expect(addToCollection).toHaveBeenCalledWith({ card_id: 'p1', quantity: 1, deck_instance_id: 3 })
  })
})
