/** Status tones: ok · warn · fault are status; blocked · unknown · neutral are greys; live is the secondary accent;
 * accent means "your turn"; finding is for findings, never faults. */
export type Tone = 'ok' | 'warn' | 'fault' | 'blocked' | 'unknown' | 'neutral' | 'live' | 'accent' | 'finding'
