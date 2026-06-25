const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

const parseFrame = (frame: string): SseEvent | null => {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (!event && data.length === 0) {
    return null;
  }
  return { data: data.join("\n"), event, id };
};

interface ByteChunkReader {
  read: () => Promise<
    { done: false; value: Uint8Array } | { done: true; value?: undefined }
  >;
  releaseLock: () => void;
}

const readReaderChunks = async function* readReaderChunks(
  reader: ByteChunkReader
): AsyncGenerator<Uint8Array> {
  const { value, done } = await reader.read();
  if (done) {
    return;
  }
  if (value) {
    yield value;
  }
  yield* readReaderChunks(reader);
};

const readStreamChunks = async function* readStreamChunks(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader() as ByteChunkReader;
  try {
    yield* readReaderChunks(reader);
  } finally {
    reader.releaseLock();
  }
};

export const parseSse = async function* parseSse(
  stream: ReadableStream<Uint8Array> | null
): AsyncGenerator<SseEvent> {
  if (!stream) {
    return;
  }

  let buffer = "";
  for await (const value of readStreamChunks(stream)) {
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseFrame(frame);
      if (event) {
        yield event;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) {
    const event = parseFrame(buffer);
    if (event) {
      yield event;
    }
  }
};

export const encodeSse = (data: unknown, event?: string): Uint8Array => {
  const lines: string[] = [];
  if (event) {
    lines.push(`event: ${event}`);
  }
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const line of payload.split("\n")) {
    lines.push(`data: ${line}`);
  }
  lines.push("", "");
  return encoder.encode(lines.join("\n"));
};
