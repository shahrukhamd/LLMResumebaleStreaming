import {useState, useRef, useCallback, useEffect} from 'react'
import { v4 as uuidv4 } from 'uuid'

type StreamStatus =
    | 'idle'
    | 'streaming'
    | 'disconnected'
    | 'resuming'
    | 'complete'
    | 'error'

export default function App() {
    const [prompt, setPrompt] = useState('')
    const [response, setResponse] = useState('')
    const [status, setStatus] = useState<StreamStatus>('idle')
    const [tokenCount, setTokenCount] = useState(0)
    const [resumedFromToken, setResumedFromToken] = useState<number | null>(null)
    const [segments, setSegments] = useState<string[]>([])
    const [useMock, setUseMock] = useState(true)
    const [tokensPerSecond, setTokensPerSecond] = useState(8)

    const sessionIdRef = useRef<string>('')
    const lastEventIdRef = useRef<number>(-1)
    const xhrRef = useRef<XMLHttpRequest | null>(null)

    const appendToken = useCallback((token: string) => {
        setResponse(prev => prev + token)
        setTokenCount(prev => prev + 1)
    }, [])

    const startStream = useCallback((sessionId: string) => {
        setStatus('streaming')

        const xhr = new XMLHttpRequest()
        xhrRef.current = xhr

        xhr.open('POST', 'http://localhost:3001/api/stream')
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.setRequestHeader('Accept', 'text/event-stream')

        let buffer = ''

        xhr.onprogress = () => {
            const newData = xhr.responseText.slice(buffer.length)
            buffer = xhr.responseText
            for (const { id, data } of parseSSEChunk(newData)) {
                if (data === 'stream complete') { setStatus('complete'); return }
                if (id !== null) lastEventIdRef.current = id
                appendToken(data)
            }
        }

        xhr.onerror = () => {
            setStatus('error')
        }

        xhr.send(JSON.stringify({
            message: prompt,
            sessionId,
            useMock,
            tokensPerSecond
        }))
    }, [prompt, appendToken, useMock, tokensPerSecond])

    const handleSend = useCallback(() => {
        if (!prompt.trim()) return

        const sessionId = uuidv4()
        sessionIdRef.current = sessionId
        lastEventIdRef.current = -1

        setResponse('')
        setTokenCount(0)
        setResumedFromToken(null)
        setSegments([])

        startStream(sessionId)
    }, [prompt, startStream])

    const handleDisconnect = useCallback(() => {
        if (xhrRef.current) {
            xhrRef.current.abort()
            xhrRef.current = null
        }

        setSegments(prev => response ? [...prev, response] : prev)
        setResponse('')
        setStatus('disconnected')

        setTimeout(() => {
            handleResumeRef.current()
        }, 2000)
    }, [response])

    const handleResume = useCallback(() => {
        setStatus('resuming')

        const sessionId = sessionIdRef.current
        const lastId = lastEventIdRef.current
        const resumeFrom = lastId + 1

        setResumedFromToken(resumeFrom)

        fetch(
            `http://localhost:3001/api/stream/replay?sessionId=${sessionId}&lastEventId=${lastId}`
        )
            .then(res => res.text())
            .then(text => {
                for (const { id, data } of parseSSEChunk(text)) {
                    if (data === 'replay complete' || data === 'stream complete') {
                        setStatus('complete')
                        return
                    }
                    if (id !== null) lastEventIdRef.current = id
                    appendToken(data)
                }
                setStatus('complete')
            })
            .catch(() => {
                setStatus('error')
            })
    }, [appendToken])

    const handleResumeRef = useRef(handleResume)
    useEffect(() => { handleResumeRef.current = handleResume }, [handleResume])

    const handleReset = useCallback(() => {
        setPrompt('')
        setResponse('')
        setStatus('idle')
        setTokenCount(0)
        setResumedFromToken(null)
        setSegments([])
        lastEventIdRef.current = -1
        sessionIdRef.current = ''
    }, [])

    return (
        <div style={styles.container}>
            <h1 style={styles.title}>Resumable Streaming</h1>
            <p style={styles.subtitle}>
                Demonstrates SSE stream recovery using Redis buffering
            </p>

            <StatusBadge status={status} resumedFromToken={resumedFromToken} />

            <div style={styles.mockControls}>
                <label style={styles.mockLabel}>
                    <input
                        type="checkbox"
                        checked={useMock}
                        onChange={e => setUseMock(e.target.checked)}
                        disabled={status === 'streaming' || status === 'resuming'}
                    />
                    Use mock producer
                </label>

                {useMock && (
                    <label style={styles.mockLabel}>
                        Speed: {tokensPerSecond} tokens/sec
                        <input
                            type="range"
                            min={1}
                            max={20}
                            value={tokensPerSecond}
                            onChange={e => setTokensPerSecond(parseInt(e.target.value))}
                            disabled={status === 'streaming' || status === 'resuming'}
                            style={{ width: 120 }}
                        />
                    </label>
                )}
            </div>

            <div style={styles.inputRow}>
                <input
                    style={styles.input}
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSend()}
                    placeholder="Ask something that generates a long response..."
                    disabled={status === 'streaming' || status === 'resuming'}
                />
                <button
                    style={styles.sendButton}
                    onClick={handleSend}
                    disabled={status === 'streaming' || status === 'resuming' || !prompt.trim()}
                >
                    Send
                </button>
            </div>

            <div style={styles.controls}>
                {status === 'streaming' && (
                    <button style={styles.disconnectButton} onClick={handleDisconnect}>
                        Simulate Disconnect
                    </button>
                )}
                {(status === 'complete' || status === 'error') && (
                    <button style={styles.resetButton} onClick={handleReset}>
                        Start New Prompt
                    </button>
                )}
                {status === 'streaming' && (
                    <span style={styles.tokenCount}>
            {tokenCount} tokens received
          </span>
                )}
            </div>

            {response && (
                <div style={styles.responseBox}>
                    <div style={styles.responseText}>{response}</div>
                </div>
            )}

            {segments.length > 0 && (
                <div style={styles.segmentsContainer}>
                    <p style={styles.segmentsTitle}>Stream History</p>
                    {segments.map((segment, index) => (
                        <div key={index} style={styles.segmentItem}>
                            <div style={styles.segmentLabel}>
                                {index === 0 ? 'Initial stream' : `Resumed ${index}`}
                                <span style={styles.segmentBadge}>disconnected</span>
                            </div>
                            <div style={styles.segmentText}>{segment}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

function StatusBadge({
                         status,
                         resumedFromToken
                     }: {
    status: StreamStatus
    resumedFromToken: number | null
}) {
    const config: Record<StreamStatus, { label: string; color: string }> = {
        idle:         { label: 'Ready',        color: '#555' },
        streaming:    { label: 'Streaming...', color: '#2196F3' },
        disconnected: { label: 'Disconnected — reconnecting in 2s...', color: '#FF9800' },
        resuming:     { label: resumedFromToken !== null
                ? `Resuming from token ${resumedFromToken}...`
                : 'Resuming...',   color: '#9C27B0' },
        complete:     { label: 'Complete',     color: '#4CAF50' },
        error:        { label: 'Error',        color: '#f44336' },
    }

    const { label, color } = config[status]

    return (
        <div style={{ ...styles.badge, background: color }}>
            {label}
        </div>
    )
}

function parseSSEChunk(text: string): { id: number | null; data: string }[] {
    const events: { id: number | null; data: string }[] = []
    // Split on double-newline = SSE event boundary
    const rawEvents = text.split('\n\n').filter(Boolean)

    for (const rawEvent of rawEvents) {
        let id: number | null = null
        const dataLines: string[] = []

        for (const line of rawEvent.split('\n')) {
            if (line.startsWith('id: ')) {
                id = parseInt(line.slice(4))
            } else if (line.startsWith('data: ')) {
                dataLines.push(line.slice(6))
            }
        }

        if (dataLines.length > 0) {
            // Re-join multi-line data with the newline the server split on
            events.push({ id, data: dataLines.join('\n') })
        }
    }
    return events
}

const styles: Record<string, React.CSSProperties> = {
    container: {
        maxWidth: 720,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
    },
    title: {
        fontSize: 28,
        fontWeight: 700,
        color: '#fff',
    },
    subtitle: {
        color: '#888',
        fontSize: 14,
    },
    badge: {
        display: 'inline-block',
        padding: '6px 14px',
        borderRadius: 20,
        fontSize: 13,
        fontWeight: 500,
        color: '#fff',
        alignSelf: 'flex-start',
    },
    inputRow: {
        display: 'flex',
        gap: 10,
    },
    input: {
        flex: 1,
        padding: '12px 16px',
        borderRadius: 8,
        border: '1px solid #333',
        background: '#1a1a1a',
        color: '#e0e0e0',
        fontSize: 15,
        outline: 'none',
    },
    sendButton: {
        padding: '12px 24px',
        borderRadius: 8,
        border: 'none',
        background: '#2196F3',
        color: '#fff',
        fontSize: 15,
        fontWeight: 600,
        cursor: 'pointer',
    },
    responseBox: {
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 8,
        padding: 20,
        minHeight: 120,
    },
    responseText: {
        fontSize: 15,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        color: '#e0e0e0',
    },
    controls: {
        display: 'flex',
        alignItems: 'center',
        gap: 16,
    },
    disconnectButton: {
        padding: '10px 20px',
        borderRadius: 8,
        border: '1px solid #FF9800',
        background: 'transparent',
        color: '#FF9800',
        fontSize: 14,
        fontWeight: 500,
        cursor: 'pointer',
    },
    resetButton: {
        padding: '10px 20px',
        borderRadius: 8,
        border: '1px solid #4CAF50',
        background: 'transparent',
        color: '#4CAF50',
        fontSize: 14,
        fontWeight: 500,
        cursor: 'pointer',
    },
    tokenCount: {
        fontSize: 13,
        color: '#666',
    },
    segmentsContainer: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
    },
    segmentsTitle: {
        fontSize: 13,
        fontWeight: 600,
        color: '#666',
        textTransform: 'uppercase',
        letterSpacing: 1,
    },
    segmentItem: {
        border: '1px solid #2a2a2a',
        borderLeft: '3px solid #FF9800',
        borderRadius: 8,
        padding: 16,
        background: '#141414',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
    },
    segmentLabel: {
        fontSize: 12,
        fontWeight: 600,
        color: '#FF9800',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
    },
    segmentBadge: {
        background: '#2a1a00',
        color: '#FF9800',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 500,
    },
    segmentText: {
        fontSize: 14,
        lineHeight: 1.7,
        color: '#999',
        whiteSpace: 'pre-wrap' as const,
    },
    mockControls: {
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        padding: '12px 16px',
        background: '#1a1a1a',
        borderRadius: 8,
        border: '1px solid #2a2a2a',
    },
    mockLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        color: '#aaa',
        cursor: 'pointer',
    },
}