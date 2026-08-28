import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Camera, RotateCcw, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { getDeckInstance, resetDeckInstance, deleteDeckInstance, addToCollection } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardModal } from '../components/CardItem'
import { CompactCardArtwork } from '../components/UnifiedCard'
import DeckCardScanner from '../components/DeckCardScanner'
import { isDeckCardFound, isDeckCardMissing, missingQuantity, selectVisibleDeckCards } from '../utils/deckChecklist'

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

  const scanMutation = useMutation({
    mutationFn: (candidate) => addToCollection({ card_id: candidate.id, quantity: 1, deck_instance_id: Number(instanceId) }),
    onSuccess: (_response, candidate) => {
      toast.success(`${t('decks.scan.scanned')}: ${candidate.name}`)
      invalidate()
    },
    onError: () => toast.error(t('decks.scan.addFailed')),
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
  // Tab counts are card TYPES (rows), matching what's actually listed below —
  // distinct from the physical-card totals in the header above. Missing and
  // Found deliberately overlap rather than partition the deck: a card
  // needing 4 copies with 1 scanned is both still Missing (3 more needed)
  // and already Found (you have one) — see utils/deckChecklist.js.
  const missingTypeCount = cards.filter(isDeckCardMissing).length
  const foundTypeCount = cards.filter(isDeckCardFound).length

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
            { key: 'missing', label: `${t('decks.detail.missing')} (${missingTypeCount})` },
            { key: 'found', label: `${t('decks.detail.found')} (${foundTypeCount})` },
            { key: 'all', label: `${t('decks.detail.all')} (${cards.length})` },
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
                className="flex w-full items-center gap-3 rounded-xl border border-[rgba(255,255,255,0.05)] bg-[rgba(20,20,40,0.6)] p-3 text-left backdrop-blur-xl transition-all duration-200 hover:border-brand-red/30 hover:bg-bg-elevated hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/70"
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
                    : t('decks.detail.foundLabel')}
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
        onConfirm={(candidate) => scanMutation.mutateAsync(candidate)}
      />
    </div>
  )
}
