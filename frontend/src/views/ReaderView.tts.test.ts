import { describe, expect, it } from 'vitest'
import source from './ReaderView.vue?raw'

describe('ReaderView TTS highlight handling', () => {
  it('does not clear the reading highlight while paused', () => {
    expect(source).toContain('!speaking && !store.isPaused && !store.isAutoScrolling')
  })

  it('restores the highlight after resuming playback', () => {
    expect(source).toContain('ensureReadingHighlight()')
  })

  it('wires the panel MiMo voice selector to the store', () => {
    expect(source).toContain('@mimo-voice-change="changeMimoVoice"')
    expect(source).toContain('store.setMimoSpeechVoice(voiceId)')
  })
})
