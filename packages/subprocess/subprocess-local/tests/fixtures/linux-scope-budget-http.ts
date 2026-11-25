/** Issue loopback requests independently of the thread running the scope scheduler. */
import { Agent, get } from 'node:http'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { parentPort, workerData } from 'node:worker_threads'

const port = parentPort
const serverPort: unknown = workerData
if (port === null || typeof serverPort !== 'number') throw new Error('Expected a probe worker and a loopback port')
const agent = new Agent({ keepAlive: true, maxSockets: 1 })
let stopping = false
port.once('message', () => { stopping = true })
try {
  while (!stopping) {
    const at = performance.now()
    await new Promise<void>((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port: serverPort, agent }, (response) => {
        response.resume()
        response.once('error', reject)
        response.once('end', () => {
          if (response.statusCode === 204) resolve()
          else reject(new Error(`HTTP probe received status ${String(response.statusCode)}`))
        })
      })
      request.once('error', reject)
      request.setTimeout(30_000, () => { request.destroy(new Error('HTTP probe timed out')) })
    })
    const end = performance.now()
    port.postMessage({ at, end, ms: end - at })
    await sleep(10)
  }
} finally {
  agent.destroy()
  port.close()
}
