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
  const streamRef = useRef(null)
  const [status, setStatus] = useState('idle')

  // A callback ref (with a `.current` property hung off the function itself,
  // so existing `videoRef.current` reads elsewhere keep working), not a plain
  // useRef: the <video> element unmounts and remounts as a fresh DOM node
  // whenever DeckCardScanner's phase leaves and re-enters the block that
  // renders it (e.g. through 'ambiguous', which has no <video> of its own).
  // A plain ref only gets srcObject assigned once, when getUserMedia first
  // resolves — the new node after a remount never gets it, and the video
  // shows as black until the whole scanner is closed and reopened. Running
  // on every mount fixes that regardless of which phase transition caused it.
  const videoRef = useCallback((node) => {
    videoRef.current = node
    if (node && streamRef.current) node.srcObject = streamRef.current
  }, [])

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
