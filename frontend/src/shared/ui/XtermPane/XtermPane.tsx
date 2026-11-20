import { useEffect, useRef, useState } from 'react'
import type { ITheme } from '@xterm/xterm'
import { cx } from '@/shared/lib'
import '@xterm/xterm/css/xterm.css'
import './XtermPane.css'

/** A terminal's output and input, wherever it runs */
export interface TerminalFeed {
  /** Calls `write` with what the terminal printed; replay: its scrollback, so the view starts over */
  attach(write: (data: string, replay: boolean) => void): () => void
  input?(data: string): void
  resize?(cols: number, rows: number): void
}

export interface XtermPaneProps {
  feed: TerminalFeed
  /** Its accessible name: "741 · robot terminal" */
  label: string
  className?: string
}

/** The terminal's colours are the console's: ground surface-well, text text-2, the ANSI colours its status tones */
function themeOf(el: HTMLElement): ITheme {
  const css = getComputedStyle(el)
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined
  return {
    background: v('--surface-well'),
    foreground: v('--text-2'),
    cursor: v('--live'),
    cursorAccent: v('--surface-well'),
    selectionBackground: v('--accent-line'),
    black: v('--surface-raised-2'),
    red: v('--fault-text'),
    green: v('--ok-text'),
    yellow: v('--warn-text'),
    blue: v('--accent'),
    magenta: v('--robot-r2'),
    cyan: v('--live'),
    white: v('--text-2'),
    brightBlack: v('--text-muted'),
    brightRed: v('--fault-text'),
    brightGreen: v('--ok-text'),
    brightYellow: v('--warn-text'),
    brightBlue: v('--accent'),
    brightMagenta: v('--robot-r3'),
    brightCyan: v('--robot-r1'),
    brightWhite: v('--text'),
  }
}

/** A live terminal (xterm.js): what it prints, and what is typed into it goes back. It fills its parent. */
export function XtermPane({ feed, label, className }: XtermPaneProps) {
  const screen = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = screen.current
    if (!el) return
    let disposed = false
    let cleanup = () => undefined as void
    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
        // The bundled mono must be in before xterm measures a cell
        await document.fonts?.load('12px "JetBrains Mono"').catch(() => undefined)
        if (disposed) return
        const term = new Terminal({
          fontFamily: getComputedStyle(el).getPropertyValue('--font-mono') || 'monospace',
          fontSize: 12,
          lineHeight: 1.25,
          theme: themeOf(el),
          cursorBlink: true,
          scrollback: 10_000,
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(el)
        const refit = () => {
          // A hidden pane has no size to fit
          if (el.clientWidth && el.clientHeight) fit.fit()
        }
        refit()
        const typed = term.onData((data) => feed.input?.(data))
        const resized = term.onResize(({ cols, rows }) => feed.resize?.(cols, rows))
        feed.resize?.(term.cols, term.rows)
        const detach = feed.attach((data, replay) => {
          if (replay) term.reset()
          term.write(data)
        })
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refit)
        observer?.observe(el)
        cleanup = () => {
          observer?.disconnect()
          detach()
          typed.dispose()
          resized.dispose()
          term.dispose()
        }
      } catch {
        if (!disposed) setFailed(true)
      }
    })()
    return () => {
      disposed = true
      cleanup()
    }
  }, [feed])

  return (
    <div className={cx('cc-xterm', className)} role="group" aria-label={label}>
      {failed ? <p className="cc-xterm__failed">This browser could not open the terminal.</p> : null}
      <div className="cc-xterm__screen" ref={screen} />
    </div>
  )
}
