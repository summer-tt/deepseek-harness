/** V2 history records become one event-shaped Client value per wire record. */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionHistoryRecord } from '../src/types.ts'
import {
  historyEntries,
  historyRecordFirstSeq,
  historyRecordLastSeq,
  sameHistoryValue,
} from '../src/client/sessions/history-records.ts'

describe('Session history record projection', () => {
  it('retains an ordinary event and its point cursor', () => {
    const ordinary: SessionHistoryRecord = {
      type: 'event',
      event: { type: 'turn/start', seq: 7, time: 1, data: { turn: 1 } },
    }

    const records = [ordinary]
    const [entry] = historyEntries(records)

    expect(historyEntries(records)).toBe(records)
    expect(entry).toBe(ordinary)
    expect(historyRecordFirstSeq(ordinary)).toBe(7)
    expect(entry?.event.time).toBe(1)
    expect(historyRecordLastSeq(ordinary)).toBe(7)
  })

  it('retains one message with an embedded compact text stream', () => {
    const message: SessionHistoryRecord = {
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 11,
        time: 20,
        data: {
          turn: 1,
          step: 2,
          message: {
            id: 'message-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'abcd' }],
            source: { kind: 'model', provider: 'fixture', model: 'fixture-v2' },
          },
          stream: [{ type: 'text-chunks', time0: 20, index: 0, dt: [1, 2, 3], texts: ['a', 'b', 'c', 'd'] }],
        },
      },
    }

    const [entry] = historyEntries([message])
    if (entry?.type !== 'event') throw new Error('expected v2 history entry')
    const { event } = entry

    expect(entry).toBe(message)
    expect(event).toBe(message.event)
    expect(historyRecordFirstSeq(message)).toBe(11)
    expect(event.time).toBe(20)
    expect(historyRecordLastSeq(message)).toBe(11)
  })

  it('preserves an attempt stream and optional tool-name absence', () => {
    const attempt: SessionHistoryRecord = {
      type: 'event',
      event: {
        type: 'assistant/attempt',
        seq: 20,
        time: 200,
        data: {
          turn: 2,
          step: 4,
          stream: [{
            type: 'tool-call-chunks',
            time0: 200,
            index: 1,
            id: ToolCallId('call-1'),
            dt: [2, 3],
            args: ['', '{"x":', '1}'],
          }],
        },
      },
    }

    const [entry] = historyEntries([attempt])
    if (entry?.type !== 'event') throw new Error('expected v2 history entry')
    const { event } = entry

    if (event.type !== 'assistant/attempt') throw new Error('expected Assistant attempt event')
    expect(event).toBe(attempt.event)
    const [record] = event.data.stream
    expect(record).toMatchObject({ type: 'tool-call-chunks', id: 'call-1' })
    expect(Object.hasOwn(record as object, 'name')).toBe(false)
    expect(historyRecordLastSeq(attempt)).toBe(20)
  })
})


it('compares reordered JSON keys and distinguishes own keys from inherited keys', () => {
  expect(sameHistoryValue({ a: [1], b: 2 }, { b: 2, a: [1] })).toBe(true)
  expect(sameHistoryValue({ constructor: 1 }, Object.assign(Object.create({ constructor: 1 }), { different: 1 }))).toBe(false)
  expect(sameHistoryValue([1], { 0: 1 })).toBe(false)
})

it('compares deeply nested JSON without exhausting the call stack', () => {
  let left: unknown = 'last'
  let right: unknown = 'last'
  for (let depth = 0; depth < 15_000; depth += 1) {
    left = { child: left }
    right = { child: right }
  }
  expect(sameHistoryValue(left, right)).toBe(true)
})
