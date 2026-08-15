/**
 * dsh-multimedia — client entry: registers the multimedia conversation tab
 * ('conversation.view' slot) backed by the host half's /multimedia API.
 *
 * Standard client wiring (see dsh-channel-wechat docs/weclaw-integration.md):
 *   - `ctx.locale.register(NS, { zh, en })` installs the 'multimedia'
 *     dictionary; the slot registration passes `locale: NS` so the renderer
 *     synthesizes the typed `t` seat on the component props.
 *   - The tab label reads through the locale-bound translate (follows the
 *     active locale), never a hardcoded string.
 */
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MultimediaTab } from './MultimediaTab.tsx'
import { NS, en, zh } from './locales.ts'

export const inject = ['slots', 'conversation', 'locale']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-multimedia: tab dictionaries')
  const t = ctx.locale.bind(NS)

  let disposeTab: (() => void) | undefined
  disposeTab = ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'multimedia',
      order: 90,
      locale: NS,
      label: () => t('tabTitle'),
    }, (props) => MultimediaTab({ ...props })))

  ctx.on('dispose', () => disposeTab?.())
}
