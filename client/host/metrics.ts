/** The metric strip on the Live tab. Server-rendered on first paint, refreshed after each call. */

import { els } from './dom'

export async function refreshMetrics(): Promise<void> {
  try {
    const response = await fetch('/api/host/metrics')
    if (!response.ok) return
    const metrics = (await response.json()) as { callsCompleted: number; queueJoins: number; averageCallSeconds: number | null }
    els.calls.textContent = String(metrics.callsCompleted)
    els.joins.textContent = String(metrics.queueJoins)
    els.avg.textContent = metrics.averageCallSeconds ? `${Math.round(metrics.averageCallSeconds / 60)}m` : '—'
  } catch {
    /* the numbers are a nicety; the queue is not */
  }
}
