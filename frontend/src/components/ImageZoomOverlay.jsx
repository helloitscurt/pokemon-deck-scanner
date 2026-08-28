import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'

/**
 * Full-screen (near-full-screen) view of a single image — click the
 * backdrop, the X, or press Escape to close. Deliberately simple: no
 * pan/pinch/scroll-zoom, just a much bigger view of the card than the
 * detail dialog's own thumbnail gives you.
 */
export default function ImageZoomOverlay({ src, alt = '', onClose }) {
  const { t } = useSettings()

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose?.()
      }
    }
    // Capture phase: fires before UnifiedCardDialog's own Escape listener,
    // so stopPropagation here closes only this overlay, not the card dialog
    // underneath it too — the two are separate document listeners since this
    // overlay is a sibling portal, not a descendant, of that dialog.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-3 top-3 z-10 grid h-10 w-10 place-items-center rounded-full border border-white/15 bg-black/75 text-white shadow-lg transition-colors hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red"
        aria-label={t('common.close')}
      >
        <X size={20} aria-hidden />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[92vh] max-w-[92vw] object-contain"
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  )
}
