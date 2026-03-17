import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { ChatMessage } from '../hooks/useWebRTC'

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (msg: string) => void
  myId: string
  isDark?: boolean
  compact?: boolean // student mode: smaller panel
}

export default function ChatPanel({ messages, onSend, myId, isDark = false, compact = false }: ChatPanelProps) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    const trimmed = input.trim()
    if (!trimmed) return
    onSend(trimmed)
    setInput('')
  }

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const panel: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: isDark ? '#1e293b' : '#ffffff',
    borderLeft: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
    width: compact ? 280 : 320,
    flexShrink: 0,
  }

  const header: CSSProperties = {
    padding: '12px 16px',
    borderBottom: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
    fontWeight: 700,
    fontSize: 14,
    color: isDark ? '#f1f5f9' : '#111827',
  }

  const msgArea: CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  }

  const inputArea: CSSProperties = {
    padding: '8px 12px',
    borderTop: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
    display: 'flex',
    gap: 6,
  }

  return (
    <div style={panel}>
      <div style={header}>Chat</div>

      <div style={msgArea}>
        {messages.map((m, i) => {
          const isMe = m.from === myId
          const isTeacher = m.role === 'teacher'
          return (
            <div key={i} style={{
              alignSelf: isMe ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
            }}>
              <div style={{
                fontSize: 11,
                color: isDark ? '#94a3b8' : '#6b7280',
                marginBottom: 2,
                textAlign: isMe ? 'right' : 'left',
              }}>
                {isMe ? 'You' : m.name}
                {isTeacher && !isMe && (
                  <span style={{
                    marginLeft: 4,
                    background: '#1a73e8',
                    color: '#fff',
                    padding: '1px 5px',
                    borderRadius: 3,
                    fontSize: 9,
                    fontWeight: 600,
                  }}>Teacher</span>
                )}
              </div>
              <div style={{
                padding: '6px 10px',
                borderRadius: 10,
                fontSize: 13,
                lineHeight: 1.4,
                background: isMe
                  ? '#1a73e8'
                  : (isDark ? '#334155' : '#f3f4f6'),
                color: isMe
                  ? '#fff'
                  : (isDark ? '#f1f5f9' : '#111827'),
                wordBreak: 'break-word',
              }}>
                {m.message}
              </div>
              <div style={{
                fontSize: 9,
                color: isDark ? '#64748b' : '#9ca3af',
                marginTop: 1,
                textAlign: isMe ? 'right' : 'left',
              }}>
                {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div style={inputArea}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Type a message..."
          style={{
            flex: 1,
            padding: '7px 10px',
            border: `1px solid ${isDark ? '#475569' : '#d1d5db'}`,
            borderRadius: 6,
            fontSize: 13,
            background: isDark ? '#0f172a' : '#fff',
            color: isDark ? '#f1f5f9' : '#111827',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          style={{
            padding: '7px 14px',
            background: input.trim() ? '#1a73e8' : (isDark ? '#334155' : '#e5e7eb'),
            color: input.trim() ? '#fff' : (isDark ? '#64748b' : '#9ca3af'),
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: input.trim() ? 'pointer' : 'default',
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
