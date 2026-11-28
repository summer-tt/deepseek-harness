/** The Plugins list summary and editor for browser session history cache limits. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionCacheFormFace } from './form.ts'
import { MAX_CACHE_MIB } from './budget.ts'

/** Props bound by the Plugins slot and the form registration. */
export type SessionCacheCardProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.sessionCache'> & InjectFace<SessionCacheFormFace>

/** Render the cache limits for the Plugins list or detail page.
 * @param props Requested view, localized copy, and scoped form state and actions.
 * @returns The brief summary or the native settings form.
 */
export function SessionCacheCard(props: SessionCacheCardProps) {
  const { t } = props
  const state = props.useSessionCacheForm(snapshot => snapshot)
  if (props.view === 'summary') return t('description')
  const fieldProps = {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('invalidNumber', { max: MAX_CACHE_MIB }),
    numeric: true,
    disabled: !state.writable,
  }
  return (
    <SettingsForm
      labels={{
        unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'),
        save: t('save'), saving: t('saving'),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SettingsValueField
        id="plugin-config-session-cache-session"
        label={t('sessionLimit')}
        hint={t('sessionHint')}
        {...fieldProps}
        {...state.historyCacheSessionMiB}
        onEdit={(text) => { props.edit('historyCacheSessionMiB', text) }}
        onReset={() => { props.resetField('historyCacheSessionMiB') }}
      />
      <SettingsValueField
        id="plugin-config-session-cache-page"
        label={t('pageLimit')}
        hint={t('pageHint')}
        {...fieldProps}
        {...state.historyCachePageMiB}
        onEdit={(text) => { props.edit('historyCachePageMiB', text) }}
        onReset={() => { props.resetField('historyCachePageMiB') }}
      />
    </SettingsForm>
  )
}
