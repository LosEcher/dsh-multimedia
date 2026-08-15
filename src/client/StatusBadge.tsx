/**
 * StatusBadge — 状态徽章（非颜色编码通道，WCAG 1.4.1）。
 *
 * 组合 primitives 的 StateDot（状态点，aria-hidden）与文字标签：
 * 色盲用户（~8% 男性）无法仅靠颜色区分状态，点+文字双重编码。
 * 对齐 harness 内置 ui-trajectory 范式：tertiary 底 + 深字 + secondary 边框。
 * 样式走 multimedia.module.css 的 mmBadge*（令牌白名单，随主题）。
 */

import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './multimedia.module.css'

/** Job/任务状态 → 徽章变体 + 状态点语义 */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'succeeded': return styles.mmBadgeOk
    case 'failed': return styles.mmBadgeErr
    case 'queued': case 'running': case 'cancelling': return styles.mmBadgeWarn
    default: return styles.mmBadgeInfo
  }
}

/** 状态 → StateDot 语义（done/ongoing/warning/error） */
export function statusDotState(status: string): StateDotState {
  switch (status) {
    case 'succeeded': return 'done'
    case 'failed': return 'error'
    case 'queued': case 'running': case 'cancelling': return 'ongoing'
    default: return 'warning'
  }
}

export function StatusBadge({ status, children }: {
  status: string
  children: ReactNode
}) {
  return (
    <span className={`${styles.mmBadge} ${statusBadgeClass(status)}`}>
      <StateDot state={statusDotState(status)} size={8} className={styles.mmBadgeDot} />
      {children}
    </span>
  )
}
