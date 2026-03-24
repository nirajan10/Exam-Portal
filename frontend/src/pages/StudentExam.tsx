import {
  useCallback, useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getPublicExam, joinExam, submitExam, executeCodeForStudent, Exam, Question, QuestionSet, RunResult } from '../api/client'
import { accessTokenKey } from './ExamLobby'
import { useTheme } from '../contexts/ThemeContext'
import DraggableCamera from '../components/DraggableCamera'
import ChatPanel from '../components/ChatPanel'
import DeviceSelector from '../components/DeviceSelector'
import { useWebRTC } from '../hooks/useWebRTC'

// ── Phase machine ─────────────────────────────────────────────────────────────

type Phase = 'loading' | 'inactive' | 'buffer' | 'entry' | 'exam' | 'submitting' | 'submitted' | 'error' | 'concluded'

// ── Helpers ───────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function formatCountdown(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

function computeTimeline(exam: Exam): { bufferEnd: number | null; examEnd: number | null; graceEnd: number | null } {
  if (!exam.started_at) return { bufferEnd: null, examEnd: null, graceEnd: null }
  const t0 = new Date(exam.started_at).getTime()
  const bufferMs = (exam.buffer_duration_minutes ?? 0) * 60_000
  const bufferEnd = t0 + bufferMs
  const examEnd = bufferEnd + exam.duration_minutes * 60_000
  const graceEnd = examEnd + 2 * 60_000
  return { bufferEnd, examEnd, graceEnd }
}

// ── Storage keys ──────────────────────────────────────────────────────────────

const startKey      = (examId: string, email: string) => `exam_${examId}_start_${email}`
const violKey       = (examId: string, email: string) => `exam_${examId}_viol_${email}`
const answersKey    = (examId: string) => `exam_${examId}_answers`
const sessionIdKey  = (examId: string) => `exam_${examId}_session_id`
const setNameKey    = (examId: string) => `exam_${examId}_set_name`

// ── Offline backup helpers ────────────────────────────────────────────────────

const OFFLINE_SALT = 'exam-salt-2026'

async function sha256hex(text: string): Promise<string> {
  const buf  = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

interface OfflineAnswer { question_id: number; answer: string }

async function buildOfflineBase64(
  examId: number,
  studentName: string,
  studentEmail: string,
  studentId: string,
  setName: string,
  answers: OfflineAnswer[],
): Promise<string> {
  const sorted = [...answers].sort((a, b) => a.question_id - b.question_id)
  const answersJson = JSON.stringify(sorted)
  const hashInput = `v1:${examId}:${studentName}:${studentEmail}:${answersJson}:${OFFLINE_SALT}`
  const hash = await sha256hex(hashInput)

  const payload = {
    v: 1,
    exam_id: examId,
    student_name: studentName,
    student_email: studentEmail,
    student_id: studentId,
    set_name: setName,
    exported_at: new Date().toISOString(),
    answers: sorted,
    hash,
  }
  return btoa(JSON.stringify(payload))
}

function triggerDownload(filename: string, textContent: string) {
  const blob = new Blob([textContent], { type: 'application/octet-stream' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ── Lightweight code editor ───────────────────────────────────────────────────
// Replaces Monaco to eliminate the ~10 MB bundle and slow load.
// Supports: Tab indentation, Enter auto-indent, monospace font, dark background.

interface CodeEditorProps {
  value: string
  onChange: (v: string) => void
  language: string
  onPaste?: (e: ClipboardEvent) => void
}

function CodeEditor({ value, onChange }: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    const start = ta.selectionStart
    const end   = ta.selectionEnd

    if (e.key === 'Tab') {
      e.preventDefault()
      const spaces = '    '
      const next   = value.substring(0, start) + spaces + value.substring(end)
      onChange(next)
      requestAnimationFrame(() => {
        if (ref.current) {
          ref.current.selectionStart = ref.current.selectionEnd = start + spaces.length
        }
      })
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const indent    = value.slice(lineStart, start).match(/^(\s*)/)?.[1] ?? ''
      const next      = value.substring(0, start) + '\n' + indent + value.substring(end)
      onChange(next)
      requestAnimationFrame(() => {
        if (ref.current) {
          ref.current.selectionStart = ref.current.selectionEnd = start + 1 + indent.length
        }
      })
    }
  }

  const editorStyle: CSSProperties = {
    display: 'block', width: '100%',
    fontFamily: "'Courier New', Courier, 'Lucida Console', monospace",
    fontSize: 14, lineHeight: 1.55,
    padding: '12px 14px',
    background: '#1e1e1e', color: '#d4d4d4',
    border: '1px solid #374151', borderRadius: 7,
    resize: 'vertical', minHeight: 240,
    boxSizing: 'border-box',
    tabSize: 4, whiteSpace: 'pre',
    overflowWrap: 'normal', overflowX: 'auto',
    outline: 'none', caretColor: '#d4d4d4',
    // Paste is blocked at the window level; this visual cue reinforces it.
  }

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      style={editorStyle}
    />
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function StudentExam() {
  const { id }   = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isDark } = useTheme()

  const [exam,  setExam]  = useState<Exam | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')

  // Entry form
  const [studentName,  setStudentName]  = useState('')
  const [studentEmail, setStudentEmail] = useState('')
  const [entryError,   setEntryError]   = useState('')
  const [joining,      setJoining]      = useState(false) // API call in-flight

  // Session — generated by the backend on first join; deterministic on re-entry
  const [sessionId, setSessionId] = useState('')

  // Exam in-progress
  const [answers,    setAnswers]    = useState<Record<number, string>>({})
  const [codeStdins, setCodeStdins] = useState<Record<number, string>>({})
  const [runResults, setRunResults] = useState<Record<number, RunResult>>({})
  const [runCounts,  setRunCounts]  = useState<Record<number, number>>({})

  const [isLateJoiner,   setIsLateJoiner]   = useState(false)
  const [assignedSetId,  setAssignedSetId]   = useState<number | null>(null)
  const [bufferExpired,  setBufferExpired]   = useState(false)
  const timerTargetRef   = useRef<number | null>(null) // absolute ms deadline
  const assignedSetIdRef = useRef<number | null>(null)  // mirrors assignedSetId

  // Run confirmation modal — qId of the question waiting for confirmation, or null
  const [pendingRunQId,  setPendingRunQId]  = useState<number | null>(null)
  const [pendingRunLang, setPendingRunLang] = useState<string>('python')
  const [isRunning,      setIsRunning]      = useState(false)

  // Timer
  const [timeLeft, setTimeLeft] = useState<number | null>(null)

  // Violations
  const [violationCount,  setViolationCount]  = useState(0)
  const [violationMsg,    setViolationMsg]     = useState('')
  const [showViolOverlay, setShowViolOverlay]  = useState(false)
  const [examLocked,      setExamLocked]       = useState(false)

  // Fullscreen recovery blocker (Esc-key grace period)
  const [showFsBlocker,    setShowFsBlocker]    = useState(false)
  const [fsGraceCountdown, setFsGraceCountdown] = useState(5)

  // Submission
  const [submitError, setSubmitError]   = useState('')
  const [showOfflineBtn, setShowOfflineBtn] = useState(false)

  // Pre-submission check modal
  const [showSubmitModal, setShowSubmitModal] = useState(false)
  const [unansweredCount, setUnansweredCount] = useState(0)

  // Offline download immunity — ref so event handler closures always see the live value
  // without needing to re-register listeners on every state change.
  const isDownloadingRef  = useRef(false)
  const [isDownloading,   setIsDownloading]   = useState(false)
  // Shown when the browser exits fullscreen due to a download dialog (not a real violation).
  const [showDownloadFsPrompt, setShowDownloadFsPrompt] = useState(false)

  // Refs — give event handlers access to fresh state without re-registering
  const phaseRef           = useRef<Phase>('loading')
  const violationCountRef  = useRef(0)
  const examLockedRef      = useRef(false)
  const submitRef          = useRef<(() => void) | null>(null)
  const showSubmitModalRef = useRef(false)
  const examRef            = useRef<Exam | null>(null)
  const answersRef         = useRef<Record<number, string>>({})
  const codeStdinsRef      = useRef<Record<number, string>>({})
  const assignedSetRef     = useRef<QuestionSet[]>([])
  const studentNameRef     = useRef('')
  const studentEmailRef    = useRef('')
  const sessionIdRef       = useRef('')
  const showFsBlockerRef   = useRef(false)
  const fsGraceTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fsGraceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fsRepeatViolRef    = useRef<ReturnType<typeof setInterval> | null>(null)

  phaseRef.current           = phase
  violationCountRef.current  = violationCount
  examLockedRef.current      = examLocked
  examRef.current            = exam
  showFsBlockerRef.current   = showFsBlocker
  answersRef.current         = answers
  codeStdinsRef.current      = codeStdins
  studentNameRef.current     = studentName
  studentEmailRef.current    = studentEmail
  sessionIdRef.current       = sessionId
  showSubmitModalRef.current = showSubmitModal
  assignedSetIdRef.current = assignedSetId

  // assignedQuestions — set once when the student begins the exam; always an array, never undefined
  const [assignedQuestions, setAssignedQuestions] = useState<QuestionSet[]>([])

  // ── WebRTC / camera proctoring ──────────────────────────────────────────
  const [showStudentChat, setShowStudentChat] = useState(false)
  const [studentAudioOn, setStudentAudioOn] = useState(false)
  const [studentVideoOn, setStudentVideoOn] = useState(true)

  const cameraRequired = exam?.camera_proctoring_required ?? false
  const [cameraGranted, setCameraGranted] = useState(false)
  const [studentAudioDeviceId, setStudentAudioDeviceId] = useState('')
  const [studentVideoDeviceId, setStudentVideoDeviceId] = useState('')
  const webrtcRoomId = `exam-${id}`

  const {
    localStream: studentLocalStream,
    remoteStreams: studentRemoteStreams,
    chatMessages: studentChatMessages,
    connected: studentWsConnected,
    disconnectedSince: studentDisconnectedSince,
    myId: studentMyId,
    kickedByTeacher: studentKickedByTeacher,
    connect: studentConnect,
    disconnect: studentDisconnect,
    sendChat: studentSendChat,
    toggleAudio: studentToggleAudio,
    toggleVideo: studentToggleVideo,
    switchDevices: studentSwitchDevices,
  } = useWebRTC({
    roomId: webrtcRoomId,
    name: studentName || 'Student',
    role: 'student',
    enableVideo: cameraRequired,
    enableAudio: cameraRequired,
    audioDeviceId: studentAudioDeviceId,
    videoDeviceId: studentVideoDeviceId,
  })

  // Connect WebRTC when entering exam phase with camera required.
  useEffect(() => {
    if (cameraRequired && phase === 'exam' && studentName && !studentWsConnected) {
      studentConnect()
    }
  }, [cameraRequired, phase, studentName, studentWsConnected, studentConnect])

  // Also connect during buffer phase so teacher can see students waiting.
  useEffect(() => {
    if (cameraRequired && phase === 'buffer' && studentName && !studentWsConnected) {
      studentConnect()
    }
  }, [cameraRequired, phase, studentName, studentWsConnected, studentConnect])

  // Disconnect on submission or unmount.
  useEffect(() => {
    if (phase === 'submitted' || phase === 'concluded') {
      studentDisconnect()
    }
  }, [phase, studentDisconnect])

  const handleStudentToggleAudio = () => { studentToggleAudio(); setStudentAudioOn(p => !p) }
  const handleStudentToggleVideo = () => { studentToggleVideo(); setStudentVideoOn(p => !p) }

  // Play teacher's audio so the student can hear the teacher.
  const teacherAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map())
  useEffect(() => {
    const teacherStreams = studentRemoteStreams.filter(r => r.role === 'teacher')
    // Attach new streams.
    for (const rs of teacherStreams) {
      let el = teacherAudioRefs.current.get(rs.participantId)
      if (!el) {
        el = document.createElement('audio')
        el.autoplay = true
        el.style.display = 'none'
        document.body.appendChild(el)
        teacherAudioRefs.current.set(rs.participantId, el)
      }
      if (el.srcObject !== rs.stream) {
        el.srcObject = rs.stream
        el.play().catch(() => {})
      }
    }
    // Remove stale entries.
    const activeIds = new Set(teacherStreams.map(r => r.participantId))
    teacherAudioRefs.current.forEach((el, pid) => {
      if (!activeIds.has(pid)) {
        el.srcObject = null
        el.remove()
        teacherAudioRefs.current.delete(pid)
      }
    })
  }, [studentRemoteStreams])

  // Cleanup audio elements on unmount.
  useEffect(() => {
    return () => {
      teacherAudioRefs.current.forEach(el => { el.srcObject = null; el.remove() })
      teacherAudioRefs.current.clear()
    }
  }, [])

  // ── 5-minute disconnect grace period (camera exams only) ──────────────────
  const DISCONNECT_GRACE_MS = 5 * 60 * 1000
  const [disconnectCountdown, setDisconnectCountdown] = useState<number | null>(null)

  useEffect(() => {
    if (!cameraRequired || phase !== 'exam') return
    if (!studentDisconnectedSince) {
      // Reconnected — clear countdown.
      setDisconnectCountdown(null)
      return
    }

    // Start counting down.
    const tick = () => {
      const elapsed = Date.now() - studentDisconnectedSince
      const remaining = Math.max(0, Math.ceil((DISCONNECT_GRACE_MS - elapsed) / 1000))
      setDisconnectCountdown(remaining)
      if (remaining <= 0) {
        // Grace period expired — auto-submit.
        submitRef.current?.()
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [cameraRequired, phase, studentDisconnectedSince])

  // ── Auto-submit when kicked by teacher ──────────────────────────────────
  useEffect(() => {
    if (studentKickedByTeacher && phase === 'exam') {
      submitRef.current?.()
    }
  }, [studentKickedByTeacher, phase])

  // ── Load exam + access-token gate ─────────────────────────────────────────

  useEffect(() => {
    if (!id) return
    if (!sessionStorage.getItem(accessTokenKey(Number(id)))) {
      navigate('/exams', { replace: true })
      return
    }
    getPublicExam(Number(id))
      .then(e => { setExam(e); setPhase('entry') })
      .catch((err: unknown) => {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 403) setPhase('inactive')
        else if (status === 410) setPhase('concluded')
        else setPhase('error')
      })
  }, [id])

  // ── Pre-fill entry form from localStorage (re-entry after refresh) ─────────

  useEffect(() => {
    if (!id || phase !== 'entry') return
    const storedName  = localStorage.getItem(`exam_${id}_name`)
    const storedEmail = localStorage.getItem(`exam_${id}_email`)
    if (storedName)  setStudentName(storedName)
    if (storedEmail) setStudentEmail(storedEmail)
  }, [id, phase])

  // ── Batch submit ──────────────────────────────────────────────────────────

  const doSubmit = useCallback(async () => {
    const currentExam = examRef.current
    if (!currentExam || phaseRef.current === 'submitting' || phaseRef.current === 'submitted') return

    setPhase('submitting')
    setSubmitError('')

    const questions  = (assignedSetRef.current ?? []).flatMap(qs => qs.questions ?? [])
    const name       = studentNameRef.current  || (localStorage.getItem(`exam_${id}_name`)  ?? '')
    const email      = studentEmailRef.current || (localStorage.getItem(`exam_${id}_email`) ?? '')
    const sessionID  = sessionIdRef.current    || (localStorage.getItem(sessionIdKey(id ?? '')) ?? '')

    // Send every question the student was shown — answered or not.
    // Unanswered questions arrive as "" so the backend can record them and
    // teachers can see exactly which questions were skipped.
    const answersPayload = questions.map(q => ({
      question_id: q.id,
      answer: answersRef.current[q.id] ?? '',
    }))

    try {
      await submitExam(currentExam.id, {
        student_name:  name,
        student_email: email,
        session_id:    sessionID,
        answers:       answersPayload,
      })

      // Clean up session artefacts only after confirmed 201
      if (id && email) {
        localStorage.removeItem(startKey(id, email))
        localStorage.removeItem(violKey(id, email))
        sessionStorage.removeItem(accessTokenKey(Number(id)))
      }

      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      setPhase('submitted')
    } catch (err: unknown) {
      // Don't lock the student out — let them retry or see the error.
      const isNetworkErr = !(err as { response?: unknown })?.response
      setSubmitError(
        isNetworkErr
          ? (cameraRequired
              ? 'No connection to the server. Reconnecting automatically — your answers are saved.'
              : 'No connection to the server. Your answers are saved in your browser — use "Download Backup" below.')
          : 'Submission failed. Please check your connection and try again.',
      )
      setShowOfflineBtn(true)
      setPhase('exam')
      // Re-enter fullscreen so the student isn't left outside with active
      // violation listeners firing on the re-rendered exam UI.
      if (examRef.current && examRef.current.violation_limit > 0) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
    }
  }, [id])

  submitRef.current = doSubmit

  // ── Fullscreen recovery (called by the FsBlocker overlay button) ──────────

  const resumeFromFsBlocker = useCallback(() => {
    if (fsGraceTimerRef.current)    { clearTimeout(fsGraceTimerRef.current);    fsGraceTimerRef.current = null }
    if (fsGraceIntervalRef.current) { clearInterval(fsGraceIntervalRef.current); fsGraceIntervalRef.current = null }
    if (fsRepeatViolRef.current)    { clearInterval(fsRepeatViolRef.current);    fsRepeatViolRef.current = null }
    setShowFsBlocker(false)
    showFsBlockerRef.current = false
    document.documentElement.requestFullscreen().catch(() => {})
  }, [])

  // ── Auto-save answers to localStorage ─────────────────────────────────────
  // Keeps a recoverable snapshot so the offline-download button always has
  // up-to-date data even if the browser is closed and reopened.

  useEffect(() => {
    if (!id || phase !== 'exam') return
    localStorage.setItem(answersKey(id), JSON.stringify(answers))
  }, [id, phase, answers])

  useEffect(() => {
    if (!id || !sessionId) return
    localStorage.setItem(sessionIdKey(id), sessionId)
  }, [id, sessionId])

  useEffect(() => {
    if (!id || assignedQuestions.length === 0) return
    const name = assignedQuestions[0].title ?? ''
    if (name) localStorage.setItem(setNameKey(id), name)
  }, [id, assignedQuestions])

  // ── Buffer → Exam transition ───────────────────────────────────────────────
  // When bufferExpired is set, fetch questions and start the real exam timer.

  useEffect(() => {
    if (!bufferExpired || !id) return
    setBufferExpired(false)
    const setId = assignedSetIdRef.current

    getPublicExam(Number(id)).then(freshExam => {
      setExam(freshExam)
      const sets = freshExam.question_sets ?? []
      if (sets.length === 0) { setPhase('error'); return }

      const rawSet = (setId ? sets.find(s => s.id === setId) : undefined) ?? sets[0]
      const assigned = [{
        ...rawSet,
        questions: freshExam.randomize_question_order && rawSet.questions
          ? shuffle(rawSet.questions)
          : (rawSet.questions ?? []),
      }]
      setAssignedQuestions(assigned)
      assignedSetRef.current = assigned

      const { examEnd } = computeTimeline(freshExam)
      timerTargetRef.current = examEnd
      const remaining = examEnd
        ? Math.max(1, Math.ceil((examEnd - Date.now()) / 1000))
        : freshExam.duration_minutes * 60
      setTimeLeft(remaining)
      setPhase('exam')

      if (freshExam.violation_limit > 0) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
    }).catch(() => setPhase('error'))
  }, [bufferExpired, id])

  // ── Offline backup download ────────────────────────────────────────────────

  const handleDownloadBackup = useCallback(async () => {
    if (!id || !exam) return

    // ── Activate immunity window ───────────────────────────────────────────
    // Blur, visibilitychange, and fullscreenchange fired by the save dialog
    // must not count as violations. We use a ref (not state) so the already-
    // registered event handlers see the updated value immediately.
    isDownloadingRef.current = true
    setIsDownloading(true)

    try {
      const examId  = exam.id
      const name    = studentName  || localStorage.getItem(`exam_${id}_name`)    || ''
      const email   = studentEmail || localStorage.getItem(`exam_${id}_email`)   || ''
      const sid     = sessionId    || localStorage.getItem(sessionIdKey(id))     || ''
      const setName = assignedQuestions[0]?.title || localStorage.getItem(setNameKey(id)) || ''

      // Restore answers from localStorage if component state is empty (e.g. reopened tab).
      let rawAnswers: Record<number, string> = answers
      const stored = localStorage.getItem(answersKey(id))
      if (Object.keys(rawAnswers).length === 0 && stored) {
        try { rawAnswers = JSON.parse(stored) } catch { /* ignore */ }
      }

      const ansArr: OfflineAnswer[] = Object.entries(rawAnswers).map(([qid, ans]) => ({
        question_id: Number(qid),
        answer: ans,
      }))

      const base64   = await buildOfflineBase64(examId, name, email, sid, setName, ansArr)
      const safeName = (name || 'Student').replace(/[^a-z0-9]/gi, '_')
      const safeId   = (sid  || 'unknown').replace(/[^a-z0-9]/gi, '_')
      triggerDownload(`OFFLINE_SUBMISSION_${safeName}_${safeId}.exam`, base64)
    } finally {
      // ── Clear immunity after 2 s (enough for any save dialog to settle) ──
      setTimeout(() => {
        isDownloadingRef.current = false
        setIsDownloading(false)

        // If fullscreen is required but was exited by the dialog, try to
        // silently re-enter it. requestFullscreen() needs a user gesture, so
        // it may fail here — in that case the download fullscreen prompt
        // (shown by onFullscreenChange) will already be visible.
        if (examRef.current && examRef.current.violation_limit > 0 && !document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {
            // Browser blocked silent re-entry — show the penalty-free prompt.
            setShowDownloadFsPrompt(true)
          })
        }
      }, 2000)
    }
  }, [id, exam, studentName, studentEmail, sessionId, assignedQuestions, answers])

  // ── Violation handler ─────────────────────────────────────────────────────

  const triggerViolation = useCallback((reason?: string) => {
    if (phaseRef.current !== 'exam' || examLockedRef.current) return
    // Don't penalise the student for having our own modal open.
    if (showSubmitModalRef.current) return
    // Don't penalise for blur/visibility events caused by the download dialog.
    if (isDownloadingRef.current) return
    // Don't penalise during the Esc-key grace period (FsBlocker is visible).
    if (showFsBlockerRef.current) return
    const currentExam = examRef.current
    if (!currentExam || currentExam.violation_limit === 0) return

    const next      = violationCountRef.current + 1
    const idStr     = id ?? ''
    const emailStr  = localStorage.getItem(`exam_${idStr}_email`) ?? ''
    localStorage.setItem(violKey(idStr, emailStr), String(next))
    setViolationCount(next)

    const msg = reason ?? 'You left the exam environment.'
    setViolationMsg(msg)

    if (next >= currentExam.violation_limit) {
      setExamLocked(true)
      examLockedRef.current = true
      submitRef.current?.()
    } else {
      setShowViolOverlay(true)
    }
  }, [id])

  // ── Begin exam ────────────────────────────────────────────────────────────

  const beginExam = async () => {
    if (!exam) return
    setEntryError('')

    if (cameraRequired && !cameraGranted) {
      setEntryError('Camera and microphone access is required. Please click "Enable Camera & Microphone" above.')
      return
    }

    if (!studentName.trim())  { setEntryError('Name is required.'); return }
    if (!studentEmail.trim()) { setEntryError('Email is required.'); return }
    if (!/\S+@\S+\.\S+/.test(studentEmail)) {
      setEntryError('Please enter a valid email address.')
      return
    }

    // Absolute timeline check — conclude immediately if exam has ended
    const { bufferEnd, examEnd } = computeTimeline(exam)
    const now = Date.now()
    if (examEnd && now >= examEnd) {
      setPhase('concluded')
      return
    }

    const sets = exam.question_sets ?? []
    const inBuffer = bufferEnd !== null && now < bufferEnd
    // Don't require sets during buffer (they're hidden server-side)
    if (sets.length === 0 && !inBuffer) {
      setEntryError('This exam has no questions yet.')
      return
    }

    setJoining(true)
    let joinResult: { session_id: string; assigned_set_id: number }
    try {
      joinResult = await joinExam(exam.id, studentName.trim(), studentEmail.trim())
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 410) { setPhase('concluded'); return }
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not connect to the exam server. Please check your internet and try again.'
      setEntryError(msg)
      setJoining(false)
      return
    } finally {
      setJoining(false)
    }

    setSessionId(joinResult.session_id)
    setAssignedSetId(joinResult.assigned_set_id)
    assignedSetIdRef.current = joinResult.assigned_set_id

    const idStr = id ?? ''
    localStorage.setItem(`exam_${idStr}_name`,  studentName.trim())
    localStorage.setItem(`exam_${idStr}_email`, studentEmail.trim())

    const storedViol = localStorage.getItem(violKey(idStr, studentEmail.trim()))
    if (storedViol) { const v = Number(storedViol); setViolationCount(v); violationCountRef.current = v }

    if (inBuffer) {
      // Student joined during buffer — show countdown, questions will be fetched when buffer ends
      timerTargetRef.current = bufferEnd
      setTimeLeft(Math.max(1, Math.ceil((bufferEnd - now) / 1000)))
      setPhase('buffer')
      if (exam.violation_limit > 0) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
      return
    }

    // ── After buffer (or no buffer configured) ──────────────────────────────
    const lateJoiner = bufferEnd !== null && now >= bufferEnd
    setIsLateJoiner(lateJoiner)

    const rawSet = sets.find(s => s.id === joinResult.assigned_set_id) ?? sets[0]
    const assigned = [{
      ...rawSet,
      questions: exam.randomize_question_order && rawSet.questions
        ? shuffle(rawSet.questions)
        : (rawSet.questions ?? []),
    }]
    setAssignedQuestions(assigned)
    assignedSetRef.current = assigned

    if (!exam.started_at) {
      // Old exam with no started_at — use localStorage-based start time (backward compat)
      const storedStart = localStorage.getItem(startKey(idStr, studentEmail.trim()))
      const startMs = storedStart ? Number(storedStart) : Date.now()
      if (!storedStart) localStorage.setItem(startKey(idStr, studentEmail.trim()), String(startMs))
      const elapsed   = Math.floor((Date.now() - startMs) / 1000)
      const remaining = Math.max(0, exam.duration_minutes * 60 - elapsed)
      timerTargetRef.current = null
      setTimeLeft(remaining)
    } else {
      timerTargetRef.current = examEnd
      setTimeLeft(Math.max(1, Math.ceil((examEnd! - now) / 1000)))
    }

    setPhase('exam')
    if (exam.violation_limit > 0) {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }

  // ── Event listeners: violations + paste blocking ──────────────────────────

  useEffect(() => {
    if (phase !== 'exam') return

    const onFullscreenChange = () => {
      if (document.fullscreenElement) {
        // Student returned to fullscreen — clear all violation timers and hide blocker.
        if (fsGraceTimerRef.current)    { clearTimeout(fsGraceTimerRef.current);    fsGraceTimerRef.current = null }
        if (fsGraceIntervalRef.current) { clearInterval(fsGraceIntervalRef.current); fsGraceIntervalRef.current = null }
        if (fsRepeatViolRef.current)    { clearInterval(fsRepeatViolRef.current);    fsRepeatViolRef.current = null }
        setShowFsBlocker(false)
        showFsBlockerRef.current = false
        return
      }
      if (isDownloadingRef.current) {
        // Download dialog forced fullscreen exit — show a penalty-free re-entry prompt.
        setShowDownloadFsPrompt(true)
        return
      }
      // Show the grace-period blocker. The student has 5 s to return to fullscreen
      // without incurring a violation. This handles Esc closing a modal (which also
      // exits fullscreen) without immediately counting it as a cheating attempt.
      if (fsGraceTimerRef.current)    clearTimeout(fsGraceTimerRef.current)
      if (fsGraceIntervalRef.current) clearInterval(fsGraceIntervalRef.current)
      if (fsRepeatViolRef.current)    clearInterval(fsRepeatViolRef.current)
      setShowFsBlocker(true)
      showFsBlockerRef.current = true
      setFsGraceCountdown(5)
      let cd = 5
      fsGraceIntervalRef.current = setInterval(() => {
        cd -= 1
        setFsGraceCountdown(cd)
        if (cd <= 0) { clearInterval(fsGraceIntervalRef.current!); fsGraceIntervalRef.current = null }
      }, 1000)
      fsGraceTimerRef.current = setTimeout(() => {
        fsGraceTimerRef.current = null
        if (fsGraceIntervalRef.current) { clearInterval(fsGraceIntervalRef.current); fsGraceIntervalRef.current = null }
        // Dismiss the blocker so triggerViolation's guard (showFsBlockerRef) allows it.
        setShowFsBlocker(false)
        showFsBlockerRef.current = false
        // First violation after the 5 s grace period.
        triggerViolation('You exited fullscreen mode.')
        // Then keep adding a violation every 2 s until the student returns
        // or the exam auto-submits from hitting the violation limit.
        fsRepeatViolRef.current = setInterval(() => {
          triggerViolation('Still outside fullscreen.')
        }, 2000)
      }, 5000)
    }
    // Both visibilitychange and blur are needed:
    //  - visibilitychange fires when the tab becomes hidden (new tab, Alt+Tab)
    //  - blur fires when the window loses focus (new window, Ctrl+N)
    // A tab switch fires BOTH, so we deduplicate with a timestamp: if a
    // violation was already recorded in the last 500 ms, skip the second one.
    let lastViolationTs = 0
    const deduplicatedViolation = (reason?: string) => {
      const now = Date.now()
      if (now - lastViolationTs < 500) return
      lastViolationTs = now
      triggerViolation(reason)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') deduplicatedViolation('You switched to another tab.')
    }
    const onBlur = () => {
      deduplicatedViolation('You opened another window or left the exam.')
    }
    // Block paste globally during exam; log as violation if proctoring is enabled.
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault()
      triggerViolation('Paste action detected. This has been logged as a violation.')
    }

    // Only register fullscreen/visibility/blur if violation tracking is enabled.
    if (examRef.current && examRef.current.violation_limit > 0) {
      document.addEventListener('fullscreenchange', onFullscreenChange)
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('blur', onBlur)
    }
    // Paste is always blocked regardless of violation_limit.
    window.addEventListener('paste', onPaste)

    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('paste', onPaste)
      if (fsGraceTimerRef.current)    { clearTimeout(fsGraceTimerRef.current);    fsGraceTimerRef.current = null }
      if (fsGraceIntervalRef.current) { clearInterval(fsGraceIntervalRef.current); fsGraceIntervalRef.current = null }
      if (fsRepeatViolRef.current)    { clearInterval(fsRepeatViolRef.current);    fsRepeatViolRef.current = null }
    }
  }, [phase, triggerViolation])

  // ── Auto-recover fullscreen on any click ──────────────────────────────────
  // During buffer and exam phases, if the student exits fullscreen (e.g. Esc)
  // any click inside the page silently re-enters fullscreen. This works because
  // requestFullscreen() requires a user gesture — a click satisfies that.
  useEffect(() => {
    if (!['buffer', 'exam'].includes(phase)) return
    if (!examRef.current || examRef.current.violation_limit === 0) return

    const onClick = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {})
      }
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [phase])

  // ── Countdown ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!['buffer', 'exam'].includes(phase) || timeLeft === null) return
    if (timeLeft <= 0) {
      if (phaseRef.current === 'buffer') setBufferExpired(true)
      else submitRef.current?.()
      return
    }
    const interval = setInterval(() => {
      if (timerTargetRef.current !== null) {
        const left = Math.max(0, Math.ceil((timerTargetRef.current - Date.now()) / 1000))
        setTimeLeft(left)
        if (left <= 0) {
          clearInterval(interval)
          if (phaseRef.current === 'buffer') setBufferExpired(true)
          else submitRef.current?.()
        }
      } else {
        // Fallback: no absolute deadline (old exam without started_at)
        setTimeLeft(prev => {
          if (prev === null || prev <= 1) { clearInterval(interval); submitRef.current?.(); return 0 }
          return prev - 1
        })
      }
    }, 1000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, timeLeft === null])

  // ── Code run ──────────────────────────────────────────────────────────────

  const maxRuns = exam?.max_code_runs ?? 0
  const canRun  = (qId: number) => maxRuns > 0 && (runCounts[qId] ?? 0) < maxRuns

  // Opens the confirmation modal — actual execution happens in confirmRun()
  const handleRun = (qId: number, language: string) => {
    if (!exam || !canRun(qId) || isRunning) return
    setPendingRunQId(qId)
    setPendingRunLang(language || 'python')
  }

  // Called when student presses Confirm in the run modal
  const confirmRun = async () => {
    if (!exam || pendingRunQId === null || isRunning) return
    const qId   = pendingRunQId
    const lang  = pendingRunLang
    setPendingRunQId(null)   // close modal immediately
    setIsRunning(true)
    try {
      const result = await executeCodeForStudent(
        exam.id,
        lang as 'c' | 'cpp' | 'python',
        answersRef.current[qId] ?? '',
        codeStdinsRef.current[qId] ?? '',
      )
      setRunResults(prev => ({ ...prev, [qId]: result }))
      setRunCounts(prev => ({ ...prev, [qId]: (prev[qId] ?? 0) + 1 }))
    } catch { /* silent */ }
    finally { setIsRunning(false) }
  }

  // ── MRQ helpers ───────────────────────────────────────────────────────────

  const getMrqSelected = (qId: number): string[] => {
    try { return JSON.parse(answers[qId] ?? '[]') } catch { return [] }
  }
  const toggleMrqOption = (qId: number, opt: string) => {
    const current = getMrqSelected(qId)
    const updated = current.includes(opt)
      ? current.filter(o => o !== opt)
      : [...current, opt]
    setAnswers(prev => ({ ...prev, [qId]: JSON.stringify(updated) }))
  }

  // ── Stable shuffled options per question ──────────────────────────────────

  const shuffledOptions = useMemo(() => {
    const map: Record<number, string[]> = {}
    ;(assignedQuestions ?? []).forEach(qs => {
      ;(qs.questions ?? []).forEach(q => {
        if ((q.type === 'MCQ' || q.type === 'MRQ') && Array.isArray(q.options)) {
          map[q.id] = q.randomize_options ? shuffle(q.options as string[]) : (q.options as string[])
        }
      })
    })
    return map
  }, [assignedQuestions])

  // ── Answer completeness helpers ───────────────────────────────────────────

  const isAnswered = (q: Question): boolean => {
    const ans = answers[q.id]
    if (!ans) return false
    if (q.type === 'MRQ') {
      try { return JSON.parse(ans).length > 0 } catch { return false }
    }
    return ans.trim() !== ''
  }

  const allQuestions = useMemo(
    () => (assignedQuestions ?? []).flatMap(qs => qs.questions ?? []),
    [assignedQuestions],
  )

  // ── Render ────────────────────────────────────────────────────────────────

  if (phase === 'loading') return (
    <Center><p style={{ color: '#6b7280' }}>Loading exam…</p></Center>
  )

  if (phase === 'concluded') return (
    <Center>
      <div style={centeredCard}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
          Exam Has Concluded
        </h2>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
          This exam has already ended. Please contact your instructor if you believe this is an error.
        </p>
      </div>
    </Center>
  )

  if (phase === 'buffer' && exam) return (
    <Center>
      <div style={{ ...centeredCard, textAlign: 'center', maxWidth: 440, padding: 36 }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
        <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
          Exam Starting Soon
        </h2>
        <p style={{ margin: '0 0 24px', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Your instructor is speaking. Questions will appear automatically when the briefing ends.
        </p>
        <div style={{
          fontSize: 52, fontWeight: 800, fontFamily: 'monospace', letterSpacing: 2,
          color: '#1a73e8', marginBottom: 20,
        }}>
          {timeLeft !== null ? formatCountdown(timeLeft) : '…'}
        </div>
        <p style={{ margin: 0, fontSize: 12, color: '#94a3b8' }}>
          Session: <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{sessionId}</span>
        </p>
      </div>
    </Center>
  )

  if (phase === 'inactive') return (
    <Center>
      <div style={centeredCard}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
        <h2 style={{ margin: '0 0 12px', fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
          Exam Not Yet Open
        </h2>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14, lineHeight: 1.6 }}>
          Please wait for your instructor to open the exam, then refresh this page.
        </p>
      </div>
    </Center>
  )

  // ── Entry form ────────────────────────────────────────────────────────────

  if (phase === 'entry' && exam) return (
    <Center>
      <div style={{ ...centeredCard, maxWidth: 460, padding: 36 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>
          {exam.title}
        </h2>
        {exam.description && (
          <p style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {exam.description}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 24,
          padding: 12, background: 'var(--card-bg2)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <MetaPill label="Duration" value={`${exam.duration_minutes} min`} />
          {exam.camera_proctoring_required && <MetaPill label="Webcam" value="Required" warn />}
          {exam.violation_limit > 0 && (
            <MetaPill label="Fullscreen" value={`${exam.violation_limit} violations max`} warn />
          )}
        </div>

        {/* Online proctoring warning */}
        {exam.camera_proctoring_required && (
          <div style={{
            marginBottom: 16,
            padding: 14,
            background: isDark ? '#422006' : '#fffbeb',
            border: `1px solid ${isDark ? '#854d0e' : '#fde68a'}`,
            borderRadius: 8,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: isDark ? '#fbbf24' : '#92400e', marginBottom: 6 }}>
              Online Proctored Exam
            </div>
            <ul style={{
              margin: 0, paddingLeft: 18, fontSize: 12,
              color: isDark ? '#fcd34d' : '#78350f', lineHeight: 1.7,
            }}>
              <li>Ensure you have a <strong>stable internet connection</strong> throughout the exam.</li>
              <li>Sit in a <strong>quiet, well-lit environment</strong> with no background noise.</li>
              <li>Your camera and microphone will be <strong>monitored live</strong> by the instructor.</li>
              <li>If you disconnect, you have <strong>5 minutes</strong> to reconnect or your exam will be auto-submitted.</li>
              <li>Offline backup submissions are <strong>not available</strong> for proctored exams.</li>
            </ul>
          </div>
        )}

        {/* Camera preview — shown when proctoring is required */}
        {exam.camera_proctoring_required && (
          <CameraPreview
            onStatusChange={granted => setCameraGranted(granted)}
            onDevicesSelected={(audioId, videoId) => {
              setStudentAudioDeviceId(audioId)
              setStudentVideoDeviceId(videoId)
            }}
          />
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Full Name" required>
            <input value={studentName} onChange={e => setStudentName(e.target.value)}
              placeholder="e.g. Jane Smith" style={fieldInput} disabled={joining} />
          </Field>
          <Field label="Email Address" required>
            <input type="email" value={studentEmail} onChange={e => setStudentEmail(e.target.value)}
              placeholder="e.g. jane@university.edu" style={fieldInput} disabled={joining} />
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#6b7280', lineHeight: 1.4 }}>
              Use a valid email — your results will be sent to this address.
            </p>
          </Field>
        </div>

        {entryError && (
          <p style={{ margin: '12px 0 0', fontSize: 13, color: '#dc2626' }}>⚠ {entryError}</p>
        )}

        {exam.violation_limit > 0 && (
          <p style={{ margin: '16px 0 0', fontSize: 12, color: '#92400e',
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', lineHeight: 1.5 }}>
            ⚠ This exam runs in fullscreen lockdown. Leaving fullscreen or switching tabs counts as
            a violation. You have <strong>{exam.violation_limit}</strong> before auto-submission.
            <br /><strong>Paste is also blocked</strong> and counts as a violation.
          </p>
        )}

        <button onClick={beginExam} disabled={joining || (exam.camera_proctoring_required && !cameraGranted)} style={{
          marginTop: 20, width: '100%', padding: '12px 0',
          background: joining ? '#60a5fa'
            : (exam.camera_proctoring_required && !cameraGranted) ? '#9ca3af'
            : '#1a73e8',
          color: 'white',
          border: 'none', borderRadius: 7, fontSize: 15, fontWeight: 700,
          cursor: (joining || (exam.camera_proctoring_required && !cameraGranted)) ? 'not-allowed' : 'pointer',
          transition: 'background 0.2s',
        }}>
          {joining ? 'Connecting…'
            : (exam.camera_proctoring_required && !cameraGranted) ? 'Enable Camera to Continue'
            : 'Begin Exam →'}
        </button>
      </div>
    </Center>
  )

  // ── Submitting screen ─────────────────────────────────────────────────────

  if (phase === 'submitting') return (
    <Center>
      <div style={{ ...centeredCard, textAlign: 'center', padding: 48 }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>
          <SubmitSpinner />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
          Submitting your answers…
        </h2>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
          Please wait. Do not close this tab.
        </p>
      </div>
    </Center>
  )

  // ── Submitted screen ──────────────────────────────────────────────────────

  if (phase === 'submitted') return (
    <Center bg="#f0fdf4">
      <div style={{ textAlign: 'center', maxWidth: 420, padding: 48 }}>
        <div style={{ fontSize: 72, marginBottom: 16 }}>✅</div>
        <h2 style={{ margin: '0 0 8px', fontSize: 24, fontWeight: 700, color: '#15803d' }}>
          Submitted Successfully
        </h2>
        <p style={{ margin: 0, fontSize: 15, color: '#6b7280', lineHeight: 1.6 }}>
          Your answers have been recorded. You may close this window.
        </p>
      </div>
    </Center>
  )

  // ── Exam interface ────────────────────────────────────────────────────────

  const urgent        = timeLeft !== null && timeLeft <= 300
  const violationsLeft = exam ? Math.max(0, exam.violation_limit - violationCount) : 0

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', userSelect: 'none', background: 'var(--page-bg)', minHeight: '100vh', transition: 'background 0.2s' }}>
      <style>{`@keyframes run-spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Offline download in-progress overlay ──────────────────────── */}
      {isDownloading && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(15,23,42,0.82)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1e293b', border: '1px solid #334155',
            borderRadius: 14, padding: '32px 40px', textAlign: 'center',
            maxWidth: 380, boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>
              <DownloadSpinner />
            </div>
            <p style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>
              Generating Secure Backup…
            </p>
            <p style={{ margin: 0, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
              Anti-cheat paused temporarily.<br />
              Do not close this tab.
            </p>
          </div>
        </div>
      )}

      {/* ── Download-caused fullscreen exit prompt (penalty-free) ─────── */}
      {showDownloadFsPrompt && exam && exam.violation_limit > 0 && (
        <Overlay>
          <div style={modalBox}>
            <div style={{ fontSize: 44, marginBottom: 12 }}>⬇️</div>
            <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
              Fullscreen Exited
            </h3>
            <p style={{ margin: '0 0 6px', fontSize: 14, color: '#374151', lineHeight: 1.5 }}>
              Your browser left fullscreen to save the backup file.
            </p>
            <p style={{ margin: '0 0 22px', fontSize: 13, color: '#6b7280' }}>
              <strong>No violation was recorded.</strong> Click below to return to the exam.
            </p>
            <button
              onClick={() => {
                setShowDownloadFsPrompt(false)
                document.documentElement.requestFullscreen().catch(() => {})
              }}
              style={primaryBtn}
            >
              Return to Fullscreen
            </button>
          </div>
        </Overlay>
      )}

      {/* ── Fullscreen recovery blocker (Esc-key grace period) ──────── */}
      {showFsBlocker && exam && exam.violation_limit > 0 && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 99999,
          background: '#0f172a',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ textAlign: 'center', maxWidth: 480, padding: '0 24px' }}>
            <div style={{ fontSize: 64, marginBottom: 20, lineHeight: 1 }}>⛶</div>
            <h2 style={{ margin: '0 0 12px', fontSize: 26, fontWeight: 800, color: '#f1f5f9' }}>
              Fullscreen Required
            </h2>
            <p style={{ margin: '0 0 8px', fontSize: 16, color: '#94a3b8', lineHeight: 1.6 }}>
              This exam must run in fullscreen mode.
            </p>
            <p style={{
              margin: '0 0 32px', fontSize: 14,
              color: fsGraceCountdown <= 2 ? '#f87171' : '#64748b',
              transition: 'color 0.3s',
            }}>
              {fsGraceCountdown > 0
                ? `A violation will be recorded in ${fsGraceCountdown} second${fsGraceCountdown !== 1 ? 's' : ''} if you don't return.`
                : 'Recording violation…'}
            </p>
            <button
              onClick={resumeFromFsBlocker}
              style={{
                padding: '16px 48px', fontSize: 18, fontWeight: 800,
                background: '#1a73e8', color: 'white',
                border: 'none', borderRadius: 10, cursor: 'pointer',
                boxShadow: '0 4px 24px rgba(26,115,232,0.45)',
                letterSpacing: '0.3px',
              }}
            >
              Resume Exam (Return to Fullscreen)
            </button>
          </div>
        </div>
      )}

      {/* ── Violation overlay ─────────────────────────────────────────── */}
      {showViolOverlay && exam && (
        <Overlay>
          <div style={modalBox}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
            <h3 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: '#dc2626' }}>
              Violation Detected
            </h3>
            <p style={{ margin: '0 0 8px', fontSize: 14, color: '#374151', lineHeight: 1.5 }}>
              {violationMsg || 'You left the exam environment.'}
            </p>
            <p style={{ margin: '0 0 22px', fontSize: 13, color: '#6b7280' }}>
              {violationsLeft > 0
                ? `${violationsLeft} violation${violationsLeft !== 1 ? 's' : ''} remaining before automatic submission.`
                : 'No violations remaining — next violation will submit your exam.'}
            </p>
            <button
              onClick={() => { setShowViolOverlay(false); document.documentElement.requestFullscreen().catch(() => {}) }}
              style={primaryBtn}
            >
              Return to Exam
            </button>
          </div>
        </Overlay>
      )}

      {/* ── Locked overlay ────────────────────────────────────────────── */}
      {examLocked && (
        <Overlay dim={0.92}>
          <div style={modalBox}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🔒</div>
            <h3 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#dc2626' }}>
              Exam Auto-Submitted
            </h3>
            <p style={{ margin: 0, fontSize: 14, color: '#374151' }}>
              You exceeded the violation limit. Your answers have been submitted automatically.
            </p>
          </div>
        </Overlay>
      )}

      {/* ── Run-code confirmation modal ──────────────────────────────── */}
      {pendingRunQId !== null && (() => {
        const used      = runCounts[pendingRunQId] ?? 0
        const remaining = maxRuns - used
        const lastRun   = remaining === 1
        return (
          <Overlay>
            <div
              style={modalBox}
              role="dialog"
              aria-modal="true"
              aria-labelledby="run-confirm-title"
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); confirmRun() }
                if (e.key === 'Escape') { e.preventDefault(); setPendingRunQId(null) }
              }}
              // Capture focus so keyboard events register on this div
              tabIndex={-1}
              ref={el => el?.focus()}
            >
              <div style={{ fontSize: 36, marginBottom: 10 }}>▶</div>
              <h3
                id="run-confirm-title"
                style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: '#111827' }}
              >
                Run Code?
              </h3>

              {lastRun ? (
                <p style={{
                  margin: '0 0 8px', padding: '8px 12px', borderRadius: 6,
                  background: '#fef2f2', border: '1px solid #fecaca',
                  fontSize: 13, fontWeight: 700, color: '#dc2626',
                }}>
                  ⚠ Warning: This is your last attempt!
                </p>
              ) : null}

              <p style={{ margin: '0 0 24px', fontSize: 14, color: '#374151', lineHeight: 1.6 }}>
                Are you sure you want to run this code?{' '}
                You have{' '}
                <strong style={{ color: lastRun ? '#dc2626' : '#111827' }}>
                  {remaining} attempt{remaining !== 1 ? 's' : ''}
                </strong>{' '}
                remaining.
              </p>

              <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                <button
                  onClick={() => setPendingRunQId(null)}
                  style={{
                    padding: '9px 22px', borderRadius: 7, fontWeight: 600, fontSize: 14,
                    border: '1px solid #d1d5db', background: '#f9fafb', color: '#374151',
                    cursor: 'pointer',
                  }}
                >
                  Cancel (Esc)
                </button>
                <button
                  onClick={confirmRun}
                  disabled={isRunning}
                  autoFocus
                  style={{
                    padding: '9px 22px', borderRadius: 7, fontWeight: 700, fontSize: 14,
                    border: 'none',
                    background: isRunning ? '#9ca3af' : lastRun ? '#dc2626' : '#1a73e8',
                    color: 'white',
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: 7,
                  }}
                >
                  {isRunning ? (
                    <>
                      <span style={{
                        display: 'inline-block', width: 13, height: 13,
                        border: '2px solid rgba(255,255,255,0.4)',
                        borderTopColor: '#fff', borderRadius: '50%',
                        animation: 'run-spin 0.7s linear infinite',
                      }} />
                      Running…
                    </>
                  ) : 'Confirm (Enter)'}
                </button>
              </div>
            </div>
          </Overlay>
        )
      })()}

      {/* ── Pre-submission check modal ────────────────────────────────── */}
      {showSubmitModal && (() => {
        // Closing this modal (Cancel / Esc) must restore fullscreen so the student
        // cannot peek at other windows. Any dismiss path calls closeSubmitModal().
        const closeSubmitModal = () => {
          setShowSubmitModal(false)
          if (examRef.current && examRef.current.violation_limit > 0 && !document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {})
          }
        }
        return (
          <Overlay>
            <div
              style={modalBox}
              onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); closeSubmitModal() } }}
              tabIndex={-1}
              ref={el => el?.focus()}
            >
              {unansweredCount > 0 ? (
                <>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
                  <h3 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: '#dc2626' }}>
                    Unanswered Questions Detected
                  </h3>
                  <p style={{ margin: '0 0 24px', fontSize: 14, color: '#374151', lineHeight: 1.6 }}>
                    You have <strong>{unansweredCount}</strong> unanswered question{unansweredCount !== 1 ? 's' : ''} out
                    of <strong>{allQuestions.length}</strong>. Are you sure you want to submit?
                  </p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
                  <h3 style={{ margin: '0 0 10px', fontSize: 18, fontWeight: 700, color: '#111827' }}>
                    Finish Exam?
                  </h3>
                  <p style={{ margin: '0 0 24px', fontSize: 14, color: '#374151', lineHeight: 1.6 }}>
                    Are you sure you want to finish the exam? This cannot be undone.
                  </p>
                </>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={closeSubmitModal}
                  style={{
                    flex: 1, padding: '10px 0', background: '#f3f4f6',
                    border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 600,
                    cursor: 'pointer', color: '#374151',
                  }}
                >
                  Go Back &amp; Review
                </button>
                <button
                  onClick={() => { setShowSubmitModal(false); doSubmit() }}
                  style={{
                    flex: 1, padding: '10px 0',
                    background: unansweredCount > 0 ? '#dc2626' : '#1a73e8',
                    border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 700,
                    cursor: 'pointer', color: 'white',
                  }}
                >
                  {unansweredCount > 0 ? 'Submit Anyway' : 'Submit Exam'}
                </button>
              </div>
              {!cameraRequired && (
                <button
                  onClick={() => { setShowSubmitModal(false); handleDownloadBackup() }}
                  style={{
                    marginTop: 12, width: '100%', padding: '9px 0',
                    background: 'none', border: '1px solid #d1d5db',
                    borderRadius: 7, fontSize: 13, fontWeight: 600,
                    cursor: 'pointer', color: '#374151',
                  }}
                >
                  ⬇ Download Offline Copy
                </button>
              )}
            </div>
          </Overlay>
        )
      })()}

      {/* ── Sticky header ─────────────────────────────────────────────── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{
          background: urgent ? '#dc2626' : (isDark ? '#030712' : '#ffffff'),
          color: urgent ? '#ffffff' : (isDark ? '#f1f5f9' : '#0f172a'),
          padding: '10px 24px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: urgent ? 'none' : (isDark ? '1px solid #1e293b' : '1px solid #e2e8f0'),
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{exam?.title}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{studentName}</div>
            {sessionId && (
              <div style={{ fontSize: 11, opacity: 0.55, fontFamily: 'monospace', letterSpacing: '0.5px' }}>
                {sessionId}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            {exam && exam.violation_limit > 0 && (
              <div style={{ fontSize: 12, opacity: 0.85, textAlign: 'center' }}>
                <div>Violations</div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  {violationCount} / {exam.violation_limit}
                </div>
              </div>
            )}
            {timeLeft !== null && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  {urgent ? '⚠ Time almost up!' : 'Time remaining'}
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>
                  {formatCountdown(timeLeft)}
                </div>
              </div>
            )}
          </div>
        </div>
        {isLateJoiner && exam && (() => {
          const { examEnd } = computeTimeline(exam)
          return (
            <div style={{
              background: '#fffbeb', borderBottom: '1px solid #fde68a',
              padding: '6px 20px', fontSize: 12, color: '#92400e', textAlign: 'center',
            }}>
              ⚠ You have joined late. Your exam will end at the scheduled time:{' '}
              <strong>
                {examEnd ? new Date(examEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
              </strong>
            </div>
          )
        })()}
      </div>

      {/* ── Question navigator (fixed right sidebar) ──────────────────── */}
      {allQuestions.length > 0 && (
        <div style={{
          position: 'fixed', right: 12, top: '50%', transform: 'translateY(-50%)',
          zIndex: 50, background: '#1e293b', borderRadius: 10, padding: '10px 8px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.35)', border: '1px solid #334155',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
          maxHeight: '70vh', overflowY: 'auto',
        }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase',
            letterSpacing: '0.5px', marginBottom: 4 }}>
            Q
          </div>
          {allQuestions.map((q, idx) => {
            const answered = isAnswered(q)
            return (
              <button
                key={q.id}
                onClick={() => document.getElementById(`question-${q.id}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                title={`Q${idx + 1}: ${answered ? 'Answered' : 'Unanswered'}`}
                style={{
                  width: 28, height: 28, borderRadius: '50%', cursor: 'pointer', padding: 0,
                  border: answered ? '2px solid #1a73e8' : '2px solid #ef4444',
                  background: answered ? '#1a73e8' : 'transparent',
                  color: answered ? 'white' : '#ef4444',
                  fontSize: 11, fontWeight: 700, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.15s, border-color 0.15s',
                }}
              >
                {idx + 1}
              </button>
            )
          })}
        </div>
      )}

      {/* ── Exam body ─────────────────────────────────────────────────── */}
      <div style={{ maxWidth: 860, margin: '32px auto', padding: '0 24px 48px' }}>

        {(assignedQuestions ?? []).map(qs => (
          <section key={qs.id} style={{ marginBottom: 32 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700,
              color: isDark ? '#94a3b8' : '#64748b',
              paddingBottom: 10, borderBottom: '2px solid var(--border)' }}>
              {qs.title}
            </h3>

            {(qs.questions ?? []).map((q, idx) => {
              const opts = shuffledOptions[q.id] ?? []

              return (
                <div key={q.id} id={`question-${q.id}`} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 20,
                  marginBottom: 16, background: 'var(--card-bg)' }}>

                  {/* Question header */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 14 }}>
                    <span style={{ background: 'var(--card-bg2)', color: 'var(--text)', fontWeight: 700,
                      fontSize: 12, borderRadius: 4, padding: '2px 7px', flexShrink: 0, marginTop: 1 }}>
                      Q{idx + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontWeight: 500, fontSize: 15, color: 'var(--text-body)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                        {q.content}
                      </span>
                      <span style={{ display: 'inline-block', marginLeft: 10, fontSize: 11, fontWeight: 600,
                        background: '#fef3c7', color: '#92400e', padding: '1px 7px', borderRadius: 9999 }}>
                        {q.points} mark{q.points !== 1 ? 's' : ''}
                      </span>
                      {q.type === 'MRQ' && (
                        <span style={{ display: 'inline-block', marginLeft: 6, fontSize: 11, fontWeight: 600,
                          background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 9999 }}>
                          Select all that apply
                        </span>
                      )}
                    </div>
                  </div>

                  {/* MCQ */}
                  {q.type === 'MCQ' && opts.map((opt, i) => (
                    <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
                      marginBottom: 8, cursor: 'pointer', padding: '9px 12px', borderRadius: 7,
                      background: answers[q.id] === opt ? (isDark ? '#1e3a5f' : '#eff6ff') : 'var(--card-bg2)',
                      border: answers[q.id] === opt ? `1px solid ${isDark ? '#3b82f6' : '#bfdbfe'}` : '1px solid var(--border)' }}>
                      <input type="radio" name={`q-${q.id}`} value={opt}
                        checked={answers[q.id] === opt}
                        onChange={() => setAnswers(prev => ({ ...prev, [q.id]: opt }))}
                        style={{ accentColor: '#1a73e8' }} />
                      <span style={{ fontSize: 14, color: 'var(--text-body)' }}>{opt}</span>
                    </label>
                  ))}

                  {/* MRQ */}
                  {q.type === 'MRQ' && opts.map((opt, i) => {
                    const selected = getMrqSelected(q.id).includes(opt)
                    return (
                      <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
                        marginBottom: 8, cursor: 'pointer', padding: '9px 12px', borderRadius: 7,
                        background: selected ? (isDark ? '#3b1f6e' : '#f5f3ff') : 'var(--card-bg2)',
                        border: selected ? `1px solid ${isDark ? '#7c3aed' : '#c4b5fd'}` : '1px solid var(--border)' }}>
                        <input type="checkbox" value={opt} checked={selected}
                          onChange={() => toggleMrqOption(q.id, opt)}
                          style={{ width: 16, height: 16, accentColor: '#6d28d9', cursor: 'pointer' }} />
                        <span style={{ fontSize: 14, color: 'var(--text-body)' }}>{opt}</span>
                      </label>
                    )
                  })}

                  {/* Theory */}
                  {q.type === 'theory' && (
                    <textarea
                      value={answers[q.id] ?? ''}
                      onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                      rows={6} placeholder="Write your answer here…"
                      style={{ display: 'block', width: '100%', padding: 12,
                        border: '1px solid var(--input-border)', borderRadius: 7, fontSize: 14,
                        fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6,
                        background: 'var(--input-bg)', color: 'var(--text)' }}
                    />
                  )}

                  {/* Code */}
                  {q.type === 'code' && (() => {
                    const lang = q.language || 'python'
                    const langLabel: Record<string, string> = { python: 'Python 3', c: 'C', cpp: 'C++ 17' }
                    const result = runResults[q.id]
                    return (
                      <div>
                        {/* Language badge + hint */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <span style={{
                            padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 700,
                            background: '#1e293b', color: '#93c5fd', letterSpacing: '0.3px',
                          }}>
                            {langLabel[lang] ?? lang}
                          </span>
                          <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>
                            Tab = 4 spaces · Paste is disabled
                          </span>
                        </div>

                        <CodeEditor
                          value={answers[q.id] ?? ''}
                          onChange={val => setAnswers(prev => ({ ...prev, [q.id]: val }))}
                          language={lang}
                        />

                        {maxRuns === 0 ? (
                          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#6b7280', fontStyle: 'italic' }}>
                            Code execution is not available for this exam.
                          </p>
                        ) : (
                          <div>
                            {/* stdin textarea */}
                            <div style={{ marginTop: 10 }}>
                              <label style={{ display: 'block', fontSize: 11, fontWeight: 600,
                                color: '#64748b', marginBottom: 4 }}>
                                stdin (program input, one value per line)
                              </label>
                              <textarea
                                value={codeStdins[q.id] ?? ''}
                                onChange={e => setCodeStdins(prev => ({ ...prev, [q.id]: e.target.value }))}
                                rows={3}
                                placeholder="Leave empty if your program reads no input"
                                style={{
                                  display: 'block', width: '100%', boxSizing: 'border-box',
                                  padding: '8px 12px',
                                  background: '#0f172a', color: '#94a3b8',
                                  border: '1px solid #334155', borderRadius: 6,
                                  fontFamily: "'Courier New', Courier, monospace",
                                  fontSize: 13, lineHeight: 1.5, resize: 'vertical',
                                }}
                              />
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                              {(() => {
                                const used      = runCounts[q.id] ?? 0
                                const disabled  = !canRun(q.id) || isRunning
                                return (
                                  <>
                                    <button
                                      onClick={() => handleRun(q.id, lang)}
                                      disabled={disabled}
                                      style={{ padding: '6px 16px',
                                        background: disabled ? '#9ca3af' : '#1a73e8',
                                        color: 'white', border: 'none', borderRadius: 5,
                                        fontSize: 13, fontWeight: 600,
                                        cursor: disabled ? 'not-allowed' : 'pointer',
                                        display: 'flex', alignItems: 'center', gap: 6 }}
                                    >
                                      {isRunning ? (
                                        <>
                                          <span style={{
                                            display: 'inline-block', width: 12, height: 12,
                                            border: '2px solid rgba(255,255,255,0.4)',
                                            borderTopColor: '#fff',
                                            borderRadius: '50%',
                                            animation: 'run-spin 0.7s linear infinite',
                                          }} />
                                          Running…
                                        </>
                                      ) : '▶ Run Code'}
                                    </button>
                                    <span style={{ fontSize: 12, color: used >= maxRuns ? '#ef4444' : '#6b7280' }}>
                                      {used} / {maxRuns} run{maxRuns > 1 ? 's' : ''} used
                                    </span>
                                  </>
                                )
                              })()}
                            </div>

                            {result && (
                              <div style={{ marginTop: 10, background: '#0f172a', borderRadius: 8,
                                border: '1px solid #1e293b', fontFamily: 'monospace', fontSize: 13,
                                overflow: 'hidden' }}>
                                {/* Status bar */}
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                  padding: '6px 12px', background: '#1e293b', borderBottom: '1px solid #334155' }}>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b',
                                    textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                                    Output
                                  </span>
                                  <span style={{ fontSize: 11, color: result.exit_code === 0 ? '#4ade80' : '#f87171' }}>
                                    {result.timed_out
                                      ? '⏱ Timed Out'
                                      : `Exit ${result.exit_code}`}
                                  </span>
                                </div>
                                <div style={{ padding: '10px 14px' }}>
                                  {result.timed_out && (
                                    <p style={{ color: '#fb923c', margin: '0 0 8px', fontSize: 12 }}>
                                      ⏱ Execution Timed Out — Check if your code is waiting for input
                                    </p>
                                  )}
                                  {result.stdout ? (
                                    <div style={{ marginBottom: result.stderr ? 10 : 0 }}>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: '#475569',
                                        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
                                        STDOUT
                                      </div>
                                      <pre style={{ margin: 0, color: '#e2e8f0', whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word' }}>
                                        {result.stdout}
                                      </pre>
                                    </div>
                                  ) : !result.timed_out && result.exit_code === 0 && (
                                    <span style={{ color: '#475569', fontSize: 12 }}>
                                      (no output)
                                    </span>
                                  )}
                                  {result.stderr && (
                                    <div>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: '#7f1d1d',
                                        textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4,
                                        marginTop: result.stdout ? 0 : 0 }}>
                                        STDERR
                                      </div>
                                      <pre style={{ margin: 0, color: '#fca5a5', whiteSpace: 'pre-wrap',
                                        wordBreak: 'break-word' }}>
                                        {result.stderr}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )
            })}
          </section>
        ))}

        {/* Submit section */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 24, marginTop: 8 }}>
          {submitError && (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5',
              borderRadius: 8, padding: '14px 16px', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ color: '#dc2626', flexShrink: 0 }}>⚠</span>
                <p style={{ margin: 0, fontSize: 13, color: '#dc2626', lineHeight: 1.5 }}>{submitError}</p>
              </div>
              {showOfflineBtn && !cameraRequired && (
                <button
                  onClick={handleDownloadBackup}
                  style={{
                    marginTop: 12, display: 'block', width: '100%', padding: '10px 0',
                    background: '#1e293b', color: '#93c5fd',
                    border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700,
                    cursor: 'pointer', letterSpacing: '0.2px',
                  }}
                >
                  ⬇ Download Backup Submission File
                </button>
              )}
            </div>
          )}
          <button
            onClick={() => {
              const unanswered = allQuestions.filter(q => !isAnswered(q)).length
              setUnansweredCount(unanswered)
              setShowSubmitModal(true)
            }}
            disabled={examLocked}
            style={{ padding: '13px 40px', fontSize: 15, fontWeight: 700,
              background: examLocked ? '#9ca3af' : '#1a73e8',
              color: 'white', border: 'none', borderRadius: 7,
              cursor: examLocked ? 'not-allowed' : 'pointer' }}
          >
            Submit Exam
          </button>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
            Review all answers before submitting.
          </p>
        </div>
      </div>

      {/* ── Camera proctoring overlay (draggable video + chat toggle) ─── */}
      {cameraRequired && studentLocalStream && (
        <DraggableCamera
          stream={studentLocalStream}
          muted
          onToggleAudio={handleStudentToggleAudio}
          onToggleVideo={handleStudentToggleVideo}
          audioEnabled={studentAudioOn}
          videoEnabled={studentVideoOn}
          onSwitchDevices={(audioId, videoId) => {
            setStudentAudioDeviceId(audioId)
            setStudentVideoDeviceId(videoId)
            studentSwitchDevices(audioId, videoId)
          }}
        />
      )}

      {/* ── Disconnect warning overlay ──────────────────────────────── */}
      {cameraRequired && disconnectCountdown !== null && phase === 'exam' && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0,
          zIndex: 10000,
          padding: '12px 20px',
          background: '#dc2626',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontSize: 14,
          fontWeight: 600,
          boxShadow: '0 4px 20px rgba(220,38,38,0.4)',
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
            <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
          </svg>
          <span>
            Connection lost — reconnecting automatically.
            Your exam will be auto-submitted in{' '}
            <strong>{Math.floor(disconnectCountdown / 60)}:{String(disconnectCountdown % 60).padStart(2, '0')}</strong>
            {' '}if not reconnected.
          </span>
        </div>
      )}

      {/* ── Chat toggle button ────────────────────────────────────────── */}
      {cameraRequired && studentWsConnected && (
        <button
          onClick={() => setShowStudentChat(prev => !prev)}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed',
            bottom: 20,
            left: 20,
            zIndex: 9998,
            padding: '8px 16px',
            background: showStudentChat ? '#1a73e8' : (isDark ? '#334155' : '#f3f4f6'),
            color: showStudentChat ? '#fff' : (isDark ? '#f1f5f9' : '#374151'),
            border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
            borderRadius: 20,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
          }}
        >
          {showStudentChat ? 'Close Chat' : `Chat ${studentChatMessages.length > 0 ? `(${studentChatMessages.length})` : ''}`}
        </button>
      )}

      {/* ── Student chat panel (floating) ─────────────────────────────── */}
      {cameraRequired && showStudentChat && (
        <div style={{
          position: 'fixed',
          bottom: 60,
          left: 20,
          zIndex: 9998,
          height: 400,
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
        }}>
          <ChatPanel
            messages={studentChatMessages}
            onSend={studentSendChat}
            myId={studentMyId}
            isDark={isDark}
            compact
          />
        </div>
      )}
    </div>
  )
}

// ── Small layout helpers ──────────────────────────────────────────────────────

function Center({ children, bg }: { children: ReactNode; bg?: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: bg ?? 'var(--page-bg)', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      {children}
    </div>
  )
}

function Overlay({ children, dim = 0.85 }: { children: ReactNode; dim?: number }) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999,
      background: `rgba(0,0,0,${dim})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backdropFilter: 'blur(4px)' }}>
      {children}
    </div>
  )
}

const centeredCard: CSSProperties = {
  background: 'var(--card-bg)', borderRadius: 12,
  border: '1px solid var(--border)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.08)',
}

const modalBox: CSSProperties = {
  background: 'white', borderRadius: 12, padding: 36,
  maxWidth: 400, width: '100%', textAlign: 'center',
  boxShadow: '0 24px 64px rgba(0,0,0,0.3)',
}

const primaryBtn: CSSProperties = {
  padding: '10px 28px', background: '#1a73e8', color: 'white',
  border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 700, cursor: 'pointer',
}

function MetaPill({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 10px', borderRadius: 6,
      background: warn ? '#fffbeb' : 'var(--card-bg2)',
      border: `1px solid ${warn ? '#fde68a' : 'var(--border)'}`, fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)', marginBottom: 1 }}>{label}</span>
      <span style={{ fontWeight: 700, color: warn ? '#92400e' : 'var(--text)' }}>{value}</span>
    </div>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  )
}

const fieldInput: CSSProperties = {
  width: '100%', padding: '9px 12px',
  border: '1px solid var(--input-border)', borderRadius: 6,
  fontSize: 14, boxSizing: 'border-box',
  background: 'var(--input-bg)', color: 'var(--text)',
}

function SubmitSpinner() {
  return (
    <>
      <style>{`
        @keyframes exam-submit-spin { to { transform: rotate(360deg); } }
        .exam-submit-spinner {
          display: inline-block; width: 48px; height: 48px;
          border: 5px solid #e2e8f0; border-top-color: #1a73e8;
          border-radius: 50%; animation: exam-submit-spin 0.8s linear infinite;
        }
      `}</style>
      <span className="exam-submit-spinner" />
    </>
  )
}

function CameraPreview({ onStatusChange, onDevicesSelected }: {
  onStatusChange: (granted: boolean) => void
  onDevicesSelected?: (audioId: string, videoId: string) => void
}) {
  const [status, setStatus] = useState<'idle' | 'granted' | 'denied'>('idle')

  const requestCamera = async () => {
    try {
      // Just check permission — DeviceSelector will handle the actual stream.
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      stream.getTracks().forEach(t => t.stop())
      setStatus('granted')
      onStatusChange(true)
    } catch {
      setStatus('denied')
      onStatusChange(false)
    }
  }

  return (
    <div style={{
      marginBottom: 20,
      padding: 16,
      background: 'var(--card-bg2)',
      borderRadius: 8,
      border: '1px solid var(--border)',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
        Camera & Microphone Setup
      </div>
      {status === 'idle' && (
        <button
          type="button"
          onClick={requestCamera}
          style={{
            padding: '8px 20px',
            background: '#1a73e8',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Enable Camera & Microphone
        </button>
      )}
      {status === 'denied' && (
        <div>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: '#dc2626' }}>
            Camera/microphone access denied. Please allow access in your browser settings and try again.
          </p>
          <button
            type="button"
            onClick={() => { setStatus('idle'); onStatusChange(false) }}
            style={{
              padding: '6px 16px',
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      )}
      {status === 'granted' && (
        <>
          <DeviceSelector
            compact
            onDevicesSelected={(audioId, videoId) => {
              onDevicesSelected?.(audioId, videoId)
            }}
          />
          <div style={{
            marginTop: 8,
            background: '#dcfce7',
            color: '#15803d',
            padding: '4px 12px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 600,
            display: 'inline-block',
          }}>
            Camera ready
          </div>
        </>
      )}
      <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
        Your camera and microphone will be active during the exam for live proctoring.
      </p>
    </div>
  )
}

function DownloadSpinner() {
  return (
    <>
      <style>{`
        @keyframes exam-dl-spin { to { transform: rotate(360deg); } }
        .exam-dl-spinner {
          display: inline-block; width: 36px; height: 36px;
          border: 4px solid #334155; border-top-color: #93c5fd;
          border-radius: 50%; animation: exam-dl-spin 0.7s linear infinite;
        }
      `}</style>
      <span className="exam-dl-spinner" />
    </>
  )
}
