import { useEffect, useRef, useState, type CSSProperties } from 'react'

interface MediaDeviceOption {
  deviceId: string
  label: string
}

interface DeviceSelectorProps {
  onDevicesSelected: (audioId: string, videoId: string) => void
  /** If true, shows a compact inline version (for settings panels). */
  compact?: boolean
  isDark?: boolean
  /** Pre-selected device IDs. */
  initialAudioId?: string
  initialVideoId?: string
}

export default function DeviceSelector({
  onDevicesSelected,
  compact = false,
  isDark = false,
  initialAudioId = '',
  initialVideoId = '',
}: DeviceSelectorProps) {
  const [audioDevices, setAudioDevices] = useState<MediaDeviceOption[]>([])
  const [videoDevices, setVideoDevices] = useState<MediaDeviceOption[]>([])
  const [selectedAudio, setSelectedAudio] = useState(initialAudioId)
  const [selectedVideo, setSelectedVideo] = useState(initialVideoId)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [audioLevel, setAudioLevel] = useState(0)
  const [error, setError] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number>(0)

  // Enumerate devices — needs at least one getUserMedia call first for labels.
  const enumerate = async () => {
    try {
      // Request temporary access to get device labels.
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      tempStream.getTracks().forEach(t => t.stop())

      const devices = await navigator.mediaDevices.enumerateDevices()
      const audio = devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
      const video = devices
        .filter(d => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))

      setAudioDevices(audio)
      setVideoDevices(video)

      // Auto-select first device if none selected.
      if (!selectedAudio && audio.length) setSelectedAudio(audio[0].deviceId)
      if (!selectedVideo && video.length) setSelectedVideo(video[0].deviceId)
      setError('')
    } catch {
      setError('Could not access camera/microphone. Please allow permission.')
    }
  }

  useEffect(() => {
    enumerate()
    // Listen for device changes (e.g. plugging in a webcam).
    navigator.mediaDevices.addEventListener('devicechange', enumerate)
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerate)
  }, [])

  // Start preview whenever selected devices change.
  useEffect(() => {
    if (!selectedAudio && !selectedVideo) return

    let cancelled = false
    const startPreview = async () => {
      // Stop previous preview.
      previewStream?.getTracks().forEach(t => t.stop())

      try {
        const constraints: MediaStreamConstraints = {
          audio: selectedAudio ? { deviceId: { exact: selectedAudio } } : true,
          video: selectedVideo
            ? { deviceId: { exact: selectedVideo }, width: { ideal: 320 }, height: { ideal: 240 } }
            : true,
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }

        setPreviewStream(stream)
        if (videoRef.current) videoRef.current.srcObject = stream

        // Set up audio level meter.
        if (audioCtxRef.current) audioCtxRef.current.close()
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        source.connect(analyser)
        analyserRef.current = analyser

        // Notify parent of selected devices.
        onDevicesSelected(selectedAudio, selectedVideo)
      } catch {
        if (!cancelled) setError('Failed to start preview with selected devices.')
      }
    }

    startPreview()
    return () => { cancelled = true }
  }, [selectedAudio, selectedVideo])

  // Audio level animation.
  useEffect(() => {
    const tick = () => {
      if (analyserRef.current) {
        const data = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        setAudioLevel(avg / 255)
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [previewStream])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      previewStream?.getTracks().forEach(t => t.stop())
      audioCtxRef.current?.close()
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  const selectStyle: CSSProperties = {
    width: '100%',
    padding: '6px 10px',
    fontSize: 13,
    borderRadius: 6,
    border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
    background: isDark ? '#1e293b' : '#fff',
    color: isDark ? '#f1f5f9' : '#111827',
    outline: 'none',
    cursor: 'pointer',
  }

  const labelStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: isDark ? '#94a3b8' : '#6b7280',
    marginBottom: 4,
    display: 'block',
  }

  return (
    <div style={{
      padding: compact ? 12 : 16,
      background: isDark ? '#1e293b' : '#f9fafb',
      borderRadius: 8,
      border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
    }}>
      {error && (
        <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>
      )}

      {/* Video preview */}
      <div style={{
        position: 'relative',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#000',
        marginBottom: 12,
        maxWidth: compact ? 200 : 280,
        margin: '0 auto 12px',
        aspectRatio: '4/3',
      }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
        />
      </div>

      {/* Camera select */}
      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Camera</label>
        <select
          value={selectedVideo}
          onChange={e => setSelectedVideo(e.target.value)}
          style={selectStyle}
        >
          {videoDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Microphone select */}
      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Microphone</label>
        <select
          value={selectedAudio}
          onChange={e => setSelectedAudio(e.target.value)}
          style={selectStyle}
        >
          {audioDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Audio level meter */}
      <div style={{ marginBottom: 4 }}>
        <label style={labelStyle}>Mic Level</label>
        <div style={{
          height: 6,
          borderRadius: 3,
          background: isDark ? '#334155' : '#e5e7eb',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(audioLevel * 100 * 2, 100)}%`,
            background: audioLevel > 0.05 ? '#22c55e' : '#94a3b8',
            borderRadius: 3,
            transition: 'width 0.1s',
          }} />
        </div>
      </div>
    </div>
  )
}
