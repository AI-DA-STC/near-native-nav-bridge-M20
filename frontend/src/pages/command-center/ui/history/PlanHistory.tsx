import { cx } from '@/shared/lib'
import type { PlanHistoryRow } from '../../model/history'
import { PlanStatus } from '../operator/PlanStatus'
import './PlanHistory.css'

/** Every plan of this run, the denied ones included; the newest last, each instruction verbatim */
export function PlanHistory({ rows, className }: { rows: PlanHistoryRow[]; className?: string }) {
  return (
    <table className={cx('cc-history', className)}>
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th>Plan</th>
          <th>Instruction</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.n}>
            <td className="cc-mono cc-num">{r.n}</td>
            <td className="cc-mono cc-num">{r.time}</td>
            <td className="cc-mono">{r.plan}</td>
            <td className="cc-history__instr" title={r.instruction}>
              {r.instruction}
            </td>
            <td>
              <PlanStatus status={r.status} size="sm" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
