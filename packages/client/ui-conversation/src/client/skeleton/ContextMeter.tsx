/** Composer context-occupancy meter: a ring beside the send button fed by the
 * `contextPressure` projection, with a click-open panel of the heuristic
 * `contextBreakdown` composition (system prompt, tools, conversation).
 * Renders nothing until a provider reports both pressure and a route
 * capacity. */

import { useEffect, useRef, useState } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the `contextPressure` / `contextBreakdown` projection key merges.
import type {} from '@deepseek-ai/dsh-token-meter/client'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import { contextOccupancy, formatTokens } from '../chat/StatsLine.tsx'
import css from './ContextMeter.module.css'

/** Ring geometry: 14px viewBox, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Marker the localized occupancy sentence is split on, so the panel headline
 * keeps the reading in its own tone while each locale still owns the word
 * order (`45% of context used` / `上下文已用 45%`).
 */
const READING_SLOT = '\u0000'

/** Panel legend rows, in bar-segment order; each color class carries the shared swatch/segment tint. */
const ROWS = [
  { key: 'systemTokens', label: 'context.system', color: css.colorSystem },
  { key: 'toolsTokens', label: 'context.tools', color: css.colorTools },
  { key: 'messageTokens', label: 'context.messages', color: css.colorMessages },
] as const

/**
 * OpenCode Go quota payload served by the deployment plugin at
 * /api/opencode-quota (absent when the plugin is stopped). The panel renders
 * the quota block above the context reading only while the route answers.
 */
interface OpenCodeQuotaPayload {
  ok: boolean
  base?: string
  usage?: {
    monthly: { percent: number | null; resetsAt: string | null }
    weekly: { percent: number | null; resetsAt: string | null }
    rolling: { percent: number | null; resetsAt: string | null }
  }
}

/** Quota rows in display order, mirroring the plugin's usage windows. */
const QUOTA_ROWS = [
  { key: 'monthly', name: '月限额' },
  { key: 'weekly', name: '周限额' },
  { key: 'rolling', name: '五小时' },
] as const

/** Compact reset countdown: HH:MM today, 明天, M/D within a month, M月D日 beyond. */
function shortReset(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const diff = t.getTime() - Date.now()
  if (diff < 0) return '已重置'
  const days = Math.floor(diff / 86_400_000)
  if (days <= 0) return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  if (days === 1) return '明天'
  if (days < 30) return `${t.getMonth() + 1}/${t.getDate()}`
  return `${t.getMonth() + 1}月${t.getDate()}日`
}

export interface ContextMeterProps {
  useProjection: UseProjection
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
}

export function ContextMeter({ useProjection, t }: ContextMeterProps) {
  const pressure = useProjection('contextPressure')
  const breakdown = useProjection('contextBreakdown')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const context = contextOccupancy(pressure)
  const available = context !== null

  // OpenCode Go quota feed: served by the deployment plugin at
  // /api/opencode-quota; the quota block hides while the route is absent
  // (plugin stopped) or answers !ok.
  const [quota, setQuota] = useState<OpenCodeQuotaPayload | null>(null)
  useEffect(() => {
    let alive = true
    const refresh = async (): Promise<void> => {
      try {
        const res = await fetch('/api/opencode-quota', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const json = (await res.json()) as OpenCodeQuotaPayload
        // 只有 ok 才保留额度区块；!ok（网关不是 OpenCode Go、路由缺失等）
        // 时清空状态，面板立即恢复官方原样。
        if (alive) setQuota(json.ok === true ? json : null)
      } catch {
        // route unavailable — keep the last known value
      }
    }
    void refresh()
    const timer = setInterval(refresh, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  // A model switch can temporarily remove capacity while this component stays
  // mounted. Close the now-unavailable panel instead of preserving stale UI.
  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  // Outside click / Escape close, one document listener while open (Menu's pattern).
  useEffect(() => {
    if (!open || !available) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [available, open])

  if (context === null) return null
  const percent = context.percent
  const reading = `${percent}%`
  const [headBefore = '', headAfter = ''] = t('context.aria', { percent: READING_SLOT })
    .split(READING_SLOT)
    .map(part => part.trim())

  // The bar's overall length stays the provider-exact percent; the heuristic
  // breakdown only proportions its colored parts. A zero-width part is dropped
  // instead of rendered: `.segment`'s min-width keeps a hairline part visible,
  // which at 0% occupancy would draw a filled bar over an empty context.
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', color: undefined, width: percent }]
    : ROWS.map(row => ({ key: row.key, color: row.color, width: percent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)
  const usage = quota?.usage

  return (
    <span ref={rootRef} className={css.root}>
      <Tooltip label={t('context.aria', { percent: reading })} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className={css.trigger}
          aria-label={t('context.aria', { percent: reading })}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className={css.track} cx="7" cy="7" r={RADIUS} />
            <circle
              className={css.fill}
              cx="7"
              cy="7"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('context.used')}>
          {usage && (
            <div className={css.quotaBlock}>
              <div className={css.quotaTitle}>OpenCode Go 额度</div>
              {QUOTA_ROWS.map((row) => {
                const w = usage[row.key]
                const used = typeof w.percent === 'number' ? w.percent : null
                const remaining = used === null ? null : Math.max(0, Math.round(100 - used))
                const color = remaining === null
                  ? 'var(--dsw-alias-label-tertiary)'
                  : remaining >= 50
                    ? 'var(--dsw-alias-state-success-primary)'
                    : remaining >= 20
                      ? 'var(--dsw-alias-state-warn-primary)'
                      : 'var(--dsw-alias-state-error-primary)'
                return (
                  <div key={row.key} className={css.quotaRow}>
                    <span className={css.quotaName}>{row.name}</span>
                    <span className={css.quotaTrack}>
                      <span className={css.quotaFill} style={{ width: `${used === null ? 0 : Math.min(100, used)}%`, background: color }} />
                    </span>
                    <span className={css.quotaValue} style={{ color }}>{remaining === null ? '--' : `剩 ${remaining}%`}</span>
                    <span className={css.quotaReset}>{shortReset(w.resetsAt)}</span>
                  </div>
                )
              })}
              <div className={css.quotaDivider} />
            </div>
          )}
          <div className={css.header}>
            {/* Empty sides collapse through `.headline:empty` so the locale that
                needs no leading (or trailing) text spends no header gap. */}
            <span className={css.headline}>{headBefore}</span>
            <span className={css.percent}>{reading}</span>
            <span className={css.headline}>{headAfter}</span>
            <span className={css.figures}>
              {`~${formatTokens(context.usedTokens)} / ${formatTokens(context.contextWindow)}`}
            </span>
          </div>
          <div className={css.bar}>
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.color === undefined ? css.segment : `${css.segment} ${segment.color}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {breakdown !== undefined && (
            <dl className={css.rows}>
              {ROWS.map(row => (
                <div key={row.key} className={css.row}>
                  <dt>
                    <span className={`${css.swatch} ${row.color}`} aria-hidden />
                    {t(row.label)}
                  </dt>
                  <dd>{`~${formatTokens(breakdown[row.key])}`}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </span>
  )
}
