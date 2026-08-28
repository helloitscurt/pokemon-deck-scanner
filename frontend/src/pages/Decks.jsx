import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Plus, Layers } from 'lucide-react'
import { getDeckInstances } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'

export default function Decks() {
  const navigate = useNavigate()
  const { t } = useSettings()

  const { data: instances = [], isLoading } = useQuery({
    queryKey: ['deck-instances'],
    queryFn: getDeckInstances,
  })

  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary">{t('decks.title')}</h1>
          <p className="text-sm text-text-secondary mt-1">{t('decks.subtitle')}</p>
        </div>
        <button onClick={() => navigate('/decks/add')} className="btn-primary text-sm py-2 px-3 flex-shrink-0">
          <Plus size={16} /> {t('decks.addDeck')}
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}
        </div>
      ) : instances.length === 0 ? (
        <div className="card text-center py-12 space-y-3">
          <Layers size={32} className="mx-auto text-text-muted" />
          <p className="text-text-secondary">{t('decks.empty')}</p>
          <button onClick={() => navigate('/decks/add')} className="btn-primary mx-auto text-sm">
            <Plus size={16} /> {t('decks.addDeck')}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {instances.map((instance) => {
            const progress = Math.min(100, Math.max(0, Number(instance.progress) || 0))
            const hpClass = progress >= 66 ? 'healthy' : progress >= 33 ? 'medium' : 'low'
            return (
              <button
                key={instance.id}
                onClick={() => navigate(`/decks/${instance.id}`)}
                className="w-full card text-left hover:border-brand-red/40 transition-colors"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="font-bold text-text-primary truncate">{instance.name}</p>
                  {instance.is_complete && (
                    <span className="badge badge-green flex-shrink-0">{t('decks.complete')}</span>
                  )}
                </div>
                <div className="flex items-baseline gap-2 text-sm mb-2">
                  <span className="text-text-secondary">
                    {instance.scanned_count} / {instance.total_count} {t('decks.cardsFound')}
                  </span>
                  <span className={`shrink-0 whitespace-nowrap font-bold tabular-nums ${instance.is_complete ? 'text-green' : 'text-brand-red'}`}>
                    {progress}%
                  </span>
                </div>
                <div className="hp-bar-track">
                  <div className={`hp-bar-fill ${instance.scanned_count > 0 ? hpClass : ''}`} style={{ width: `${progress}%` }} />
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
