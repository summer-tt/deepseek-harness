import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'
import { SUBPROCESS_RUNNER_ENV } from '../src/runner-launch.ts'
import { cleanupLinuxLaunchFiles, consumeLinuxLaunchRequest, linuxLaunchFilesFromLocator } from '../src/runner-protocol.ts'

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn(), spawnSync: vi.fn() }))
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

function peakStartsInSecond(starts: readonly number[]): number {
  let first = 0
  let peak = 0
  for (const [last, time] of starts.entries()) {
    while (time - (starts[first] ?? time) >= 1_000) first += 1
    peak = Math.max(peak, last - first + 1)
  }
  return peak
}

it.skipIf(process.platform !== 'linux')('bounds status-query starts for a burst of naturally exited Linux scopes', { timeout: 10_000 }, async () => {
  const scopeCount = 32
  const starts: number[] = []
  const children = new Map<string, FakeChild>()
  const observedActive = new Set<string>()
  const handles: SubprocessHandle[] = []
  let finishing = false
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
  childProcess.spawn.mockImplementation((file: string, args: string[], options: SpawnOptions) => {
    const unit = args.find(arg => arg.startsWith('--unit=dsh-subprocess-'))?.slice('--unit='.length)
    const requestPath = options.env?.[SUBPROCESS_RUNNER_ENV]
    if (file !== 'systemd-run' || !args.includes('--scope') || unit === undefined || requestPath === undefined) {
      throw new Error('Expected the native user scope launcher, not a fallback process')
    }
    const child = new FakeChild(10_000 + children.size, requestPath)
    children.set(`${unit}.scope`, child)
    consumeLinuxLaunchRequest(requestPath)
    return child
  })
  childProcess.spawnSync.mockImplementation((file: string, args: string[]) => {
    const [user, operation] = args
    if (user === '--user' && (
      (file === 'systemd-run' && operation === '--scope')
      || (file === 'systemctl' && operation === 'show' && args.includes('--property=Version'))
      || (finishing && file === 'systemctl' && operation === 'kill' && children.has(args.at(-1) ?? ''))
    )) return { status: 0, stdout: '', stderr: '' }
    throw new Error(`Unexpected synchronous process request: ${file} ${args.join(' ')}`)
  })
  childProcess.execFile.mockImplementation((file: string, args: string[], _options: object, reply: Reply) => {
    const [user, operation, unit] = args
    if (file !== 'systemctl' || user !== '--user' || operation !== 'show' || unit === undefined || !children.has(unit)) {
      throw new Error(`Unexpected async process request: ${file} ${args.join(' ')}`)
    }
    starts.push(performance.now())
    const state = !finishing && !observedActive.has(unit) ? 'active' : 'inactive'
    if (state === 'active') observedActive.add(unit)
    queueMicrotask(() => { reply(null, `LoadState=loaded\nActiveState=${state}\nTasksCurrent=[not set]\n`, '') })
    return new EventEmitter()
  })

  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  try {
    for (let i = 0; i < scopeCount; i += 1) {
      handles.push(ctx.subprocess.spawn({
        argv: ['fixture-target'],
        cwd: process.cwd(),
        env: {},
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: 100,
      }))
    }
    expect(children.size).toBe(scopeCount)
    for (const child of children.values()) child.exit()
    expect(await Promise.all(handles.map(handle => handle.done))).toEqual(
      Array.from({ length: scopeCount }, () => ({ exitCode: 0, signal: null })),
    )
    expect(await Promise.all(handles.map(handle => handle.waitForExit()))).toEqual(Array.from({ length: scopeCount }, () => true))
    expect(observedActive.size).toBe(scopeCount)
    expect(starts).toHaveLength(scopeCount * 2)
    expect(signal).not.toHaveBeenCalled()
    expect(peakStartsInSecond(starts), 'ordinary systemctl show starts in a rolling second').toBeLessThanOrEqual(20)
  } finally {
    finishing = true
    for (const child of children.values()) {
      if (child.exitCode === null) child.exit()
    }
    try {
      await fiber.dispose()
    } finally {
      signal.mockRestore()
      for (const child of children.values()) cleanupLinuxLaunchFiles(linuxLaunchFilesFromLocator(child.requestPath))
    }
  }
})
