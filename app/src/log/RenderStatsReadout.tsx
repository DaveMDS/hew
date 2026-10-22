/**
 * RenderStatsReadout — compact render-statistics line for the LogPanel header.
 *
 * Shows the most recent frame's three.js `renderer.info` counters with draw
 * calls first and most prominent (the number that quantifies the instancing
 * win: dozens, not thousands, on instance-heavy models), plus the CPU-side
 * duration of the last renderer.render() call and — only while renders are
 * streaming (orbit, tool drag) — a smoothed frames-per-second.
 *
 * The viewport renders ON DEMAND, so "no new frames" is the normal resting
 * state, not an error: when no render has landed recently the fps slot shows
 * "idle" and the other numbers still describe the frame currently on screen.
 * GPU work is asynchronous, so the timing is labeled "cpu ms", not frame time.
 *
 * Mounting this component is what turns stats collection on (it is the
 * subscriber that makes renderStats.isRenderStatsActive() true); unmounting
 * it returns the render loop to a single boolean check per frame.
 */

import { useEffect, useRef, useState } from 'react'
import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { formatNumber } from '../i18n/format'
import { getSnapshot, subscribe, type RenderStatsSnapshot } from '../viewport/renderStats'

// Snapshots arrive at most every NOTIFY_INTERVAL_MS (250ms) while renders
// stream, so anything older than this means the stream has stopped and the
// fps figure would be stale.
const STALE_AFTER_MS = 600


const containerStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: '11px',
  whiteSpace: 'nowrap',
  cursor: 'default',
}

const drawCallsStyle: React.CSSProperties = {
  color: 'var(--accent-base)',
  fontWeight: 'bold',
}

const mutedStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
}

const idleStyle: React.CSSProperties = {
  color: 'var(--text-faint)',
  fontStyle: 'italic',
}

/** Compact count: 1234 → "1234", 56789 → "56.8k", 1234567 → "1.23M". */
function fmtCount(n: number): string {
  if (n >= 1_000_000) {
    const m = formatNumber(n / 1_000_000, { fractionDigits: 2 })
    return t({ comment: 'Compact count in millions, e.g. 1.23M triangles', message: `${m}M` })
  }
  if (n >= 10_000) {
    const k = formatNumber(n / 1_000, { fractionDigits: 1 })
    return t({ comment: 'Compact count in thousands, e.g. 56.8k triangles', message: `${k}k` })
  }
  return formatNumber(n, { grouping: false })
}

export function RenderStatsReadout() {
  const { t } = useLingui()
  const title = t`three.js renderer.info for the most recent frame. "cpu ms" is the CPU-side renderer.render() duration (GPU work is async). fps is smoothed over the current burst of renders; "idle" means the on-demand render loop is at rest.`
  const [snap, setSnap] = useState<RenderStatsSnapshot | null>(() => getSnapshot())
  const [stale, setStale] = useState(true)
  const staleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsub = subscribe((s) => {
      setSnap(s)
      setStale(false)
      // Each snapshot re-arms the idle timer; when snapshots stop arriving
      // the fps slot flips to "idle" rather than freezing a dead number.
      if (staleTimer.current !== null) clearTimeout(staleTimer.current)
      staleTimer.current = setTimeout(() => setStale(true), STALE_AFTER_MS)
    })
    return () => {
      unsub()
      if (staleTimer.current !== null) clearTimeout(staleTimer.current)
    }
  }, [])

  if (snap === null) {
    return (
      <span style={{ ...containerStyle, ...mutedStyle }} title={title}>
        {t`draw — · no frames yet`}
      </span>
    )
  }

  const streaming = !stale && snap.fps !== null
  const drawCalls = formatNumber(snap.drawCalls, { grouping: false })
  const triangles = fmtCount(snap.triangles)
  const geometries = formatNumber(snap.geometries, { grouping: false })
  const textures = formatNumber(snap.textures, { grouping: false })
  const cpuMs = formatNumber(snap.cpuMs, { fractionDigits: 1 })
  const fps = formatNumber(Math.round(snap.fps ?? 0), { grouping: false })
  return (
    <span style={containerStyle} title={title}>
      <span style={drawCallsStyle}>{t`draw ${drawCalls}`}</span>
      <span style={mutedStyle}>
        {' · '}
        {t`tri ${triangles}`}
        {' · '}
        {t`geo ${geometries}`}
        {' · '}
        {t`tex ${textures}`}
        {' · '}
        {t`${cpuMs} cpu ms`}
        {' · '}
      </span>
      {streaming ? (
        <span style={mutedStyle}>{t`${fps} fps`}</span>
      ) : (
        <span style={idleStyle}>{t`idle`}</span>
      )}
    </span>
  )
}
