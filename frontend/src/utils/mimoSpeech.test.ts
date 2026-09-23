import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MIMO_FORMAT,
  MIMO_SPEECH_PATH,
  MimoSpeechError,
  buildMimoSpeechBody,
  buildMimoSpeechUrl,
  requestMimoSpeechAudio,
} from './mimoSpeech'

afterEach(() => {
  vi.restoreAllMocks()
})

function installLocalStorage() {
  const memory = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => memory.get(key) || null,
      setItem: (key: string, value: string) => memory.set(key, value),
      removeItem: (key: string) => memory.delete(key),
      clear: () => memory.clear(),
    },
    configurable: true,
  })
}

function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => payload,
  }
}


function stubUnmeasurableAudio() {
  vi.stubGlobal('Audio', class {
    duration = Number.NaN
    onloadedmetadata: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) {
      setTimeout(() => this.onerror?.(), 0)
    }
    get src() {
      return ''
    }
  })
}

function audioPayload(base64: string) {
  return { choices: [{ message: { role: 'assistant', audio: { id: 'a1', data: base64 } } }] }
}

describe('buildMimoSpeechBody', () => {
  it('builds chat-audio shape without speed or style prompt', () => {
    const body = buildMimoSpeechBody({
      input: '待合成文本',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      format: 'wav',
    })
    expect(body).toEqual({
      model: 'mimo-v2.5-tts',
      stream: false,
      messages: [{ role: 'assistant', content: '待合成文本' }],
      audio: { format: 'wav', voice: '冰糖' },
    })
    expect(body).not.toHaveProperty('input')
    expect(body).not.toHaveProperty('speed')
    expect(body).not.toHaveProperty('response_format')
  })
})

describe('buildMimoSpeechUrl', () => {
  it('joins base url with chat completions path and trims trailing slash', () => {
    expect(buildMimoSpeechUrl('https://api.xiaomimimo.com/v1/')).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(buildMimoSpeechUrl('https://api.xiaomimimo.com/v1')).toBe('https://api.xiaomimimo.com/v1/chat/completions')
  })
})

describe('requestMimoSpeechAudio', () => {
  it('posts chat-audio body directly in browser mode and decodes base64 audio', async () => {
    installLocalStorage()
    stubUnmeasurableAudio()
    const fetchMock = vi.fn(async () => jsonResponse(audioPayload(btoa('RIFFmock-wav'))))
    vi.stubGlobal('fetch', fetchMock)

    const blob = await requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'test-key',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '茉莉',
      format: 'wav',
    })

    expect(blob.type).toBe('audio/wav')
    expect(await blob.text()).toBe('RIFFmock-wav')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.xiaomimimo.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        }),
      }),
    )
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'mimo-v2.5-tts',
      stream: false,
      messages: [{ role: 'assistant', content: '你好' }],
      audio: { format: 'wav', voice: '茉莉' },
    })
  })

  it('routes server mode through aiProxy without browser credentials', async () => {
    installLocalStorage()
    stubUnmeasurableAudio()
    localStorage.setItem('accessToken', 'alice-token')
    const fetchMock = vi.fn(async () => jsonResponse(audioPayload(btoa('ID3'))))
    vi.stubGlobal('fetch', fetchMock)

    const blob = await requestMimoSpeechAudio({
      source: 'server',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'browser-key',
      input: '你好',
      model: 'browser-model',
      voice: 'browser-voice',
      format: 'mp3',
    })

    expect(blob.type).toBe('audio/mpeg')
    expect(fetchMock).toHaveBeenCalledWith(
      '/reader3/ai/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'alice-token',
          'Content-Type': 'application/json',
        }),
      }),
    )
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
    const payload = JSON.parse(String(init.body))
    expect(payload.useServerConfig).toBe(true)
    expect(payload.kind).toBe('speech')
    expect(payload.path).toBe(MIMO_SPEECH_PATH)
    expect(payload.body).toEqual({
      model: 'browser-model',
      stream: false,
      messages: [{ role: 'assistant', content: '你好' }],
      audio: { format: 'mp3', voice: 'browser-voice' },
    })
    expect(String(init.body)).not.toContain('browser-key')
  })

  it('uses mp3 mime type by default', async () => {
    installLocalStorage()
    stubUnmeasurableAudio()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(audioPayload(btoa('ID3')))))

    const blob = await requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
    })

    expect(blob.type).toBe('audio/mpeg')
  })

  it('surfaces upstream error message', async () => {
    installLocalStorage()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { error: { message: 'Invalid API Key' } },
      { ok: false, status: 401 },
    )))

    await expect(requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
    })).rejects.toThrow('Invalid API Key')
  })

  it('retries 429 with backoff and then succeeds', async () => {
    installLocalStorage()
    stubUnmeasurableAudio()
    let calls = 0
    const fetchMock = vi.fn(async () => {
      calls += 1
      if (calls < 3) return jsonResponse({ error: { message: 'rate limited' } }, { ok: false, status: 429 })
      return jsonResponse(audioPayload(btoa('RIFF')))
    })
    vi.stubGlobal('fetch', fetchMock)
    // 0 < 2000ms 的回调同步执行（退避等待、音频元数据），>= 2000ms 的兜底超时直接跳过
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number) => {
      if (typeof handler === 'function' && (ms ?? 0) < 2000) handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    const blob = await requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      format: 'wav',
    })

    expect(calls).toBe(3)
    expect(blob.type).toBe('audio/wav')
  })

  it('does not retry non-retryable errors', async () => {
    installLocalStorage()
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: { message: 'Invalid API Key' } },
      { ok: false, status: 401 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
    })).rejects.toBeInstanceOf(MimoSpeechError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives up after max attempts on persistent 429', async () => {
    installLocalStorage()
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: { message: 'rate limited' } },
      { ok: false, status: 429 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    // 0 < 2000ms 的回调同步执行（退避等待、音频元数据），>= 2000ms 的兜底超时直接跳过
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number) => {
      if (typeof handler === 'function' && (ms ?? 0) < 2000) handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    await expect(requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
    })).rejects.toThrow('rate limited')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws when response has no audio data', async () => {
    installLocalStorage()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: {} }] })))

    await expect(requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: DEFAULT_MIMO_FORMAT === 'mp3' ? '冰糖' : '茉莉',
    })).rejects.toThrow('MiMo 响应中缺少音频数据')
  })

  it('retries when upstream returns truncated audio', async () => {
    installLocalStorage()
    // 400 字正常应有 40 秒以上音频；第一次只给 3 秒，第二次给 120 秒
    const durations = [3, 120]
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      const duration = durations[Math.min(call, durations.length - 1)]
      call += 1
      return jsonResponse(audioPayload(btoa(`RIFF-${duration}`)))
    }))
    // 0 < 2000ms 的回调同步执行（退避等待、音频元数据），>= 2000ms 的兜底超时直接跳过
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, ms?: number) => {
      if (typeof handler === 'function' && (ms ?? 0) < 2000) handler()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    vi.stubGlobal('Audio', class {
      duration = Number.NaN
      onloadedmetadata: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        const duration = durations[Math.min(call - 1, durations.length - 1)]
        this.duration = duration
        setTimeout(() => this.onloadedmetadata?.(), 0)
      }
      get src() {
        return ''
      }
    })

    const blob = await requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '字'.repeat(400),
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      format: 'wav',
    })

    expect(call).toBe(2)
    expect(blob.type).toBe('audio/wav')
  })

  it('accepts audio whose duration cannot be measured', async () => {
    installLocalStorage()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(audioPayload(btoa('RIFF')))))
    vi.stubGlobal('Audio', class {
      duration = Number.NaN
      onloadedmetadata: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
      get src() {
        return ''
      }
    })

    const blob = await requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '字'.repeat(400),
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      format: 'wav',
    })

    expect(blob.type).toBe('audio/wav')
  })

  it('decodes large base64 payloads without losing bytes', async () => {
    installLocalStorage()
    const bytes = new Uint8Array(300000)
    bytes.forEach((_, i) => { bytes[i] = i % 256 })
    let binary = ''
    bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(audioPayload(btoa(binary)))))
    stubUnmeasurableAudio()

    const blob = await requestMimoSpeechAudio({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      input: '你好',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      format: 'wav',
    })

    const decoded = new Uint8Array(await blob.arrayBuffer())
    expect(decoded.length).toBe(bytes.length)
    expect(Array.from(decoded.slice(0, 64))).toEqual(Array.from(bytes.slice(0, 64)))
    expect(decoded[decoded.length - 1]).toBe(bytes[bytes.length - 1])
  })
})
