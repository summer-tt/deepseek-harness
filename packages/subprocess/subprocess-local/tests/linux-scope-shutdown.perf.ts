/** Deterministic, manual comparison of CLI interrupt and retained Linux scope observations. */
import assert from 'node:assert/strict'
import childProcess, { type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as eventLoopTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

class Launcher extends EventEmitter {
  exitCode: number | null = null
  signalCode = null
  stdin = null
  stdout = null
  stderr = null

  constructor(readonly pid: number) { super() }
  exit(): void {
    if (this.exitCode !== null) return
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

type Reply = (error: Error | null, stdout: string, stderr: string) => void

type Mode = 'inactive-on-term' | 'active-empty' | 'second-interrupt' | 'grace-kill'

async function compare(checkout: string, count: number, mode: Mode): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shutdown-pressure-'))
  const runtimePath = 'packages/subprocess/subprocess-local/src'
  const source = (path: string): string => pathToFileURL(join(checkout, path)).href
  const originals = { ...childProcess }
  const kill = Object.getOwnPropertyDescriptor(process, 'kill')
  const now = Object.getOwnPropertyDescriptor(performance, 'now')
  const timers = { setTimeout, clearTimeout, setImmediate }
  const savedEnv = Object.fromEntries(['TMPDIR', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].map(key => [key, process.env[key]]))
  let time = 0
  let timerId = 0
  const queue = new Map<number, { time: number; run: () => void }>()
  function schedule(run: () => void, delay: number): number {
    const id = ++timerId
    queue.set(id, { time: time + delay, run })
    return id
  }
  async function advance(until: number): Promise<void> {
    await eventLoopTurn()
    for (;;) {
      const next = [...queue].sort((left, right) => left[1].time - right[1].time)[0]
      if (next === undefined || next[1].time > until) break
      queue.delete(next[0])
      time = next[1].time
      next[1].run()
      await eventLoopTurn()
    }
    time = until
  }
  const children = new Map<string, Launcher>()
  const active = new Set<string>()
  const confirmed = new Set<string>()
  const showStarts: number[] = []
  let term = 0
  let sigkill = 0
  let stops = 0
  const holdOld = mode === 'second-interrupt' || mode === 'grace-kill'
  let descendantAlive = holdOld
  let held: (() => void) | undefined
  let disposedAt: number | undefined
  let exit: {
    code: number
    ms: number
    disposed: boolean
    active: number
    pending: number
    descendantAlive: boolean
    shows: number
    term: number
    sigkill: number
  } | undefined
  let holdFirst = holdOld
  let providerExit: ((code: number) => void) | undefined
  const reject = (): never => { throw new Error('Unexpected real process operation in shutdown fixture') }
  try {
    Object.assign(process.env, { TMPDIR: dir, PATH: dir, XDG_RUNTIME_DIR: dir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/absent` })
    Object.defineProperty(process, 'kill', { configurable: true, value: reject })
    Object.defineProperty(performance, 'now', { configurable: true, value: () => time })
    Object.assign(childProcess, {
      exec: reject, execSync: reject, execFileSync: reject, fork: reject,
      spawn(file: string, args: string[], options: SpawnOptions) {
        assert.equal(file, 'systemd-run')
        assert.deepEqual(args.slice(0, 2), ['--user', '--scope'])
        const unit = args.find(arg => arg.startsWith('--unit=dsh-subprocess-'))?.slice('--unit='.length)
        const request = options.env?.DSH_SUBPROCESS_RUNNER
        assert(unit !== undefined && request !== undefined)
        consumeLinuxLaunchRequest(request)
        const child = new Launcher(10_000 + children.size)
        children.set(`${unit}.scope`, child)
        active.add(`${unit}.scope`)
        return child
      },
      spawnSync(file: string, args: string[]) {
        const [user, operation] = args
        assert.equal(user, '--user')
        if (file === 'systemd-run') assert.equal(operation, '--scope')
        else {
          assert.equal(file, 'systemctl')
          if (operation === 'show') assert(args.includes('--property=Version'))
          else {
            const unit = args.at(-1)
            assert(unit !== undefined && children.has(unit))
            if (operation === 'stop') {
              assert.equal(mode, 'active-empty')
              stops += 1
              active.delete(unit)
            } else {
              assert.equal(operation, 'kill')
              const signal = args[3]
              if (signal === '--signal=SIGTERM') {
                term += 1
                if (mode === 'inactive-on-term') active.delete(unit)
              } else {
                assert.equal(signal, '--signal=SIGKILL')
                sigkill += 1
                if (holdOld) active.delete(unit)
                descendantAlive = false
              }
            }
          }
        }
        return { status: 0, stdout: '', stderr: '' }
      },
      execFile(file: string, args: string[], _options: object, reply: Reply) {
        assert.equal(file, 'systemctl')
        assert.deepEqual(args.slice(0, 2), ['--user', 'show'])
        const unit = args[2]
        assert(unit !== undefined && children.has(unit))
        showStarts.push(time)
        const finish = (state: 'active' | 'inactive', tasks: string): void => {
          if (state === 'inactive' || tasks === '0') confirmed.add(unit)
          reply(null, `LoadState=loaded\nActiveState=${state}\nTasksCurrent=${tasks}\n`, '')
        }
        if (holdFirst) {
          held = () => { finish('active', '1') }
          holdFirst = false
        } else queueMicrotask(() => {
          const state = active.has(unit) ? 'active' : 'inactive'
          finish(state, mode === 'active-empty' ? '0' : '[not set]')
        })
        return new EventEmitter()
      },
    })
    syncBuiltinESMExports()
    const [{ default: Runtime }, { consumeLinuxLaunchRequest }, { createProcessShutdown }] = await Promise.all([
      import(source(`${runtimePath}/index.ts`)) as Promise<typeof import('../src/index.ts')>,
      import(source(`${runtimePath}/runner-protocol.ts`)) as Promise<typeof import('../src/runner-protocol.ts')>,
      import(source('apps/cli/src/process-shutdown.ts')) as Promise<typeof import('../../../../apps/cli/src/process-shutdown.ts')>,
    ])
    Object.assign(globalThis, {
      setTimeout: (run: () => void, delay = 0) => schedule(run, Math.max(1, delay)),
      clearTimeout: (id: number) => queue.delete(id),
      setImmediate: (run: () => void) => schedule(run, 1),
    })
    const ctx = new Context()
    const listenersBefore = new Set(process.listeners('exit'))
    const fiber = await ctx.plugin(Runtime)
    providerExit = process.listeners('exit').find(listener => !listenersBefore.has(listener))
    assert(providerExit !== undefined)
    for (let index = 0; index < count; index += 1) ctx.subprocess.spawn({
      argv: ['fixture-target'], cwd: dir, env: {}, graceMs: mode === 'grace-kill' ? 50 : 200_000,
      stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    })
    const launchers = [...children.values()]
    if (holdOld) {
      launchers[0]?.exit()
      await advance(10)
      assert(held !== undefined)
    }
    const began = time
    const shutdown = createProcessShutdown(async () => {
      await fiber.dispose()
      disposedAt = time
    }, (code) => {
      exit = { code, ms: time - began, disposed: disposedAt !== undefined,
        active: active.size, pending: count - confirmed.size, descendantAlive, shows: showStarts.length, term, sigkill }
      providerExit?.(code)
    })
    shutdown.interrupt(0)
    for (const child of launchers) child.exit()
    if (holdOld) {
      await advance(began + 100)
      assert.equal(exit, undefined)
      assert.equal(showStarts.length, 1)
      if (mode === 'second-interrupt') {
        assert.equal(descendantAlive, true)
        shutdown.interrupt(0)
        assert(exit !== undefined)
      } else {
        assert.equal(sigkill, 1)
      }
      assert.equal(descendantAlive, false)
      held?.()
    }
    await advance(began + 110_000)
    assert(exit !== undefined)
    assert(disposedAt !== undefined)
    assert.equal(active.size, 0)
    assert.equal(queue.size, 0)
    const lastShow = showStarts.at(-1)
    console.log(JSON.stringify({ checkout, mode, owners: count, exit, disposedMs: disposedAt - began,
      lastShowMs: lastShow === undefined ? null : lastShow - began,
      finalTerm: term, finalKill: sigkill, stops, active: active.size }))
    assert.equal(exit.code, 0)
    assert.equal(term, count)
    if (mode === 'active-empty') assert.equal(stops, count)
    if (mode === 'grace-kill') {
      assert.equal(exit.disposed, true)
      assert.equal(exit.shows, 2)
      assert.equal(sigkill, 1)
    } else if (mode === 'second-interrupt') {
      assert.equal(exit.ms, 100)
      assert.equal(exit.descendantAlive, true)
      assert.equal(exit.shows, 1)
      assert.equal(sigkill, 1)
    } else if (!exit.disposed) {
      assert.equal(exit.ms, 5_000)
      assert.equal(sigkill, exit.pending)
    }
    return exit.disposed
  } finally {
    if (providerExit !== undefined) process.off('exit', providerExit)
    Object.assign(globalThis, timers)
    if (now === undefined) Reflect.deleteProperty(performance, 'now')
    else Object.defineProperty(performance, 'now', now)
    if (kill !== undefined) Object.defineProperty(process, 'kill', kill)
    Object.assign(childProcess, originals)
    syncBuiltinESMExports()
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

assert.equal(process.platform, 'linux')
const checkout = resolve(process.argv[2] ?? process.cwd())
const incomplete: number[] = []
for (const count of [0, 51, 201, 1_000]) {
  if (!await compare(checkout, count, 'inactive-on-term')) incomplete.push(count)
}
assert.equal(await compare(checkout, 1, 'active-empty'), true)
assert.equal(await compare(checkout, 1, 'grace-kill'), true)
assert.equal(await compare(checkout, 1, 'second-interrupt'), false)
assert.deepEqual(incomplete, [], 'CLI forced exit before graceful scope disposal with these owner counts')
