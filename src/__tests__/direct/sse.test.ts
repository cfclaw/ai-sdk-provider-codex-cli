import { describe, expect, it } from 'vitest';
import { iterateSseEvents, SSE_DONE } from '../../direct/sse.js';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterateSseEvents(body)) {
    events.push(event);
  }
  return events;
}

describe('iterateSseEvents', () => {
  it('yields each JSON event in order', async () => {
    const events = await collect(
      streamFromChunks([
        'data: {"type":"a","i":1}\n',
        'data: {"type":"b","i":2}\n',
        'data: [DONE]\n',
      ]),
    );
    expect(events).toEqual([{ type: 'a', i: 1 }, { type: 'b', i: 2 }, SSE_DONE]);
  });

  it('handles events split across multiple read chunks', async () => {
    const events = await collect(
      streamFromChunks(['data: {"type":"a",', '"i":1}\n', 'data: {"type":"b","i":2}\n']),
    );
    expect(events).toEqual([
      { type: 'a', i: 1 },
      { type: 'b', i: 2 },
    ]);
  });

  it('skips malformed events without aborting the stream', async () => {
    const events = await collect(
      streamFromChunks(['data: not json\n', 'data: {"type":"a"}\n', 'data: [DONE]\n']),
    );
    expect(events).toEqual([{ type: 'a' }, SSE_DONE]);
  });

  it('ignores non-data lines (event:, comments, blank lines)', async () => {
    const events = await collect(
      streamFromChunks([': comment\n', 'event: ping\n', '\n', 'data: {"type":"a"}\n']),
    );
    expect(events).toEqual([{ type: 'a' }]);
  });
});
