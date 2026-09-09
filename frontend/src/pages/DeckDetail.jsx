import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Camera, RotateCcw, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  getDeckInstance, resetDeckInstance, deleteDeckInstance, addToCollection, undoLastScan, undoLastScanCollectionOnly,
  updateDeckInstanceSettings, verifyDeckScan, undoVerifyDeckScan,
} from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardModal } from '../components/CardItem'
import { CompactCardArtwork } from '../components/UnifiedCard'
import DeckCardScanner from '../components/DeckCardScanner'
import { isDeckCardMissing, missingQuantity, selectVisibleDeckCards } from '../utils/deckChecklist'

export default function DeckDetail() {
  const { instanceId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useSettings()
  const confirmDialog = useConfirmDialog()
  const [filter, setFilter] = useState('missing')
  const [sortBy, setSortBy] = useState('missing_desc')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['deck-instance', instanceId],
    queryFn: () => getDeckInstance(instanceId),
  })

  // Live scanner's Path B name-preview (docs/plans/live-card-scanner.md,
  // Decision 8) — reuses this already-fetched list, no new fetch, no
  // network call from inside the scanner itself.
  const missingCards = useMemo(() => (
    (data?.cards || [])
      .filter(isDeckCardMissing)
      .map((dc) => ({ number: dc.card?.number, name: dc.card?.name }))
      .filter((c) => c.number && c.name)
  ), [data?.cards])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['deck-instance', instanceId] })
    queryClient.invalidateQueries({ queryKey: ['deck-instances'] })
  }

  const resetMutation = useMutation({
    mutationFn: () => resetDeckInstance(instanceId),
    onSuccess: () => {
      toast.success(t('decks.detail.resetDone'))
      invalidate()
    },
    onError: () => toast.error(t('decks.detail.resetFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteDeckInstance(instanceId),
    onSuccess: () => {
      toast.success(t('decks.detail.deleted'))
      queryClient.invalidateQueries({ queryKey: ['deck-instances'] })
      navigate('/decks')
    },
    onError: () => toast.error(t('decks.detail.deleteFailed')),
  })

  // docs/plans/scanner-ux-todos.md item 11 — a persistent per-deck toggle for
  // whether a scan adds to the general collection (default) or only
  // verifies/tracks deck progress, for re-scanning an already-built deck to
  // confirm its cards are still physically present without adding
  // duplicates every pass.
  const settingsMutation = useMutation({
    mutationFn: (addToCollectionValue) => updateDeckInstanceSettings(instanceId, { add_to_collection: addToCollectionValue }),
    onSuccess: () => invalidate(),
    onError: () => toast.error(t('decks.detail.settingsUpdateFailed')),
  })

  const handleReset = async () => {
    const confirmed = await confirmDialog({
      title: t('decks.detail.reset'),
      message: t('decks.detail.resetConfirm'),
      confirmLabel: t('decks.detail.reset'),
      destructive: false,
    })
    if (!confirmed) return
    resetMutation.mutate()
  }

  const handleDelete = async () => {
    const confirmed = await confirmDialog({
      title: t('decks.detail.remove'),
      message: t('decks.detail.removeConfirm'),
      confirmLabel: t('decks.detail.remove'),
      destructive: true,
    })
    if (!confirmed) return
    deleteMutation.mutate()
  }

  // { candidate, isAutoSave, traceId } — bundled into one object because
  // useMutation only forwards a single argument through to onSuccess.
  // isAutoSave decides which toast shows: a plain success toast for a
  // manual tap (unchanged), or the Undo-capable one below in its place
  // (not in addition to it) for an auto-save. Without this, every
  // auto-save would stack two toasts for one action — DeckCardScanner's
  // auto-save path and this onSuccess both fire on the exact same confirm.
  // traceId (only present when the user has scan diagnostics enabled) is
  // just carried through to the undo call below, for correlation.
  const scanMutation = useMutation({
    mutationFn: ({ candidate }) => (
      data.add_to_collection === false
        ? verifyDeckScan(Number(instanceId), candidate.id, 1)
        : addToCollection({ card_id: candidate.id, quantity: 1, deck_instance_id: Number(instanceId) })
    ),
    onSuccess: (response, { candidate, isAutoSave, traceId, hasLiveWarningOverlay }) => {
      invalidate()
      // deck_scan_status (see backend services/deck_progress.py's SCAN_*
      // constants) is only meaningful here — it's set by add_to_collection
      // exactly when this add targeted a deck instance. A card that's not
      // part of this deck's template, or one that's already at its
      // expected quantity, still lands in the general collection (hence no
      // early return before invalidate() above) but must not look like a
      // normal successful match — same plain toast either way was the bug
      // report this is fixing. Applies to both auto-saves and manual taps
      // from the ambiguous candidate list; no Undo button here (unlike the
      // isAutoSave branch below) since there is nothing meaningful to
      // reverse: register_scan never moved deck progress for this scan, so
      // the undo route would either 404 (not_in_deck) or wrongly decrement
      // an unrelated earlier scan (already_complete).
      const deckScanStatus = response.data.deck_scan_status
      if (deckScanStatus === 'not_in_deck' || deckScanStatus === 'already_complete') {
        // hasLiveWarningOverlay (set by DeckCardScanner.jsx's confirmCard)
        // is true for every path except its own camera-denied fallback —
        // the live scanner already floats its own warning banner over the
        // video for those, so showing this toast too would double up on
        // the exact same message. The fallback has no live video to float
        // one over, so this toast stays its only warning display there.
        if (!hasLiveWarningOverlay) {
          // e.g. "4/4 Pikachu already scanned" — deck_scan_quantity (the
          // deck's expected_quantity, see register_scan) is only ever set
          // alongside 'already_complete'; scanned_quantity always equals it
          // in that state, so one number covers both sides of the fraction.
          const warningText = deckScanStatus === 'already_complete'
            ? `${response.data.deck_scan_quantity}/${response.data.deck_scan_quantity} ${candidate.name} ${t('decks.scan.alreadyCompleteDetail')}`
            : `${candidate.name} ${t('decks.scan.notInDeckDetail')}`
          toast(() => (
            <span className="flex items-center gap-2">
              <AlertTriangle size={16} className="flex-shrink-0 text-yellow" />
              <span className="min-w-0 flex-1 text-yellow">{warningText}</span>
            </span>
          ), { duration: 7000, style: { border: '1px solid #eab308' } })
        }
        return
      }
      if (!isAutoSave) {
        toast.success(`${t('decks.scan.scanned')}: ${candidate.name}`)
        return
      }
      // response.data.card_id is add_to_collection's own resolved id for
      // this card — not candidate.id — since add_to_collection can
      // rewrite it (see api/collection.py). The undo route re-derives its
      // matching row from exactly this value, deterministically, so this
      // is the only thing that needs remembering per scan.
      const cardId = response.data.card_id
      // Guards against a double-tap firing two undo calls — lives in this
      // closure (one per toast() call), not inside the render function
      // below, since react-hot-toast keeps re-invoking that function
      // during the exit animation toast.dismiss() starts: the button stays
      // in the DOM (fading out) for that duration, not removed
      // synchronously, so dismissing alone doesn't stop a fast second tap.
      let undoRequested = false
      toast((toastInstance) => (
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate">{t('decks.scan.scanned')}: {candidate.name}</span>
          <button
            type="button"
            className="flex-shrink-0 font-semibold text-brand-red-light underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
            onClick={async () => {
              if (undoRequested) return
              undoRequested = true
              toast.dismiss(toastInstance.id)
              try {
                await (data.add_to_collection === false
                  ? undoVerifyDeckScan(instanceId, cardId, traceId)
                  : undoLastScan(instanceId, cardId, traceId))
                invalidate()
                toast.success(t('decks.scan.undone'))
              } catch {
                toast.error(t('decks.scan.undoFailed'))
              }
            }}
          >
            {t('decks.scan.undo')}
          </button>
        </span>
      ), { duration: 5000 })
    },
    onError: () => toast.error(t('decks.scan.addFailed')),
  })

  // Backs the "-" on a recent-scans thumbnail (DeckCardScanner.jsx's
  // decrementRecentScan). No success toast of its own: the thumbnail's
  // count dropping (or the thumbnail disappearing) is already the
  // confirmation. Routes to whichever backend call can safely reverse the
  // add: undo_scan (collection + deck progress together) for 'counted',
  // the collection-only route for 'not_in_deck'/'already_complete', which
  // undo_scan can't safely reverse (see its own docstring and
  // docs/plans/scanner-ux-todos.md item 5) — DeckCardScanner.jsx always
  // lets the user try to remove either way, so this is the one place that
  // has to pick the right route rather than gating the button on it.
  const decrementMutation = useMutation({
    mutationFn: ({ cardId, traceId, deckScanStatus }) => {
      // Verify-only mode never has a CollectionItem side to reverse — always
      // undo-verify regardless of deckScanStatus, unlike the collection-mode
      // branch below which depends on it.
      if (data.add_to_collection === false) return undoVerifyDeckScan(instanceId, cardId, traceId)
      return deckScanStatus === 'counted'
        ? undoLastScan(instanceId, cardId, traceId)
        : undoLastScanCollectionOnly(instanceId, cardId, traceId)
    },
    onSuccess: () => invalidate(),
    onError: () => toast.error(t('decks.scan.removeFailed')),
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-32 rounded" />
        <div className="skeleton h-28 rounded-2xl" />
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="card text-center py-12">
        <p className="text-brand-red">{t('decks.detail.loadFailed')}</p>
        <button onClick={() => navigate('/decks')} className="btn-ghost mt-4 mx-auto">
          <ArrowLeft size={16} /> {t('decks.title')}
        </button>
      </div>
    )
  }

  const progress = Math.min(100, Math.max(0, Number(data.progress) || 0))
  const hpClass = progress >= 66 ? 'healthy' : progress >= 33 ? 'medium' : 'low'
  const cards = data.cards || []
  const visibleCards = selectVisibleDeckCards(cards, filter, sortBy)
  // Tab counts are physical-card sums, matching the header's "X / 60" —
  // NOT the number of rows the tab lists (a 60-card deck is usually ~20
  // unique rows once energy stacks are counted once each). Missing and
  // Found still deliberately overlap as ROW FILTERS: a card needing 4
  // copies with 1 scanned appears in both lists (3 more needed, but you've
  // found one) — see utils/deckChecklist.js. The counts here are simply
  // physical-card totals, independent of that row overlap.
  const missingPhysicalCount = data.total_count - data.scanned_count
  const foundPhysicalCount = data.scanned_count

  return (
    <div className="space-y-4 pb-2">
      <button onClick={() => navigate('/decks')} className="btn-ghost text-sm py-1.5">
        <ArrowLeft size={14} /> {t('decks.title')}
      </button>

      <div className="card">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-text-primary truncate">{data.name}</h1>
            {data.is_complete && (
              <span className="badge badge-green mt-1 inline-block">{t('decks.complete')}</span>
            )}
          </div>
        </div>

        <div className="mt-3">
          <div className="mb-1 flex items-baseline gap-2 text-sm">
            <span className="text-text-secondary">
              {data.scanned_count} / {data.total_count} {t('decks.cardsFound')}
            </span>
            <span className={`shrink-0 whitespace-nowrap font-bold tabular-nums ${data.is_complete ? 'text-green' : 'text-brand-red'}`}>
              {progress}%
            </span>
          </div>
          <div className="hp-bar-track">
            <div className={`hp-bar-fill ${data.scanned_count > 0 ? hpClass : ''}`} style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 mt-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">{t('decks.detail.addToCollectionToggle')}</p>
            <p className="text-xs text-text-muted mt-0.5">{t('decks.detail.addToCollectionToggleHint')}</p>
          </div>
          <button
            type="button"
            onClick={() => settingsMutation.mutate(!(data.add_to_collection !== false))}
            aria-pressed={data.add_to_collection !== false}
            aria-label={t('decks.detail.addToCollectionToggle')}
            className={`relative w-11 h-6 flex-shrink-0 rounded-full transition-colors duration-200 ${
              data.add_to_collection !== false ? 'bg-brand-red' : 'bg-bg-elevated border border-border'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                data.add_to_collection !== false ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mt-4">
          <button onClick={() => setScannerOpen(true)} className="btn-primary text-sm py-2 px-3 flex-1 min-w-[140px]">
            <Camera size={15} /> {t('decks.detail.scan')}
          </button>
          <button onClick={handleReset} className="btn-ghost text-sm py-2 px-3">
            <RotateCcw size={14} /> {t('decks.detail.reset')}
          </button>
          <button onClick={handleDelete} className="btn-ghost text-sm py-2 px-3 text-brand-red">
            <Trash2 size={14} /> {t('decks.detail.remove')}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1 sm:w-auto">
          {[
            { key: 'missing', label: `${t('decks.detail.missing')} (${missingPhysicalCount})` },
            { key: 'found', label: `${t('decks.detail.found')} (${foundPhysicalCount})` },
            { key: 'all', label: `${t('decks.detail.all')} (${data.total_count})` },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
                filter === key
                  ? 'bg-brand-red/20 text-brand-red border border-brand-red/30'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="flex flex-shrink-0 items-center gap-2 text-xs text-text-muted">
          {t('decks.detail.sortBy')}
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="select text-sm py-1.5">
            <option value="missing_desc">{t('decks.detail.sortMissingDesc')}</option>
            <option value="alphabetical">{t('decks.detail.sortAlphabetical')}</option>
            <option value="number_asc">{t('decks.detail.sortNumberAsc')}</option>
          </select>
        </label>
      </div>

      {visibleCards.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-text-secondary">
            {filter === 'missing'
              ? t('decks.detail.nothingMissing')
              : filter === 'found'
                ? t('decks.detail.nothingFoundYet')
                : t('decks.detail.noCards')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleCards.map((deckCard) => {
            const missing = missingQuantity(deckCard)
            return (
              <button
                key={deckCard.card_id}
                onClick={() => setSelectedCard(deckCard.card)}
                className="flex w-full items-center gap-3 rounded-xl border border-[rgba(255,255,255,0.05)] bg-[rgba(20,20,40,0.6)] p-3 text-left backdrop-blur-xl transition-all duration-200 hover:border-brand-red/30 hover:bg-bg-elevated hover:shadow-glow active:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/70"
              >
                <CompactCardArtwork card={deckCard.card} image={resolveCardImageUrl(deckCard.card, 'small')} alt={deckCard.card?.name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{deckCard.card?.name}</p>
                  {deckCard.card?.number && (
                    <p className="font-mono text-xs text-text-muted">#{deckCard.card.number}</p>
                  )}
                </div>
                <p className={`flex-shrink-0 text-lg font-bold ${missing > 0 ? 'text-brand-red' : 'text-green'}`}>
                  {missing > 0
                    ? `${missing}/${deckCard.expected_quantity} ${t('decks.detail.missingCount')}`
                    : `${deckCard.scanned_quantity}/${deckCard.expected_quantity} ${t('decks.detail.foundLabel')}`}
                </p>
              </button>
            )
          })}
        </div>
      )}

      {selectedCard && (
        <CardModal
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
          defaultLang={selectedCard.lang || 'en'}
          initialTab="overview"
          readOnly
        />
      )}

      <DeckCardScanner
        isOpen={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onConfirm={(candidate, meta) => scanMutation.mutateAsync({ candidate, ...meta })}
        onDecrement={(cardId, traceId, deckScanStatus) => decrementMutation.mutateAsync({ cardId, traceId, deckScanStatus })}
        deckInstanceId={instanceId}
        missingCards={missingCards}
      />
    </div>
  )
}
