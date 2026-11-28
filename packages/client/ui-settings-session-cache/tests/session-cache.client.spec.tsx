// @vitest-environment jsdom
/** The browser companion's Plugins registration, staged editor, and accepted budget subscription. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { AccessEffect, RemoteEndpoint } from '@deepseek-ai/dsh-api-remote-access/client'
import { ClientAccessState } from '@deepseek-ai/dsh-api-remote-access/src/client/state.ts'
import { whenAllowed } from '@deepseek-ai/dsh-api-remote-access/src/client/when-allowed.ts'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { allowAllAccessPlugin, RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { MAX_CACHE_MIB } from '../src/client/budget.ts'
import { apply, inject } from '../src/client/index.ts'
import { dictionaries } from '../src/client/locales.ts'

const namespace = 'session-controller'
const en = dictionaries.en
const initial = { historyCacheSessionMiB: 17, historyCachePageMiB: 160 }
const changed = { historyCacheSessionMiB: 5, historyCachePageMiB: 40 }

function view(value: SettingsNamespaceView['value'] = initial, revision = 0): SettingsNamespaceView {
  return { ns: namespace, schema: { type: 'object', dict: {} }, value, base: initial, applies: 'live', autoGenerate: true, secrets: [], revision }
}

function documentWith(namespaces: SettingsNamespaceView[], writable = true) {
  return { ok: true as const, value: { writable, hasDocument: true, namespaces } }
}

const settingsActions = ['settings/describe', 'settings/mutate'] as const

class SettingsAccess extends Service {
  private readonly state = new ClientAccessState()

  constructor(ctx: Context) { super(ctx, 'remoteAccess') }

  allow(actions: readonly string[]): void {
    this.state.replace({ type: 'baseline', owner: false, grants: [{ resource: { kind: 'global' }, actions }] })
  }

  whenAccess(action: RemoteEndpoint, callback: () => AccessEffect): () => void {
    return whenAllowed(this.ctx, this.state.global(action), callback, action)
  }
}

async function setup(firstView = documentWith([view()]), actions: readonly string[] = settingsActions) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const { ctx, slots, remote } = runtime
  const defaultAccess = ctx.registry.get(allowAllAccessPlugin)
  await Promise.all([...defaultAccess?.fibers ?? []].map(fiber => fiber.dispose()))
  const access = new SettingsAccess(ctx)
  access.allow(actions)
  const localeRuntime = new LocaleRuntime(ctx)
  localeRuntime.setLocale('en')
  ctx.provide('locale', localeRuntime)
  slots.installLocale(localeRuntime)
  const setBudget = vi.fn()
  ctx.provide('sessionHistoryCache', { setBudget })

  const describeSettings = vi.fn().mockResolvedValue(firstView)
  const mutate = vi.fn()
  remote.provideNamespaces({ settings: { describe: describeSettings, mutate } })
  await runtime.mount({ inject: [...settingsInject], apply: settingsApply })
  await ctx.configForms.describe().ensure()
  const companion = await runtime.mount({ inject: [...inject], apply })

  async function publish(value: ReturnType<typeof documentWith>, revision: number) {
    describeSettings.mockResolvedValue(value)
    remote.emit('settings/document-updated', [namespace, revision])
    await ctx.configForms.describe().ensure()
  }

  async function declarePlugins() {
    await runtime.declare({ 'plugins.item': { kind: 'list', scope: 'root' } })
  }

  return { ctx, runtime, slots, setBudget, mutate, describeSettings, companion, publish, declarePlugins, localeRuntime, access }
}

describe('Session history cache companion', () => {
  it('applies only complete, changed, accepted values throughout the fiber lifetime, independent of the Plugins slot', async () => {
    expect(hostApply).not.toThrow()
    const { runtime, slots, setBudget, companion, publish, declarePlugins, localeRuntime } = await setup(documentWith([]))
    await declarePlugins()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget).not.toHaveBeenCalled()

    await publish(documentWith([view({ historyCacheSessionMiB: 17 }, 1)]), 1)
    expect(setBudget).not.toHaveBeenCalled()
    const entry = slots.entries('plugins.item')[0]!
    expect(entry.options).toMatchObject({ id: namespace, order: 35 })
    expect(resolveSlotLabel(entry.options.label)).toBe(en.title)
    localeRuntime.setLocale('zh')
    expect(resolveSlotLabel(entry.options.label)).toBe(dictionaries.zh.title)

    await publish(documentWith([view(initial, 2)]), 2)
    expect(setBudget.mock.calls).toEqual([[initial]])
    await publish(documentWith([view(initial, 3)], false), 3)
    await publish(documentWith([view({ ...initial, historyCachePageMiB: MAX_CACHE_MIB + 1 }, 4)]), 4)
    await publish(documentWith([view(null, 5)]), 5)
    expect(setBudget.mock.calls).toEqual([[initial]])

    await publish(documentWith([]), 6)
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget.mock.calls).toEqual([[initial]])
    runtime.root.release()
    await publish(documentWith([view(changed, 7)], false), 7)
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget.mock.calls).toEqual([[initial], [changed]])

    await declarePlugins()
    expect(slots.entries('plugins.item')).toHaveLength(1)
    await companion.dispose()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    await publish(documentWith([view(initial, 8)]), 8)
    expect(setBudget.mock.calls).toEqual([[initial], [changed]])
  })

  it('keeps the card and Core unchanged without read access even when the Settings mirror holds the namespace', async () => {
    const { slots, setBudget, declarePlugins } = await setup(undefined, ['settings/mutate'])
    await declarePlugins()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget).not.toHaveBeenCalled()
  })

  it('withdraws the card on read revocation and waits for current settings after regrant', async () => {
    const { ctx, runtime, slots, setBudget, access, describeSettings, publish, declarePlugins } = await setup()
    await declarePlugins()
    runtime.renderSlot('plugins.item', { view: 'page' })
    expect(screen.getByLabelText(en.sessionLimit)).toHaveProperty('value', '17')
    expect(describeSettings).toHaveBeenCalledTimes(1)

    access.allow([])
    await runtime.flush()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(screen.queryByLabelText(en.sessionLimit)).toBeNull()

    const refresh = Promise.withResolvers<{ ok: false; error: RemoteError }>()
    describeSettings.mockReturnValueOnce(refresh.promise)
    access.allow(settingsActions)
    await runtime.flush()
    expect(describeSettings).toHaveBeenCalledTimes(2)
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget.mock.calls).toEqual([[initial]])

    refresh.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) })
    await ctx.configForms.describe().ensure()
    await runtime.flush()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget.mock.calls).toEqual([[initial]])

    await publish(documentWith([view(changed, 1)]), 1)
    await runtime.flush()
    expect(screen.getByLabelText(en.sessionLimit)).toHaveProperty('value', '5')
    expect(setBudget.mock.calls).toEqual([[initial], [changed]])
  })

  it('does not expose cached settings on a later grant after startup without read access', async () => {
    const { ctx, runtime, slots, setBudget, access, describeSettings, declarePlugins } = await setup(undefined, [])
    await declarePlugins()
    const refresh = Promise.withResolvers<ReturnType<typeof documentWith>>()
    describeSettings.mockReturnValueOnce(refresh.promise)
    access.allow(['settings/describe'])
    await runtime.flush()
    expect(describeSettings).toHaveBeenCalledTimes(2)
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget).not.toHaveBeenCalled()

    refresh.resolve(documentWith([view(changed, 1)]))
    await ctx.configForms.describe().ensure()
    await runtime.flush()
    runtime.renderSlot('plugins.item', { view: 'page' })
    expect(screen.getByLabelText(en.sessionLimit)).toHaveProperty('value', '5')
    expect(setBudget.mock.calls).toEqual([[changed]])
  })

  it('ignores a refresh that settles after a second read revocation', async () => {
    const { ctx, runtime, slots, setBudget, access, describeSettings, declarePlugins } = await setup()
    await declarePlugins()
    const revokedRefresh = Promise.withResolvers<ReturnType<typeof documentWith>>()
    describeSettings.mockReturnValueOnce(revokedRefresh.promise)
    access.allow([])
    access.allow(settingsActions)
    await runtime.flush()
    expect(describeSettings).toHaveBeenCalledTimes(2)

    access.allow([])
    revokedRefresh.resolve(documentWith([view(changed, 1)]))
    await ctx.configForms.describe().ensure()
    await runtime.flush()
    expect(slots.entries('plugins.item')).toHaveLength(0)
    expect(setBudget.mock.calls).toEqual([[initial]])

    const current = { historyCacheSessionMiB: 8, historyCachePageMiB: 80 }
    describeSettings.mockResolvedValueOnce(documentWith([view(current, 2)]))
    access.allow(settingsActions)
    await ctx.configForms.describe().ensure()
    await runtime.flush()
    expect(slots.entries('plugins.item')).toHaveLength(1)
    expect(setBudget.mock.calls).toEqual([[initial], [current]])
  })

  it('removes write controls when write permission is withdrawn from an open form', async () => {
    const { runtime, access, mutate, declarePlugins } = await setup()
    await declarePlugins()
    runtime.renderSlot('plugins.item', { view: 'page' })
    const input = screen.getByLabelText(en.sessionLimit)
    const save = screen.getByRole('button', { name: en.save })
    fireEvent.change(input, { target: { value: '2' } })
    expect(save).toHaveProperty('disabled', false)
    access.allow(['settings/describe'])
    await runtime.flush()
    expect(input).toHaveProperty('disabled', true)
    expect(save).toHaveProperty('disabled', true)
    fireEvent.click(save)
    expect(mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['missing write access', true, ['settings/describe']],
    ['read-only document', false, settingsActions],
  ] as const)('shows the accepted amounts and disables edits with %s', async (_case, writable, actions) => {
    const { runtime, setBudget, mutate, declarePlugins } = await setup(documentWith([view()], writable), actions)
    await declarePlugins()
    runtime.renderSlot('plugins.item', { view: 'page' })
    expect(setBudget.mock.calls).toEqual([[initial]])
    expect(screen.getByRole('status').textContent).toBe(en.readOnly)
    expect(screen.getByLabelText(en.sessionLimit)).toHaveProperty('value', '17')
    expect(screen.getByLabelText(en.sessionLimit)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.pageLimit)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('shows the summary separately and leaves malformed served settings unavailable', async () => {
    const { runtime, setBudget, declarePlugins } = await setup(documentWith([view({ historyCachePageMiB: 4 })]))
    await declarePlugins()
    const summary = runtime.renderSlot('plugins.item', { view: 'summary' })
    expect(summary.container.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.sessionLimit)).toBeNull()
    summary.update({ view: 'page' })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
    expect(screen.queryByLabelText(en.pageLimit)).toBeNull()
    expect(setBudget).not.toHaveBeenCalled()
  })

  it('keeps failed drafts in the form and forwards only the accepted atomic save to Core', async () => {
    const { runtime, setBudget, mutate, declarePlugins } = await setup()
    await declarePlugins()
    runtime.renderSlot('plugins.item', { view: 'page' })
    const session = screen.getByLabelText(en.sessionLimit)
    const page = screen.getByLabelText(en.pageLimit)
    const save = screen.getByRole('button', { name: en.save })
    const edit = (input: HTMLElement, value: string) => { fireEvent.change(input, { target: { value } }) }

    for (const invalid of ['0', '2.5', 'x', String(MAX_CACHE_MIB + 1)]) {
      edit(session, invalid)
      expect(session.getAttribute('aria-invalid')).toBe('true')
      expect(save).toHaveProperty('disabled', true)
    }
    expect(mutate).not.toHaveBeenCalled()
    edit(session, '5')
    edit(page, '40')
    expect(setBudget.mock.calls).toEqual([[initial]])

    const response = Promise.withResolvers<{ ok: false; error: RemoteError }>()
    mutate.mockReturnValueOnce(response.promise)
    fireEvent.click(save)
    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(setBudget.mock.calls).toEqual([[initial]])
    response.resolve({ ok: false, error: new RemoteError('settings/rejected', 'conflict', { ns: namespace }) })
    await screen.findByText(en.saveFailed)
    expect(session).toHaveProperty('value', '5')
    expect(page).toHaveProperty('value', '40')
    expect(setBudget.mock.calls).toEqual([[initial]])

    mutate.mockResolvedValueOnce({ ok: true, value: { ...view(changed, 1), user: changed } })
    fireEvent.click(save)
    await waitFor(() => { expect(save).toHaveProperty('disabled', true); expect(setBudget.mock.calls).toEqual([[initial], [changed]]) })
    expect(mutate).toHaveBeenLastCalledWith(namespace, [
      { op: 'set', path: ['historyCacheSessionMiB'], value: 5 },
      { op: 'set', path: ['historyCachePageMiB'], value: 40 },
    ], 0)
    expect(screen.queryByText(en.saveFailed)).toBeNull()

    const [resetSession, resetPage] = screen.getAllByRole('button', { name: en.reset })
    fireEvent.click(resetSession!)
    fireEvent.click(resetPage!)
    expect(session).toHaveProperty('value', '17')
    expect(page).toHaveProperty('value', '160')
    expect(setBudget.mock.calls).toEqual([[initial], [changed]])
    mutate.mockResolvedValueOnce({ ok: true, value: { ...view(initial, 2), user: {} } })
    fireEvent.click(save)
    await waitFor(() => { expect(setBudget.mock.calls).toEqual([[initial], [changed], [initial]]) })
    expect(mutate).toHaveBeenLastCalledWith(namespace, [
      { op: 'unset', path: ['historyCacheSessionMiB'] },
      { op: 'unset', path: ['historyCachePageMiB'] },
    ], 1)
  })
})
