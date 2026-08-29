import { useCallback, useEffect, useRef, useState } from 'react'

// Lifecycle for a live back-camera video stream. Declarative: the stream
// starts/stops itself as `active` toggles, and is always released on
// unmount — nothing else needs to remember to call stop().
//
// status is one of 'idle' | 'starting' | 'streaming' | 'denied' | 'unavailable'.
// 'denied' covers both a real permission refusal and any other
// getUserMedia failure (no camera, already in use, etc.) — none of them
// are recoverable without the user changing something outside this
// component, so DeckCardScanner falls back to the same manual-capture UI
// for all of them rather than trying to distinguish the reason.
//
// Returns { videoRef, status, stop } — attach videoRef to a
// <video autoPlay playsInline muted> element.
export function useCameraStream({ active = true } = {}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [status, setStatus] = useState('idle')

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setStatus('idle')
  }, [])

  useEffect(() => {
    if (!active) {
      stop()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable')
      return
    }

    let cancelled = false
    setStatus('starting')

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        if (cancelled) {
          // The effect was torn down (unmount, or active flipped false)
          // while the permission prompt/stream setup was still pending —
          // don't leave a live camera stream nothing will ever stop.
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setStatus('streaming')
      })
      .catch(() => {
        if (!cancelled) setStatus('denied')
      })

    return () => {
      cancelled = true
      stop()
    }
  }, [active, stop])

  return { videoRef, status, stop }
}
