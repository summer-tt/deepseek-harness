/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import type {} from '@deepseek-ai/dsh-client-product-analytics/client'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerOccurrenceId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { WeakMapWithValues } from '@deepseek-ai/dsh-util-values'
import { ModelCatalogDirectory } from './catalog.ts'
import { ModelDirectory } from './directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/** Model picker address for one mounted composer over a retained Session. */
export interface SessionModelPickerTarget {
  readonly sessionId: SessionId
  readonly composerId: ComposerOccurrenceId
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Directories keyed by Client binding, removed by their scope disposer. */
  readonly directories: WeakMapWithValues<SessionBinding, ModelDirectory>
  readonly pickerOpeners: WeakMap<SessionBinding, Map<ComposerOccurrenceId, () => boolean>>
}

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ['sessions', 'remote', 'remote.session']

  private readonly live: LiveState = {
    directories: new WeakMapWithValues(),
    pickerOpeners: new WeakMap(),
  }
  private readonly catalog: ModelCatalogDirectory

  /**
   * @param ctx - context owning the directory and picker registrations.
   */
  constructor(ctx: Context) {
    super(ctx, 'modelDirectories')
    this.catalog = new ModelCatalogDirectory(ctx)
    void this.catalog.load().catch(() => { /* selectors expose the shared error */ })
    ctx.on('connection/reset', () => {
      this.catalog.resetGeneration()
      for (const directory of this.live.directories.values) directory.resetConnected()
    })
    ctx.remote.$on('llm/adapters-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('llm/models-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('settings/document-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('credentials/record-updated', () => { this.catalog.refresh() })
    ctx.remote.$on('credentials/reference-updated', () => { this.catalog.refresh() })
  }

  /**
   * Install the picker for one mounted composer. Call from an effect whose cleanup runs
   * when the composer unmounts or changes Session.
   * @param target - the retained Session and mounted composer from the slot owner props.
   * @param open - synchronously open the picker and return true, or return false to keep the native fallback.
   * @returns an idempotent disposer for this registration.
   * @throws when the Session is no longer retained or this composer already has an opener.
   */
  registerPickerOpener(target: SessionModelPickerTarget, open: () => boolean): () => void {
    const { sessionId, composerId } = target
    const binding = this.ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('modelDirectories.registerPickerOpener requires a retained Session')
    const { pickerOpeners } = this.live
    let openers = pickerOpeners.get(binding)
    if (openers === undefined) {
      openers = new Map()
      pickerOpeners.set(binding, openers)
      const registered = openers
      binding.ctx.effect(() => () => {
        registered.clear()
        pickerOpeners.delete(binding)
      }, 'ui-model-selection: Session picker openers')
    }
    if (openers.has(composerId)) throw new Error('modelDirectories: composer already has a picker opener')
    const registration = () => open()
    openers.set(composerId, registration)
    const registered = openers
    return () => {
      if (registered.get(composerId) === registration) registered.delete(composerId)
    }
  }

  /**
   * Ask the initiating composer to open its registered picker.
   * @param target - the Session and composer captured by the initiating gesture.
   * @returns whether its picker opened. An unavailable Session or opener returns false.
   */
  openPicker(target: SessionModelPickerTarget): boolean {
    const { sessionId, composerId } = target
    const sessions = this.ctx.sessions
    const binding = sessions.binding(sessionId)
    if (binding === undefined || sessions.subagentAddress(sessionId) !== undefined) return false
    return this.live.pickerOpeners.get(binding)?.get(composerId)?.() === true
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this
    const sessions = this.ctx.sessions
    const actx = sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const binding = sessions.binding(sessionId)
    if (binding === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no binding`)
    const existing = live.directories.get(binding)
    if (existing !== undefined) return existing
    const directory = new ModelDirectory(
      this.ctx.remote.session,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      this.catalog,
      binding.session.projections.faceOf('modelSelection'),
      () => binding.session.getSnapshot().blank,
      (name, attributes) => this.ctx.get('productAnalytics')?.track(name, attributes),
    )
    live.directories.set(binding, directory)
    actx.effect(() => () => {
      directory.dispose()
      live.directories.delete(binding)
    }, 'ui-model-selection: session directory')
    return directory
  }
}
