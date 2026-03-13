import { Router, Request, Response } from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import Redis from 'ioredis'
import { mockTokenStream } from '../mock/producer'

const router = Router()

const redis = new Redis({
    host: 'localhost',
    port: 6379
})

router.post('/stream', async (req: Request, res: Response) => {
    const { message, sessionId, useMock = false, tokensPerSecond } = req.body

    if (!message || !sessionId) {
        res.status(400).json({ error: 'message and sessionId are required' })
        return
    }

    const bufferKey = `stream:${sessionId}`

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    res.flushHeaders()

    try {
        let tokenStream: AsyncGenerator<string>

        if (useMock) {
            tokenStream = mockTokenStream({ tokensPerSecond })
        } else {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
            const result = await model.generateContentStream(message)

            tokenStream = (async function* () {
                for await (const chunk of result.stream) {
                    const text = chunk.text()
                    if (text) yield text
                }
            })()
        }

        let sequenceNumber = 0

        for await (const token of tokenStream) {
            await redis.rpush(bufferKey, token)
            await redis.expire(bufferKey, 3600)
            res.write(toSSEMessage(sequenceNumber, token))
            sequenceNumber++
        }
        // Signal that the stream is fully written
        await redis.set(`${bufferKey}:done`, '1', 'EX', 3600)

        res.write('event: done\ndata: stream complete\n\n')
        res.end()

    } catch (error) {
        console.error('Streaming error:', error)
        res.write(`event: error\ndata: something went wrong\n\n`)
        res.end()
    }
})

router.get('/stream/replay', async (req: Request, res: Response) => {
    const { sessionId, lastEventId } = req.query

    if (!sessionId || lastEventId === undefined) {
        res.status(400).json({ error: 'sessionId and lastEventId are required' })
        return
    }

    const fromIndex = parseInt(lastEventId as string) + 1
    if (isNaN(fromIndex)) {
        res.status(400).json({ error: 'lastEventId must be a number' })
        return
    }

    const bufferKey = `stream:${sessionId}`

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    res.flushHeaders()

    let currentIndex = fromIndex

    const poll = async () => {
        while (true) {
            // Read whatever tokens are available from currentIndex onwards
            const newTokens = await redis.lrange(bufferKey, currentIndex, -1)

            for (const token of newTokens) {
                res.write(toSSEMessage(currentIndex, token))
                currentIndex++
            }

            // Check if the original stream has finished writing
            const isDone = await redis.get(`${bufferKey}:done`)
            if (isDone) {
                res.write('event: done\ndata: replay complete\n\n')
                res.end()
                return
            }

            // Stream still in progress, wait before polling again
            await new Promise(resolve => setTimeout(resolve, 100))
        }
    }

    try {
        await poll()
    } catch (error) {
        console.error('Replay error:', error)
        res.write('event: error\ndata: something went wrong\n\n')
        res.end()
    }
})

function toSSEMessage(id: number, token: string): string {
    const dataLines = token
        .split('\n')
        .map(line => `data: ${line}`)
        .join('\n')
    return `id: ${id}\n${dataLines}\n\n`
}

export { router as streamRoute }