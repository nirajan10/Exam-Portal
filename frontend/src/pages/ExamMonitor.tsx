import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useParams, Link, Navigate } from 'react-router-dom'
import { getExam, Exam } from '../api/client'
import { useTheme } from '../contexts/ThemeContext'
import { useWebRTC, type RemoteStream } from '../hooks/useWebRTC'
import ChatPanel from '../components/ChatPanel'
import DeviceSelector from '../components/DeviceSelector'

// Google Meet–style SVG icons
const MicOn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
    <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
    <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
  </svg>
)
const MicOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
    <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
  </svg>
)
const CamOn = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
  </svg>
)
const CamOff = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
    <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>
  </svg>
)

// ── Remote video tile ────────────────────────────────────────────────────────

interface VideoTileProps {
  rs: RemoteStream
  isDark: boolean
  isMuted: boolean
  onToggleMute?: (id: string) => void
  onKick?: (id: string) => void
}

function VideoTile({ rs, isDark, isMuted, onToggleMute, onKick }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [showActions, setShowActions] = useState(false)

  // Video element is ALWAYS muted — it only renders the picture.
  // Audio is handled by a separate hidden <audio> element so the browser's
  // echo cancellation can properly track what is being played.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = rs.stream
    video.play().catch(() => {})
  }, [rs.stream, rs.rev])

  // Manage a separate <audio> element for this tile's audio.
  useEffect(() => {
    let el = audioRef.current
    if (!el) {
      el = document.createElement('audio')
      el.autoplay = true
      el.style.display = 'none'
      document.body.appendChild(el)
      audioRef.current = el
    }
    el.srcObject = rs.stream
    el.muted = isMuted
    el.play().catch(() => {})
    return undefined
  }, [rs.stream, rs.rev, isMuted])

  // React to mute changes instantly.
  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = isMuted
  }, [isMuted])

  // Cleanup audio element on unmount.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.srcObject = null
        audioRef.current.remove()
        audioRef.current = null
      }
    }
  }, [])

  const actionBtn: CSSProperties = {
    padding: '4px 10px',
    border: 'none',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  }

  return (
    <div
      style={{
        position: 'relative',
        background: '#000',
        borderRadius: 8,
        overflow: 'hidden',
        aspectRatio: '4/3',
        border: isMuted
          ? '2px solid #f59e0b'
          : `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {/* Muted badge */}
      {isMuted && (
        <div style={{
          position: 'absolute',
          top: 6,
          left: 6,
          background: '#f59e0b',
          color: '#fff',
          padding: '2px 6px',
          borderRadius: 4,
          fontSize: 10,
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          gap: 3,
          zIndex: 2,
        }}>
          <MicOff /> MUTED
        </div>
      )}
      {/* Name bar */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '4px 8px',
        background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        zIndex: 2,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: '#22c55e',
          display: 'inline-block',
        }} />
        {rs.name}
      </div>
      {/* Mute / Kick overlay on hover */}
      {showActions && rs.role === 'student' && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          padding: 6,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 4,
          background: 'linear-gradient(rgba(0,0,0,0.5), transparent)',
          zIndex: 3,
        }}>
          {onToggleMute && (
            <button
              style={{
                ...actionBtn,
                background: isMuted ? '#22c55e' : '#f59e0b',
                color: '#fff',
              }}
              onClick={(e) => { e.stopPropagation(); onToggleMute(rs.participantId) }}
              title={isMuted ? 'Unmute this student' : "Mute this student's audio"}
            >
              {isMuted ? <><MicOn /> Unmute</> : <><MicOff /> Mute</>}
            </button>
          )}
          {onKick && (
            <button
              style={{ ...actionBtn, background: '#dc2626', color: '#fff' }}
              onClick={(e) => {
                e.stopPropagation()
                if (window.confirm(`Kick "${rs.name}" from the exam? Their current answers will be auto-submitted.`)) {
                  onKick(rs.participantId)
                }
              }}
              title="Kick this student (auto-submits their exam)"
            >
              Kick
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export default function ExamMonitor() {
  const { id } = useParams<{ id: string }>()
  const { isDark } = useTheme()
  const [exam, setExam] = useState<Exam | null>(null)
  const [error, setError] = useState('')
  const [showChat, setShowChat] = useState(true)
  const [teacherName, setTeacherName] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const [viewAll, setViewAll] = useState(false)
  const PAGE_SIZE = 12

  // Audio/video toggle for teacher's own stream.
  const [audioOn, setAudioOn] = useState(false)
  const [videoOn, setVideoOn] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [audioDeviceId, setAudioDeviceId] = useState('')
  const [videoDeviceId, setVideoDeviceId] = useState('')

  const localVideoRef = useRef<HTMLVideoElement>(null)

  // Students the teacher has muted. Empty by default (all audible).
  const [mutedStudents, setMutedStudents] = useState<Set<string>>(new Set())

  // Load exam info.
  useEffect(() => {
    if (!id) return
    getExam(Number(id)).then(e => {
      setExam(e)
      // Teacher name from cached localStorage.
      try {
        const t = JSON.parse(localStorage.getItem('exam_teacher_info') ?? '{}')
        setTeacherName(t.name || 'Teacher')
      } catch { setTeacherName('Teacher') }
    }).catch(() => setError('Failed to load exam.'))
  }, [id])

  const {
    localStream, remoteStreams, participants, chatMessages,
    connected, myId, connect, disconnect, sendChat,
    sendKickStudent,
    toggleAudio, toggleVideo, switchDevices,
  } = useWebRTC({
    roomId: `exam-${id}`,
    name: teacherName || 'Teacher',
    role: 'teacher',
    enableVideo: true,
    enableAudio: true,
    audioDeviceId,
    videoDeviceId,
  })

  // Mute is teacher-local — mutes/unmutes the audio element for the tile.
  const handleToggleMute = (participantId: string) => {
    setMutedStudents(prev => {
      const next = new Set(prev)
      if (next.has(participantId)) {
        next.delete(participantId)
      } else {
        next.add(participantId)
      }
      return next
    })
  }

  // Connect when teacher name is ready.
  // Use a ref to track connection state and avoid rapid reconnections.
  const didConnect = useRef(false)
  useEffect(() => {
    if (teacherName && id && !didConnect.current) {
      didConnect.current = true
      connect()
    }
    return () => {
      if (didConnect.current) {
        didConnect.current = false
        disconnect()
      }
    }
  }, [teacherName, id, connect, disconnect])

  // Set local video.
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
    }
  }, [localStream])

  const handleToggleAudio = () => {
    toggleAudio()
    setAudioOn(prev => !prev)
  }

  const handleToggleVideo = () => {
    toggleVideo()
    setVideoOn(prev => !prev)
  }

  // Redirect if exam is not active.
  if (exam && !exam.is_active) {
    return <Navigate to={`/exams/${id}`} replace />
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#dc2626' }}>
        {error}
        <br />
        <Link to={`/exams/${id}`} style={{ color: '#1a73e8', marginTop: 12, display: 'inline-block' }}>
          Back to Exam
        </Link>
      </div>
    )
  }

  const studentStreams = remoteStreams.filter(r => r.role === 'student')
  const studentCount = participants.filter(p => p.role === 'student').length

  // Pagination
  const totalPages = Math.max(1, Math.ceil(studentStreams.length / PAGE_SIZE))
  // Clamp page if students disconnect and page is now out of range.
  const safePage = Math.min(currentPage, totalPages - 1)
  // Use effect to avoid setState during render.
  useEffect(() => {
    if (safePage !== currentPage) setCurrentPage(safePage)
  }, [safePage, currentPage])
  const visibleStreams = viewAll
    ? studentStreams
    : studentStreams.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  const showPagination = studentStreams.length > PAGE_SIZE

  // Grid column count adapts to visible tile count.
  const tileCount = visibleStreams.length
  const gridCols = tileCount <= 1 ? 1
    : tileCount <= 4 ? 2
    : tileCount <= 9 ? 3
    : tileCount <= 16 ? 4
    : 5

  const container: CSSProperties = {
    display: 'flex',
    height: '100vh',
    background: isDark ? '#0f172a' : '#f9fafb',
    overflow: 'hidden',
  }

  const main: CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }

  const topBar: CSSProperties = {
    padding: '10px 20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
    background: isDark ? '#1e293b' : '#fff',
    flexShrink: 0,
  }

  const btnStyle: CSSProperties = {
    padding: '6px 14px',
    border: 'none',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  }

  return (
    <div style={container}>
      <div style={main}>
        {/* Top bar */}
        <div style={topBar}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link
              to={`/exams/${id}`}
              style={{ color: isDark ? '#94a3b8' : '#6b7280', textDecoration: 'none', fontSize: 13 }}
            >
              &larr; Back
            </Link>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827' }}>
              {exam?.title || 'Exam'} — Live Monitor
            </h3>
            <span style={{
              background: connected ? '#dcfce7' : '#fee2e2',
              color: connected ? '#15803d' : '#dc2626',
              padding: '2px 8px',
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 600,
            }}>
              {connected ? `${studentCount} student${studentCount !== 1 ? 's' : ''}` : 'Disconnected'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Teacher's own camera preview */}
            <div style={{
              width: 80, height: 60, borderRadius: 6, overflow: 'hidden',
              background: '#000', border: '2px solid #1a73e8',
            }}>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
              />
            </div>

            <button
              onClick={handleToggleAudio}
              style={{
                ...btnStyle,
                background: audioOn ? (isDark ? '#334155' : '#f3f4f6') : '#dc2626',
                color: audioOn ? (isDark ? '#f1f5f9' : '#374151') : '#fff',
              }}
              title={audioOn ? 'Mute mic' : 'Unmute mic'}
            >
              {audioOn ? <><MicOn /> Mic</> : <><MicOff /> Mic Off</>}
            </button>

            <button
              onClick={handleToggleVideo}
              style={{
                ...btnStyle,
                background: videoOn ? (isDark ? '#334155' : '#f3f4f6') : '#dc2626',
                color: videoOn ? (isDark ? '#f1f5f9' : '#374151') : '#fff',
              }}
              title={videoOn ? 'Camera off' : 'Camera on'}
            >
              {videoOn ? <><CamOn /> Cam</> : <><CamOff /> Cam Off</>}
            </button>

            <button
              onClick={() => setShowChat(!showChat)}
              style={{
                ...btnStyle,
                background: showChat ? '#1a73e8' : (isDark ? '#334155' : '#f3f4f6'),
                color: showChat ? '#fff' : (isDark ? '#f1f5f9' : '#374151'),
              }}
            >
              {showChat ? 'Hide Chat' : 'Show Chat'}
            </button>

            <button
              onClick={() => setShowSettings(!showSettings)}
              style={{
                ...btnStyle,
                background: showSettings ? '#1a73e8' : (isDark ? '#334155' : '#f3f4f6'),
                color: showSettings ? '#fff' : (isDark ? '#f1f5f9' : '#374151'),
                fontSize: 16,
                padding: '4px 10px',
              }}
              title="Device Settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ verticalAlign: 'middle' }}>
                <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Device settings panel */}
        {showSettings && (
          <div style={{
            padding: 16,
            borderBottom: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
            background: isDark ? '#1e293b' : '#fff',
          }}>
            <div style={{ maxWidth: 360, margin: '0 auto' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: isDark ? '#f1f5f9' : '#111827', marginBottom: 12 }}>
                Device Settings
              </div>
              <DeviceSelector
                compact
                isDark={isDark}
                initialAudioId={audioDeviceId}
                initialVideoId={videoDeviceId}
                onDevicesSelected={(audioId, videoId) => {
                  setAudioDeviceId(audioId)
                  setVideoDeviceId(videoId)
                  if (connected) switchDevices(audioId, videoId)
                }}
              />
            </div>
          </div>
        )}

        {/* Video grid */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: 16,
        }}>
          {studentStreams.length === 0 ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: isDark ? '#64748b' : '#9ca3af',
              fontSize: 16,
            }}>
              Waiting for students to join with camera...
            </div>
          ) : (
            <>
              {showPagination && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  marginBottom: 12,
                }}>
                  <button
                    onClick={() => setViewAll(!viewAll)}
                    style={{
                      ...btnStyle,
                      background: viewAll ? '#1a73e8' : (isDark ? '#334155' : '#f3f4f6'),
                      color: viewAll ? '#fff' : (isDark ? '#f1f5f9' : '#374151'),
                    }}
                  >
                    {viewAll ? 'Paginate' : 'View All'}
                  </button>
                  {!viewAll && (
                    <>
                      <button
                        onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                        disabled={safePage === 0}
                        style={{
                          ...btnStyle,
                          background: isDark ? '#334155' : '#f3f4f6',
                          color: isDark ? '#f1f5f9' : '#374151',
                          opacity: safePage === 0 ? 0.4 : 1,
                          cursor: safePage === 0 ? 'default' : 'pointer',
                        }}
                      >
                        &larr; Prev
                      </button>
                      <span style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: isDark ? '#94a3b8' : '#6b7280',
                      }}>
                        Page {safePage + 1} of {totalPages}
                      </span>
                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={safePage >= totalPages - 1}
                        style={{
                          ...btnStyle,
                          background: isDark ? '#334155' : '#f3f4f6',
                          color: isDark ? '#f1f5f9' : '#374151',
                          opacity: safePage >= totalPages - 1 ? 0.4 : 1,
                          cursor: safePage >= totalPages - 1 ? 'default' : 'pointer',
                        }}
                      >
                        Next &rarr;
                      </button>
                    </>
                  )}
                  <span style={{
                    fontSize: 12,
                    color: isDark ? '#64748b' : '#9ca3af',
                  }}>
                    ({studentStreams.length} total)
                  </span>
                </div>
              )}
              <div style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
                gap: 12,
                maxWidth: 1400,
                margin: '0 auto',
              }}>
                {visibleStreams.map(rs => (
                  <VideoTile
                    key={rs.participantId}
                    rs={rs}
                    isDark={isDark}
                    isMuted={mutedStudents.has(rs.participantId)}
                    onToggleMute={handleToggleMute}
                    onKick={sendKickStudent}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Chat sidebar */}
      {showChat && (
        <ChatPanel
          messages={chatMessages}
          onSend={sendChat}
          myId={myId}
          isDark={isDark}
        />
      )}
    </div>
  )
}
