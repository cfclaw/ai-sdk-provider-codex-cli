/**
 * Minimal SSE parser for the Codex Responses API stream.
 *
 * The backend emits standard `text/event-stream` frames with `data:` lines
 * containing a JSON payload. We yield each parsed JSON event one at a time.
 * Comment lines (`:`), `event:` lines, and lines that aren't `data:` are
 * ignored. The terminal `data: [DONE]` marker is yielded as a sentinel
 * `{ type: '__done__' }` event so the consumer can finalize cleanly.
 */
export interface SseEvent {
  type?: string;
  [k: string]: unknown;
}

export const SSE_DONE: SseEvent = { type: '__done__' };

export async function* iterateSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are delimited by blank lines, but the official Codex
      // backend also emits one event per line with a `data: ` prefix.
      // Splitting on `\n` and filtering for `data:` covers both shapes.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') {
          yield SSE_DONE;
          continue;
        }

        try {
          const event = JSON.parse(payload) as SseEvent;
          yield event;
        } catch {
          // Malformed event — skip silently so a single corrupt frame
          // doesn't kill the whole stream. The caller can detect missing
          // terminal events from the absence of a `response.completed`.
        }
      }
    }

    // Flush any trailing partial line on stream end.
    const trailing = buffer.trim();
    if (trailing.startsWith('data:')) {
      const payload = trailing.slice(5).trimStart();
      if (payload === '[DONE]') {
        yield SSE_DONE;
      } else {
        try {
          yield JSON.parse(payload) as SseEvent;
        } catch {
          // ignore
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
