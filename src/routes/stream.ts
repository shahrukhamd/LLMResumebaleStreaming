import { Router, Request, Response } from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import Redis from 'ioredis'

const router = Router()

const redis = new Redis({
    host: 'localhost',
    port: 6379
})

router.post('/stream', async (req: Request, res: Response) => {
    const { message, sessionId } = req.body

    if (!message || !sessionId) {
        res.status(400).json({ error: 'message and sessionId are required' })
        return
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '')
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' })
    const bufferKey = `stream:${sessionId}`

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    res.flushHeaders()

    try {
        const result = await model.generateContentStream(message)

        let sequenceNumber = 0

        for await (const chunk of result.stream) {
            const token = chunk.text()

            if (!token) continue

            await redis.rpush(bufferKey, token)
            await redis.expire(bufferKey, 3600)

            res.write(`id: ${sequenceNumber}\ndata: ${token}\n\n`)

            sequenceNumber++
        }

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

    const bufferKey = `stream:${sessionId}`
    const fromIndex = parseInt(lastEventId as string) + 1

    const missedTokens = await redis.lrange(bufferKey, fromIndex, -1)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    res.flushHeaders()

    let sequenceNumber = fromIndex

    for (const token of missedTokens) {
        res.write(`id: ${sequenceNumber}\ndata: ${token}\n\n`)
        sequenceNumber++
    }

    res.write('event: done\ndata: replay complete\n\n')
    res.end()
})

export { router as streamRoute }