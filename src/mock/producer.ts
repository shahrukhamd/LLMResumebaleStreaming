export interface MockProducerOptions {
    tokensPerSecond?: number
    text?: string
}

const DEFAULT_TEXT = `
Resumable streaming is a technique that allows a data stream to continue 
from the point of interruption rather than restarting from the beginning. 
This is particularly valuable in AI applications where language models 
generate long responses token by token over a network connection.

When a user's browser disconnects mid-stream — due to a network hiccup, 
switching tabs, or closing a laptop — traditional implementations discard 
all progress and restart generation from scratch. This wastes compute 
resources, increases latency, and creates a frustrating user experience.

The solution involves three components working together. First, a server-side 
buffer stores every token as it arrives from the language model, indexed by 
sequence number. Second, the streaming protocol includes those sequence numbers 
so the client always knows exactly which token it last received. Third, when 
the client reconnects, it sends that last sequence number and the server 
replays only the missed tokens from the buffer.

Redis is the ideal buffer for this use case because it stores data in memory 
rather than on disk, making reads and writes fast enough to keep up with 
token generation. Its built-in list data structure maintains token order 
naturally, and its expiry feature automatically cleans up buffers after a 
configurable time window.

The result is a seamless experience where users never notice a disconnection 
happened at all. From their perspective, the stream simply continued. Behind 
the scenes, the infrastructure detected the gap, fetched the missed tokens 
from Redis, and replayed them before continuing with live generation.
`

function tokenize(text: string): string[] {
    const tokens: string[] = []
    let current = ''

    for (const char of text) {
        current += char
        if (char === ' ' || char === '\n') {
            tokens.push(current)
            current = ''
        }
    }

    if (current.length > 0) {
        tokens.push(current)
    }

    return tokens
}

export async function* mockTokenStream(
    options: MockProducerOptions = {}
): AsyncGenerator<string> {
    const tokensPerSecond = options.tokensPerSecond ?? 8
    const text = options.text ?? DEFAULT_TEXT
    const delayMs = Math.floor(1000 / tokensPerSecond)
    const tokens = tokenize(text)

    for (const token of tokens) {
        await sleep(delayMs)
        yield token
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}