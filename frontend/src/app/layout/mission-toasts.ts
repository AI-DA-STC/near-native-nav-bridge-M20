import { useEffect, useRef } from 'react'
import { useMissionSnapshot } from '@/shared/api'
import { robotOf } from '@/shared/config'
import { formatNumber } from '@/shared/lib'
import { pushToast } from '@/shared/ui/Toast'

/* Toasts for what the mission finds, on whichever screen the operator is: the box, once a robot has reached it. The
 * first snapshot only sets what was already known: opening the page does not toast an old finding. */

export function useMissionToasts(): void {
  const snap = useMissionSnapshot()
  const found = useRef<number | null | undefined>(undefined)
  useEffect(() => {
    if (!snap) return
    const detection = snap.detection
    const was = found.current
    found.current = detection?.foundAt ?? null
    if (was === undefined || !detection || detection.foundAt === was) return
    const id = snap.robots[detection.by].id || robotOf(detection.by).id
    pushToast({
      tone: 'finding',
      title: 'Anomalous object identified',
      body: `${robotOf(detection.by).label} · ${id} stopped ${formatNumber(detection.distM, 1)} m from it at (${formatNumber(detection.x)}, ${formatNumber(detection.y)})`,
    })
  }, [snap])
}
