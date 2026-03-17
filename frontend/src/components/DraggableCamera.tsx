import { useRef, useState, useEffect, type CSSProperties } from 'react'
import DeviceSelector from './DeviceSelector'

// Google Meet–style SVG icons
const MicOn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
  </svg>
)
const MicOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
  </svg>
)
const CamOn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
  </svg>
)
const CamOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>
  </svg>
)

interface DraggableCameraProps {
  stream: MediaStream | null
  muted?: boolean
  onToggleAudio?: () => void
  onToggleVideo?: () => void
  audioEnabled?: boolean
  videoEnabled?: boolean
  onSwitchDevices?: (audioId: string, videoId: string) => void
}

export default function DraggableCamera({
  stream, muted = true, onToggleAudio, onToggleVideo,
  audioEnabled = true, videoEnabled = true, onSwitchDevices,
}: DraggableCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 20, y: 20 }) // bottom-right offset
  const [dragging, setDragging] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [showDeviceSettings, setShowDeviceSettings] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 })

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
    }
  }, [stream])

  // ── Drag handlers ─────────────────────────────────────────────────────

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, posX: pos.x, posY: pos.y }
  }

  useEffect(() => {
    if (!dragging) return

    const onMouseMove = (e: MouseEvent) => {
      const dx = dragStart.current.x - e.clientX
      const dy = dragStart.current.y - e.clientY
      setPos({
        x: Math.max(0, dragStart.current.posX + dx),
        y: Math.max(0, dragStart.current.posY + dy),
      })
    }

    const onMouseUp = () => setDragging(false)

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragging])

  // ── Touch drag handlers ───────────────────────────────────────────────

  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0]
    setDragging(true)
    dragStart.current = { x: touch.clientX, y: touch.clientY, posX: pos.x, posY: pos.y }
  }

  useEffect(() => {
    if (!dragging) return

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0]
      const dx = dragStart.current.x - touch.clientX
      const dy = dragStart.current.y - touch.clientY
      setPos({
        x: Math.max(0, dragStart.current.posX + dx),
        y: Math.max(0, dragStart.current.posY + dy),
      })
    }

    const onTouchEnd = () => setDragging(false)

    window.addEventListener('touchmove', onTouchMove)
    window.addEventListener('touchend', onTouchEnd)
    return () => {
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [dragging])

  const containerStyle: CSSProperties = {
    position: 'fixed',
    right: pos.x,
    bottom: pos.y,
    zIndex: 9999,
    borderRadius: 12,
    // overflow must NOT be hidden — the device-settings popup renders above
    // the container via position:absolute + bottom:100%.
    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    border: '2px solid rgba(255,255,255,0.2)',
    cursor: dragging ? 'grabbing' : 'grab',
    userSelect: 'none',
    transition: dragging ? 'none' : 'width 0.2s, height 0.2s',
    width: minimized ? 60 : 200,
    height: minimized ? 60 : 150,
    background: '#000',
  }

  const btnStyle: CSSProperties = {
    background: 'rgba(0,0,0,0.6)',
    border: 'none',
    color: '#fff',
    width: 28,
    height: 28,
    borderRadius: '50%',
    cursor: 'pointer',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  return (
    <div ref={containerRef} style={containerStyle} onMouseDown={onMouseDown} onTouchStart={onTouchStart}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: minimized ? 'none' : 'block',
          transform: 'scaleX(-1)',
          borderRadius: 12,
        }}
      />

      {minimized && (
        <div style={{
          width: '100%', height: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 24,
        }}>
          {videoEnabled ? <CamOn /> : <CamOff />}
        </div>
      )}

      {/* Controls overlay */}
      <div style={{
        position: 'absolute',
        bottom: 4,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        gap: 4,
      }}
        onMouseDown={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
      >
        {!minimized && (
          <>
            {onToggleAudio && (
              <button
                style={{ ...btnStyle, background: audioEnabled ? 'rgba(0,0,0,0.6)' : '#dc2626' }}
                onClick={onToggleAudio}
                title={audioEnabled ? 'Mute' : 'Unmute'}
              >
                {audioEnabled ? <MicOn /> : <MicOff />}
              </button>
            )}
            {onToggleVideo && (
              <button
                style={{ ...btnStyle, background: videoEnabled ? 'rgba(0,0,0,0.6)' : '#dc2626' }}
                onClick={onToggleVideo}
                title={videoEnabled ? 'Camera off' : 'Camera on'}
              >
                {videoEnabled ? <CamOn /> : <CamOff />}
              </button>
            )}
          </>
        )}
        {onSwitchDevices && !minimized && (
          <button
            style={btnStyle}
            onClick={() => setShowDeviceSettings(!showDeviceSettings)}
            title="Device settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          </button>
        )}
        <button
          style={btnStyle}
          onClick={() => setMinimized(!minimized)}
          title={minimized ? 'Expand' : 'Minimize'}
        >
          {minimized ? '\u2197' : '\u2199'}
        </button>
      </div>

      {/* Device settings popup */}
      {showDeviceSettings && onSwitchDevices && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 8,
            width: 300,
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          }}
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
        >
          <DeviceSelector
            compact
            onDevicesSelected={(audioId, videoId) => {
              onSwitchDevices(audioId, videoId)
            }}
          />
          <button
            onClick={() => setShowDeviceSettings(false)}
            style={{
              width: '100%',
              padding: '8px',
              background: '#1e293b',
              color: '#94a3b8',
              border: 'none',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  )
}
