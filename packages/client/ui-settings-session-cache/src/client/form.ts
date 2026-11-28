/** Staged editor for the two Session Controller cache limits. */

import type { SessionHistoryCacheBudget } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, type SettingsFieldSpec, type SettingsFieldState,
  type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isCacheMiB, readBudget } from './budget.ts'

interface SessionCacheFormState extends SettingsFormShell {
  historyCacheSessionMiB: SettingsFieldState
  historyCachePageMiB: SettingsFieldState
}

/** Slot actions and observable state for the settings form. */
export interface SessionCacheFormFace extends SettingsFormActions {
  hooks: {
    /** Form projection bound by the renderer as useSessionCacheForm. */
    sessionCacheForm: SnapshotStore<SessionCacheFormState>
  }
}

function cacheField(field: keyof SessionHistoryCacheBudget): SettingsFieldSpec {
  const spec = settingsNumberField(field)
  return {
    ...spec,
    parse: (text) => {
      const write = spec.parse(text)
      return write?.kind === 'set' && !isCacheMiB(write.value) ? undefined : write
    },
  }
}

/** Create the slot's draft model, scoped to its readable registration and the live write grant.
 * @param scope Shared Host configuration scope for the session-controller entry.
 * @returns The injected face, write grant setter, and disposer for the form's subscriptions.
 */
export function createSessionCacheForm(scope: SettingsFormScope<SessionHistoryCacheBudget>): {
  face: SessionCacheFormFace
  allowWrites: () => () => void
  dispose: () => void
} {
  const writable = createSnapshotStore(false)
  const form = new SettingsFormModel<SessionHistoryCacheBudget>({
    getSnapshot: () => {
      const snapshot = scope.getSnapshot()
      const status = snapshot.status === 'ready' && readBudget(snapshot.value) === undefined ? 'unavailable' : snapshot.status
      return { ...snapshot, status, writable: status === 'ready' && snapshot.writable && writable.getSnapshot() }
    },
    subscribe: (listener) => {
      const stopScope = scope.subscribe(listener)
      const stopWritable = writable.subscribe(listener)
      return () => { stopScope(); stopWritable() }
    },
    mutate: (ops, revision) => scope.mutate(ops, revision),
  }, [cacheField('historyCacheSessionMiB'), cacheField('historyCachePageMiB')])
  const snapshot = form.bind(() => {
    const shell = form.shell()
    return {
      ...shell,
      dirty: shell.writable && shell.dirty,
      historyCacheSessionMiB: form.field('historyCacheSessionMiB'),
      historyCachePageMiB: form.field('historyCachePageMiB'),
    }
  })
  const face: SessionCacheFormFace = { hooks: { sessionCacheForm: snapshot }, ...form.actions() }
  return {
    face,
    allowWrites: () => {
      writable.set(true)
      return () => { writable.set(false) }
    },
    dispose: () => { form.dispose() },
  }
}
