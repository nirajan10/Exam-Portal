import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { Exam, Submission } from '../api/client'

// ── Colour constants (RGB tuples) ─────────────────────────────────────────────

type RGB = [number, number, number]
const BLUE:   RGB = [26, 115, 232]
const GREEN:  RGB = [34, 197, 94]
const RED:    RGB = [239, 68, 68]
const AMBER:  RGB = [245, 158, 11]
const PURPLE: RGB = [139, 92, 246]
const SLATE:  RGB = [71, 85, 105]
const DARK:   RGB = [17, 24, 39]
const BORDER: RGB = [229, 231, 235]
const LIGHT:  RGB = [248, 250, 252]

// ── Helpers ───────────────────────────────────────────────────────────────────

type QInfo = { type: string; content: string; points: number; correct_answers?: string[]; language?: string }

function buildQMap(exam: Exam): Map<number, QInfo> {
  const map = new Map<number, QInfo>()
  for (const qs of exam.question_sets ?? []) {
    for (const q of qs.questions ?? []) map.set(q.id, q)
  }
  return map
}

function computeMaxScore(exam: Exam, questionSetId?: number): number {
  const sets = exam.question_sets ?? []
  if (sets.length === 0) return 0
  // Use the student's assigned set when available; fall back to the first set.
  const target = (questionSetId ? sets.find(s => s.id === questionSetId) : null)
    ?? [...sets].sort((a, b) => a.order - b.order)[0]
  return (target.questions ?? []).reduce((sum, q) => sum + q.points, 0)
}

function drawBar(doc: jsPDF, x: number, y: number, w: number, h: number, pct: number, color: RGB) {
  doc.setFillColor(BORDER[0], BORDER[1], BORDER[2])
  doc.roundedRect(x, y, w, h, h / 2, h / 2, 'F')
  if (pct > 0) {
    const fw = Math.max(Math.min((w * pct) / 100, w), h)
    doc.setFillColor(color[0], color[1], color[2])
    doc.roundedRect(x, y, fw, h, h / 2, h / 2, 'F')
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateStudentPDF(exam: Exam, submission: Submission): Promise<Blob> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const W = 210
  const M = 15                 // margin
  const CW = W - M * 2        // content width
  let y = 0

  const qMap = buildQMap(exam)
  const maxScore = computeMaxScore(exam, submission.question_set_id)
  const answers = submission.answers ?? []
  const pct = maxScore > 0 ? Math.round((submission.total_score / maxScore) * 100) : 0
  const scoreColor: RGB = pct >= 70 ? GREEN : pct >= 41 ? AMBER : RED

  // Scores by type
  let mcqScore = 0, codeScore = 0, theoryScore = 0
  let mcqMax = 0, codeMax = 0, theoryMax = 0
  for (const a of answers) {
    const q = qMap.get(a.question_id)
    if (!q) continue
    const s = a.score ?? 0
    if (q.type === 'MCQ' || q.type === 'MRQ') { mcqScore += s; mcqMax += q.points }
    else if (q.type === 'code')               { codeScore += s; codeMax += q.points }
    else if (q.type === 'theory')             { theoryScore += s; theoryMax += q.points }
  }

  // ── Header bar ────────────────────────────────────────────────────────────────
  doc.setFillColor(BLUE[0], BLUE[1], BLUE[2])
  doc.rect(0, 0, W, 22, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(13)
  doc.text(exam.title, M, 10)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(8)
  doc.text('Individual Student Report', M, 17)
  doc.text(
    new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    W - M, 17, { align: 'right' },
  )
  y = 29

  // ── Student info row ──────────────────────────────────────────────────────────
  doc.setFillColor(LIGHT[0], LIGHT[1], LIGHT[2])
  doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
  doc.roundedRect(M, y, CW, 16, 2, 2, 'FD')

  const infoFields = [
    { label: 'STUDENT', value: submission.student_name, x: M + 3 },
    { label: 'SESSION', value: submission.session_id || '—', x: M + 62 },
    { label: 'SET',     value: submission.set_name    || '—', x: M + 118 },
    { label: 'EMAIL',   value: submission.student_email,      x: M + 144 },
  ]
  for (const f of infoFields) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(5.5)
    doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
    doc.text(f.label, f.x, y + 5)
    doc.setFont('helvetica', f.label === 'STUDENT' ? 'bold' : 'normal')
    doc.setFontSize(f.label === 'STUDENT' ? 9 : 7.5)
    doc.setTextColor(DARK[0], DARK[1], DARK[2])
    const truncated = f.value.length > 26 ? f.value.slice(0, 24) + '…' : f.value
    doc.text(truncated, f.x, y + 12)
  }
  y += 22

  // ── Score cards ───────────────────────────────────────────────────────────────
  const cards: { label: string; value: string; sub: string; color: RGB }[] = [
    { label: 'TOTAL SCORE', value: `${submission.total_score}/${maxScore}`, sub: `${pct}%`,             color: scoreColor },
    { label: 'MCQ / MRQ',   value: String(mcqScore),    sub: mcqMax   > 0 ? `of ${mcqMax}`   : 'none', color: BLUE      },
    { label: 'CODE',         value: String(codeScore),   sub: codeMax  > 0 ? `of ${codeMax}`  : 'none', color: PURPLE    },
    { label: 'THEORY',       value: String(theoryScore), sub: theoryMax > 0 ? `of ${theoryMax}` : 'none', color: AMBER },
  ]
  const cw = (CW - 4.5) / 4
  for (let i = 0; i < cards.length; i++) {
    const cd = cards[i]
    const cx = M + i * (cw + 1.5)
    doc.setFillColor(255, 255, 255)
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
    doc.roundedRect(cx, y, cw, 20, 2, 2, 'FD')
    // coloured left accent strip
    doc.setFillColor(cd.color[0], cd.color[1], cd.color[2])
    doc.rect(cx, y, 3, 20, 'F')

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6)
    doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
    doc.text(cd.label, cx + 5, y + 5.5)

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(13)
    doc.setTextColor(cd.color[0], cd.color[1], cd.color[2])
    doc.text(cd.value, cx + 5, y + 14)

    if (cd.sub) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7)
      doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
      doc.text(cd.sub, cx + 5, y + 19)
    }
  }
  y += 26

  // ── Overall score bar ─────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.setTextColor(DARK[0], DARK[1], DARK[2])
  doc.text(`Overall: ${pct}%`, M, y + 3.5)
  drawBar(doc, M + 26, y, CW - 26, 5, pct, scoreColor)
  y += 12

  // ── Performance by type ───────────────────────────────────────────────────────
  const types: { label: string; score: number; max: number; color: RGB }[] = [
    { label: 'MCQ/MRQ', score: mcqScore,   max: mcqMax,   color: BLUE   },
    { label: 'Code',    score: codeScore,  max: codeMax,  color: PURPLE },
    { label: 'Theory',  score: theoryScore, max: theoryMax, color: AMBER },
  ].filter(t => t.max > 0)

  if (types.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(DARK[0], DARK[1], DARK[2])
    doc.text('Performance by Type', M, y + 4)
    y += 9
    for (const t of types) {
      const tp = Math.round((t.score / t.max) * 100)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
      doc.text(t.label, M, y + 3.5)
      doc.text(`${t.score}/${t.max} (${tp}%)`, W - M, y + 3.5, { align: 'right' })
      drawBar(doc, M + 24, y, CW - 52, 5, tp, t.color)
      y += 9
    }
    y += 4
  }

  // ── MCQ / MRQ answers table ───────────────────────────────────────────────────
  const mcqAnswers = answers.filter(a => {
    const t = qMap.get(a.question_id)?.type
    return t === 'MCQ' || t === 'MRQ'
  })

  if (mcqAnswers.length > 0) {
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(DARK[0], DARK[1], DARK[2])
    doc.text('MCQ / MRQ Answers', M, y + 5)
    y += 9

    const rows = mcqAnswers.map((a, idx) => {
      const q = qMap.get(a.question_id)
      const rawCA = q?.correct_answers
      const correct = Array.isArray(rawCA) ? rawCA.join(' / ') : (rawCA ? String(rawCA) : '—')
      const student = a.answer || '(blank)'
      const ok = a.score != null && a.score > 0
      return [
        String(idx + 1),
        q ? (q.content.length > 68 ? q.content.slice(0, 68) + '…' : q.content) : `Q#${a.question_id}`,
        student.length > 44 ? student.slice(0, 44) + '…' : student,
        correct.length > 34 ? correct.slice(0, 34) + '…' : correct,
        { content: ok ? '✓' : '✗', styles: { textColor: ok ? GREEN : RED, fontStyle: 'bold' as const, fontSize: 11, halign: 'center' as const } },
        `${a.score ?? '—'}/${q?.points ?? '?'}`,
      ]
    })

    autoTable(doc, {
      startY: y,
      head: [['#', 'Question', 'Student Answer', 'Correct Answer', '', 'Score']],
      body: rows,
      margin: { left: M, right: M },
      theme: 'grid',
      headStyles: { fillColor: BLUE, textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
      bodyStyles: { fontSize: 7.5, textColor: DARK },
      columnStyles: {
        0: { cellWidth: 7, halign: 'center' },
        4: { cellWidth: 9 },
        5: { cellWidth: 15, halign: 'center' },
      },
    })
    y = (doc as jsPDF & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8
  }

  // ── Code answers ──────────────────────────────────────────────────────────────
  const codeAnswers = answers.filter(a => qMap.get(a.question_id)?.type === 'code')

  if (codeAnswers.length > 0) {
    if (y > 240) { doc.addPage(); y = M }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(DARK[0], DARK[1], DARK[2])
    doc.text('Code Submissions', M, y + 5)
    y += 10

    for (const a of codeAnswers) {
      const q = qMap.get(a.question_id)
      const lang = (q?.language ?? 'code').toUpperCase()
      const scoreStr = a.score != null ? `${a.score}/${q?.points ?? '?'} pts` : 'Ungraded'
      const code = a.answer || '(no code submitted)'
      const codeLines = code.split('\n')
      const shownLines = codeLines.slice(0, 35)
      const overflow = codeLines.length - shownLines.length
      const blockH = shownLines.length * 3.8 + 8

      if (y + blockH + 14 > 280) { doc.addPage(); y = M }

      // Question label
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(7.5)
      doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
      const qText = q ? `[${lang}] ${q.content.slice(0, 90)}` : `[CODE] Question #${a.question_id}`
      doc.text(qText, M, y)
      doc.setTextColor(PURPLE[0], PURPLE[1], PURPLE[2])
      doc.text(scoreStr, W - M, y, { align: 'right' })
      y += 5

      // Dark code block
      doc.setFillColor(15, 23, 42)
      doc.roundedRect(M, y, CW, blockH, 2, 2, 'F')
      doc.setTextColor(148, 163, 184)
      doc.setFont('courier', 'normal')
      doc.setFontSize(6.5)
      let ly = y + 5
      for (const line of shownLines) {
        doc.text(line.replace(/\t/g, '    ').slice(0, 100), M + 3, ly)
        ly += 3.8
      }
      if (overflow > 0) {
        doc.setTextColor(100, 116, 139)
        doc.text(`… ${overflow} more line${overflow !== 1 ? 's' : ''} not shown`, M + 3, ly)
      }
      y += blockH + 8
    }
  }

  // ── Theory / written answers ──────────────────────────────────────────────────
  const theoryAnswers = answers.filter(a => qMap.get(a.question_id)?.type === 'theory')

  if (theoryAnswers.length > 0) {
    if (y > 240) { doc.addPage(); y = M }
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(DARK[0], DARK[1], DARK[2])
    doc.text('Written Answers', M, y + 5)
    y += 10

    for (const a of theoryAnswers) {
      const q = qMap.get(a.question_id)
      const scoreStr = a.score != null ? `${a.score}/${q?.points ?? '?'} pts` : 'Ungraded'
      if (y > 260) { doc.addPage(); y = M }

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(7.5)
      doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
      const qText = q ? q.content.slice(0, 100) : `Question #${a.question_id}`
      const qLines = doc.splitTextToSize(qText, CW - 32) as string[]
      doc.text(qLines, M, y)
      doc.setTextColor(AMBER[0], AMBER[1], AMBER[2])
      doc.text(scoreStr, W - M, y, { align: 'right' })
      y += qLines.length * 4 + 2

      const ansText = a.answer || '(blank)'
      const aLines = (doc.splitTextToSize(ansText, CW - 6) as string[]).slice(0, 15)
      const blockH = aLines.length * 3.8 + 6
      if (y + blockH > 280) { doc.addPage(); y = M }

      doc.setFillColor(LIGHT[0], LIGHT[1], LIGHT[2])
      doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
      doc.roundedRect(M, y, CW, blockH, 2, 2, 'FD')
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(DARK[0], DARK[1], DARK[2])
      let ly2 = y + 4
      for (const l of aLines) { doc.text(l, M + 3, ly2); ly2 += 3.8 }
      y += blockH + 8
    }
  }

  // ── Footer on every page ──────────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setDrawColor(BORDER[0], BORDER[1], BORDER[2])
    doc.line(M, 287, W - M, 287)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(6.5)
    doc.setTextColor(SLATE[0], SLATE[1], SLATE[2])
    doc.text(`${exam.title} · ${submission.student_name} · ${submission.student_email}`, M, 292)
    doc.text(`Page ${p} of ${totalPages}`, W - M, 292, { align: 'right' })
  }

  return doc.output('blob')
}

/** Trigger a browser download of the given blob. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Sanitise a string for use inside a filename. */
export function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').slice(0, 40)
}
