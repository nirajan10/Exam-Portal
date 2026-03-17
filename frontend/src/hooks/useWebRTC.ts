import { useCallback, useEffect, useRef, useState } from 'react'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Participant {
  id: string
  name: string
  role: 'student' | 'teacher'
}

export interface RemoteStream {
  participantId: string
  name: string
  role: string
  stream: MediaStream
  /** Bumped on every ontrack event to force React re-renders. */
  rev: number
}

export interface ChatMessage {
  from: string
  name: string
  role: string
  message: string
  timestamp: number
}

interface WSMessage {
  type: string
  from?: string
  to?: string
  name?: string
  role?: string
  room?: string
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  message?: string
  timestamp?: number
}

// ── ICE servers ─────────────────────────────────────────────────────────────

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// ── Hook ────────────────────────────────────────────────────────────────────

interface UseWebRTCOptions {
  roomId: string
  name: string
  role: 'student' | 'teacher'
  enableVideo?: boolean
  enableAudio?: boolean
  audioDeviceId?: string
  videoDeviceId?: string
}

export function useWebRTC({ roomId, name, role, enableVideo = true, enableAudio = true, audioDeviceId, videoDeviceId }: UseWebRTCOptions) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([])
  const [participants, setParticipants] = useState<Participant[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [connected, setConnected] = useState(false)
  const [disconnectedSince, setDisconnectedSince] = useState<number | null>(null)
  const [myId, setMyId] = useState('')
  const [kickedByTeacher, setKickedByTeacher] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const intentionalDisconnectRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const localStreamRef = useRef<MediaStream | null>(null)
  const myIdRef = useRef('')
  const revCounter = useRef(0)

  // Build the WebSocket URL dynamically based on the current page location.
  const getWsUrl = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/api/ws`
  }, [])

  // ── Send helper ─────────────────────────────────────────────────────────

  const sendWS = useCallback((msg: WSMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  // ── Peer connection factory ─────────────────────────────────────────────

  const createPeerConnection = (peerId: string, peerName: string, peerRole: string): RTCPeerConnection => {
    // Close existing connection to this peer if any.
    const existing = peersRef.current.get(peerId)
    if (existing) {
      existing.close()
      peersRef.current.delete(peerId)
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    // Add local tracks to the connection.
    // Both teacher and student send all tracks (audio + video) through the
    // same stream. Using a single audio channel per peer prevents echo
    // caused by mismatched audio transceivers. Browser echo cancellation
    // (echoCancellation: true in getUserMedia constraints) handles feedback.
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!)
      })
    } else {
      // No local media (e.g. denied camera) — add recv-only transceivers
      // so the SDP offer still contains audio/video m-lines and remote tracks
      // can be negotiated.
      pc.addTransceiver('audio', { direction: 'recvonly' })
      pc.addTransceiver('video', { direction: 'recvonly' })
    }

    // Send ICE candidates to the remote peer.
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendWS({
          type: 'ice-candidate',
          to: peerId,
          candidate: e.candidate.toJSON(),
        })
      }
    }

    // Receive remote tracks — fires once per track (audio, video).
    pc.ontrack = (e) => {
      const [stream] = e.streams
      if (!stream) return
      // Bump rev so React detects the change even if stream ref is identical.
      const rev = ++revCounter.current
      setRemoteStreams(prev => {
        const exists = prev.find(r => r.participantId === peerId)
        if (exists) {
          return prev.map(r => r.participantId === peerId ? { ...r, stream, rev } : r)
        }
        return [...prev, { participantId: peerId, name: peerName, role: peerRole, stream, rev }]
      })
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        peersRef.current.delete(peerId)
        setRemoteStreams(prev => prev.filter(r => r.participantId !== peerId))
      }
    }

    peersRef.current.set(peerId, pc)
    return pc
  }

  // ── Signaling functions ────────────────────────────────────────────────

  const doCreateOffer = async (peerId: string, peerName: string, peerRole: string) => {
    try {
      const pc = createPeerConnection(peerId, peerName, peerRole)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      sendWS({ type: 'offer', to: peerId, sdp: pc.localDescription! })
    } catch (err) {
      console.error('Failed to create offer for', peerId, err)
    }
  }

  const doHandleOffer = async (msg: WSMessage) => {
    try {
      const peerId = msg.from!
      const pc = createPeerConnection(peerId, msg.name || 'Unknown', msg.role || 'student')
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp!))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      sendWS({ type: 'answer', to: peerId, sdp: pc.localDescription! })
    } catch (err) {
      console.error('Failed to handle offer from', msg.from, err)
    }
  }

  const doHandleAnswer = async (msg: WSMessage) => {
    try {
      const pc = peersRef.current.get(msg.from!)
      if (pc && pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp!))
      }
    } catch (err) {
      console.error('Failed to handle answer from', msg.from, err)
    }
  }

  const doHandleICECandidate = async (msg: WSMessage) => {
    try {
      const pc = peersRef.current.get(msg.from!)
      if (pc && msg.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      }
    } catch (err) {
      console.error('Failed to add ICE candidate from', msg.from, err)
    }
  }

  // Store handler functions in refs so ws.onmessage always calls the latest version.
  const handlersRef = useRef({
    createOffer: doCreateOffer,
    handleOffer: doHandleOffer,
    handleAnswer: doHandleAnswer,
    handleICECandidate: doHandleICECandidate,
  })
  handlersRef.current = {
    createOffer: doCreateOffer,
    handleOffer: doHandleOffer,
    handleAnswer: doHandleAnswer,
    handleICECandidate: doHandleICECandidate,
  }

  // ── Send chat ─────────────────────────────────────────────────────────

  const sendChat = useCallback((message: string) => {
    sendWS({ type: 'chat', message })
  }, [sendWS])

  // ── Moderation (teacher only) ──────────────────────────────────────────

  const sendKickStudent = useCallback((targetId: string) => {
    sendWS({ type: 'kick-student', to: targetId })
  }, [sendWS])

  // ── Toggle audio/video ────────────────────────────────────────────────

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = !t.enabled })
    }
  }, [])

  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach(t => { t.enabled = !t.enabled })
    }
  }, [])

  // ── Switch devices on the fly ───────────────────────────────────────────

  const switchDevices = useCallback(async (newAudioId?: string, newVideoId?: string) => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(newAudioId ? { deviceId: { exact: newAudioId } } : {}),
        },
        video: newVideoId
          ? { deviceId: { exact: newVideoId }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } }
          : { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
      }
      const newStream = await navigator.mediaDevices.getUserMedia(constraints)

      // Stop old tracks.
      localStreamRef.current?.getTracks().forEach(t => t.stop())
      localStreamRef.current = newStream
      setLocalStream(newStream)

      // Replace tracks on all active peer connections.
      peersRef.current.forEach(pc => {
        const senders = pc.getSenders()
        for (const track of newStream.getTracks()) {
          const sender = senders.find(s => s.track?.kind === track.kind)
          if (sender) {
            sender.replaceTrack(track)
          }
        }
      })
    } catch (err) {
      console.error('Failed to switch devices:', err)
    }
  }, [])

  // ── Connect ────────────────────────────────────────────────────────────

  const connect = useCallback(async () => {
    // Prevent double-connect.
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    // Get local media.
    try {
      const videoConstraints = enableVideo
        ? {
            width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 },
            ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
          }
        : false
      const audioConstraints = enableAudio
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
          }
        : false
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: audioConstraints,
      })
      // Start with audio muted.
      stream.getAudioTracks().forEach(t => { t.enabled = false })
      // Start with video disabled for teacher.
      if (role === 'teacher') {
        stream.getVideoTracks().forEach(t => { t.enabled = false })
      }
      localStreamRef.current = stream
      setLocalStream(stream)
    } catch (err) {
      console.error('Failed to get media:', err)
    }

    // Open WebSocket.
    const ws = new WebSocket(getWsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room: roomId, name, role }))
      setConnected(true)
      setDisconnectedSince(null)
      reconnectAttemptRef.current = 0
      intentionalDisconnectRef.current = false
    }

    ws.onmessage = (e) => {
      const msg: WSMessage = JSON.parse(e.data)

      switch (msg.type) {
        case 'join':
          if (msg.from) {
            myIdRef.current = msg.from
            setMyId(msg.from)
          }
          break

        case 'participant-list': {
          // Received right after joining — contains everyone already in the room.
          const list: Participant[] = JSON.parse(msg.message || '[]')
          setParticipants(list)
          // WE are the new joiner → send offers to existing participants.
          // Star topology: students only connect to teachers (not to each other)
          // to prevent echo/feedback loops from N-fold audio paths.
          for (const p of list) {
            if (p.id === myIdRef.current) continue
            if (role === 'student' && p.role !== 'teacher') continue
            handlersRef.current.createOffer(p.id, p.name, p.role)
          }
          break
        }

        case 'participant-joined': {
          // Someone new joined the room. Do NOT send them an offer here —
          // they will send us an offer via their own participant-list handler.
          // Sending offers from both sides causes "glare" (both destroy each
          // other's peer connections).
          const p: Participant = { id: msg.from!, name: msg.name!, role: msg.role as 'student' | 'teacher' }
          setParticipants(prev => [...prev.filter(x => x.id !== p.id), p])
          break
        }

        case 'participant-left':
          setParticipants(prev => prev.filter(p => p.id !== msg.from))
          {
            const pc = peersRef.current.get(msg.from!)
            if (pc) { pc.close(); peersRef.current.delete(msg.from!) }
          }
          setRemoteStreams(prev => prev.filter(r => r.participantId !== msg.from))
          break

        case 'offer':
          // Star topology: students ignore offers from other students.
          if (role === 'student' && msg.role !== 'teacher') break
          handlersRef.current.handleOffer(msg)
          break

        case 'answer':
          if (role === 'student' && msg.role !== 'teacher') break
          handlersRef.current.handleAnswer(msg)
          break

        case 'ice-candidate':
          if (role === 'student' && msg.role !== 'teacher') break
          handlersRef.current.handleICECandidate(msg)
          break

        case 'chat':
          setChatMessages(prev => [...prev, {
            from: msg.from || '',
            name: msg.name || 'Unknown',
            role: msg.role || 'student',
            message: msg.message || '',
            timestamp: msg.timestamp || Date.now(),
          }])
          break

        case 'kick-student':
          // Teacher has kicked this student — mark as kicked so the page can auto-submit.
          setKickedByTeacher(true)
          break
      }
    }

    const handleDisconnect = () => {
      setConnected(false)
      wsRef.current = null
      // Close all peer connections on disconnect so they're re-established on reconnect.
      peersRef.current.forEach(pc => pc.close())
      peersRef.current.clear()
      setRemoteStreams([])
      setParticipants([])

      if (!intentionalDisconnectRef.current) {
        setDisconnectedSince(prev => prev ?? Date.now())
        // Auto-reconnect with backoff (1s, 2s, 4s, 8s, max 10s).
        const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 10_000)
        reconnectAttemptRef.current++
        reconnectTimerRef.current = setTimeout(() => {
          if (!intentionalDisconnectRef.current) {
            // Re-open WebSocket only (reuse existing local media).
            const ws2 = new WebSocket(getWsUrl())
            wsRef.current = ws2
            ws2.onopen = ws.onopen
            ws2.onmessage = ws.onmessage
            ws2.onclose = handleDisconnect
            ws2.onerror = () => {} // onclose will fire after onerror
          }
        }, delay)
      }
    }
    ws.onclose = handleDisconnect
    ws.onerror = () => {} // onclose fires after onerror
  }, [roomId, name, role, enableVideo, enableAudio, audioDeviceId, videoDeviceId, getWsUrl, sendWS])

  // ── Disconnect ─────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    peersRef.current.forEach(pc => pc.close())
    peersRef.current.clear()

    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
      setLocalStream(null)
    }

    setRemoteStreams([])
    setParticipants([])
    setConnected(false)
    setDisconnectedSince(null)
  }, [])

  // Cleanup on unmount.
  useEffect(() => {
    return () => { disconnect() }
  }, [disconnect])

  return {
    localStream,
    remoteStreams,
    participants,
    chatMessages,
    connected,
    disconnectedSince,
    myId,
    kickedByTeacher,
    connect,
    disconnect,
    sendChat,
    sendKickStudent,
    toggleAudio,
    toggleVideo,
    switchDevices,
  }
}
