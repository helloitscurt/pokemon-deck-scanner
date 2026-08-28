import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Search, ExternalLink, Check, AlertTriangle, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { searchDecks, parseDeckPage, saveDeck, searchCards } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { countUnresolvedEntries, setEntryCard as setEntryCardPure, setEntryQuantity as setEntryQuantityPure } from '../utils/deckReview'

const STEP = { SEARCH: 'search', BLOCK: 'block', REVIEW: 'review' }

function ManualCardPicker({ initialQuery, onPick, onCancel, t }) {
  const [query, setQuery] = useState(initialQuery || '')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)

  const runSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const response = await searchCards({ name: query.trim(), page_size: 8 })
      setResults(response.data?.data || [])
    } catch {
      toast.error(t('decks.review.searchFailed'))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-bg-elevated p-3 space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }}
          placeholder={t('decks.review.searchPlaceholder')}
          className="input flex-1 text-sm py-1.5"
          autoFocus
        />
        <button onClick={runSearch} disabled={searching} className="btn-ghost text-sm py-1.5 px-3">
          {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
      </div>
      {results.length > 0 && (
        <div className="max-h-56 overflow-y-auto space-y-1">
          {results.map((card) => (
            <button
              key={card.id}
              onClick={() => onPick(card)}
              className="w-full flex items-center gap-2 rounded-lg p-1.5 text-left hover:bg-bg-card transition-colors"
            >
              <img src={resolveCardImageUrl(card, 'small')} alt={card.name} className="h-10 w-auto rounded flex-shrink-0" loading="lazy" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-text-primary truncate">{card.name}</p>
                <p className="text-[11px] text-text-muted truncate">{card.set_ref?.name} · #{card.number}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      <button onClick={onCancel} className="text-xs text-text-muted hover:text-text-primary">{t('common.cancel')}</button>
    </div>
  )
}

export default function AddDeck() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { t } = useSettings()

  const [step, setStep] = useState(STEP.SEARCH)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [parseResult, setParseResult] = useState(null)
  const [selectedBlockIndex, setSelectedBlockIndex] = useState(0)
  const [entries, setEntries] = useState([])
  const [editingIndex, setEditingIndex] = useState(null)

  const searchMutation = useMutation({
    mutationFn: searchDecks,
    onSuccess: (data) => setResults(data),
    onError: () => toast.error(t('decks.add.searchFailed')),
  })

  const parseMutation = useMutation({
    mutationFn: (page) => parseDeckPage(page.title),
    onSuccess: (data) => {
      setParseResult(data)
      if (data.blocks.length > 1) {
        setStep(STEP.BLOCK)
      } else {
        setSelectedBlockIndex(0)
        setEntries(data.blocks[0]?.entries || [])
        setStep(STEP.REVIEW)
      }
    },
    onError: () => toast.error(t('decks.add.parseFailed')),
  })

  const saveMutation = useMutation({
    mutationFn: saveDeck,
    onSuccess: (instance) => {
      toast.success(t('decks.add.saved'))
      queryClient.invalidateQueries({ queryKey: ['deck-instances'] })
      navigate(`/decks/${instance.id}`)
    },
    onError: () => toast.error(t('decks.add.saveFailed')),
  })

  const submitSearch = (e) => {
    e.preventDefault()
    if (query.trim().length < 2) return
    searchMutation.mutate(query.trim())
  }

  const pickBlock = (index) => {
    setSelectedBlockIndex(index)
    setEntries(parseResult.blocks[index].entries)
    setStep(STEP.REVIEW)
  }

  const setEntryCard = (index, card) => {
    setEntries((current) => setEntryCardPure(current, index, card))
    setEditingIndex(null)
  }

  const setEntryQuantity = (index, quantity) => {
    setEntries((current) => setEntryQuantityPure(current, index, quantity))
  }

  const unresolvedCount = countUnresolvedEntries(entries)
  const activeBlock = parseResult?.blocks?.[selectedBlockIndex]

  const handleSave = () => {
    if (unresolvedCount > 0 || entries.length === 0) return
    saveMutation.mutate({
      name: activeBlock?.name || parseResult?.title,
      source_url: activeBlock?.source_url,
      cards: entries.map((entry) => ({ card_id: entry.card_id, expected_quantity: entry.expected_quantity })),
    })
  }

  return (
    <div className="space-y-4 pb-2 max-w-2xl mx-auto">
      <button onClick={() => navigate('/decks')} className="btn-ghost text-sm py-1.5">
        <ArrowLeft size={14} /> {t('decks.title')}
      </button>

      <h1 className="text-xl font-bold text-text-primary">{t('decks.add.title')}</h1>

      {step === STEP.SEARCH && (
        <div className="card space-y-4">
          <p className="text-sm text-text-secondary">{t('decks.add.subtitle')}</p>
          <form onSubmit={submitSearch} className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('decks.add.searchPlaceholder')}
              className="input flex-1"
            />
            <button type="submit" disabled={searchMutation.isPending} className="btn-primary px-4">
              {searchMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
            </button>
          </form>

          {results.length > 0 && (
            <div className="space-y-2">
              {results.map((result) => (
                <div key={result.url} className="rounded-xl border border-border bg-bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{result.title}</p>
                      {result.snippet && (
                        <p className="text-xs text-text-muted mt-1 line-clamp-2">{result.snippet}</p>
                      )}
                    </div>
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-shrink-0 text-text-muted hover:text-text-primary"
                      title={t('decks.add.viewOnBulbapedia')}
                    >
                      <ExternalLink size={14} />
                    </a>
                  </div>
                  <button
                    onClick={() => parseMutation.mutate(result)}
                    disabled={parseMutation.isPending}
                    className="btn-ghost text-xs py-1.5 mt-2"
                  >
                    {parseMutation.isPending && parseMutation.variables?.title === result.title
                      ? <Loader2 size={12} className="animate-spin" />
                      : <Check size={12} />}
                    {t('decks.add.thisIsIt')}
                  </button>
                </div>
              ))}
            </div>
          )}

          {results.length === 0 && searchMutation.isSuccess && (
            <p className="text-sm text-text-muted text-center py-4">{t('decks.add.noResults')}</p>
          )}
        </div>
      )}

      {step === STEP.BLOCK && parseResult && (
        <div className="card space-y-3">
          <p className="text-sm text-text-secondary">{t('decks.add.pickBlock')}</p>
          {parseResult.blocks.map((block, index) => (
            <button
              key={block.source_url}
              onClick={() => pickBlock(index)}
              className="w-full text-left rounded-xl border border-border bg-bg-card p-3 hover:border-brand-red/40 transition-colors"
            >
              <p className="text-sm font-semibold text-text-primary">{block.name}</p>
              <p className="text-xs text-text-muted mt-0.5">
                {block.entries.length} {t('decks.add.uniqueCards')}
              </p>
            </button>
          ))}
        </div>
      )}

      {step === STEP.REVIEW && (
        <div className="space-y-3">
          <div className="card">
            <p className="text-sm font-semibold text-text-primary">{activeBlock?.name}</p>
            <p className="text-xs text-text-muted mt-1">
              {entries.length - unresolvedCount} / {entries.length} {t('decks.add.autoResolved')}
            </p>
            {unresolvedCount > 0 && (
              <div className="flex items-center gap-2 mt-2 text-xs text-brand-yellow">
                <AlertTriangle size={14} className="flex-shrink-0" />
                {t('decks.add.needsReview').replace('{count}', unresolvedCount)}
              </div>
            )}
          </div>

          <div className="space-y-2">
            {entries.map((entry, index) => (
              <div key={index} className="card p-3">
                <div className="flex items-center gap-3">
                  {entry.card ? (
                    <img
                      src={resolveCardImageUrl(entry.card, 'small')}
                      alt={entry.card.name}
                      className="h-14 w-auto rounded flex-shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-14 w-10 rounded bg-bg-elevated flex-shrink-0 flex items-center justify-center">
                      <AlertTriangle size={16} className="text-brand-yellow" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary truncate">
                      {entry.card?.name || entry.raw_name}
                    </p>
                    {entry.card ? (
                      <p className="text-xs text-text-muted truncate">
                        {entry.card.set_ref?.name} · #{entry.card.number}
                      </p>
                    ) : (
                      <p className="text-xs text-brand-yellow">{t('decks.add.notResolved')}</p>
                    )}
                    <button
                      onClick={() => setEditingIndex(editingIndex === index ? null : index)}
                      className="text-xs text-text-muted hover:text-text-primary underline mt-0.5"
                    >
                      {entry.card ? t('decks.add.changeCard') : t('decks.add.pickCard')}
                    </button>
                  </div>
                  <label className="flex-shrink-0 flex items-center gap-1.5 text-xs text-text-muted">
                    {t('decks.add.qty')}
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={entry.expected_quantity}
                      onChange={(e) => setEntryQuantity(index, e.target.value)}
                      className="input w-14 py-1 text-center text-sm"
                    />
                  </label>
                </div>
                {editingIndex === index && (
                  <ManualCardPicker
                    initialQuery={entry.raw_name}
                    onPick={(card) => setEntryCard(index, card)}
                    onCancel={() => setEditingIndex(null)}
                    t={t}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="sticky bottom-4 flex gap-2">
            <button onClick={() => setStep(STEP.SEARCH)} className="btn-ghost flex-1">
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={unresolvedCount > 0 || saveMutation.isPending}
              className="btn-primary flex-1"
            >
              {saveMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {t('decks.add.saveDeck')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
