/**
 * Measure asynchronous scope observations in the source-resolved provider on Linux.
 * Run in a dedicated Node process with `--import tsx/esm` and set `TSX_TSCONFIG_PATH`
 * to the measured checkout's `tsconfig.base.json`. Use `--checkout=<absolute path>`
 * for another checkout, `--baseline` for the unthrottled implementation, and
 * `--trace` to append individual query and probe timestamps to the JSON summary.
 */
import assert from 'node:assert/strict'
import childProcess, { type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

const ORDINARY_OWNERS = 1_000
const PRIORITY_BURST = 14
const PROBE_PERIOD_MS = 10
const GRACE_MS = 10_000
const EXE = '/bin/bash'
const SHOW_ARGS = ['--property=LoadState', '--property=ActiveState', '--property=TasksCurrent']
const HERE = fileURLToPath(new URL('.', import.meta.url))
const fixture = (name: string): string => join(HERE, 'fixtures', `linux-scope-budget-${name}`)

type Lane = 'ordinary' | 'priority'
type Query = { owner: number; lane: Lane; startMs: number; endMs?: number; pid?: number }
type Probe = { at: number; end: number; ms: number }
type Reply = (error: Error | null, stdout: string, stderr: string) => void

class FakeLauncher extends EventEmitter {
  exitCode: number | null = null
  signalCode = null
  stdin = null
  stdout = null
  stderr = null
  firstWaitMs?: number
  signalledAt?: number
  queries: Query[] = []

  constructor(readonly owner: number) { super() }

  get pid(): number { return 10_000 + this.owner }

  exit(): void {
    if (this.exitCode !== null) return
    this.exitCode = 0
    this.emit('exit', 0, null)
  }
}

function stats(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    count: sorted.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  }
}

function rollingSecondPeak(queries: readonly Query[]): number {
  let earliest = 0
  let peak = 0
  for (const [index, query] of queries.entries()) {
    while (query.startMs - queries[earliest]!.startMs >= 1_000) earliest += 1
    peak = Math.max(peak, index - earliest + 1)
  }
  return peak
}

async function measure(checkout: string, baseline: boolean, trace: boolean): Promise<void> {
  assert.equal(process.platform, 'linux')
  const root = mkdtempSync(join(tmpdir(), 'dsh-scope-budget-'))
  const envNames = ['PATH', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS'] as const
  const savedEnv = envNames.map(name => [name, process.env[name]] as const)
  process.env.PATH = root
  process.env.TMPDIR = root
  process.env.XDG_RUNTIME_DIR = root
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(root, 'absent-session-bus')}`
  process.env.DBUS_SYSTEM_BUS_ADDRESS = `unix:path=${join(root, 'absent-system-bus')}`
  const originals = {
    execFile: childProcess.execFile, spawn: childProcess.spawn, spawnSync: childProcess.spawnSync,
    exec: childProcess.exec, execSync: childProcess.execSync, execFileSync: childProcess.execFileSync, fork: childProcess.fork,
  }
  const killDescriptor = Object.getOwnPropertyDescriptor(process, 'kill')
  const children = new Map<string, FakeLauncher>()
  const handles: SubprocessHandle[] = []
  const queries: Query[] = []
  const active = { ordinary: 0, priority: 0 }
  const peak = { ordinary: 0, priority: 0, total: 0, batch: 0 }
  const pendingQueries = new Set<Promise<undefined>>()
  const oldQueryStarted = Promise.withResolvers<() => void>()
  const priorityStarted = Promise.withResolvers<undefined>()
  const firstHttp = Promise.withResolvers<undefined>()
  const httpSamples: Probe[] = []
  const loopSamples: Probe[] = []
  const failure = Promise.withResolvers<never>()
  void failure.promise.catch(() => {})
  let batch = 0
  let finishing = false
  let measurementStart = Infinity
  let measurementEnd = Infinity
  let interval: ReturnType<typeof setInterval> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let worker: Worker | undefined
  let workerExit: Promise<void> | undefined
  let dispose: (() => Promise<void>) | undefined
  let probeCount = 0
  let syncKills = 0
  let overlap = 0
  const server = createServer((_request, response) => { response.writeHead(204).end() })
  const rejectUnexpected = (): never => { throw new Error('Unexpected process operation in the Linux scope diagnostic') }
  const source = (relative: string): string => pathToFileURL(join(checkout, relative)).href
  try {
    Object.assign(childProcess, {
      exec: rejectUnexpected, execSync: rejectUnexpected, execFileSync: rejectUnexpected, fork: rejectUnexpected,
      spawn(file: string, args: string[], options: SpawnOptions) {
        assert.equal(file, 'systemd-run')
        assert.deepEqual(args.slice(0, 2), ['--user', '--scope'])
        assert.equal(args.at(-1), 'fixture-target')
        const unit = args.find(arg => arg.startsWith('--unit=dsh-subprocess-'))?.slice('--unit='.length)
        const requestPath = options.env?.[SUBPROCESS_RUNNER_ENV]
        assert(unit !== undefined && requestPath !== undefined, 'Expected native scope launch with its private request')
        consumeLinuxLaunchRequest(requestPath)
        const child = new FakeLauncher(children.size)
        children.set(`${unit}.scope`, child)
        return child
      },
      spawnSync(file: string, args: string[]) {
        const [user, operation] = args
        assert.equal(user, '--user')
        if (file === 'systemd-run' && operation === '--scope' && args.includes('--property=ActiveState')) probeCount += 1
        else if (file === 'systemctl' && operation === 'show' && args.includes('--property=Version')) probeCount += 1
        else if (file === 'systemctl' && operation === 'kill') {
          const child = children.get(args.at(-1) ?? '')
          assert(child !== undefined && ['--signal=SIGTERM', '--signal=SIGKILL'].includes(args[3] ?? ''))
          child.signalledAt ??= performance.now()
          syncKills += 1
        } else rejectUnexpected()
        return { status: 0, stdout: '', stderr: '' }
      },
      execFile(file: string, args: string[], options: ExecFileOptions, reply: Reply) {
        const [user, operation, unit] = args
        assert.equal(file, 'systemctl')
        assert.equal(user, '--user')
        assert.equal(operation, 'show')
        assert.deepEqual(args.slice(3), SHOW_ARGS)
        assert.equal(options.encoding, 'utf8')
        assert.equal(options.timeout, 5_000)
        const owner = children.get(unit ?? '')
        assert(owner !== undefined, 'Only fixture-owned scope queries may start a process')
        const lane = owner.signalledAt === undefined ? 'ordinary' : 'priority'
        if (owner.queries.at(-1)?.endMs === undefined && owner.queries.length > 0) overlap += 1
        const first = owner.queries.length === 0
        const state = first && lane === 'ordinary' && !finishing ? 'active' : 'inactive'
        const held = first && owner.owner === 0 && !finishing
        const row: Query = { owner: owner.owner, lane, startMs: performance.now() }
        queries.push(row)
        owner.queries.push(row)
        active[lane] += 1
        peak[lane] = Math.max(peak[lane], active[lane])
        peak.total = Math.max(peak.total, active.ordinary + active.priority)
        // A microtask checkpoint separates synchronous dispatch batches without instrumenting the scheduler.
        if (batch === 0) queueMicrotask(() => { batch = 0 })
        batch += 1
        peak.batch = Math.max(peak.batch, batch)
        const completion = Promise.withResolvers<undefined>()
        pendingQueries.add(completion.promise)
        const child = originals.execFile(EXE, ['--noprofile', '--norc', fixture('systemctl.sh'), state, held ? 'held' : 'fast'], {
          cwd: root, env: { LC_ALL: 'C' }, encoding: 'utf8', timeout: options.timeout,
        }, (error, stdout, stderr) => {
          row.endMs = performance.now()
          active[lane] -= 1
          pendingQueries.delete(completion.promise)
          completion.resolve(undefined)
          if (error !== null) failure.reject(error)
          reply(error, stdout, stderr)
        })
        if (child.pid !== undefined) row.pid = child.pid
        if (held) oldQueryStarted.resolve(() => { child.stdin?.end('release\n') })
        if (owner.owner === ORDINARY_OWNERS && lane === 'priority') priorityStarted.resolve(undefined)
        return child
      },
    })
    syncBuiltinESMExports()
    process.kill = rejectUnexpected
    const packageRoot = 'packages/subprocess/subprocess-local/src'
    const [{ default: Runtime }, { Context }, { SUBPROCESS_RUNNER_ENV }, { consumeLinuxLaunchRequest }] = await Promise.all([
      import(source(`${packageRoot}/index.ts`)) as Promise<typeof import('../src/index.ts')>,
      import('@deepseek-ai/cordis'),
      import(source(`${packageRoot}/runner-launch.ts`)) as Promise<typeof import('../src/runner-launch.ts')>,
      import(source(`${packageRoot}/runner-protocol.ts`)) as Promise<typeof import('../src/runner-protocol.ts')>,
    ])
    const context = new Context()
    const fiber = await context.plugin(Runtime)
    dispose = async () => { await fiber.dispose() }
    function spawn(): void {
      handles.push(context.subprocess.spawn({
        argv: ['fixture-target'], cwd: root, env: {}, graceMs: GRACE_MS,
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      }))
    }
    for (let index = 0; index < ORDINARY_OWNERS + 1 + PRIORITY_BURST; index += 1) spawn()
    const byIndex = [...children.values()]
    assert.equal(byIndex.length, handles.length)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert(address !== null && typeof address !== 'string')
    worker = new Worker(fixture('http.ts'), { workerData: address.port, execArgv: [] })
    workerExit = new Promise<void>((done) => {
      worker!.once('exit', (code) => {
        if (code !== 0) failure.reject(new Error(`HTTP probe worker exited with status ${String(code)}`))
        done()
      })
    })
    worker.on('error', failure.reject)
    worker.on('message', (probe: Probe) => {
      httpSamples.push(probe)
      firstHttp.resolve(undefined)
    })
    watchdog = setTimeout(() => { failure.reject(new Error('Scope pressure diagnostic exceeded 125 seconds')) }, 125_000)
    await Promise.race([firstHttp.promise, failure.promise])
    let previousTick = performance.now()
    interval = setInterval(() => {
      const now = performance.now()
      loopSamples.push({ at: previousTick + PROBE_PERIOD_MS, end: now, ms: Math.max(0, now - previousTick - PROBE_PERIOD_MS) })
      previousTick = now
    }, PROBE_PERIOD_MS)

    async function load(): Promise<number> {
      measurementStart = performance.now()
      const ordinary = byIndex.slice(0, ORDINARY_OWNERS)
      const waits = ordinary.map((owner, index) => {
        owner.exit()
        owner.firstWaitMs = performance.now()
        return handles[index]!.waitForExit()
      })
      const releaseOld = await oldQueryStarted.promise
      const isolated = handles[ORDINARY_OWNERS]!
      byIndex[ORDINARY_OWNERS]!.exit()
      isolated.terminate()
      const ordinaryStartedAtIsolatedSignal = ordinary.filter(owner => owner.queries.length > 0).length
      handles[0]!.terminate()
      await sleep(250)
      releaseOld()
      await priorityStarted.promise
      for (let index = ORDINARY_OWNERS + 1; index < byIndex.length; index += 1) {
        byIndex[index]!.exit()
        handles[index]!.terminate()
      }
      const exits = await Promise.all([...waits, ...handles.slice(ORDINARY_OWNERS).map(handle => handle.waitForExit())])
      assert(exits.every(Boolean))
      for (const outcome of await Promise.all(handles.map(handle => handle.done))) {
        assert.equal(outcome.exitCode, 0)
        assert.equal(outcome.signal, null)
      }
      assert.equal(active.ordinary + active.priority, 0)
      measurementEnd = performance.now()
      await sleep(PROBE_PERIOD_MS * 3)
      return ordinaryStartedAtIsolatedSignal
    }
    const ordinaryStartedAtIsolatedSignal = await Promise.race([load(), failure.promise])
    const ordinaryFirst = queries.filter(query => query.owner < ORDINARY_OWNERS && byIndex[query.owner]!.queries[0] === query)
    const ordinary = queries.filter(query => query.lane === 'ordinary')
    const priority = queries.filter(query => query.lane === 'priority')
    const firstMs = ordinaryFirst.at(-1)!.startMs - measurementStart
    const isolatedStart = byIndex[ORDINARY_OWNERS]!.queries.find(query => query.lane === 'priority')!
    const isolatedMs = isolatedStart.startMs - byIndex[isolatedStart.owner]!.signalledAt!
    const old = byIndex[0]!
    const oldStart = old.queries[0]!
    const oldPriority = old.queries.find(query => query.lane === 'priority')!
    const withinLoad = (probe: Probe): boolean => probe.at < measurementEnd && probe.end >= measurementStart
    const http = stats(httpSamples.filter(withinLoad).map(sample => sample.ms))
    const loop = stats(loopSamples.filter(withinLoad).map(sample => sample.ms))
    const windows = { ordinary: rollingSecondPeak(ordinary), priority: rollingSecondPeak(priority), total: rollingSecondPeak(queries) }
    const result = {
      node: process.version, platform: process.platform, arch: process.arch, checkout, baseline, budgetConfig: 'provider defaults',
      owners: { ordinary: ORDINARY_OWNERS, terminationOnly: 1 + PRIORITY_BURST },
      firstRoundDispatchMs: firstMs, elapsedMs: measurementEnd - measurementStart,
      firstRoundFifo: ordinaryFirst.every((query, index) => query.owner === index),
      ordinaryStartedAtIsolatedSignal, isolatedPriorityMs: isolatedMs,
      oldQueryMs: oldStart.endMs! - oldStart.startMs,
      oldSignalToCompletionMs: oldStart.endMs! - old.signalledAt!,
      oldCompletionToPriorityMs: oldPriority.startMs - oldStart.endMs!,
      ordinaryFirstQueueMs: stats(ordinaryFirst.map(query => query.startMs - byIndex[query.owner]!.firstWaitMs!)),
      priorityQueueMs: stats(priority.filter(query => query.owner !== 0)
        .map(query => query.startMs - byIndex[query.owner]!.signalledAt!)),
      queryMs: stats(queries.map(query => query.endMs! - query.startMs)),
      windows, peak, overlap, httpRttMs: http, eventLoopDelayMs: loop,
      realExecFileStarts: queries.filter(query => query.pid !== undefined).length,
      simulatedSyncProbes: probeCount, simulatedSyncKills: syncKills,
      peakRssKiB: process.resourceUsage().maxRSS,
    }
    console.log(JSON.stringify(result))
    if (trace) console.log(JSON.stringify({ measurementStart, measurementEnd, queries, httpSamples, loopSamples }))
    assert.equal(ordinaryFirst.length, ORDINARY_OWNERS)
    assert.equal(result.realExecFileStarts, queries.length)
    assert.equal(overlap, 0)
    assert(http.count > 1 && loop.count > 1, 'Both probes must overlap the workload')
    if (baseline) {
      assert(windows.ordinary > 20 && peak.batch > 4, 'Baseline must reproduce uncontrolled scope starts')
    } else {
      assert.equal(result.firstRoundFifo, true)
      assert(ordinaryStartedAtIsolatedSignal < ORDINARY_OWNERS, 'The ordinary backlog must overlap the priority request')
      assert(firstMs <= 55_000, `First round took ${String(firstMs)} ms`)
      assert(isolatedMs <= 100, `Isolated priority dispatch took ${String(isolatedMs)} ms`)
      assert(windows.ordinary <= 20 && windows.priority <= 10 && windows.total <= 30, 'Rolling start budget exceeded')
      assert(peak.ordinary <= 8 && peak.priority <= 2 && peak.total <= 10, 'In-flight budget exceeded')
      assert(peak.batch <= 4, 'Synchronous dispatch batch exceeded four starts')
      assert(http.p95! < 50 && http.max! < 250, 'HTTP response exceeded the latency budget')
      assert(loop.p95! < 50 && loop.max! < 250, 'Event-loop delay exceeded the latency budget')
    }
  } finally {
    finishing = true
    if (watchdog !== undefined) clearTimeout(watchdog)
    if (interval !== undefined) clearInterval(interval)
    worker?.postMessage('stop')
    // Keep the process guards installed for every teardown callback, even after a failed measurement.
    const teardownDeadline = setTimeout(() => {
      console.error('Scope pressure diagnostic teardown exceeded 125 seconds')
      rmSync(root, { recursive: true, force: true })
      process.exit(1)
    }, 125_000)
    try {
      for (const child of children.values()) child.exit()
      try {
        await dispose?.()
      } finally {
        await Promise.all(pendingQueries)
        await workerExit
        if (server.listening) {
          const closed = once(server, 'close')
          server.close()
          await closed
        }
      }
      await nextTurn()
      // The runtime keeps a process-wide spill directory even when no stream is captured.
      assert.deepEqual(readdirSync(root).filter(name => name.startsWith('dsh-subprocess-launch-')), [],
        'All owned launch files must be removed on teardown')
    } finally {
      clearTimeout(teardownDeadline)
      if (killDescriptor !== undefined) Object.defineProperty(process, 'kill', killDescriptor)
      Object.assign(childProcess, originals)
      syncBuiltinESMExports()
      for (const [name, value] of savedEnv) {
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}

const checkout = resolve(process.argv.find(value => value.startsWith('--checkout='))?.slice('--checkout='.length) ?? process.cwd())
await measure(checkout, process.argv.includes('--baseline'), process.argv.includes('--trace'))
