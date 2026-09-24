import type { ComputedRef, Ref } from 'vue'
import type { useReaderStore } from '../stores/reader'
import {
  MIMO_PRELOAD_MAX,
} from '../utils/mimoSpeech'
import {
  buildChapterTextIndex,
  paragraphIndexesInRange,
  planMimoFastStartChunk,
  planNextMimoChunk,
  type ChapterTextIndex,
} from '../utils/mimoChunker'

type ReaderStore = ReturnType<typeof useReaderStore>
const OPENAI_SPEECH_CHUNK_CHAR_LIMIT = 70
const OPENAI_PRELOAD_CHUNK_LIMIT = 5
const OPENAI_MERGED_SEGMENT_CHAR_LIMIT = 260

interface AutoPlaybackConfig {
  autoPageMode: string
  clickAction: string
  scrollPixel: number
  pageSpeed: number
  fontSize: number
  lineHeight: number
}

export function useReaderAutoPlayback(
  store: ReaderStore,
  config: ComputedRef<AutoPlaybackConfig>,
  isContinuousMode: ComputedRef<boolean>,
  scrollContainerRef: Ref<HTMLElement | undefined>,
  chapterTextRef: Ref<HTMLElement | undefined>,
  nextChapter: () => void | Promise<void>,
  prevChapter: () => void | Promise<void>,
) {
  let autoScrollId: number | null = null
  let autoParagraphTimer: number | null = null
  let autoReadingParagraphIndex = -1
  let autoReadingProcessing = false
  let speechRestartTimer: number | null = null
  let isSpeechTransitioning = false
  let currentSpeechParagraph: HTMLElement | null = null
  let currentSpeechSegments: { text: string; nextParagraph: HTMLElement | null }[] = []
  let currentSpeechSegmentIndex = 0

  /* ─── MiMo 分片播放状态 ─── */
  let mimoIndex: ChapterTextIndex | null = null
  let mimoIndexParagraphs: HTMLElement[] = []
  let mimoChunkStarts: number[] = []
  let mimoCurrentChunk: { start: number; end: number } | null = null
  /** 快速启动武装位：只对下一次分片规划生效一次 */
  let mimoFastStartPending = false

  function isSafariSpeechDelayBrowser() {
    if (typeof navigator === 'undefined') return false
    const ua = navigator.userAgent || ''
    return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|EdgiOS|Android/i.test(ua)
  }

  function paragraphPreview(paragraph: HTMLElement | null) {
    return paragraph?.innerText.trim().slice(0, 40) || ''
  }

  function logSpeech(message: string, payload?: unknown) {
    void message
    void payload
  }

  function getFilteredParagraphs() {
    const roots = isContinuousMode.value
      ? Array.from(scrollContainerRef.value?.querySelectorAll('.chapter-text[data-role="continuous"]') || []) as HTMLElement[]
      : (chapterTextRef.value ? [chapterTextRef.value] : [])
    if (!roots.length) return [] as HTMLElement[]
    const allElements = roots.flatMap((root) => Array.from(root.querySelectorAll('p')) as HTMLElement[])
    const list: HTMLElement[] = []
    let lastText = ''
    allElements.forEach((el) => {
      const text = el.innerText.trim()
      if (text && text !== lastText) {
        list.push(el)
        lastText = text
      }
    })
    return list
  }

  function getCurrentParagraph() {
    const reading = chapterTextRef.value?.querySelector('.reading') as HTMLElement | null
    if (reading) return reading

    const container = scrollContainerRef.value
    if (!container) return null

    const list = getFilteredParagraphs()
    for (const paragraph of list) {
      const top = paragraph.offsetTop - container.scrollTop
      const bottom = top + paragraph.offsetHeight
      if (bottom > 40) {
        return paragraph
      }
    }

    return list[0] || null
  }

  function getPrevParagraph() {
    const current = getCurrentParagraph()
    return getPrevParagraphFrom(current)
  }

  function getPrevParagraphFrom(current: HTMLElement | null) {
    const list = getFilteredParagraphs()
    const index = current ? list.indexOf(current) : -1
    if (index > 0) return list[index - 1]
    return null
  }

  function getNextParagraph() {
    const current = getCurrentParagraph()
    return getNextParagraphFrom(current)
  }

  function getNextParagraphFrom(current: HTMLElement | null) {
    const list = getFilteredParagraphs()
    const index = current ? list.indexOf(current) : -1
    if (index >= 0 && index < list.length - 1) return list[index + 1]
    return null
  }

  function splitLongSentence(sentence: string) {
    const chunks: string[] = []
    let remaining = sentence.trim()
    while (remaining.length > OPENAI_SPEECH_CHUNK_CHAR_LIMIT) {
      let splitIndex = Math.max(
        remaining.lastIndexOf('，', OPENAI_SPEECH_CHUNK_CHAR_LIMIT),
        remaining.lastIndexOf('、', OPENAI_SPEECH_CHUNK_CHAR_LIMIT),
        remaining.lastIndexOf(',', OPENAI_SPEECH_CHUNK_CHAR_LIMIT),
        remaining.lastIndexOf(' ', OPENAI_SPEECH_CHUNK_CHAR_LIMIT),
      )
      if (splitIndex <= 0) {
        splitIndex = OPENAI_SPEECH_CHUNK_CHAR_LIMIT
      }
      chunks.push(remaining.slice(0, splitIndex).trim())
      remaining = remaining.slice(splitIndex).trim()
    }
    if (remaining) chunks.push(remaining)
    return chunks
  }

  function buildParagraphSpeechChunks(paragraph: HTMLElement | null) {
    const rawText = paragraph?.innerText.trim() || ''
    if (!rawText) return [] as string[]

    const sentences = rawText
      .replace(/\n+/g, '\n')
      .split(/(?<=[。！？!?；;])/)
      .map((item) => item.trim())
      .filter(Boolean)

    const chunks: string[] = []
    let current = ''

    const pushCurrent = () => {
      const normalized = current.trim()
      if (normalized) chunks.push(normalized)
      current = ''
    }

    for (const sentence of (sentences.length ? sentences : [rawText])) {
      if (sentence.length > OPENAI_SPEECH_CHUNK_CHAR_LIMIT) {
        pushCurrent()
        chunks.push(...splitLongSentence(sentence))
        continue
      }
      const next = current ? `${current}${sentence}` : sentence
      if (next.length > OPENAI_SPEECH_CHUNK_CHAR_LIMIT) {
        pushCurrent()
        current = sentence
      } else {
        current = next
      }
    }

    pushCurrent()
    return chunks.length ? chunks : [rawText]
  }

  function buildMergedSpeechSegment(paragraph: HTMLElement | null) {
    const currentText = paragraph?.innerText.trim() || ''
    if (!currentText) {
      return {
        text: '',
        nextParagraph: getNextParagraph(),
      }
    }

    const list = getFilteredParagraphs()
    const startIndex = paragraph ? list.indexOf(paragraph) : -1
    if (startIndex < 0) {
      return {
        text: currentText,
        nextParagraph: getNextParagraph(),
      }
    }

    const mergedTexts: string[] = [currentText]
    let mergedLength = currentText.length
    let cursorIndex = startIndex + 1

    while (cursorIndex < list.length && mergedLength < OPENAI_MERGED_SEGMENT_CHAR_LIMIT) {
      const nextText = list[cursorIndex]?.innerText.trim() || ''
      if (!nextText) {
        cursorIndex += 1
        continue
      }
      if (mergedLength + nextText.length > OPENAI_MERGED_SEGMENT_CHAR_LIMIT) {
        break
      }
      mergedTexts.push(nextText)
      mergedLength += nextText.length
      cursorIndex += 1
    }

    return {
      text: mergedTexts.join('\n'),
      nextParagraph: list[cursorIndex] || null,
    }
  }

  function resetSpeechChunkState() {
    currentSpeechParagraph = null
    currentSpeechSegments = []
    currentSpeechSegmentIndex = 0
  }

  function buildOpenAISpeechSegments(paragraph: HTMLElement) {
    if (store.speechConfig.openaiRequestMode === 'merged') {
      const merged = buildMergedSpeechSegment(paragraph)
      return merged.text ? [merged] : []
    }

    const paragraphChunks = buildParagraphSpeechChunks(paragraph)
    const nextParagraph = getNextParagraph()
    return paragraphChunks.map((text, index) => ({
      text,
      nextParagraph: index < paragraphChunks.length - 1 ? paragraph : nextParagraph,
    }))
  }

  function ensureSpeechChunkState(paragraph: HTMLElement) {
    if (store.speechConfig.provider !== 'openai') {
      return {
        text: paragraph.innerText.trim(),
        nextParagraph: getNextParagraphFrom(paragraph),
      }
    }

    if (currentSpeechParagraph !== paragraph) {
      currentSpeechParagraph = paragraph
      currentSpeechSegments = buildOpenAISpeechSegments(paragraph)
      currentSpeechSegmentIndex = 0
    }

    return currentSpeechSegments[currentSpeechSegmentIndex] || {
      text: '',
      nextParagraph: getNextParagraphFrom(paragraph),
    }
  }

  function getUpcomingSpeechChunks(startParagraph: HTMLElement | null) {
    const chunks: string[] = []

    if (store.speechConfig.provider !== 'openai') {
      return chunks
    }

    if (store.speechConfig.openaiRequestMode === 'merged') {
      const merged = buildMergedSpeechSegment(startParagraph)
      return merged.text ? [merged.text] : []
    }

    if (currentSpeechParagraph && currentSpeechSegments.length) {
      for (let i = currentSpeechSegmentIndex + 1; i < currentSpeechSegments.length && chunks.length < OPENAI_PRELOAD_CHUNK_LIMIT; i += 1) {
        if (currentSpeechSegments[i]?.text) {
          chunks.push(currentSpeechSegments[i].text)
        }
      }
    }

    let cursor = startParagraph
    while (cursor && chunks.length < OPENAI_PRELOAD_CHUNK_LIMIT) {
      const paragraphChunks = buildParagraphSpeechChunks(cursor)
      for (const chunk of paragraphChunks) {
        if (chunks.length >= OPENAI_PRELOAD_CHUNK_LIMIT) break
        chunks.push(chunk)
      }
      const list = getFilteredParagraphs()
      const index = list.indexOf(cursor)
      cursor = index >= 0 ? (list[index + 1] || null) : null
    }

    return chunks
  }

  function clearReadingClass() {
    scrollContainerRef.value?.querySelectorAll('.reading').forEach((el) => el.classList.remove('reading'))
  }

  function showParagraph(paragraph: HTMLElement | null, smooth = true) {
    const container = scrollContainerRef.value
    if (!container || !paragraph) return

    const targetTop = Math.max(0, paragraph.offsetTop - 24)
    container.scrollTo({
      top: targetTop,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }

  function markReadingParagraph(paragraph: HTMLElement | null) {
    clearReadingClass()
    if (paragraph) {
      paragraph.classList.add('reading')
    }
  }

  function markReadingParagraphs(paragraphs: HTMLElement[]) {
    clearReadingClass()
    paragraphs.forEach((paragraph) => paragraph.classList.add('reading'))
  }

  /**
   * 恢复播放时补回高亮：暂停/换片过渡窗口里（onEnd 间隙 isPaused=false）
   * 高亮可能已被清掉，恢复播放本身不会重新 mark，需要自愈。
   */
  function ensureReadingHighlight() {
    if (scrollContainerRef.value?.querySelector('.reading')) return
    markReadingParagraph(getCurrentParagraph())
  }

  /* ─── MiMo 分片播放 ─── */

  function isMimoSpeech() {
    return store.speechConfig.provider === 'mimo'
  }

  /**
   * 章节文本索引按 DOM 段落缓存：连续模式下追章只做前缀追加，偏移依然有效；
   * 章节整体变化（前缀不一致）时重置分片历史。
   */
  function getMimoChapterIndex() {
    const paragraphs = getFilteredParagraphs()
    if (!paragraphs.length) return null

    const sameParagraphs = mimoIndexParagraphs.length === paragraphs.length
      && paragraphs.every((element, index) => mimoIndexParagraphs[index] === element)
    if (mimoIndex && sameParagraphs) {
      return { index: mimoIndex, paragraphs }
    }

    const nextIndex = buildChapterTextIndex(paragraphs.map((paragraph) => paragraph.innerText.trim()))
    const prefixUnchanged = !!mimoIndex && nextIndex.text.startsWith(mimoIndex.text)
    mimoIndex = nextIndex
    mimoIndexParagraphs = paragraphs
    if (!prefixUnchanged) {
      mimoChunkStarts = []
      mimoCurrentChunk = null
    }
    return { index: nextIndex, paragraphs }
  }

  function mimoChapterLength(index: ChapterTextIndex) {
    return index.paragraphRanges[index.paragraphRanges.length - 1]?.end ?? 0
  }

  function mimoPreloadCount() {
    return Math.min(MIMO_PRELOAD_MAX, Math.max(1, Math.round(store.speechConfig.mimoPreloadCount)))
  }

  function preloadMimoUpcoming(fromOffset: number) {
    if (!isMimoSpeech()) return
    const resolved = getMimoChapterIndex()
    if (!resolved) return
    const total = mimoChapterLength(resolved.index)
    if (fromOffset >= total) return

    const texts: string[] = []
    let cursor = fromOffset
    while (texts.length < mimoPreloadCount()) {
      const chunk = planNextMimoChunk(resolved.index.text, cursor)
      if (!chunk.text) break
      texts.push(chunk.text)
      cursor = chunk.end
    }
    if (texts.length) {
      window.setTimeout(() => {
        void store.preloadSpeechAudio(texts)
      }, 0)
    }
  }

  /**
   * 分片规划入口。快速启动只武装到「下一次」规划：
   * 正常分片已有预载音频（缓存秒开）就直接按正常分片播；
   * 没有预载则第一片只取 200 字（向后标点吸附最多 300 字）尽快出声，
   * 之后的分片全部回到正常均衡规划。
   */
  function planMimoChunkAt(index: ChapterTextIndex, offset: number) {
    const normal = planNextMimoChunk(index.text, offset)
    if (!mimoFastStartPending) return normal
    mimoFastStartPending = false
    if (!normal.text) return normal
    if (store.hasSpeechAudio(normal.text)) return normal
    return planMimoFastStartChunk(index.text, offset)
  }

  function playMimoChunkAt(offset: number, interruptCurrent: boolean) {
    const resolved = getMimoChapterIndex()
    if (!resolved) {
      mimoFastStartPending = false
      store.stopTTS()
      return
    }
    const { index, paragraphs } = resolved
    const chunk = planMimoChunkAt(index, offset)
    if (!chunk.text.trim()) {
      continueMimoToNextChapter()
      return
    }

    mimoCurrentChunk = { start: chunk.start, end: chunk.end }
    if (mimoChunkStarts[mimoChunkStarts.length - 1] !== chunk.start) {
      mimoChunkStarts.push(chunk.start)
    }

    const rangeParagraphs = paragraphIndexesInRange(index, chunk.start, chunk.end)
      .map((paragraphIndex) => paragraphs[paragraphIndex])
      .filter((paragraph): paragraph is HTMLElement => !!paragraph)
    markReadingParagraphs(rangeParagraphs)
    showParagraph(rangeParagraphs[0] || null)

    logSpeech('mimo speak chunk', {
      provider: store.speechConfig.provider,
      start: chunk.start,
      end: chunk.end,
      isChapterEnd: chunk.isChapterEnd,
      text: chunk.text.slice(0, 60),
    })
    store.startTTS(chunk.text, {
      onEnd: () => {
        if (mimoCurrentChunk?.start !== chunk.start) return
        if (chunk.isChapterEnd) {
          continueMimoToNextChapter()
          return
        }
        continueMimoSpeech(chunk.end)
      },
      onError: () => {
        clearReadingClass()
      },
    }, interruptCurrent)
    preloadMimoUpcoming(chunk.end)
  }

  function startMimoSpeech(paragraph?: HTMLElement | null, interruptCurrent = true) {
    const resolved = getMimoChapterIndex()
    if (!resolved) {
      store.stopTTS()
      return
    }
    const target = paragraph || getCurrentParagraph()
    const paragraphIndex = target ? resolved.paragraphs.indexOf(target) : -1
    const offset = paragraphIndex >= 0
      ? resolved.index.paragraphRanges[paragraphIndex].start
      : 0
    if (mimoChunkStarts[mimoChunkStarts.length - 1] !== offset) {
      mimoChunkStarts = [offset]
    }
    // 开始听书/切章的第一次请求：武装快速启动
    mimoFastStartPending = true
    playMimoChunkAt(offset, interruptCurrent)
  }

  function continueMimoSpeech(offset: number) {
    if (store.isPaused) return
    playMimoChunkAt(offset, false)
  }

  function continueMimoToNextChapter() {
    if (!store.hasNext) {
      store.stopTTS()
      clearReadingClass()
      return
    }
    mimoChunkStarts = []
    mimoCurrentChunk = null
    Promise.resolve(nextChapter())
      .then(() => {
        window.setTimeout(() => {
          if (store.isPaused) return
          startMimoSpeech(getFilteredParagraphs()[0] || null, false)
        }, 120)
      })
      .catch(() => undefined)
  }

  function skipMimoChunk(interruptCurrent = true) {
    const resolved = getMimoChapterIndex()
    const total = resolved ? mimoChapterLength(resolved.index) : 0
    const nextOffset = mimoCurrentChunk?.end ?? 0
    if (!resolved || nextOffset >= total) {
      continueMimoToNextChapter()
      return
    }
    playMimoChunkAt(nextOffset, interruptCurrent)
  }

  function prevMimoChunk() {
    if (mimoChunkStarts.length >= 2) {
      mimoChunkStarts.pop()
      const target = mimoChunkStarts[mimoChunkStarts.length - 1]
      // 回放历史片：按快速启动规则复现当初那片（预载命中则走正常分片）
      mimoFastStartPending = true
      playMimoChunkAt(target, true)
      return
    }
    if (!store.hasPrev) {
      store.stopTTS()
      return
    }
    store.stopTTS(false)
    Promise.resolve(prevChapter()).then(() => {
      window.setTimeout(() => {
        const list = getFilteredParagraphs()
        startMimoSpeech(list[list.length - 1] || null, false)
      }, 120)
    })
  }

  function runAutoScroll() {
    if (!store.isAutoScrolling || !scrollContainerRef.value) return

    const container = scrollContainerRef.value
    const speed = Math.max(1, config.value.scrollPixel) * (config.value.pageSpeed / 1000) * 0.5

    container.scrollTop += speed

    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
      if (config.value.clickAction === 'auto' && store.hasNext) {
        void nextChapter()
      } else {
        stopAutoScroll()
      }
    } else {
      autoScrollId = requestAnimationFrame(runAutoScroll)
    }
  }

  function runAutoParagraph() {
    if (!store.isAutoScrolling) return
    if (autoReadingProcessing) return

    const list = getFilteredParagraphs()
    if (!list.length) return

    autoReadingProcessing = true

    if (autoReadingParagraphIndex < 0) {
      const current = getCurrentParagraph()
      autoReadingParagraphIndex = current ? Math.max(0, list.indexOf(current)) : 0
    }

    if (autoReadingParagraphIndex >= list.length) {
      autoReadingParagraphIndex = -1
      autoReadingProcessing = false
      if (store.hasNext) {
        Promise.resolve(nextChapter()).then(() => {
          window.setTimeout(() => {
            if (store.isAutoScrolling && config.value.autoPageMode === 'paragraph') {
              runAutoParagraph()
            }
          }, 300)
        })
      } else {
        stopAutoScroll()
      }
      return
    }

    const current = list[autoReadingParagraphIndex]
    markReadingParagraph(current)
    showParagraph(current)

    const estimatedLineCount = Math.max(1, Math.ceil(current.offsetHeight / (config.value.fontSize * config.value.lineHeight)))
    const delayTime = Math.max(300, config.value.pageSpeed * estimatedLineCount)

    autoReadingProcessing = false
    autoParagraphTimer = window.setTimeout(() => {
      autoReadingParagraphIndex += 1
      runAutoParagraph()
    }, delayTime)
  }

  function startAutoScroll() {
    if (config.value.autoPageMode === 'paragraph') {
      if (autoParagraphTimer) return
      runAutoParagraph()
      return
    }
    if (autoScrollId) return
    runAutoScroll()
  }

  function stopAutoScroll() {
    store.isAutoScrolling = false
    autoReadingParagraphIndex = -1
    autoReadingProcessing = false
    if (autoScrollId) {
      cancelAnimationFrame(autoScrollId)
      autoScrollId = null
    }
    if (autoParagraphTimer) {
      clearTimeout(autoParagraphTimer)
      autoParagraphTimer = null
    }
    if (!store.isSpeaking) {
      clearReadingClass()
    }
  }

  function restartSpeechTarget(paragraph: HTMLElement | null, interruptCurrent = true) {
    logSpeech('restartSpeechTarget', {
      interruptCurrent,
      paragraph: paragraphPreview(paragraph),
      isSpeechTransitioning,
    })
    if (!paragraph) {
      store.stopTTS()
      resetSpeechChunkState()
      return
    }
    if (isSpeechTransitioning) return
    isSpeechTransitioning = true
    resetSpeechChunkState()
    if (interruptCurrent) {
      store.stopTTS(false)
    }
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
    }
    const restartDelay = !interruptCurrent && store.speechConfig.provider === 'system'
      ? ((isSafariSpeechDelayBrowser() && !store.systemTtsNativeEventsReliable) ? 160 : 40)
      : 150
    speechRestartTimer = window.setTimeout(() => {
      if (store.isPaused) {
        isSpeechTransitioning = false
        return
      }
      isSpeechTransitioning = false
      startSpeech(paragraph, interruptCurrent)
    }, restartDelay)
  }

  function continueSpeechTarget(paragraph: HTMLElement | null, resetChunks = true) {
    logSpeech('continueSpeechTarget', {
      resetChunks,
      paragraph: paragraphPreview(paragraph),
      hasNextChapter: store.hasNext,
    })
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
    }

    const continueDelay = store.speechConfig.provider === 'system'
      ? ((isSafariSpeechDelayBrowser() && !store.systemTtsNativeEventsReliable) ? 160 : 40)
      : 120

    if (paragraph) {
      isSpeechTransitioning = true
      if (resetChunks) {
        resetSpeechChunkState()
      }
      speechRestartTimer = window.setTimeout(() => {
        if (store.isPaused) {
          isSpeechTransitioning = false
          return
        }
        isSpeechTransitioning = false
        startSpeech(paragraph, false)
      }, continueDelay)
      return
    }

    if (!store.hasNext) {
      store.stopTTS()
      clearReadingClass()
      return
    }

    isSpeechTransitioning = true
    if (resetChunks) {
      resetSpeechChunkState()
    }
    Promise.resolve(nextChapter())
      .then(() => {
        speechRestartTimer = window.setTimeout(() => {
          if (store.isPaused) {
            isSpeechTransitioning = false
            return
          }
          isSpeechTransitioning = false
          startSpeech(getFilteredParagraphs()[0] || null, false)
        }, continueDelay)
      })
      .catch(() => {
        isSpeechTransitioning = false
      })
  }

  function startSpeech(paragraph?: HTMLElement | null, interruptCurrent = true) {
    if (isMimoSpeech()) {
      startMimoSpeech(paragraph ?? null, interruptCurrent)
      return
    }
    const current = paragraph || getCurrentParagraph()
    logSpeech('startSpeech', {
      interruptCurrent,
      paragraph: paragraphPreview(current),
      currentIndex: store.currentIndex,
    })
    if (!current?.innerText.trim()) {
      if (interruptCurrent) {
        speechNext()
      } else {
        continueSpeechTarget(getNextParagraph())
      }
      return
    }

    markReadingParagraph(current)
    showParagraph(current)
    const chunk = ensureSpeechChunkState(current)
    if (!chunk.text.trim()) {
      if (interruptCurrent) {
        speechNext(chunk.nextParagraph)
      } else {
        continueSpeechTarget(chunk.nextParagraph)
      }
      return
    }
    const nextParagraph = chunk.nextParagraph
    logSpeech('speak chunk', {
      interruptCurrent,
      provider: store.speechConfig.provider,
      text: chunk.text.slice(0, 60),
      nextParagraph: paragraphPreview(nextParagraph),
      chunkIndex: currentSpeechSegmentIndex,
      chunkCount: currentSpeechSegments.length,
    })
    store.startTTS(chunk.text, {
      onEnd: () => {
        logSpeech('chunk onEnd', {
          provider: store.speechConfig.provider,
          currentParagraph: paragraphPreview(current),
          nextParagraph: paragraphPreview(nextParagraph),
          chunkIndex: currentSpeechSegmentIndex,
          chunkCount: currentSpeechSegments.length,
        })
        if (store.speechConfig.provider === 'openai' && currentSpeechParagraph === current && currentSpeechSegmentIndex < currentSpeechSegments.length - 1) {
          currentSpeechSegmentIndex += 1
          continueSpeechTarget(current, false)
          return
        }
        continueSpeechTarget(nextParagraph)
      },
      onError: () => {
        logSpeech('chunk onError', {
          currentParagraph: paragraphPreview(current),
          nextParagraph: paragraphPreview(nextParagraph),
        })
        resetSpeechChunkState()
        clearReadingClass()
      },
    }, interruptCurrent)
    const preloadTexts = getUpcomingSpeechChunks(nextParagraph)
    if (preloadTexts.length) {
      window.setTimeout(() => {
        void store.preloadSpeechAudio(preloadTexts)
      }, 0)
    }
  }

  function speechPrev() {
    if (isMimoSpeech()) {
      prevMimoChunk()
      return
    }
    logSpeech('speechPrev', {
      currentParagraph: paragraphPreview(getCurrentParagraph()),
      hasPrevChapter: store.hasPrev,
    })
    resetSpeechChunkState()
    const prev = getPrevParagraph()
    if (prev) {
      restartSpeechTarget(prev)
      return
    }
    if (!store.hasPrev) {
      store.stopTTS()
      return
    }
    store.stopTTS(false)
    Promise.resolve(prevChapter()).then(() => {
      window.setTimeout(() => {
        const list = getFilteredParagraphs()
        restartSpeechTarget(list[list.length - 1] || null)
      }, 120)
    })
  }

  function speechNext(forcedNext?: HTMLElement | null, interruptCurrent = true) {
    if (isMimoSpeech()) {
      skipMimoChunk(interruptCurrent)
      return
    }
    logSpeech('speechNext', {
      interruptCurrent,
      forcedNext: paragraphPreview(forcedNext || null),
      currentParagraph: paragraphPreview(getCurrentParagraph()),
      hasNextChapter: store.hasNext,
    })
    resetSpeechChunkState()
    const next = forcedNext ?? getNextParagraph()
    if (next) {
      restartSpeechTarget(next, interruptCurrent)
      return
    }
    if (!store.hasNext) {
      store.stopTTS()
      clearReadingClass()
      return
    }
    if (interruptCurrent) {
      store.stopTTS(false)
    }
    Promise.resolve(nextChapter()).then(() => {
      window.setTimeout(() => {
        restartSpeechTarget(getFilteredParagraphs()[0] || null)
      }, 120)
    })
  }

  function restartSpeechFromCurrentParagraph() {
    if (isMimoSpeech()) {
      const start = mimoChunkStarts[mimoChunkStarts.length - 1] ?? 0
      // 重启当前片（换音色/语速后缓存已失效）：重新武装快速启动
      mimoFastStartPending = true
      playMimoChunkAt(start, true)
      return
    }
    logSpeech('restartSpeechFromCurrentParagraph', {
      currentParagraph: paragraphPreview(getCurrentParagraph()),
      isSpeechTransitioning,
    })
    if (isSpeechTransitioning) return
    isSpeechTransitioning = true
    resetSpeechChunkState()
    store.stopTTS(false)
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
    }
    speechRestartTimer = window.setTimeout(() => {
      if (store.isPaused) {
        isSpeechTransitioning = false
        return
      }
      isSpeechTransitioning = false
      startSpeech()
    }, 150)
  }

  function cancelSpeechTransition() {
    if (speechRestartTimer) {
      clearTimeout(speechRestartTimer)
      speechRestartTimer = null
    }
    isSpeechTransitioning = false
  }

  function resetAutoParagraphIndex() {
    autoReadingParagraphIndex = -1
  }

  function handleContentChanged() {
    autoReadingParagraphIndex = -1
    if (store.isAutoScrolling && config.value.autoPageMode === 'paragraph') {
      if (autoParagraphTimer) {
        clearTimeout(autoParagraphTimer)
        autoParagraphTimer = null
      }
      window.setTimeout(() => {
        if (store.isAutoScrolling && config.value.autoPageMode === 'paragraph') {
          runAutoParagraph()
        }
      }, 100)
    }
  }

  function disposeAutoPlayback() {
    cancelSpeechTransition()
    stopAutoScroll()
    mimoChunkStarts = []
    mimoCurrentChunk = null
    mimoFastStartPending = false
  }

  return {
    getCurrentParagraph,
    clearReadingClass,
    ensureReadingHighlight,
    startAutoScroll,
    stopAutoScroll,
    startSpeech,
    speechPrev,
    speechNext,
    restartSpeechFromCurrentParagraph,
    cancelSpeechTransition,
    resetAutoParagraphIndex,
    handleContentChanged,
    disposeAutoPlayback,
  }
}
