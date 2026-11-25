import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { IPtyForkOptions } from 'node-pty'
import type { Config } from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'
import { cleanupLinuxLaunchFiles, consumeLinuxLaunchRequest, linuxLaunchFilesFromLocator } from '../src/runner-protocol.ts'

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() }))
const spawnPty = vi.hoisted(() => vi.fn())
vi.mock('@deepseek-ai/dsh-lazy-require', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-lazy-require')>()
  return {
    ...actual,
    createLazyRequire: (name: string, from: string) => name === 'node-pty'
      ? () => ({ spawn: spawnPty }) : actual.createLazyRequire(name, from),
  }
})
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  ...childProcess,
}))
vi.mock('../src/linux-execve.ts', () => ({
  loadLinuxExecve: () => () => { throw new Error('The fixture must not exec a target') },
}))

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdin = null
  stdout = null
  stderr = null

  constructor(readonly pid: number, readonly requestPath: string) { super() }

  exit(): void {
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

type Reply = (error: Error | null, stdout: string, stderr: string) => void

class FakePty {
  private exitListener: ((event: { exitCode: number }) => void) | undefined

  constructor(readonly pid: number) {}

  onData(): { dispose(): void } { return { dispose() {} } }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListener = listener
    return { dispose: () => { this.exitListener = undefined } }
  }

  exit(): void { this.exitListener?.({ exitCode: 0 }) }
}

function peakStartsInSecond(starts: readonly number[]): number {
  let first = 0
  let peak = 0
  for (const [last, time] of starts.entries()) {
    while (time - (starts[first] ?? time) >= 1_000) first += 1
    peak = Math.max(peak, last - first + 1)
  }
  return peak
}

async function scopeFixture(config: Config = {}) {
  const children = new Map<string, FakeChild>()
  const terminals = new Map<string, FakePty>()
  const launchPaths: string[] = []
  const kills: string[][] = []
  const pending = new Map<string, Reply>()
  const queries: string[] = []
  let finishing = false
  let onLaunch: ((kind: 'ordinary' | 'terminal') => void) | undefined
  let respond = (unit: string, reply: Reply): void => { pending.set(unit, reply) }
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
  childProcess.spawn.mockImplementation((file: string, args: string[], options: SpawnOptions) => {
    const unit = args.find(arg => arg.startsWith('--unit=dsh-subprocess-'))?.slice('--unit='.length)
    const requestPath = options.env?.[SUBPROCESS_RUNNER_ENV]
    if (file !== 'systemd-run' || !args.includes('--scope') || unit === undefined || requestPath === undefined) {
      throw new Error('Expected the native user scope launcher, not a fallback process')
    }
    const child = new FakeChild(10_000 + children.size, requestPath)
    children.set(`${unit}.scope`, child)
    launchPaths.push(requestPath)
    consumeLinuxLaunchRequest(requestPath)
    onLaunch?.('ordinary')
    return child
  })
  spawnPty.mockImplementation((file: string, args: string[], options: IPtyForkOptions) => {
    const unit = args.find(arg => arg.startsWith('--unit=dsh-terminal-'))?.slice('--unit='.length)
    const requestPath = options.env?.[SUBPROCESS_RUNNER_ENV]
    if (file !== 'systemd-run' || unit === undefined || requestPath === undefined) throw new Error('Expected a terminal scope')
    const pty = new FakePty(20_000 + terminals.size)
    terminals.set(`${unit}.scope`, pty)
    launchPaths.push(requestPath)
    consumeLinuxLaunchRequest(requestPath)
    onLaunch?.('terminal')
    return pty
  })
  childProcess.spawnSync.mockImplementation((file: string, args: string[]) => {
    const [user, operation] = args
    if (user === '--user' && (
      (file === 'systemd-run' && operation === '--scope')
      || (file === 'systemctl' && operation === 'show' && args.includes('--property=Version'))
    )) return { status: 0, stdout: '', stderr: '' }
    const unit = args.at(-1) ?? ''
    if (user === '--user' && file === 'systemctl' && operation === 'kill' && (children.has(unit) || terminals.has(unit))) {
      kills.push(args)
      return { status: 0, stdout: '', stderr: '' }
    }
    throw new Error(`Unexpected synchronous process request: ${file} ${args.join(' ')}`)
  })
  childProcess.execFile.mockImplementation((file: string, args: string[], _options: object, reply: Reply) => {
    const [user, operation, unit] = args
    if (file !== 'systemctl' || user !== '--user' || operation !== 'show' || unit === undefined
      || (!children.has(unit) && !terminals.has(unit))) {
      throw new Error(`Unexpected async process request: ${file} ${args.join(' ')}`)
    }
    if (pending.has(unit)) throw new Error(`Two in-flight queries for ${unit}`)
    queries.push(unit)
    if (finishing) queueMicrotask(() =>{  replyState(reply, 'inactive'); })
    else respond(unit, reply)
    return new EventEmitter()
  })

  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime, config)
  const dispose = async (): Promise<void> => {
    finishing = true
    for (const [unit, reply] of pending) {
      pending.delete(unit)
      replyState(reply, 'inactive')
    }
    for (const child of children.values()) if (child.exitCode === null) child.exit()
    for (const terminal of terminals.values()) terminal.exit()
    await fiber.dispose()
  }
  return {
    children, ctx, fiber, kills, pending, queries, signal, terminals, dispose,
    onLaunch: (callback: typeof onLaunch) => { onLaunch = callback },
    ordinary: (graceMs = 100): SubprocessHandle => ctx.subprocess.spawn({
      argv: ['fixture-target'], cwd: process.cwd(), env: {},
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, graceMs,
    }),
    onQuery: (next: typeof respond) => { respond = next },
    complete(unit: string, state: 'active' | 'inactive' | Error): void {
      const reply = pending.get(unit)
      if (reply === undefined) throw new Error(`No in-flight query for ${unit}`)
      pending.delete(unit)
      if (state instanceof Error) reply(state, '', '')
      else replyState(reply, state)
    },
    async cleanup(): Promise<void> {
      try {
        await dispose()
      } finally {
        signal.mockRestore()
        for (const requestPath of launchPaths) cleanupLinuxLaunchFiles(linuxLaunchFilesFromLocator(requestPath))
      }
    },
  }
}

const EXPECTED_SHUTDOWN_ERROR = 'subprocess-local: provider is shutting down'

function terminalSpec() {
  return {
    argv: ['fixture-shell'], cwd: process.cwd(), rows: 24, cols: 80,
    terminalType: 'dumb', graceMs: 1_000, env: {},
  } as const
}

function ordinarySpec() {
  return {
    argv: ['fixture-target'], cwd: process.cwd(), env: {},
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, graceMs: 1_000,
  } as const
}

function replyState(reply: Reply, state: 'active' | 'inactive'): void {
  reply(null, `LoadState=loaded\nActiveState=${state}\nTasksCurrent=[not set]\n`, '')
}

it.skipIf(process.platform !== 'linux')('bounds status-query starts for a burst of naturally exited Linux scopes', { timeout: 10_000 }, async () => {
  const fixture = await scopeFixture()
  const { children, signal } = fixture
  const scopeCount = 32
  const starts: number[] = []
  const observedActive = new Set<string>()
  fixture.onQuery((unit, reply) => {
    starts.push(performance.now())
    const state = observedActive.has(unit) ? 'inactive' : 'active'
    observedActive.add(unit)
    queueMicrotask(() =>{  replyState(reply, state); })
  })
  try {
    const handles = Array.from({ length: scopeCount }, () => fixture.ordinary())
    expect(children.size).toBe(scopeCount)
    for (const child of children.values()) child.exit()
    expect(await Promise.all(handles.map(handle => handle.done))).toEqual(
      Array.from({ length: scopeCount }, () => ({ exitCode: 0, signal: null })),
    )
    expect(await Promise.all(handles.map(handle => handle.waitForExit()))).toEqual(Array.from({ length: scopeCount }, () => true))
    expect(observedActive.size).toBe(scopeCount)
    expect(starts).toHaveLength(scopeCount * 2)
    expect(fixture.kills).toEqual([])
    expect(signal).not.toHaveBeenCalled()
    expect(peakStartsInSecond(starts), 'ordinary systemctl show starts in a rolling second').toBeLessThanOrEqual(20)
  } finally {
    await fixture.cleanup()
  }
})

it.skipIf(process.platform !== 'linux').each(['ordinary', 'terminal'] as const)(
  'rejects an old service reference after dispose reenters during %s allocation', async (kind) => {
    const fixture = await scopeFixture()
    const service = fixture.ctx.subprocess
    let disposal: Promise<void> | undefined
    fixture.onLaunch(() => { disposal ??= fixture.fiber.dispose() })
    try {
      const launch = kind === 'ordinary' ? service.spawn(ordinarySpec()) : await service.spawnTerminal(terminalSpec())
      expect(disposal).toBeDefined()
      await vi.waitFor(() =>{  expect(fixture.kills).toHaveLength(1); })
      const unit = fixture.kills[0]?.at(-1)
      if (unit === undefined) throw new Error('Expected teardown to include the reentrant launch')
      await vi.waitFor(() =>{  expect(fixture.pending.has(unit)).toBe(true); })
      fixture.onLaunch(() => { throw new Error('Launch adapter reached after disposal began') })
      const launchCalls = () => childProcess.spawn.mock.calls.length + spawnPty.mock.calls.length
      const before = launchCalls()
      const ordinary = (): void => { service.spawn(ordinarySpec()) }
      const rejection = () => service.spawnTerminal(terminalSpec()).then(() => undefined, (error: unknown) => error)
      const duringDispose = await rejection()
      fixture.children.get(unit)?.exit()
      fixture.terminals.get(unit)?.exit()
      fixture.complete(unit, 'inactive')
      await expect(launch.done).resolves.toEqual({ exitCode: 0, signal: null })
      await disposal
      expect(await rejection()).toEqual(new Error(EXPECTED_SHUTDOWN_ERROR))
      expect(ordinary).toThrow(new Error(EXPECTED_SHUTDOWN_ERROR))
      expect(duringDispose).toEqual(new Error(EXPECTED_SHUTDOWN_ERROR))
      expect(launchCalls()).toBe(before)
    } finally {
      await fixture.cleanup()
    }
  },
)

it.skipIf(process.platform !== 'linux').each(['ordinary', 'terminal'] as const)(
  'keeps %s allocation owned if the provider disposer starts synchronously inside the adapter', async (kind) => {
    const fixture = await scopeFixture()
    const runtime = fixture.ctx.subprocess as LocalSubprocessRuntime
    let disposal: Promise<void> | undefined
    let disposed = false
    fixture.onLaunch(() => {
      // Cordis normally defers effect disposal; invoke the same provider operation here to force the overlap.
      disposal = runtime['disposeManagedProcesses']().then(() => { disposed = true })
    })
    try {
      const launch = kind === 'ordinary' ? runtime.spawn(ordinarySpec()) : await runtime.spawnTerminal(terminalSpec())
      expect(disposal).toBeDefined()
      await vi.waitFor(() =>{  expect(fixture.kills.length + Number(disposed)).toBeGreaterThan(0); })
      expect(disposed).toBe(false)
      const unit = fixture.kills[0]?.at(-1)
      if (unit === undefined) throw new Error('Expected the pending allocation to be included in disposal')
      await vi.waitFor(() =>{  expect(fixture.pending.has(unit)).toBe(true); })
      fixture.children.get(unit)?.exit()
      fixture.terminals.get(unit)?.exit()
      fixture.complete(unit, 'inactive')
      await launch.done
      await disposal
      expect(disposed).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  },
)

it.skipIf(process.platform !== 'linux').each(['ordinary', 'terminal'] as const)(
  'releases a failed %s allocation when dispose reenters the launcher', async (kind) => {
    const fixture = await scopeFixture()
    const service = fixture.ctx.subprocess
    const failure = new Error('fixture launch failed')
    let disposal: Promise<void> | undefined
    fixture.onLaunch(() => {
      disposal ??= fixture.fiber.dispose()
      throw failure
    })
    try {
      if (kind === 'ordinary') expect(() => service.spawn(ordinarySpec())).toThrow(failure)
      else await expect(service.spawnTerminal(terminalSpec())).rejects.toBe(failure)
      expect(disposal).toBeDefined()
      await disposal
      expect(fixture.queries).toEqual([])
      expect(fixture.kills).toEqual([])
      if (kind === 'ordinary') expect(() => service.spawn(ordinarySpec())).toThrow(new Error(EXPECTED_SHUTDOWN_ERROR))
      else await expect(service.spawnTerminal(terminalSpec())).rejects.toEqual(new Error(EXPECTED_SHUTDOWN_ERROR))
    } finally {
      await fixture.cleanup()
    }
  },
)

it.skipIf(process.platform !== 'linux')('reports a current query error and retries while the launcher remains owned', async () => {
  const fixture = await scopeFixture()
  try {
    const handle = fixture.ordinary()
    const unit = fixture.children.keys().next().value
    if (unit === undefined) throw new Error('Expected a scope')
    const firstWait = handle.waitForExit()
    const checked = expect(firstWait).rejects.toThrow('current manager failure')
    await vi.waitFor(() =>{  expect(fixture.pending.has(unit)).toBe(true); })
    fixture.complete(unit, new Error('current manager failure'))
    await checked
    const secondWait = handle.waitForExit()
    await vi.waitFor(() =>{  expect(fixture.queries).toEqual([unit, unit]); })
    fixture.children.get(unit)?.exit()
    fixture.complete(unit, 'inactive')
    await expect(secondWait).resolves.toBe(true)
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
  } finally {
    await fixture.cleanup()
  }
})

it.skipIf(process.platform !== 'linux')('shares ordinary capacity with PTY owners and drains both during dispose', async () => {
  const fixture = await scopeFixture({ ordinaryConcurrency: 1, startsPerTurn: 2 })
  try {
    const ordinary = fixture.ordinary()
    const terminal = await fixture.ctx.subprocess.spawnTerminal({
      argv: ['fixture-shell'], cwd: process.cwd(), rows: 24, cols: 80,
      terminalType: 'dumb', graceMs: 100, env: {}, shellActivity: true,
    })
    const ordinaryUnit = [...fixture.children.keys()][0]!
    const terminalUnit = [...fixture.terminals.keys()][0]!
    const ordinaryExit = ordinary.waitForExit()
    await vi.waitFor(() =>{  expect(fixture.queries).toEqual([ordinaryUnit]); })
    fixture.terminals.get(terminalUnit)!.exit()
    await terminal.done
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(fixture.queries).toEqual([ordinaryUnit])
    fixture.complete(ordinaryUnit, 'active')
    await vi.waitFor(() =>{  expect(fixture.pending.has(terminalUnit)).toBe(true); })
    await fixture.dispose()
    await expect(ordinaryExit).resolves.toBe(true)
    expect(fixture.pending.size).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})

it.skipIf(process.platform !== 'linux')('promotes a queued owner, discards stale failures, and confirms TERM then KILL serially', async () => {
  const fixture = await scopeFixture({ ordinaryConcurrency: 1, priorityConcurrency: 1, startsPerTurn: 2 })
  try {
    const survivor = fixture.ordinary()
    const terminating = fixture.ordinary(400)
    const [survivorUnit, terminatingUnit] = [...fixture.children.keys()]
    if (survivorUnit === undefined || terminatingUnit === undefined) throw new Error('Expected two scopes')
    for (const child of fixture.children.values()) child.exit()
    await Promise.all([survivor.done, terminating.done])
    const caller = new AbortController()
    const abandonedWait = survivor.waitForExit(caller.signal)
    const scopeExit = terminating.waitForExit()
    await vi.waitFor(() =>{  expect(fixture.queries).toEqual([survivorUnit]); })
    caller.abort()
    await expect(abandonedWait).resolves.toBe(false)
    expect(fixture.pending.has(survivorUnit)).toBe(true)

    terminating.terminate()
    await vi.waitFor(() =>{  expect(fixture.pending.has(terminatingUnit)).toBe(true); })
    expect(fixture.queries).toEqual([survivorUnit, terminatingUnit])
    await vi.waitFor(() =>{  expect(fixture.kills.map(args => args[3])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']); }, { timeout: 2_000 })
    expect(fixture.queries).toEqual([survivorUnit, terminatingUnit])
    fixture.complete(terminatingUnit, Object.assign(new Error('stale manager error'), { code: 'EIO' }))
    await vi.waitFor(() =>{  expect(fixture.queries).toEqual([survivorUnit, terminatingUnit, terminatingUnit]); })
    fixture.complete(terminatingUnit, 'inactive')
    await expect(scopeExit).resolves.toBe(true)
    expect(fixture.pending.has(survivorUnit)).toBe(true)
    fixture.complete(survivorUnit, 'inactive')
    await expect(survivor.waitForExit()).resolves.toBe(true)
  } finally {
    await fixture.cleanup()
  }
})
