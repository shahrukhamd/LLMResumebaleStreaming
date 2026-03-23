# Resumable LLM Streaming

A proof of concept demonstrating how to recover an AI token stream after a browser disconnect  without restarting generation from scratch.

Most AI platforms silently restart when a connection drops. The user loses everything generated so far, the model regenerates from scratch, and you pay for tokens twice. This project shows a better approach: buffer every token server-side as it arrives, assign each one a sequence number, and replay only the missed tokens when the client reconnects. From the user's perspective, the stream simply continues.

![Demo](media/demo.gif)

## The Problem

### How streaming actually works

When an LLM generates a response, it produces one token at a time. A token is roughly a word fragment  the string "Resumable streaming" is three tokens: `Resumable`, ` stream`, `ing`. The model cannot plan ahead or batch tokens. Each one depends on every token before it, so they must be processed and sent sequentially.

These tokens travel to the browser over a persistent HTTP connection using a protocol called Server-Sent Events (SSE). The server keeps the connection open and pushes data as it becomes available, rather than waiting for the full response to be ready.

```
AI Provider  →  token by token  →  Your Server  →  SSE  →  Browser
```

### Two failures, not one

The phrase "the stream broke" sounds like one problem. It is actually two completely different problems that most implementations treat as identical.

```
Failure A — Client disconnect

Browser  ✗  Your Server ←————————— AI Provider
              (still receiving tokens)

The generation never stopped. The server is still getting tokens
from the provider. You just lost the pipe to the browser.
Fix: buffer tokens on the server, replay on reconnect.


Failure B — Provider disconnect

Browser ←—— Your Server  ✗  AI Provider
                              (generation gone forever)

The generation died. No provider exposes a resume API.
The partial response is all you have.
Fix: continuation prompting — a harder, separate problem.
```

This project solves Failure A completely. Failure B is documented in [What's Next](#whats-next).

### Why the naive fix doesn't work

The browser's native `EventSource` API reconnects automatically after a dropped connection. It even sends a `Last-Event-ID` header telling the server the last event it received. The infrastructure for resuming already exists in the browser.

The problem is that almost no server implementations use it. When the reconnect arrives, most servers ignore `Last-Event-ID` and start a brand new stream from the beginning triggering a full AI regeneration. The browser did its job. The server threw the information away.

This project fixes that on the server side.


## How It Works

### 1. Every token gets buffered in Redis

As tokens arrive from the AI provider, each one is immediately written to a Redis list before being forwarded to the browser. Redis lists preserve insertion order, giving us a reliable ordered record of every token in the stream.

```
Token arrives from provider
  → RPUSH stream:{sessionId} "{token}"   (append to Redis list)
  → SSE write to browser                 (forward immediately)
```

The Redis key is namespaced by session ID so concurrent users never share a buffer. A one-hour TTL means buffers clean themselves up automatically, no garbage collection code needed.

### 2. Every SSE event carries a sequence number

The SSE `id` field is a standard part of the protocol. The browser remembers the last `id` it saw and automatically includes it as `Last-Event-ID` on reconnect. We assign a monotonically increasing integer to every token:

```
id: 0
data: Resumable

id: 1
data:  stream

id: 2
data: ing

id: 3
data:  is
```

The sequence number doubles as the Redis list index. Token `id: 47` is stored at index 47 in the Redis list. This makes replay trivial, no mapping or translation needed.

### 3. On reconnect, Redis replays the gap

When the browser reconnects and sends `Last-Event-ID: 47`, the server reads from Redis starting at index 48 and streams every missed token back in order. No AI call is made. No tokens are regenerated. The browser receives exactly what it missed.

```
Browser reconnects:  Last-Event-ID: 47
Server:              LRANGE stream:{sessionId} 48 -1
                     → [token_48, token_49, token_50, ...]
                     → replay each as SSE event
                     → continue with live stream
```


## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Browser (React)                      │
│                                                          │
│  · Generates a UUID session ID per conversation          │
│  · Opens XHR stream to POST /api/stream                  │
│  · Tracks last received sequence number                  │
│  · On disconnect: calls GET /api/stream/replay           │
│    with sessionId + lastEventId                          │
│  · Displays live status across 5 states:                 │
│    idle → streaming → disconnected → resuming → done     │
└───────────────────────┬──────────────────────────────────┘
                        │
              POST /api/stream (initial)
              GET  /api/stream/replay (on reconnect)
                        │
┌───────────────────────▼──────────────────────────────────┐
│              Node.js + Express (TypeScript)              │
│                                                          │
│  POST /api/stream                                        │
│  · Accepts: { message, sessionId, useMock,               │
│               tokensPerSecond }                          │
│  · Starts token stream (Gemini SDK or mock producer)     │
│  · For each token:                                       │
│      RPUSH stream:{sessionId} "{token}"                  │
│      EXPIRE stream:{sessionId} 3600                      │
│      res.write(`id: {seq}\ndata: {token}\n\n`)           │
│  · On stream end: sends SSE done event, closes           │
│                                                          │
│  GET /api/stream/replay                                  │
│  · Accepts: ?sessionId=...&lastEventId=...               │
│  · LRANGE stream:{sessionId} {lastEventId+1} -1          │
│  · Replays each token as a numbered SSE event            │
│  · Sends done event, closes                              │
└──────────┬────────────────────────┬──────────────────────┘
           │                        │
     RPUSH / LRANGE        generateContentStream
     EXPIRE                         │
           │                        │
┌──────────▼───────────┐  ┌─────────▼──────────────────────┐
│        Redis         │  │   AI Provider                  │
│                      │  │   (Gemini or Mock Producer)    │
│  Key:                │  │                                │
│  stream:{sessionId}  │  │  Exposes AsyncGenerator<string>│
│                      │  │  — same interface for both     │
│  Value (LIST):       │  │  — route handler is agnostic   │
│  [0]  "Resumable"    │  │                                │
│  [1]  " stream"      │  └────────────────────────────────┘
│  [2]  "ing"          │
│  [3]  " is"          │
│  ...                 │
│                      │
│  TTL: 3600 seconds   │
│  (auto-expires)      │
└──────────────────────┘
```

### Why XHR instead of EventSource

The browser's native `EventSource` only supports GET requests. Our stream endpoint is a POST because we need to send the prompt and session ID in the request body. We use `XMLHttpRequest` instead, reading `xhr.responseText` incrementally via `onprogress` to get identical streaming behavior while supporting POST.

### Why Redis instead of in-process memory

An in-process array would work for a single server instance. But it breaks the moment you run two server instances for reliability, they don't share memory. Redis is an external shared store that all instances can read from and write to. It also survives server restarts, whereas in-process state disappears the moment the process exits.

### Provider abstraction via AsyncGenerator

The route handler consumes tokens through a `for await` loop over an `AsyncGenerator<string>`. Both the Gemini SDK path and the mock producer implement this same interface. The handler has no `if (mock)` branches, it is identical regardless of which provider is active. This is what makes the infrastructure independently testable.

```ts
// Both paths produce AsyncGenerator<string>
const tokenStream = useMock
  ? mockTokenStream({ tokensPerSecond })
  : geminiStream(message)

// This loop never changes regardless of provider
for await (const token of tokenStream) {
  await redis.rpush(bufferKey, token)
  res.write(`id: ${seq}\ndata: ${token}\n\n`)
  seq++
}
```


## Mock Producer

Testing streaming infrastructure against a real AI API is painful. Responses are non-deterministic, rate limits interfere with rapid iteration, and you cannot control when or how fast tokens arrive.

The mock producer solves this. It streams a fixed paragraph of text at a configurable token rate, controllable via a slider in the UI. At 2 tokens per second you can easily click disconnect at a specific point in the text. At 15 you can stress-test the buffer write path. Because it implements the same `AsyncGenerator<string>` interface as the Gemini path, you can toggle between real and mock at runtime without restarting anything.


## Running Locally

### Prerequisites

- Node.js 18 or later
- Docker — for Redis, keeps your system clean and fully reversible
- A Gemini API key from [aistudio.google.com](https://aistudio.google.com)

### 1. Start Redis

```bash
docker run -d \
  --name redis-streaming \
  -p 6379:6379 \
  redis:alpine
```

Verify it is running:

```bash
docker exec -it redis-streaming redis-cli ping
# PONG
```

To stop Redis when you are done:

```bash
docker stop redis-streaming
```

### 2. Set Up the Backend

```bash
cd ./LLM-Resumeable-Streaming
npm install
```

Create a `.env` file in the project root:

```
GEMINI_API_KEY=your-key-here
PORT=3001
```

Start the server:

```bash
npm run dev
# Server running on http://localhost:3001
```

### 3. Set Up the Frontend

Open a second terminal:

```bash
cd ./resumable-streaming-client
npm install
npm run dev
# Frontend running on http://localhost:5173
```

### 4. Try the Disconnect Flow

Open `http://localhost:5173`.

The mock producer is enabled by default, no API key needed to test the core behavior.

1. Type any prompt and click **Send**
2. While tokens are streaming, click **Simulate Disconnect**
3. Watch the status badge: `Streaming` → `Disconnected` → `Resuming from token N` → `Complete`
4. The stream history below the response shows which tokens arrived before and after each disruption, clearly separated

To test with real Gemini, uncheck **Use mock producer**.


## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Type safety catches subtle streaming edge cases early |
| Runtime | Node.js | Non-blocking I/O keeps many concurrent streams flowing efficiently |
| Server | Express | Minimal overhead, straightforward SSE handling |
| Buffer | Redis | In-memory speed, native LIST + LRANGE, built-in expiry |
| Frontend | React + Vite | Component state maps cleanly to streaming state machine |
| AI Provider | Google Gemini | Free tier sufficient for development and testing |


## What's Next

This POC solves client-side disconnects reliably. The natural next problem is provider-side failures, when the AI provider drops mid-generation and the generation itself is gone.

**The fix is continuation prompting: take the partial response buffered in Redis, inject it back as assistant context, and ask the model to continue. The tricky parts are preventing the model from repeating the last few words, handling mid-token boundaries that produce garbled text, and dealing with mid-flight tool call JSON that leaves a malformed object in the buffer. That is a deeper problem and a separate project.**


## Why I Built This

I wanted to understand the infrastructure gap between what AI providers expose and what production AI platforms actually need to build on top of them. Resumable streaming is a clean example of that gap. The provider gives you a stream. What you do when that stream breaks, and how you make the recovery invisible to the user, is entirely the platform's problem to solve.
