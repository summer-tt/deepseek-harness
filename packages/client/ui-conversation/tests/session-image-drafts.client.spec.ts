// @vitest-environment jsdom
/**
 * Session image draft lifecycle over the production Conversation apply: the
 * native shell is created and released by retaining an ordinary Session, image
 * drafts follow their owning Session across release/rebind and authorization
 * changes, and every exit path (user removal, Session removal, authorization
 * handoff, route invalidation, scope disposal) releases the preview URL.
 */
import { apply as applyMenus, inject as injectMenus } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { act } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import {
  RemoteError, SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides, SessionFixtureSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  BeginSubmissionInput, ISession, PendingSubmissionRetirement, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  SessionHistoryInvalidation, SessionHistoryOwner, SessionHistoryRoute,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject, type ComposerBarInjected } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ComposerImageAttachment } from '../src/client/contract/slots.ts'
import type { InputHub } from '../src/client/input/hub.ts'
import type { ConversationController } from '../src/client/service.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The Conversation hub's hold on a Session whose image send awaits the Host result. */
    composerImageSubmission: unknown
  }
}

usePinnedBrowserLanguages('zh-CN')

/** A local (same-process Host) ordinary Session identity. */
const LOCAL = SessionId('local-session')
/** The paired Zen Host, as the 8-hex-digit server segment of a virtual identity. */
const SERVER = 'aabb0011'
/** Zen virtual Host ordinary Session identities: `zr~<server>~<session>` (see historyServer). */
const VIRTUAL = SessionId(`zr~${SERVER}~session-a`)
const VIRTUAL_B = SessionId(`zr~${SERVER}~session-b`)
const OWNER: SessionHistoryOwner = { ownerEpoch: 'browser-owner-1' as SessionHistoryOwner['ownerEpoch'], supportsHistoryWindowStart: true }
const NEXT_OWNER: SessionHistoryOwner = { ownerEpoch: 'browser-owner-2' as SessionHistoryOwner['ownerEpoch'], supportsHistoryWindowStart: true }
const ROUTE: SessionHistoryRoute = { serverId: SERVER, routeEpoch: 'route-1', available: true }
/** A second paired Zen Host with its own route, to prove a route change never crosses Hosts. */
const OTHER_SERVER = 'cceeff22'
const VIRTUAL_OTHER = SessionId(`zr~${OTHER_SERVER}~session-c`)
const OTHER_ROUTE: SessionHistoryRoute = { serverId: OTHER_SERVER, routeEpoch: 'other-route-1', available: true }
/** Durable image reference the Host echoes back for an observed retirement. */
const IMAGE_REF = {
  attachmentId: 'image-stored-1' as never,
  mediaType: 'image/png' as const,
  bytes: 1,
  width: 1,
  height: 1,
}

function imageFile(name: string): File {
  return new File([Uint8Array.of(1, 2, 3)], name, { type: 'image/png' })
}

/** The production hub's draft-authorization callbacks; the plugin core installs their Host-event listeners. */
interface DraftAuthorization {
  authorizeDraftOwner(ownerEpoch: string): void
  authorizeDraftRoute(route: SessionHistoryRoute): void
  invalidateDraftRouteSession(invalidation: SessionHistoryInvalidation): void
  resetDraftAuthorization(): void
  releaseDraftSession(id: SessionId): void
}

async function bench(options: { readonly remote?: boolean } = {}) {
  const runtime = await SlotTestRuntime.create()
  // The plugin core installs its history listeners only once both `remote` and `connection` exist.
  const generation = createSnapshotStore<{ readonly id: number } | undefined>(options.remote ? { id: 7 } : undefined)
  if (options.remote) runtime.ctx.provide('connection', { generation } as never)
  runtime.fileUpload.uploadImage = (sessionId: SessionId, ...args: unknown[]) => {
    const session = runtime.sessions.behavior(sessionId) as { uploadImage?: (...input: unknown[]) => Promise<unknown> }
    if (session.uploadImage === undefined) throw new Error('test image upload has no Session override')
    return session.uploadImage(...args)
  }
  type PromptResult = Awaited<ReturnType<ISession['prompt']>>
  const prompt = vi.fn((_content?: unknown, _mode?: unknown, _signal?: AbortSignal, _rpcId?: string) =>
    Promise.resolve<PromptResult>({ ok: true, value: { accepted: true } }))
  // Echo retirement driver: each submission's onRetire is recorded the way the Host queue would deliver it.
  const echoes: BeginSubmissionInput[] = []
  const beginSubmission = vi.fn((input: BeginSubmissionInput) => {
    echoes.push(input)
    return { requestId: `test-echo-${echoes.length}` as never, abandon: vi.fn() }
  })
  // One upload stub per Session: an ordinary Session uploads its images when added, and every upload answers ready.
  const uploadImages = new Map<SessionId, ReturnType<typeof vi.fn>>()
  const sessionFace = (id: SessionId): SessionBehaviorOverrides => {
    const uploadImage = vi.fn(() => Promise.resolve({ ok: true, value: { receiptId: `image-receipt-${id}` as never, image: IMAGE_REF } }))
    uploadImages.set(id, uploadImage)
    // The transcript's image loader verifies a retired echo's stored reference through the Session scope.
    const readAttachment = vi.fn((attachment: typeof IMAGE_REF) =>
      Promise.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1, 2, 3) } }))
    return { prompt, cancel: vi.fn(), loadOlder: vi.fn(), beginSubmission, uploadImage, readAttachment }
  }
  await runtime.sessions.add({ id: LOCAL, session: sessionFace(LOCAL) })
  await runtime.sessions.add({ id: VIRTUAL, session: sessionFace(VIRTUAL) })
  await runtime.sessions.add({ id: VIRTUAL_B, session: sessionFace(VIRTUAL_B) })
  await runtime.sessions.add({ id: VIRTUAL_OTHER, session: sessionFace(VIRTUAL_OTHER) })
  const developerTools = createSnapshotStore(true)
  runtime.ctx.provide('configForms', {
    developerTools: { enabled: developerTools, setEnabled: async () => {} },
    get: () => stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('uiWorkspace', { openWorkspace: vi.fn(), openSession: vi.fn() } as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) })
  await runtime.mount({ inject: [...injectMenus], apply: applyMenus })
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  }, () => null)
  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()

  // Deterministic object URLs: every image draft gets its own preview and every revocation is observable.
  let urlSeq = 0
  const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:draft-${++urlSeq}`)
  const revoked = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  onTestFinished(() => {
    created.mockRestore()
    revoked.mockRestore()
  })

  const hub = (): InputHub => (runtime.ctx.get('conversation') as unknown as { input: InputHub }).input
  const controller = (): ConversationController => runtime.ctx.get('conversation') as ConversationController
  /** Retain one Session the way the main view does and wait for its scope. */
  const retain = async (id: SessionId): Promise<SessionReference> => {
    const reference = runtime.sessions.retain(id, { source: 'mainView' })
    await reference.ready
    return reference
  }
  /** Release a retained Session inside act, so the mounted tree's ScopeProvider updates under the test's act scope. */
  const release = async (reference: SessionReference): Promise<void> => {
    await act(async () => { reference.release() })
    await runtime.flush()
  }
  /** Drive the composer's intake face for the retained Session (the paste/drop path). */
  const composer = (id: SessionId): ComposerBarInjected =>
    (runtime.slots.entries('conversation.composer.bar')[0]!.inject as unknown as (id: SessionId) => ComposerBarInjected)(id)
  /** Add one image through the production intake path and wait for its background upload to settle ready. */
  const addImage = async (id: SessionId, file: File): Promise<ComposerImageAttachment> => {
    expect(composer(id).addFiles?.([file])).toBeNull()
    const attachment = controller().resolveDraftAttachments(hub().shell(id).snapshot.attachmentIds).at(-1)
    if (attachment === undefined || attachment.kind !== 'image') throw new Error('image draft missing')
    await vi.waitFor(() => {
      expect(controller().fileUploads.getSnapshot()[attachment.id]).toEqual({ status: 'ready', receiptId: `image-receipt-${id}` })
    })
    return attachment
  }
  /** Preview URLs of the images a Session's draft still holds, in draft order. */
  const previewsOf = (id: SessionId): string[] => controller()
    .resolveDraftAttachments(hub().shell(id).snapshot.attachmentIds)
    .flatMap(attachment => attachment.kind === 'image' ? [attachment.previewUrl] : [])
  /** How many of these ids the draft registry still holds. */
  const live = (...ids: string[]): number => controller().resolveDraftAttachments(ids as never).length
  /** Observe the retirement of the echo a send registered (1-based), as the Host queue would. */
  const retire = (index: number, reason: PendingSubmissionRetirement['reason']): void => {
    const onRetire = echoes[index - 1]?.onRetire
    if (onRetire === undefined) throw new Error(`echo ${index} recorded no retirement callback`)
    onRetire(reason === 'observed' ? { reason, attachments: [IMAGE_REF] } : { reason })
  }
  return {
    runtime, feature, prompt, echoes, generation, uploadImages, created, revoked,
    retain, release, composer, addImage, previewsOf, live, retire,
    hub, controller, authorize: hub() as unknown as DraftAuthorization,
  }
}
type Bench = Awaited<ReturnType<typeof bench>>

/** Retain `id` and create its shell through the hub. */
async function shellFor(b: Bench, id: SessionId) {
  const reference = await b.retain(id)
  return { reference, shell: b.hub().shellFor(reference.binding) }
}

/**
 * Submit `text` with the draft's images and leave the Host's answer pending: the composer holds
 * everything read-only until `receipt` settles. Returns the abort signal the Host received.
 */
async function submitPending(
  b: Bench, shell: { submit(mode?: 'queue', source?: 'click'): void }, receipt: Promise<Awaited<ReturnType<ISession['prompt']>>>,
) {
  b.prompt.mockImplementationOnce(() => receipt)
  shell.submit('queue', 'click')
  await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
  return b.prompt.mock.calls[0]?.[2] as AbortSignal
}

describe('Session image drafts: native shell release and rebind', () => {
  it('releases the shell and its preview when an unverified Host’s Session is released, then rebinds a fresh empty shell', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const first = await shellFor(b, LOCAL)
    const image = await b.addImage(LOCAL, imageFile('first.png'))
    const staleBinding = first.reference.binding

    await b.release(first.reference)
    // Without a verified route the pairing cannot be proven: the scope releases the shell and its draft attachments.
    expect(b.live(image.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(image.previewUrl)
    expect(() => b.hub().shellFor(staleBinding)).toThrow()
    expect(b.runtime.sessions.binding(LOCAL)).toBeUndefined()

    const second = await shellFor(b, LOCAL)
    expect(second.reference.binding).not.toBe(staleBinding)
    expect(second.shell).not.toBe(first.shell)
    expect(second.shell.snapshot).toMatchObject({ draft: '', attachmentIds: [], phase: 'plain' })
    expect(b.revoked).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'a verified local Session', id: LOCAL, route: undefined },
    { name: 'a verified virtual Session', id: VIRTUAL, route: ROUTE },
  ])('restores the same image id and preview URL on the newly bound shell after release and rebind of $name', async ({ id, route }) => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    if (route !== undefined) b.authorize.authorizeDraftRoute(route)
    const first = await shellFor(b, id)
    const image = await b.addImage(id, imageFile('carried.png'))
    const staleBinding = first.reference.binding

    await b.release(first.reference)
    // The authorization proves the pairing: the image and its preview outlive the binding that created them.
    expect(b.runtime.sessions.binding(id)).toBeUndefined()
    expect(b.live(image.id)).toBe(1)
    expect(b.revoked).not.toHaveBeenCalled()

    const second = await shellFor(b, id)
    expect(second.reference.binding).not.toBe(staleBinding)
    expect(second.shell).not.toBe(first.shell)
    expect(second.shell.snapshot.attachmentIds).toEqual([image.id])
    expect(b.previewsOf(id)).toEqual([image.previewUrl])
    expect(b.created).toHaveBeenCalledOnce()
    // The restored image is live: an explicit removal is what releases it.
    b.composer(id).removeAttachment?.(image.id)
    expect(second.shell.snapshot.attachmentIds).toEqual([])
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(image.previewUrl)
  })

  it('keeps the pre-owner route authorized through the first owner in the Zen ready→route→owner order, releasing images that predate each grant', async () => {
    const b = await bench({ remote: true })
    onTestFinished(() => b.runtime.dispose())
    const emit = (event: string, args: readonly unknown[]) => { b.runtime.remote.emit(event, args) }
    const first = await shellFor(b, VIRTUAL)
    const beforeRoute = await b.addImage(VIRTUAL, imageFile('before-route.png'))
    // Zen publishes the already-online Host route before the browser owner frame arrives; the route
    // releases what it cannot vouch for, and a draft admitted under it is authorized without an owner.
    emit('api-session/history-route', [ROUTE])
    expect(b.live(beforeRoute.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(beforeRoute.previewUrl)
    const afterRoute = await b.addImage(VIRTUAL, imageFile('after-route.png'))
    expect(first.shell.snapshot.attachmentIds).toEqual([afterRoute.id])

    // The first owner authenticates: it clears what it cannot vouch for but keeps the route it found authorized.
    emit('api-session/history-owner', [OWNER])
    expect(first.shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(afterRoute.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledTimes(2)

    // The route survived the owner handoff: a draft under it parks across a release and is restored on rebind.
    const kept = await b.addImage(VIRTUAL, imageFile('kept.png'))
    await b.release(first.reference)
    expect(b.live(kept.id)).toBe(1)
    expect(b.revoked).toHaveBeenCalledTimes(2)
    const back = await shellFor(b, VIRTUAL)
    expect(back.shell.snapshot.attachmentIds).toEqual([kept.id])
    expect(b.previewsOf(VIRTUAL)).toEqual([kept.previewUrl])
  })

  it('ignores late owner and route grants for a rejected connection generation until the generation changes', async () => {
    const b = await bench({ remote: true })
    onTestFinished(() => b.runtime.dispose())
    const emit = (event: string, args: readonly unknown[]) => { b.runtime.remote.emit(event, args) }
    const { shell } = await shellFor(b, VIRTUAL)
    emit('api-session/history-owner', [OWNER])
    emit('api-session/history-route', [ROUTE])
    const image = await b.addImage(VIRTUAL, imageFile('before-reject.png'))
    // The Host rejects this generation's credentials: everything authorized under it is released.
    b.runtime.ctx.emit('connection/authentication-rejected', { generation: 7 })
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(image.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(image.previewUrl)

    // Late frames for the rejected generation grant nothing, so neither their grants nor their releases fire.
    const ignored = await b.addImage(VIRTUAL, imageFile('ignored.png'))
    emit('api-session/history-owner', [NEXT_OWNER])
    emit('api-session/history-route', [{ ...ROUTE, routeEpoch: 'route-2' }])
    expect(shell.snapshot.attachmentIds).toEqual([ignored.id])
    expect(b.live(ignored.id)).toBe(1)
    expect(b.revoked).toHaveBeenCalledTimes(1)

    // A new connection generation reopens authorization, releasing the unproven draft with the old generation.
    b.generation.set({ id: 8 })
    await b.runtime.flush()
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(ignored.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledTimes(2)
    // Grants under the new generation apply again: the owner admits the draft and the route authorizes it.
    emit('api-session/history-owner', [NEXT_OWNER])
    emit('api-session/history-route', [{ ...ROUTE, routeEpoch: 'route-2' }])
    const fresh = await b.addImage(VIRTUAL, imageFile('fresh.png'))
    expect(shell.snapshot.attachmentIds).toEqual([fresh.id])
    b.runtime.ctx.emit('connection/authentication-rejected', { generation: 8 })
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(fresh.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledTimes(3)
  })

  it('keeps each Session’s images on its own shell while switching rapidly between two virtual Sessions', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    const a = await shellFor(b, VIRTUAL)
    const other = await shellFor(b, VIRTUAL_B)
    const first = await b.addImage(VIRTUAL, imageFile('a.png'))
    const second = await b.addImage(VIRTUAL_B, imageFile('b.png'))
    a.shell.setDraft('for a')
    other.shell.setDraft('for b')

    // Rapid lookups through every hub path land on the same resident shells, each with its own text and image.
    for (let i = 0; i < 5; i++) {
      expect(b.hub().shell(VIRTUAL)).toBe(a.shell)
      expect(b.hub().shell(VIRTUAL_B)).toBe(other.shell)
      expect(b.hub().for(b.runtime.sessions.scope(VIRTUAL)!)).toBe(a.shell)
      expect(b.hub().for(b.runtime.sessions.scope(VIRTUAL_B)!)).toBe(other.shell)
    }
    expect(a.shell.snapshot).toMatchObject({ draft: 'for a', attachmentIds: [first.id] })
    expect(other.shell.snapshot).toMatchObject({ draft: 'for b', attachmentIds: [second.id] })
    expect(b.previewsOf(VIRTUAL)).toEqual([first.previewUrl])
    expect(b.previewsOf(VIRTUAL_B)).toEqual([second.previewUrl])
    expect(b.revoked).not.toHaveBeenCalled()
  })
})

describe('Session image drafts: send outcomes', () => {
  it('sends text and an image together by receipt and hands the preview to the transcript until the binding is released', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const { reference, shell } = await shellFor(b, LOCAL)
    const image = await b.addImage(LOCAL, imageFile('with-text.png'))
    shell.setDraft('看看这张图')
    const receipt = Promise.withResolvers<Awaited<ReturnType<ISession['prompt']>>>()
    await submitPending(b, shell, receipt.promise)
    // The composer keeps the sent text and image, read-only, until the Host answers.
    expect(shell.snapshot).toMatchObject({ phase: 'sending', draft: '看看这张图', attachmentIds: [image.id] })
    expect(b.prompt.mock.calls[0]?.[0]).toEqual([
      { type: 'file', receiptId: `image-receipt-${LOCAL}` },
      { type: 'text', text: '看看这张图' },
    ])
    expect(b.echoes[0]).toMatchObject({ mode: 'queue', text: '看看这张图' })
    expect(b.echoes[0]?.attachments[0]).toMatchObject({ type: 'image', value: { previewUrl: image.previewUrl, name: 'with-text.png' } })

    receipt.resolve({ ok: true, value: { accepted: true } })
    await vi.waitFor(() => { expect(shell.snapshot).toMatchObject({ phase: 'plain', draft: '', attachmentIds: [] }) })
    // Accepted: the draft registry lets the image go at the observed retirement and the transcript's image
    // cache adopts its preview, which it keeps until the Session binding that displays it is released.
    expect(b.live(image.id)).toBe(1)
    b.retire(1, 'observed')
    expect(b.live(image.id)).toBe(0)
    expect(b.revoked).not.toHaveBeenCalled()
    await b.release(reference)
    // Releasing the binding revokes the adopted preview (and the transcript cache's own canonical-URL load).
    expect(b.revoked).toHaveBeenCalledWith(image.previewUrl)
  })

  it('sends an image-only draft with no text block', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const { shell } = await shellFor(b, LOCAL)
    await b.addImage(LOCAL, imageFile('only.png'))
    shell.submit('queue', 'click')
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    expect(b.prompt.mock.calls[0]?.[0]).toEqual([{ type: 'file', receiptId: `image-receipt-${LOCAL}` }])
    expect(b.prompt.mock.calls[0]?.[1]).toBe('queue')
    await vi.waitFor(() => { expect(shell.snapshot).toMatchObject({ phase: 'plain', draft: '', attachmentIds: [] }) })
  })

  it('keeps text and images for correction, with the preview alive, when the Host refuses the send', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const { shell } = await shellFor(b, LOCAL)
    const image = await b.addImage(LOCAL, imageFile('kept.png'))
    shell.setDraft('retry me')
    b.prompt.mockResolvedValueOnce({ ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }) })
    shell.submit('queue', 'click')
    await vi.waitFor(() => { expect(b.prompt).toHaveBeenCalledOnce() })
    await vi.waitFor(() => { expect(shell.snapshot.phase).toBe('plain') })
    expect(shell.snapshot).toMatchObject({ draft: 'retry me', attachmentIds: [image.id] })
    expect(b.previewsOf(LOCAL)).toEqual([image.previewUrl])
    // The failed echo retires; the draft keeps everything for a retry until the user removes the image.
    b.retire(1, 'failed')
    expect(b.live(image.id)).toBe(1)
    expect(b.revoked).not.toHaveBeenCalled()
    b.composer(LOCAL).removeAttachment?.(image.id)
    expect(shell.snapshot).toMatchObject({ draft: 'retry me', attachmentIds: [] })
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(image.previewUrl)
  })

  it.each(['success', 'failure'] as const)(
    'keeps a verified in-flight image send alive while the view leaves and returns, then settles on Host %s',
    async (outcome) => {
      const b = await bench()
      onTestFinished(() => b.runtime.dispose())
      b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
      b.authorize.authorizeDraftRoute(ROUTE)
      const view = await shellFor(b, VIRTUAL)
      const image = await b.addImage(VIRTUAL, imageFile('in-flight.png'))
      const receipt = Promise.withResolvers<{ ok: true; value: { accepted: true } } | { ok: false; error: RemoteError }>()
      const signal = await submitPending(b, view.shell, receipt.promise)
      const binding = view.reference.binding

      // The view leaves while the Host decides. The send holds the Session under its own consumer
      // source, so the binding, the attempt, and the frozen rail all stay exactly as they were.
      view.reference.release()
      await b.runtime.flush()
      expect(b.runtime.sessions.binding(VIRTUAL)).toBe(binding)
      expect(signal.aborted).toBe(false)
      expect(b.runtime.sessions.retainInfo(VIRTUAL).getSnapshot().retainedBy.composerImageSubmission).toBe(1)
      expect(view.shell.snapshot).toMatchObject({ phase: 'sending', attachmentIds: [image.id] })
      expect(b.live(image.id)).toBe(1)
      expect(b.revoked).not.toHaveBeenCalled()
      // The frozen rail refuses removal and late intake while the send is pending.
      expect(view.shell.removeAttachment(image.id)).toBe(false)
      b.composer(VIRTUAL).addFiles?.([imageFile('late.png')])
      expect(view.shell.snapshot.attachmentIds).toEqual([image.id])
      expect(b.live(image.id)).toBe(1)

      // The view comes back during the send and lands on the same resident shell, still sending.
      const back = await shellFor(b, VIRTUAL)
      expect(back.reference.binding).toBe(binding)
      expect(back.shell).toBe(view.shell)
      expect(back.shell.snapshot).toMatchObject({ phase: 'sending', attachmentIds: [image.id] })
      expect(signal.aborted).toBe(false)

      // The Host answers: success clears the image and releases the hold; failure keeps it for correction.
      if (outcome === 'success') {
        receipt.resolve({ ok: true, value: { accepted: true } })
        await vi.waitFor(() => { expect(back.shell.snapshot).toMatchObject({ phase: 'plain', attachmentIds: [] }) })
        b.retire(1, 'observed')
        expect(b.live(image.id)).toBe(0)
      } else {
        receipt.resolve({ ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }) })
        await vi.waitFor(() => { expect(back.shell.snapshot).toMatchObject({ phase: 'plain', attachmentIds: [image.id] }) })
        expect(b.live(image.id)).toBe(1)
        expect(b.revoked).not.toHaveBeenCalled()
      }
      await vi.waitFor(() => {
        expect(b.runtime.sessions.retainInfo(VIRTUAL).getSnapshot().retainedBy.composerImageSubmission ?? 0).toBe(0)
      })
      await b.release(back.reference)
    },
  )

})

describe('Session image drafts: removal, revocation, and invalidation', () => {
  it('admits image intake before any authorization on local and remote Sessions alike', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const local = await shellFor(b, LOCAL)
    const remote = await shellFor(b, VIRTUAL)
    expect(b.composer(LOCAL).addFiles?.([imageFile('early-local.png')])).toBeNull()
    expect(b.composer(VIRTUAL).addFiles?.([imageFile('early-remote.png')])).toBeNull()
    expect(local.shell.snapshot.attachmentIds).toHaveLength(1)
    expect(remote.shell.snapshot.attachmentIds).toHaveLength(1)
    expect(b.previewsOf(LOCAL)).toHaveLength(1)
    expect(b.previewsOf(VIRTUAL)).toHaveLength(1)
    expect(b.created).toHaveBeenCalledTimes(2)
  })

  it('revokes only the preview of the image the user removes', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const { shell } = await shellFor(b, LOCAL)
    const first = await b.addImage(LOCAL, imageFile('remove-me.png'))
    const kept = await b.addImage(LOCAL, imageFile('keep-me.png'))
    b.composer(LOCAL).removeAttachment?.(first.id)
    expect(shell.snapshot.attachmentIds).toEqual([kept.id])
    expect(b.live(first.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(first.previewUrl)
    expect(b.live(kept.id)).toBe(1)
  })

  it('releases every image and revokes each preview synchronously when the Session is removed', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    const { shell } = await shellFor(b, VIRTUAL)
    const first = await b.addImage(VIRTUAL, imageFile('gone-1.png'))
    const second = await b.addImage(VIRTUAL, imageFile('gone-2.png'))
    b.authorize.releaseDraftSession(VIRTUAL)
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(first.id, second.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledWith(first.previewUrl)
    expect(b.revoked).toHaveBeenCalledWith(second.previewUrl)
  })

  it('invalidates a virtual Session’s images only on the current route epoch and leaves other Sessions and Hosts alone', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    b.authorize.authorizeDraftRoute(OTHER_ROUTE)
    const remote = await shellFor(b, VIRTUAL)
    const sibling = await shellFor(b, VIRTUAL_B)
    const local = await shellFor(b, LOCAL)
    const otherHost = await shellFor(b, VIRTUAL_OTHER)
    const revokedImage = await b.addImage(VIRTUAL, imageFile('revoked.png'))
    const siblingImage = await b.addImage(VIRTUAL_B, imageFile('sibling.png'))
    const localImage = await b.addImage(LOCAL, imageFile('local.png'))
    const otherImage = await b.addImage(VIRTUAL_OTHER, imageFile('other-host.png'))
    const stale: SessionHistoryInvalidation = { serverId: SERVER, routeEpoch: 'route-0', sessionId: VIRTUAL }
    b.authorize.invalidateDraftRouteSession(stale)
    expect(b.live(revokedImage.id)).toBe(1)
    expect(b.revoked).not.toHaveBeenCalled()

    b.authorize.invalidateDraftRouteSession({ ...stale, routeEpoch: ROUTE.routeEpoch })
    expect(remote.shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(revokedImage.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(revokedImage.previewUrl)
    // The sibling on the same Host, the local Session, and the other Host are not part of the invalidated address.
    expect(sibling.shell.snapshot.attachmentIds).toEqual([siblingImage.id])
    expect(local.shell.snapshot.attachmentIds).toEqual([localImage.id])
    expect(otherHost.shell.snapshot.attachmentIds).toEqual([otherImage.id])
    // A route epoch replaced on one Host never reaches the other Host's drafts.
    b.authorize.authorizeDraftRoute({ ...ROUTE, routeEpoch: 'route-2' })
    expect(sibling.shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(siblingImage.id)).toBe(0)
    expect(otherHost.shell.snapshot.attachmentIds).toEqual([otherImage.id])
    expect(b.live(otherImage.id)).toBe(1)
    expect(b.revoked).toHaveBeenCalledTimes(2)
    b.authorize.authorizeDraftRoute({ ...OTHER_ROUTE, routeEpoch: 'other-route-2' })
    expect(otherHost.shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(otherImage.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledTimes(3)
  })

  it.each([
    { name: 'a replaced route epoch', change: (b: Bench) => { b.authorize.authorizeDraftRoute({ ...ROUTE, routeEpoch: 'route-2' }) } },
    { name: 'a route that becomes unavailable', change: (b: Bench) => { b.authorize.authorizeDraftRoute({ ...ROUTE, available: false }) } },
  ])('drops the Host route’s images on $name and leaves local Sessions alone', async ({ change }) => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    const local = await shellFor(b, LOCAL)
    const remote = await shellFor(b, VIRTUAL)
    const localImage = await b.addImage(LOCAL, imageFile('local.png'))
    const remoteImage = await b.addImage(VIRTUAL, imageFile('remote.png'))
    change(b)
    expect(remote.shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(remoteImage.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(remoteImage.previewUrl)
    // A local Session is outside every relay route.
    expect(local.shell.snapshot.attachmentIds).toEqual([localImage.id])
    expect(b.live(localImage.id)).toBe(1)
  })

  it.each([
    { name: 'a new owner epoch', change: (b: Bench) => { b.authorize.authorizeDraftOwner(NEXT_OWNER.ownerEpoch) } },
    { name: 'an authorization reset', change: (b: Bench) => { b.authorize.resetDraftAuthorization() } },
  ])('drops every draft image, local and remote, on $name', async ({ change }) => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    const local = await shellFor(b, LOCAL)
    const remote = await shellFor(b, VIRTUAL)
    const localImage = await b.addImage(LOCAL, imageFile('local.png'))
    const remoteImage = await b.addImage(VIRTUAL, imageFile('remote.png'))
    change(b)
    expect(local.shell.snapshot.attachmentIds).toEqual([])
    expect(remote.shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(localImage.id, remoteImage.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledWith(localImage.previewUrl)
    expect(b.revoked).toHaveBeenCalledWith(remoteImage.previewUrl)
    expect(b.revoked).toHaveBeenCalledTimes(2)
  })

  it('restores the image and a failure notice when the Host rejects a verified send while the view is away', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    const view = await shellFor(b, VIRTUAL)
    const image = await b.addImage(VIRTUAL, imageFile('away.png'))
    view.shell.setDraft('retry away')
    const refusal = new RemoteError('gateway/internal', 'connection reset', {})
    const receipt = Promise.withResolvers<Awaited<ReturnType<ISession['prompt']>>>()
    await submitPending(b, view.shell, receipt.promise)
    const binding = view.reference.binding
    // The refusal surfaces on the Session snapshot the way the production transport publishes it.
    void receipt.promise.then(() => b.runtime.sessions.updateSessionSnapshot(VIRTUAL, (state: SessionFixtureSnapshot) => {
      state.promptError = { op: 'send', error: refusal }
    }))

    // The view leaves; the Host then rejects the prompt as a transport failure while nobody is looking.
    view.reference.release()
    await b.runtime.flush()
    expect(b.runtime.sessions.binding(VIRTUAL)).toBe(binding)
    receipt.resolve({ ok: false, error: new RemoteError('gateway/internal', 'connection reset', {}) })
    await vi.waitFor(() => {
      expect(b.runtime.sessions.retainInfo(VIRTUAL).getSnapshot().retainedBy.composerImageSubmission ?? 0).toBe(0)
    })
    // Settlement released the send's hold; with the view still away the binding is unheld, so the
    // rejected image is parked with the draft and its failure notice instead of being drawn anywhere.
    await vi.waitFor(() => { expect(b.runtime.sessions.binding(VIRTUAL)).toBeUndefined() })
    expect(b.live(image.id)).toBe(1)
    expect(b.revoked).not.toHaveBeenCalled()

    // The view returns: the parked image and the failure notice come back with it, and the text survives.
    const back = await shellFor(b, VIRTUAL)
    expect(back.shell.snapshot).toMatchObject({ phase: 'plain', attachmentIds: [image.id] })
    expect(b.previewsOf(VIRTUAL)).toEqual([image.previewUrl])
    expect(back.shell.notices.getSnapshot()).toMatchObject({ level: 'error' })
    expect(b.revoked).not.toHaveBeenCalled()
  })

  it('revokes an in-flight image’s preview when an unverified Host’s Session is released while the Host is still deciding', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const original = await shellFor(b, LOCAL)
    const image = await b.addImage(LOCAL, imageFile('in-flight.png'))
    const receipt = Promise.withResolvers<Awaited<ReturnType<ISession['prompt']>>>()
    const signal = await submitPending(b, original.shell, receipt.promise)
    expect(signal.aborted).toBe(false)

    await b.release(original.reference)
    expect(signal.aborted).toBe(true)
    expect(b.live(image.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(image.previewUrl)
    // A late Host acceptance after the shell is gone changes nothing.
    receipt.resolve({ ok: true, value: { accepted: true } })
    await b.runtime.flush()
    expect(b.live(image.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledOnce()
  })

  it('follows the forwarded Host history events and the owner’s connection generation through the production listeners', async () => {
    const b = await bench({ remote: true })
    onTestFinished(() => b.runtime.dispose())
    const { shell } = await shellFor(b, VIRTUAL)
    const emit = (event: string, args: readonly unknown[]) => { b.runtime.remote.emit(event, args) }

    // The browser owner arrives through the event stream, then the paired Host route.
    emit('api-session/history-owner', [OWNER])
    emit('api-session/history-route', [ROUTE])
    const image = await b.addImage(VIRTUAL, imageFile('remote.png'))
    expect(shell.snapshot.attachmentIds).toEqual([image.id])

    // The Host revokes sharing for this Session on the current route: its image is erased.
    emit('api-session/history-invalidated', [{ serverId: SERVER, routeEpoch: ROUTE.routeEpoch, sessionId: VIRTUAL }])
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(image.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledExactlyOnceWith(image.previewUrl)

    // A stale route epoch is ignored; the Host removing the Session releases a later draft.
    const stale = await b.addImage(VIRTUAL, imageFile('stale.png'))
    emit('api-session/history-invalidated', [{ serverId: SERVER, routeEpoch: 'route-0', sessionId: VIRTUAL }])
    expect(shell.snapshot.attachmentIds).toEqual([stale.id])
    expect(b.revoked).toHaveBeenCalledTimes(1)
    emit('api-session/removed', [VIRTUAL])
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(stale.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledTimes(2)

    // Authorization ending on the owner's connection generation resets; another generation changes nothing.
    const kept = await b.addImage(VIRTUAL, imageFile('kept.png'))
    b.runtime.ctx.emit('connection/history-authorization-ended', { generation: 6 })
    expect(shell.snapshot.attachmentIds).toEqual([kept.id])
    expect(b.revoked).toHaveBeenCalledTimes(2)
    b.runtime.ctx.emit('connection/history-authorization-ended', { generation: 7 })
    expect(shell.snapshot.attachmentIds).toEqual([])
    expect(b.live(kept.id)).toBe(0)
    expect(b.revoked).toHaveBeenCalledTimes(3)
  })

  it('releases every remaining image and URL when the Conversation plugin is disposed', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    await shellFor(b, LOCAL)
    b.authorize.authorizeDraftOwner(OWNER.ownerEpoch)
    b.authorize.authorizeDraftRoute(ROUTE)
    await shellFor(b, VIRTUAL)
    const localImage = await b.addImage(LOCAL, imageFile('dispose-local.png'))
    const remoteImage = await b.addImage(VIRTUAL, imageFile('dispose-remote.png'))
    // The conversation service leaves with the plugin fiber; keep its handles to read what it released.
    const controller = b.controller()
    const uploads = controller.fileUploads
    expect(Object.keys(uploads.getSnapshot())).toHaveLength(2)

    await b.feature.dispose()
    expect(b.runtime.ctx.get('conversation')).toBeUndefined()
    expect(controller.resolveDraftAttachments([localImage.id, remoteImage.id])).toEqual([])
    expect(b.revoked).toHaveBeenCalledWith(localImage.previewUrl)
    expect(b.revoked).toHaveBeenCalledWith(remoteImage.previewUrl)
    expect(b.revoked).toHaveBeenCalledTimes(2)
    expect(uploads.getSnapshot()).toEqual({})
  })
})
