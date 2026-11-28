/** Connect accepted Session Controller settings to the page cache and contribute its Plugins form. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { SessionHistoryCacheBudget } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { readBudget } from './budget.ts'
import { createSessionCacheForm } from './form.ts'
import { SessionCacheCard } from './SessionCacheCard.tsx'
import { dictionaries, type SessionCacheLocaleKey } from './locales.ts'

const namespace = 'session-controller'
const locale = 'settings.sessionCache'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session history cache settings copy. */
    'settings.sessionCache': SessionCacheLocaleKey
  }
}

/** Services for the Plugins slot and the page-wide budget subscription. */
export const inject = ['slots', 'locale', 'configForms', 'remoteAccess', 'sessionHistoryCache']

/** Apply the Host-accepted cache settings for this page and register the editor while visible.
 * @param ctx Browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(locale, dictionaries), 'ui-settings-session-cache: dictionaries')
  const t = ctx.locale.bind(locale)

  let lastApplied: SessionHistoryCacheBudget | undefined
  let starting = true
  ctx.remoteAccess.whenAccess('settings/describe', function* () {
    const install = () => ctx.effect(function* () {
      const accepted = ctx.configForms.get<SessionHistoryCacheBudget>(namespace)
      const sync = (): void => {
        const snapshot = accepted.getSnapshot()
        if (snapshot.status !== 'ready') return
        const budget = readBudget(snapshot.value)
        if (budget === undefined) return
        if (lastApplied?.historyCacheSessionMiB === budget.historyCacheSessionMiB
          && lastApplied.historyCachePageMiB === budget.historyCachePageMiB) return
        ctx.sessionHistoryCache.setBudget(budget)
        lastApplied = budget
      }
      yield accepted.subscribe(sync)
      sync()
      yield ctx.configForms.whileServed([namespace], () => ctx.slots.inject('plugins.item', function* () {
        const form = createSessionCacheForm(accepted)
        yield form.dispose
        yield ctx.remoteAccess.whenAccess('settings/mutate', form.allowWrites)
        yield ctx.slots.register({
          name: 'plugins.item', id: namespace, order: 35, label: () => t('title'), locale, inject: () => form.face,
        }, SessionCacheCard)
      }))
    }, 'ui-settings-session-cache: accepted settings')

    if (starting) {
      yield install()
      return
    }

    // The shared mirror can retain a document read before access was withdrawn.
    const mirror = ctx.configForms.describe()
    const previous = mirror.getSnapshot().view
    let active = true
    let refreshing = true
    let disposeAccepted: ReturnType<typeof install> | undefined
    const resume = (): void => {
      if (!active || refreshing) return
      const snapshot = mirror.getSnapshot()
      if (snapshot.view === undefined || snapshot.view === previous || snapshot.error !== null) return
      unsubscribe()
      disposeAccepted = install()
    }
    const unsubscribe = mirror.subscribe(resume)
    yield () => {
      active = false
      unsubscribe()
      return disposeAccepted?.()
    }
    void ctx.configForms.refresh().then(() => {
      refreshing = false
      resume()
    }).catch((error: unknown) => {
      refreshing = false
      if (active) ctx.logger.error('Could not refresh the session history cache settings', error)
    })
  })
  starting = false
}
