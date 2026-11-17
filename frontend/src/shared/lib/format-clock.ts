const pad = (n: number) => String(n).padStart(2, '0')

function split(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 }
}

/** A duration as m:ss, or h:mm:ss past an hour: "1:47", "7:42". */
export function formatDuration(ms: number): string {
  const { h, m, s } = split(ms)
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** The mission clock, readable from the back of the room: "04:06", or h:mm:ss past an hour. */
export function formatClock(ms: number): string {
  const { h, m, s } = split(ms)
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** A clock time of day in local time, as the timeline shows it: "10:42:07". */
export function formatTimeOfDay(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
