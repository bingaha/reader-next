import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useReaderStore } from './reader'
import { requestMimoSpeechAudio } from '../utils/mimoSpeech'

vi.mock('../api/bookshelf', () => ({
  getChapterList: vi.fn(),
  getBookContent: vi.fn(),
  getShelfBook: vi.fn(),
  saveBookProgress: vi.fn(),
  setBookSource: vi.fn(),
}))

vi.mock('../api/bookmark', () => ({
  getBookmarks: vi.fn(),
  saveBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  deleteBookmarks: vi.fn(),
}))

vi.mock('../api/replaceRule', () => ({
  getReplaceRules: vi.fn(),
}))

vi.mock('../utils/browserCache', () => ({
  getBrowserCachedChapter: vi.fn(),
  setBrowserCachedChapter: vi.fn(),
}))

vi.mock('../utils/recentBooks', () => ({
  saveRecentReadBook: vi.fn(),
}))

vi.mock('../utils/openaiSpeech', () => ({
  DEFAULT_OPENAI_BASE_URL: 'https://api.openai.com/v1',
  requestOpenAISpeechAudio: vi.fn(),
}))

vi.mock('../utils/mimoSpeech', () => ({
  DEFAULT_MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1',
  DEFAULT_MIMO_FORMAT: 'mp3',
  DEFAULT_MIMO_MODEL: 'mimo-v2.5-tts',
  DEFAULT_MIMO_VOICE: '冰糖',
  MIMO_PRELOAD_DEFAULT: 2,
  MIMO_PRELOAD_MAX: 10,
  requestMimoSpeechAudio: vi.fn(),
}))

vi.mock('./aiBook', () => ({
  useAiBookStore: () => ({
    loadServerModelConfig: vi.fn().mockResolvedValue(null),
  }),
}))

function installLocalStorage(initial: Record<string, string> = {}) {
  const memory = new Map<string, string>(Object.entries(initial))
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

function useStore() {
  const store = useReaderStore()
  store.content = '<p>第一章内容</p>'
  return store
}

describe('reader mimo speech config', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    installLocalStorage()
  })

  it('fills mimo defaults when nothing is persisted', () => {
    const store = useStore()
    expect(store.speechConfig.provider).toBe('system')
    expect(store.speechConfig.mimoBaseUrl).toBe('https://api.xiaomimimo.com/v1')
    expect(store.speechConfig.mimoModel).toBe('mimo-v2.5-tts')
    expect(store.speechConfig.mimoVoice).toBe('冰糖')
    expect(store.speechConfig.mimoFormat).toBe('mp3')
    expect(store.speechConfig.mimoPreloadCount).toBe(2)
    expect(store.networkSpeechConfigured).toBe(true)
  })

  it('keeps existing openai config untouched by mimo migration', () => {
    installLocalStorage({
      'reader-speechConfig': JSON.stringify({
        provider: 'openai',
        openaiBaseUrl: 'http://localhost:8825',
        openaiModel: 'qwen-tts',
        openaiVoice: 'vivian',
        openaiFormat: 'mp3',
        openaiRequestMode: 'merged',
        speechRate: 1.4,
      }),
    })
    const store = useStore()
    expect(store.speechConfig.provider).toBe('openai')
    expect(store.speechConfig.openaiBaseUrl).toBe('http://localhost:8825')
    expect(store.speechConfig.openaiModel).toBe('qwen-tts')
    expect(store.speechConfig.openaiVoice).toBe('vivian')
    expect(store.speechConfig.openaiRequestMode).toBe('merged')
    expect(store.speechConfig.speechRate).toBe(1.4)
    expect(store.speechProviderLabel).toBe('OpenAI Speech')
  })

  it('repairs invalid persisted mimo values', () => {
    installLocalStorage({
      'reader-speechConfig': JSON.stringify({
        provider: 'mimo',
        mimoSource: 'nope',
        mimoFormat: 'opus',
        mimoPreloadCount: 99,
        mimoBaseUrl: '   ',
        mimoVoice: '',
      }),
    })
    const store = useStore()
    expect(store.speechConfig.mimoSource).toBe('browser')
    expect(store.speechConfig.mimoFormat).toBe('mp3')
    expect(store.speechConfig.mimoPreloadCount).toBe(10)
    expect(store.speechConfig.mimoBaseUrl).toBe('https://api.xiaomimimo.com/v1')
    expect(store.speechConfig.mimoVoice).toBe('冰糖')
  })

  it('clamps mimo preload count setter', () => {
    const store = useStore()
    store.setMimoPreloadCount(0)
    expect(store.speechConfig.mimoPreloadCount).toBe(1)
    store.setMimoPreloadCount(50)
    expect(store.speechConfig.mimoPreloadCount).toBe(10)
    store.setMimoPreloadCount(5)
    expect(store.speechConfig.mimoPreloadCount).toBe(5)
  })

  it('labels mimo provider', () => {
    const store = useStore()
    store.setSpeechProvider('mimo')
    expect(store.speechProviderLabel).toBe('MiMo TTS')
    expect(store.networkSpeechConfigured).toBe(true)
  })

  it('requires base url in browser mode', () => {
    const store = useStore()
    store.setSpeechProvider('mimo')
    store.setMimoSpeechBaseUrl('')
    expect(store.networkSpeechConfigured).toBe(false)
    store.setMimoSpeechBaseUrl('https://api.xiaomimimo.com/v1')
    expect(store.networkSpeechConfigured).toBe(true)
  })
})

describe('reader mimo speech playback', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    installLocalStorage()
  })

  it('sends chat-audio request through mimo client', async () => {
    const store = useStore()
    store.setSpeechProvider('mimo')
    store.setMimoSpeechBaseUrl('https://api.xiaomimimo.com/v1')
    store.setMimoSpeechApiKey('test-key')
    store.setMimoSpeechModel('mimo-v2.5-tts')
    store.setMimoSpeechVoice('茉莉')
    store.setMimoSpeechFormat('wav')

    vi.mocked(requestMimoSpeechAudio).mockResolvedValue(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
    )

    await new Promise<void>((resolve) => {
      store.startTTS('待合成文本', { onStart: () => resolve() })
    })

    expect(requestMimoSpeechAudio).toHaveBeenCalledTimes(1)
    expect(requestMimoSpeechAudio).toHaveBeenCalledWith(expect.objectContaining({
      source: 'browser',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: 'test-key',
      input: '待合成文本',
      model: 'mimo-v2.5-tts',
      voice: '茉莉',
      format: 'wav',
    }))
  })

  it('does not preload when provider is system', async () => {
    const store = useStore()
    await store.preloadSpeechAudio(['片段一', '片段二'])
    expect(requestMimoSpeechAudio).not.toHaveBeenCalled()
  })

  it('preloads mimo chunks and caches them', async () => {
    const store = useStore()
    store.setSpeechProvider('mimo')
    vi.mocked(requestMimoSpeechAudio).mockResolvedValue(
      new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
    )

    await store.preloadSpeechAudio(['片段一', '片段二'])
    await vi.waitFor(() => {
      expect(requestMimoSpeechAudio).toHaveBeenCalledTimes(2)
    })
  })

  it('reports preloaded audio via hasSpeechAudio for fast start', async () => {
    const store = useStore()
    store.setSpeechProvider('mimo')
    vi.mocked(requestMimoSpeechAudio).mockResolvedValue(
      new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
    )

    expect(store.hasSpeechAudio('片段一')).toBe(false)
    await store.preloadSpeechAudio(['片段一'])
    await vi.waitFor(() => {
      expect(store.hasSpeechAudio('片段一')).toBe(true)
    })
    expect(store.hasSpeechAudio('片段二')).toBe(false)
  })

  it('clears cached audio when speech config changes', async () => {
    const store = useStore()
    store.setSpeechProvider('mimo')
    vi.mocked(requestMimoSpeechAudio).mockResolvedValue(
      new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
    )

    await store.preloadSpeechAudio(['片段一'])
    await vi.waitFor(() => {
      expect(requestMimoSpeechAudio).toHaveBeenCalledTimes(1)
    })

    store.setMimoSpeechVoice('苏打')
    await store.preloadSpeechAudio(['片段一'])
    // 配置变化后缓存失效，同一文本会重新请求
    expect(requestMimoSpeechAudio).toHaveBeenCalledTimes(2)
  })
})
