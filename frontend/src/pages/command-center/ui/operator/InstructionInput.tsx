import { useId, useState, type ReactNode } from 'react'
import { cx } from '@/shared/lib'
import { Button } from '@/shared/ui/Button'
import { Icon } from '@/shared/ui/Icon'
import { Kbd } from '@/shared/ui/Kbd'
import './InstructionInput.css'

export interface InstructionInputProps {
  /** Receives the default instruction (the placeholder) when the field is empty */
  onSend?: (text: string) => void
  placeholder: string
  /** The operator's turn: accent field and a primary Send */
  hot?: boolean
  disabled?: boolean
  reason?: string
  label?: string
  hint?: ReactNode
  className?: string
}

/** The operator's instruction during Patrol: Enter sends, Shift+Enter breaks the line, empty sends the default */
export function InstructionInput({
  onSend,
  placeholder,
  hot = false,
  disabled = false,
  reason,
  label = 'Instruction',
  hint = 'Empty sends the default instruction.',
  className,
}: InstructionInputProps) {
  const [value, setValue] = useState('')
  const id = useId()
  const send = () => {
    if (!disabled) onSend?.(value.trim() || placeholder)
  }
  return (
    <form
      className={cx('cc-instr', hot && 'is-hot', disabled && 'is-disabled', className)}
      onSubmit={(e) => {
        e.preventDefault()
        send()
      }}
    >
      <label className="cc-instr__label" htmlFor={id}>
        {label}
      </label>
      <div className="cc-instr__row">
        <textarea
          id={id}
          className="cc-input cc-instr__field"
          rows={2}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <Button type="submit" variant={hot ? 'primary' : 'secondary'} icon="send" disabled={disabled} aria-describedby={`${id}-hint`}>
          Send
        </Button>
      </div>
      <div className="cc-instr__hint" id={`${id}-hint`}>
        {disabled && reason ? (
          <span className="cc-instr__reason">
            <Icon name="info" size={13} /> {reason}
          </span>
        ) : (
          <>
            {hint} <Kbd>Enter</Kbd> sends, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> breaks the line.
          </>
        )}
      </div>
    </form>
  )
}
