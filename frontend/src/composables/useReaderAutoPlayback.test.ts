import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import { useReaderAutoPlayback } from './useReaderAutoPlayback'
import type { useReaderStore } from '../stores/reader'

type ReaderStore = ReturnType<typeof useReaderStore>

function setupDom() {
  const container = document.createElement('div')
  const chapterText = document.createElement('div')
  chapterText.className = 'chapter-text'
  const paragraphs = ['第一段内容。', '第二段内容。', '第三段内容。'].map((text) => {
    const p = document.createElement('p')
    p.textContent = text
    chapterText.appendChild(p)
    return p
  })
  container.appendChild(chapterText)
  document.body.appendChild(container)
  return { container, chapterText, paragraphs }
}

function createAutoPlayback(container: HTMLElement, chapterText: HTMLElement) {
  return useReaderAutoPlayback(
    {} as ReaderStore,
    computed(() => ({
      autoPageMode: 'scroll',
      clickAction: 'none',
      scrollPixel: 1,
      pageSpeed: 100,
      fontSize: 16,
      lineHeight: 1.6,
    })),
    computed(() => false),
    ref<HTMLElement | undefined>(container),
    ref<HTMLElement | undefined>(chapterText),
    () => {},
    () => {},
  )
}

describe('useReaderAutoPlayback highlight restore', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('re-marks the current paragraph when the highlight was lost', () => {
    const { container, chapterText, paragraphs } = setupDom()
    const playback = createAutoPlayback(container, chapterText)

    expect(chapterText.querySelector('.reading')).toBeNull()
    playback.ensureReadingHighlight()

    expect(chapterText.querySelector('.reading')).toBe(paragraphs[0])
  })

  it('keeps an existing highlight untouched', () => {
    const { container, chapterText, paragraphs } = setupDom()
    paragraphs[1].classList.add('reading')
    const playback = createAutoPlayback(container, chapterText)

    playback.ensureReadingHighlight()

    expect(chapterText.querySelector('.reading')).toBe(paragraphs[1])
  })
})
