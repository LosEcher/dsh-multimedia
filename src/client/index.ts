/**
 * dsh-multimedia — client entry: registers a '多媒体' conversation tab
 * ('conversation.view' slot) backed by the host half's /multimedia API.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MultimediaTab } from './MultimediaTab.tsx'

export const inject = ['slots', 'conversation']

export function apply(ctx: Context) {
  let disposeTab: (() => void) | undefined
  disposeTab = ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'multimedia',
      order: 90,
      label: () => '多媒体',
    }, (props) => MultimediaTab({ ...props })))

  ctx.on('dispose', () => disposeTab?.())
}
