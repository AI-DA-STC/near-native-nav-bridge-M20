import { useEffect, useRef, useState } from 'react'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import './Terminal.css'

export interface TerminalLine {
  kind: 'cmd' | 'section' | 'out' | 'warn' | 'error'
  text: string
}

export interface TerminalProps {
  /** Raw output, verbatim; each line is classified by its prefix ($, ===, [WARN], [ERROR]) */
  text?: string
  lines?: TerminalLine[]
  /** An input row that sends a line to the script */
  input?: boolean
  onSend?: (line: string) => void
  placeholder?: string
  maxHeight?: number | string
  /** Stick to the newest line */
  follow?: boolean
  className?: string
}

function classify(line: string): TerminalLine {
  if (/^\$ /.test(line)) return { kind: 'cmd', text: line.slice(2) }
  if (/^===/.test(line)) return { kind: 'section', text: line }
  if (/^\[WARN\]|^Warning:|^WARN/.test(line)) return { kind: 'warn', text: line }
  if (/^\[ERROR\]|^\[FAULT\]|^Traceback|^ERROR/.test(line)) return { kind: 'error', text: line }
  return { kind: 'out', text: line }
}

/** The mission script's raw output in a terminal well: commands in live, section rules bold, warnings and errors in
 * their status colours, the rest as printed */
export function Terminal({
  lines,
  text = '',
  input = false,
  onSend,
  placeholder = 'send a line to the script (empty = Enter)',
  maxHeight,
  follow = true,
  className,
}: TerminalProps) {
  const rows = lines ?? text.split('\n').filter((l, i, all) => !(i === all.length - 1 && l === '')).map(classify)
  const outRef = useRef<HTMLPreElement>(null)
  const [value, setValue] = useState('')
  useEffect(() => {
    if (follow && outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight
  }, [rows.length, follow])
  return (
    <div className={cx('cc-term', className)}>
      <pre className="cc-term__out" ref={outRef} style={maxHeight ? { maxHeight } : undefined} tabIndex={0}>
        {rows.map((row, i) => (
          <div key={i} className={`cc-term__line is-${row.kind}`}>
            {row.kind === 'cmd' ? <span className="cc-term__prompt">$ </span> : null}
            {row.text}
          </div>
        ))}
      </pre>
      {input ? (
        <form
          className="cc-term__in"
          onSubmit={(e) => {
            e.preventDefault()
            onSend?.(value)
            setValue('')
          }}
        >
          <input
            className="cc-input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Send a line to the script"
          />
          <Button size="sm" type="submit">
            Send
          </Button>
        </form>
      ) : null}
    </div>
  )
}
