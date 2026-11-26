/**
 * Measure one CLI interrupt with source-resolved provider code and real forks of a fixed manager stub.
 * From the measured checkout, set TSX_TSCONFIG_PATH to its tsconfig.base.json and run
 * `unshare --user --map-root-user --pid --fork --net node --import tsx/esm <this file> <owners> <fast|slow>`.
 */
import assert from 'node:assert/strict'
import childProcess, { type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const SHOW = ['--property=LoadState', '--property=ActiveState', '--property=TasksCurrent']
const SCOPE = /^dsh-subprocess-1-[0-9a-f]{12}\.scope$/u
const PROBE = /^--unit=(dsh-subprocess-probe-1-[0-9a-f]{12})$/u
const STUB = new URL('./fixtures/linux-scope-shutdown-fork-systemctl.sh', import.meta.url)
const EXE = '/bin/bash'
const TARGET = 'fixture-target'

type Reply = (error: Error | null, stdout: string, stderr: string) => void

class Launcher extends EventEmitter {
  exitCode: number | null = null
  signalCode = null
  stdin = null
  stdout = null
  stderr = null
  termAt?: number
  confirmedAt?: number
  showStarts = 0
  killed = false

  constructor(readonly pid: number) { super() }

  exit(): void {
    assert.equal(this.exitCode, null)
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

async function measure(checkout: string, count: number, slow: boolean): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-shutdown-fork-'))
  const bus = `unix:path=${join(root, 'absent-bus')}`
  const env = { PATH: root, LC_ALL: 'C', XDG_RUNTIME_DIR: root, DBUS_SESSION_BUS_ADDRESS: bus, DBUS_SYSTEM_BUS_ADDRESS: bus }
  const originals = { ...childProcess }
  const owners = new Map<string, Launcher>()
  const exit = Promise.withResolvers<undefined>()
  const queries = new Set<Promise<void>>()
  const errors: { unit: string; code?: string | number | null; signal?: string | null; message: string }[] = []
  const guardFailures: string[] = []
  let providerExit: ((code: number) => void) | undefined
  let began: number | undefined
  let firstTermAt: number | undefined
  let lastTermAt: number | undefined
  let termWallMs = 0
  let term = 0
  let sigkill = 0
  let lastShowStart: number | undefined
  let lastShowEnd: number | undefined
  let showStarts = 0
  let showEnds = 0
  let queryPeak = 0
  let slowShowMs: number | undefined
  let providerDisposedAt: number | undefined
  let disposeError: string | undefined
  let exitResult: object | undefined
  const reject = (operation: string): never => {
    guardFailures.push(operation)
    throw new Error(`Unexpected process operation in shutdown diagnostic: ${operation}`)
  }
  const source = (path: string): string => pathToFileURL(join(checkout, path)).href
  const elapsed = (at: number | undefined): number | null => at === undefined ? null : at - began!
  const unconfirmed = (at: number): number => [...owners.values()]
    .filter(owner => owner.confirmedAt === undefined || owner.confirmedAt > at).length
  const snapshot = (at: number) => ({
    ms: elapsed(at), term, showStarts, showEnds,
    active: [...owners.values()].filter(owner => owner.termAt === undefined && !owner.killed).length,
    unconfirmed: unconfirmed(at), inFlight: queries.size,
  })
  try {
    // The selector needs an executable identity. Accidental execution fails without using PATH.
    writeFileSync(join(root, 'systemd-run'), '#!/bin/bash\nexit 126\n', { flag: 'wx', mode: 0o700 })
    Object.assign(process.env, env, { TMPDIR: root })
    process.kill = () => reject('process.kill')
    Object.assign(childProcess, {
      exec: () => reject('exec'), execSync: () => reject('execSync'),
      execFileSync: () => reject('execFileSync'), fork: () => reject('fork'),
      spawn(file: string, args: string[], options: SpawnOptions) {
        const stem = args.find(arg => arg.startsWith('--unit='))?.slice('--unit='.length)
        const unit = `${stem}.scope`
        const request = options.env?.DSH_SUBPROCESS_RUNNER
        if (file !== 'systemd-run' || args[0] !== '--user' || args[1] !== '--scope' || args.at(-1) !== TARGET
          || !SCOPE.test(unit) || owners.has(unit) || request === undefined) reject(`spawn ${file}`)
        assert(request !== undefined)
        consumeLinuxLaunchRequest(request)
        const child = new Launcher(10_000 + owners.size)
        owners.set(unit, child)
        return child
      },
      spawnSync(file: string, args: string[]) {
        const probeStem = PROBE.exec(args[5] ?? '')?.[1]
        if (began === undefined && file === 'systemd-run' && probeStem !== undefined) {
          assert.deepEqual(args, ['--user', '--scope', '--quiet', '--collect', '--expand-environment=no',
            `--unit=${probeStem}`, '--', 'systemctl', '--user', 'show', `${probeStem}.scope`, '--property=ActiveState', '--value'])
          return { status: 0, stdout: '', stderr: '' }
        }
        if (began === undefined && file === 'systemctl' && args[1] === 'show') {
          assert.deepEqual(args, ['--user', 'show', '--property=Version', '--value'])
          return { status: 0, stdout: '', stderr: '' }
        }
        const [user, operation, members, signal, unit] = args
        const owner = unit === undefined ? undefined : owners.get(unit)
        if (began === undefined || file !== 'systemctl' || args.length !== 5 || user !== '--user' || operation !== 'kill'
          || members !== '--kill-who=all' || owner === undefined || (signal !== '--signal=SIGTERM' && signal !== '--signal=SIGKILL')) {
          return reject(`spawnSync ${file} ${String(operation)}`)
        }
        const isTerm = signal === '--signal=SIGTERM'
        const start = performance.now()
        const result = originals.spawnSync(EXE, ['--noprofile', '--norc', STUB.pathname, isTerm ? 'term' : 'kill'], {
          cwd: root, env, encoding: 'utf8', timeout: 5_000,
        })
        const end = performance.now()
        if (result.error !== undefined || result.signal !== null || result.status !== 0) {
          return reject(`stub ${signal} failed: ${String(result.error ?? result.signal ?? result.status)}`)
        }
        if (isTerm) {
          assert.equal(owner.termAt, undefined)
          firstTermAt ??= start
          lastTermAt = end
          termWallMs += end - start
          term += 1
          owner.termAt = end
          owner.exit()
        } else {
          sigkill += 1
          owner.killed = true
        }
        return result
      },
      execFile(file: string, args: string[], options: ExecFileOptions, reply: Reply) {
        const unit = args[2]
        const owner = unit === undefined ? undefined : owners.get(unit)
        if (file !== 'systemctl' || args[0] !== '--user' || args[1] !== 'show' || owner === undefined || unit === undefined) {
          return reject(`execFile ${file}`)
        }
        assert.deepEqual(args.slice(3), SHOW)
        assert.equal(options.timeout, 5_000)
        assert.equal(options.encoding, 'utf8')
        const started = performance.now()
        const inactive = owner.termAt !== undefined || owner.killed
        const held = slow && owner.pid === 10_000 && owner.showStarts === 0
        owner.showStarts += 1
        showStarts += 1
        lastShowStart = started
        const completion = Promise.withResolvers<undefined>()
        const child = originals.execFile(EXE, ['--noprofile', '--norc', STUB.pathname,
          `${held ? 'slow-' : ''}${inactive ? 'inactive' : 'active'}`], {
          cwd: root, env, timeout: options.timeout, encoding: 'utf8',
        }, (error, stdout, stderr) => {
          const ended = performance.now()
          showEnds += 1
          lastShowEnd = ended
          if (held) slowShowMs = ended - started
          if (error !== null) errors.push({
            unit,
            ...(error.code === undefined ? {} : { code: error.code }),
            ...(error.signal === undefined ? {} : { signal: error.signal }),
            message: error.message,
          })
          else if (inactive && stdout === 'LoadState=loaded\nActiveState=inactive\nTasksCurrent=[not set]\n') owner.confirmedAt ??= ended
          queries.delete(completion.promise)
          completion.resolve(undefined)
          reply(error, stdout, stderr)
        })
        queries.add(completion.promise)
        queryPeak = Math.max(queryPeak, queries.size)
        return child
      },
    })
    syncBuiltinESMExports()
    const runtime = 'packages/subprocess/subprocess-local/src'
    const [runtimeModule, { Context }, { consumeLinuxLaunchRequest }, cli] = await Promise.all([
      import(source(`${runtime}/index.ts`)) as Promise<typeof import('../src/index.ts')>,
      import(source('vendor/cordis/src/index.ts')) as Promise<typeof import('@deepseek-ai/cordis')>,
      import(source(`${runtime}/runner-protocol.ts`)) as Promise<typeof import('../src/runner-protocol.ts')>,
      import(source('apps/cli/src/process-shutdown.ts')) as Promise<typeof import('../../../../apps/cli/src/process-shutdown.ts')>,
    ])
    const { default: Runtime } = runtimeModule
    const { createProcessShutdown, PROCESS_SHUTDOWN_TIMEOUT_MS } = cli
    const ctx = new Context()
    const listeners = new Set(process.listeners('exit'))
    const fiber = await ctx.plugin(Runtime)
    providerExit = process.listeners('exit').find(listener => !listeners.has(listener))
    assert(providerExit !== undefined)
    for (let index = 0; index < count; index += 1) {
      ctx.subprocess.spawn({ argv: [TARGET], cwd: root, env: {}, graceMs: 30_000,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' } })
    }
    assert.equal(owners.size, count)
    const shutdown = createProcessShutdown(async () => {
      try {
        await fiber.dispose()
        providerDisposedAt = performance.now()
      } catch (error) {
        disposeError = String(error)
        throw error
      }
    }, (code) => {
      const requested = performance.now()
      const before = snapshot(requested)
      const killsBefore = sigkill
      if (process.listeners('exit').includes(providerExit!)) providerExit?.(code)
      const finished = performance.now()
      exitResult = {
        code, before, totalMs: elapsed(finished),
        disposed: providerDisposedAt !== undefined,
        fallback: sigkill > killsBefore, fallbackKills: sigkill - killsBefore,
        fallbackMs: finished - requested,
        unconfirmedAtDeadline: requested - began! >= PROCESS_SHUTDOWN_TIMEOUT_MS
          ? unconfirmed(began! + PROCESS_SHUTDOWN_TIMEOUT_MS) : 0,
      }
      exit.resolve(undefined)
    })
    began = performance.now()
    shutdown.interrupt(0)
    await exit.promise
    // The CLI would exit here. Keep guards in place while the simulated owners settle so the
    // log can distinguish deadline failures from actual fixture or child-process errors.
    await shutdown.shutdown(0)
    await Promise.all(queries)
    console.log(JSON.stringify({
      checkout, node: process.version, platform: process.platform, arch: process.arch, pid: process.pid,
      owners: count, mode: slow ? 'slow' : 'fast', deadlineMs: PROCESS_SHUTDOWN_TIMEOUT_MS,
      term, termWallMs, termSpanMs: term === 0 ? 0 : lastTermAt! - firstTermAt!, lastTermMs: elapsed(lastTermAt),
      showStarts, showEnds, queryPeak, lastShowStartMs: elapsed(lastShowStart), lastShowEndMs: elapsed(lastShowEnd),
      slowShowMs: slowShowMs ?? null, disposedMs: elapsed(providerDisposedAt), disposeError: disposeError ?? null,
      exit: exitResult, sigkill, unconfirmedAfterDrain: unconfirmed(performance.now()), errors, guardFailures,
      peakRssKiB: process.resourceUsage().maxRSS,
    }))
    assert.equal(term, count)
    assert.equal(showStarts, showEnds)
    assert.deepEqual(guardFailures, [])
    assert.deepEqual(errors, [])
    assert.equal(disposeError, undefined)
    assert.equal(unconfirmed(performance.now()), 0)
    if (slow) assert(slowShowMs !== undefined && slowShowMs >= 1_000)
  } finally {
    if (providerExit !== undefined) process.off('exit', providerExit)
    // The diagnostic owns this process. Keep its subprocess and signal guards installed until exit.
    rmSync(root, { recursive: true, force: true })
  }
}

assert.equal(process.platform, 'linux')
assert.equal(process.pid, 1, 'Run each sample in a fresh PID namespace')
const count = Number(process.argv[2])
assert([0, 51, 201, 1_000].includes(count))
const mode = process.argv[3]
assert(mode === 'fast' || (mode === 'slow' && count > 0))
await measure(process.cwd(), count, mode === 'slow')
