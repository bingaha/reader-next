import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ReaderTtsPanel from './ReaderTtsPanel.vue'

const baseProps = {
  show: true,
  theme: { popup: '#fff', fontColor: '#000' },
  chapterTitle: '第一章 北灵院',
  provider: 'mimo' as const,
  providerLabel: 'MiMo TTS',
  isSpeaking: true,
  isLoading: false,
  isPaused: false,
  voices: [] as SpeechSynthesisVoice[],
  voiceName: '',
  rate: 1,
  pitch: 1,
  supportsPitch: false,
  openaiModel: 'qwen-tts',
  openaiVoice: 'vivian',
  openaiSource: 'browser' as const,
  mimoModel: 'mimo-v2.5-tts',
  mimoVoice: '茉莉',
  mimoSource: 'browser' as const,
  stopAfterMinutes: 0,
  timerText: '',
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(ReaderTtsPanel, {
    props: { ...baseProps, ...props },
    global: { stubs: { Transition: false } },
  })
}

describe('ReaderTtsPanel voice controls', () => {
  it('shows the MiMo voice selector instead of the OpenAI voice input in mimo mode', () => {
    const wrapper = mountPanel()

    expect(wrapper.find('input').exists()).toBe(false)
    const select = wrapper.find('select.tts-voice-select')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('茉莉')
  })

  it('emits mimo-voice-change when the MiMo voice is switched', async () => {
    const wrapper = mountPanel()

    await wrapper.find('select.tts-voice-select').setValue('苏打')

    expect(wrapper.emitted('mimo-voice-change')?.[0]).toEqual(['苏打'])
  })

  it('shows the OpenAI voice input only in openai browser mode', () => {
    const wrapper = mountPanel({ provider: 'openai' })

    const input = wrapper.find('input.tts-voice-select')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('vivian')
  })

  it('hides voice controls and shows backend notes in server mode', () => {
    const mimoServer = mountPanel({ mimoSource: 'server' })
    expect(mimoServer.find('input').exists()).toBe(false)
    expect(mimoServer.find('select').exists()).toBe(false)
    expect(mimoServer.text()).toContain('MiMo TTS 使用后端配置')

    const openaiServer = mountPanel({ provider: 'openai', openaiSource: 'server' })
    expect(openaiServer.find('input').exists()).toBe(false)
    expect(openaiServer.find('select').exists()).toBe(false)
    expect(openaiServer.text()).toContain('OpenAI Speech 使用后端配置')
  })

  it('keeps the system voice selector in system mode', () => {
    const wrapper = mountPanel({ provider: 'system', voices: [] })

    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('select.tts-voice-select').exists()).toBe(true)
  })
})
