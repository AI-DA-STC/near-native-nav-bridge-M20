import { plainText, splitFinished } from './shell-prompt.ts'

/* A shell as the setup steps use it: they type into it and wait for what it prints. The text is kept plain (no escape
 * sequences, no carriage returns); positions in it are absolute, so a step can wait for what comes after a mark. */

export interface WaitOptions {
  /** The position to read from, from mark() */
  from: number
  /** null: until the test passes, the shell ends or the signal aborts */
  timeoutMs: number | null
  signal?: AbortSignal
  /** What is awaited, for the timeout's message ("Waited 15 s for <what>"): "the robot's password prompt" */
  what: string
}

export interface Waited<T> {
  value: T
  /** The text read, from `from` to the end at the moment the test passed */
  text: string
  /** The position after it: where the next wait goes on from */
  end: number
}

export interface Shell {
  readonly exited: boolean
  /** The end of everything printed so far */
  mark(): number
  textSince(from: number): string
  write(data: string): void
  /** Resolves with the first non-null result of `test` on the text printed since `from`, tried again on every output */
  waitFor<T>(test: (text: string) => T | null | undefined, options: WaitOptions): Promise<Waited<T>>
}

export class WaitTimeout extends Error {
  readonly what: string
  constructor(what: string, timeoutMs: number) {
    super(`Waited ${Math.round(timeoutMs / 1000)} s for ${what}`)
    this.name = 'WaitTimeout'
    this.what = what
  }
}

export class ShellExited extends Error {
  constructor(message = 'The terminal session ended') {
    super(message)
    this.name = 'ShellExited'
  }
}

export class Aborted extends Error {
  constructor() {
    super('Stopped')
    this.name = 'Aborted'
  }
}

interface Waiter {
  from: number
  test: (text: string) => unknown
  settle: (result: Waited<unknown> | null, error?: Error) => void
}

/** Keeps at most this much plain text; a wait that started before the cut reads from the oldest text left */
const KEEP_CHARS = 256 * 1024

export class ShellTranscript {
  private text = ''
  private base = 0
  private unfinished = ''
  private ended: Error | null = null
  private readonly waiters = new Set<Waiter>()

  get exited(): boolean {
    return this.ended !== null
  }

  /** Raw output from the terminal, escape sequences and all */
  protected append(raw: string): void {
    const [finished, rest] = splitFinished(this.unfinished + raw)
    this.unfinished = rest
    const plain = plainText(finished)
    if (!plain) return
    this.text += plain
    if (this.text.length > KEEP_CHARS) {
      const drop = this.text.length - KEEP_CHARS / 2
      this.text = this.text.slice(drop)
      this.base += drop
    }
    for (const waiter of [...this.waiters]) this.check(waiter)
  }

  /** The shell is gone: every wait fails */
  protected finish(reason: Error = new ShellExited()): void {
    if (this.ended) return
    this.ended = reason
    for (const waiter of [...this.waiters]) waiter.settle(null, reason)
  }

  mark(): number {
    return this.base + this.text.length
  }

  textSince(from: number): string {
    return this.text.slice(Math.max(0, from - this.base))
  }

  waitFor<T>(test: (text: string) => T | null | undefined, options: WaitOptions): Promise<Waited<T>> {
    return new Promise<Waited<T>>((resolve, reject) => {
      if (options.signal?.aborted) return reject(new Aborted())
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => waiter.settle(null, new Aborted())
      const waiter: Waiter = {
        from: options.from,
        test,
        settle: (result, error) => {
          this.waiters.delete(waiter)
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          if (error) reject(error)
          else resolve(result as Waited<T>)
        },
      }
      this.waiters.add(waiter)
      options.signal?.addEventListener('abort', onAbort)
      const timeoutMs = options.timeoutMs
      if (timeoutMs !== null) timer = setTimeout(() => waiter.settle(null, new WaitTimeout(options.what, timeoutMs)), timeoutMs)
      // What was printed before the wait began counts too
      this.check(waiter)
      if (this.waiters.has(waiter) && this.ended) waiter.settle(null, this.ended)
    })
  }

  private check(waiter: Waiter): void {
    const text = this.textSince(waiter.from)
    const value = waiter.test(text)
    if (value !== null && value !== undefined) waiter.settle({ value, text, end: this.mark() })
  }
}
