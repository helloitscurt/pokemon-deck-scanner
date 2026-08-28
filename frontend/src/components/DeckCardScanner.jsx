import { useRef, useState } from 'react'
import { Camera, Check, Loader2 } from 'lucide-react'
import Modal from './ui/Modal'
import { recognizeCard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'

/**
 * DeckCardScanner — single-photo point-and-capture scan, for deck-completion
 * mode specifically. Deliberately not a reuse of UnifiedCardScanner: that
 * component is built around staging a multi-photo batch, enqueueing an async
 * job, and reviewing results later on a separate page (ScanQueue/ScanReview) —
 * a good fit for "scan a pile of cards and sort them out afterward", but not
 * for "scan this one card, get immediate feedback, scan the next" against a
 * specific deck's checklist. This uses the synchronous single-image
 * /api/cards/recognize endpoint directly instead.
 *
 * Props: isOpen, onClose, onConfirm(candidateCard) — the caller decides what
 * "confirm" means (here: addToCollection with deck_instance_id set).
 */
export default function DeckCardScanner({ isOpen, onClose, onConfirm }) {
  const { t } = useSettings()
  const cameraRef = useRef()
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const reset = () => {
    setResult(null)
    setError(null)
  }

  const handleFile = async (file) => {
    if (!file) return
    reset()
    setScanning(true)
    try {
      const data = await recognizeCard(file)
      setResult(data)
    } catch (err) {
      setError(err?.response?.data?.detail || t('decks.scan.failed'))
    } finally {
      setScanning(false)
    }
  }

  const handleClose = () => {
    reset()
    onClose?.()
  }

  const confirmCard = (candidate) => {
    onConfirm(candidate)
    reset()
  }

  const matches = (result?.matches || []).slice(0, 6)

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={t('decks.scan.title')} size="lg">
      <div className="space-y-4 p-4 sm:p-5">
        <input
          ref={cameraRef}
          type="file"
          accept={SCANNER_IMAGE_ACCEPT}
          capture="environment"
          className="hidden"
          onChange={(event) => {
            handleFile(event.target.files?.[0])
            event.target.value = ''
          }}
        />

        {!result && !scanning && !error && (
          <>
            <p className="text-sm text-text-secondary text-center">{t('decks.scan.subtitle')}</p>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              className="btn-primary w-full flex items-center justify-center gap-2 py-4"
            >
              <Camera size={18} /> {t('decks.scan.takePhoto')}
            </button>
          </>
        )}

        {scanning && (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <Loader2 size={28} className="animate-spin text-brand-red" />
            <p className="text-sm text-text-secondary">{t('decks.scan.identifying')}</p>
          </div>
        )}

        {error && !scanning && (
          <div className="card border-brand-red/30 bg-brand-red/5 text-center py-4">
            <p className="text-sm text-brand-red">{error}</p>
            <button onClick={reset} className="btn-ghost mt-3 mx-auto text-sm">{t('decks.scan.tryAgain')}</button>
          </div>
        )}

        {result && !scanning && (
          <div className="space-y-3">
            {matches.length === 0 && (
              <div className="text-center py-6 space-y-3">
                <p className="text-sm text-text-secondary">{t('decks.scan.noMatch')}</p>
                <button onClick={reset} className="btn-ghost mx-auto text-sm">{t('decks.scan.tryAgain')}</button>
              </div>
            )}
            {matches.map((candidate, i) => (
              <button
                key={candidate.id || i}
                type="button"
                onClick={() => confirmCard(candidate)}
                className="w-full flex items-center gap-3 rounded-xl border border-border bg-bg-card p-3 text-left hover:border-brand-red/40 hover:bg-brand-red/10 transition-colors"
              >
                <img
                  src={resolveCardImageUrl(candidate, 'small')}
                  alt={candidate.name}
                  className="h-16 w-auto rounded-md flex-shrink-0"
                  loading="lazy"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-text-primary truncate">{candidate.name}</p>
                  <p className="text-xs text-text-muted truncate">
                    {candidate.set?.name}{candidate.number ? ` · #${candidate.number}` : ''}
                  </p>
                  {i === 0 && result._identity_confident && (
                    <span className="badge badge-green mt-1 inline-block">{t('decks.scan.bestMatch')}</span>
                  )}
                </div>
                <Check size={18} className="flex-shrink-0 text-text-muted" />
              </button>
            ))}
            {matches.length > 0 && (
              <button onClick={reset} className="btn-ghost w-full text-sm">{t('decks.scan.scanAnother')}</button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
