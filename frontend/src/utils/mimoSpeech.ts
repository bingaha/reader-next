import { readSpeechError } from './openaiSpeech'

export const DEFAULT_MIMO_BASE_URL = 'https://api.xiaomimimo.com/v1'
export const DEFAULT_MIMO_MODEL = 'mimo-v2.5-tts'
export const DEFAULT_MIMO_VOICE = '冰糖'
export const DEFAULT_MIMO_FORMAT = 'mp3'
export const MIMO_SPEECH_PATH = '/v1/chat/completions'

export const MIMO_VOICES = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
] as const

export type MimoVoice = typeof MIMO_VOICES[number]
export type MimoAudioFormat = 'wav' | 'mp3'

export const MIMO_AUDIO_FORMATS: MimoAudioFormat[] = ['mp3', 'wav']

export const MIMO_PRELOAD_DEFAULT = 2
export const MIMO_PRELOAD_MAX = 10

const MIMO_MAX_ATTEMPTS = 3
const MIMO_RETRY_BASE_DELAY_MS = 800
const BASE64_SLICE_CHARS = 0x8000

export interface MimoSpeechRequest {
  source?: 'browser' | 'server'
  baseUrl: string
  apiKey?: string
  input: string
  model: string
  voice: string
  format?: MimoAudioFormat
  signal?: AbortSignal
}

export class MimoSpeechError extends Error {
  status: number
  retryable: boolean

  constructor(message: string, status: number, retryable = isRetryableStatus(status)) {
    super(message)
    this.name = 'MimoSpeechError'
    this.status = status
    this.retryable = retryable
  }
}

export function normalizeMimoBaseUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

export function buildMimoSpeechUrl(baseUrl: string) {
  const normalized = normalizeMimoBaseUrl(baseUrl)
  // 用户常直接填写带 /v1 的官方地址（https://api.xiaomimimo.com/v1），避免拼出 /v1/v1
  const suffix = normalized.endsWith('/v1')
    ? MIMO_SPEECH_PATH.slice('/v1'.length)
    : MIMO_SPEECH_PATH
  return `${normalized}${suffix}`
}

export function buildMimoSpeechBody({
  input,
  model,
  voice,
  format,
}: Pick<MimoSpeechRequest, 'input' | 'model' | 'voice' | 'format'>) {
  return {
    model,
    stream: false,
    messages: [{ role: 'assistant', content: input }],
    audio: {
      format: format || DEFAULT_MIMO_FORMAT,
      voice,
    },
  }
}

function buildAuthHeaders(apiKey?: string) {
  const headers: Record<string, string> = {}
  if (!apiKey?.trim()) return headers
  headers.Authorization = `Bearer ${apiKey.trim()}`
  return headers
}

function buildReaderAuthHeaders() {
  const headers: Record<string, string> = {}
  try {
    const token = localStorage.getItem('accessToken') || ''
    if (token) headers.Authorization = token
  } catch {
    // ignore storage access failures
  }
  return headers
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500
}

/** 普通话约 3-5 字/秒，取极保守下界用于校验音频是否被截断 */
const MIN_AUDIO_SECONDS_PER_CHAR = 0.1
const TRUNCATED_AUDIO_RATIO = 0.35

function audioDurationSeconds(blob: Blob) {
  if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return Promise.resolve(null)
  }
  const objectUrl = URL.createObjectURL(blob)
  return new Promise<number | null>((resolve) => {
    const audio = new Audio()
    let settled = false
    let timer: number | undefined
    const finish = (value: number | null) => {
      if (settled) return
      settled = true
      if (timer != null) window.clearTimeout(timer)
      audio.onloadedmetadata = null
      audio.onerror = null
      audio.src = ''
      resolve(value)
    }
    timer = window.setTimeout(() => finish(null), 3000)
    audio.onloadedmetadata = () => finish(Number.isFinite(audio.duration) ? audio.duration : null)
    audio.onerror = () => finish(null)
    audio.src = objectUrl
  }).finally(() => {
    URL.revokeObjectURL(objectUrl)
  })
}

/** MiMo 偶发返回截断音频（同一请求时长为正常值的十分之一），播前校验时长 */
async function ensureCompleteAudio(blob: Blob, input: string) {
  const duration = await audioDurationSeconds(blob)
  if (duration == null) return blob
  const expectedSeconds = Array.from(input).length * MIN_AUDIO_SECONDS_PER_CHAR
  if (duration < expectedSeconds * TRUNCATED_AUDIO_RATIO) {
    throw new MimoSpeechError(
      `MiMo 返回的音频不完整（${Math.round(duration)} 秒，预期约 ${Math.round(expectedSeconds)} 秒）`,
      200,
      true,
    )
  }
  return blob
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function base64ToUint8Array(base64: string) {
  const normalized = base64.replace(/\s+/g, '')
  const payload = normalized.includes(',')
    ? normalized.slice(normalized.indexOf(',') + 1)
    : normalized
  const padding = (/=+$/.exec(payload) || [''])[0].length
  const byteLength = Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (let index = 0; index < payload.length; index += BASE64_SLICE_CHARS) {
    const binary = atob(payload.slice(index, index + BASE64_SLICE_CHARS))
    for (let charIndex = 0; charIndex < binary.length; charIndex += 1) {
      bytes[offset + charIndex] = binary.charCodeAt(charIndex)
    }
    offset += binary.length
  }
  return bytes
}

function extractMimoAudioData(payload: unknown): string {
  const data = (payload as {
    choices?: { message?: { audio?: { data?: string } } }[]
  } | null)?.choices?.[0]?.message?.audio?.data
  if (typeof data !== 'string' || !data.trim()) {
    throw new MimoSpeechError('MiMo 响应中缺少音频数据', 200)
  }
  return data
}

function formatToMimeType(format: MimoAudioFormat) {
  return format === 'wav' ? 'audio/wav' : 'audio/mpeg'
}

async function requestOnce(request: MimoSpeechRequest): Promise<Blob> {
  const format = request.format || DEFAULT_MIMO_FORMAT
  const body = buildMimoSpeechBody(request)
  const response = request.source === 'server'
    ? await fetch('/reader3/ai/proxy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildReaderAuthHeaders(),
      },
      body: JSON.stringify({
        useServerConfig: true,
        kind: 'speech',
        path: MIMO_SPEECH_PATH,
        body,
      }),
      signal: request.signal,
    })
    : await fetch(buildMimoSpeechUrl(request.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(request.apiKey),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    })

  if (!response.ok) {
    throw new MimoSpeechError(await readSpeechError(response), response.status)
  }

  const payload = await response.json()
  const bytes = base64ToUint8Array(extractMimoAudioData(payload))
  const blob = new Blob([bytes], { type: formatToMimeType(format) })
  return ensureCompleteAudio(blob, request.input)
}

export async function requestMimoSpeechAudio(request: MimoSpeechRequest) {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= MIMO_MAX_ATTEMPTS; attempt += 1) {
    if (request.signal?.aborted) break
    try {
      return await requestOnce(request)
    } catch (error) {
      lastError = error
      const retryable = error instanceof MimoSpeechError
        ? error.retryable
        : isRetryableStatus((error as { status?: number })?.status || 0)
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      if (aborted || !retryable || attempt === MIMO_MAX_ATTEMPTS) {
        throw error
      }
      await sleep(MIMO_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), request.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new MimoSpeechError('MiMo 语音请求失败', 0, false)
}
