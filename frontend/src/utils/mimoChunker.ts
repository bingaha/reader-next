/**
 * MiMo TTS 分片规划。
 *
 * MiMo 单次请求可承受约 2500 字，官方建议超长才分段；这里保留 100 字余量，
 * 单片上限 2400 字。分片只按「当前偏移」纯函数式计算，任意偏移重算结果一致，
 * 因此回退、预载都不需要缓存分片计划。
 *
 * 两种规划：
 * - planNextMimoChunk（正常）：剩余塞得下一片就整段一片；否则均衡分片
 *   （剩余字数除以 2400 向上取整得到片数，均分取目标点，再往前找切点）。
 * - planMimoFastStartChunk（快速启动）：无预载音频时第一次请求专用，
 *   从偏移起取 200 字并向后吸附到最近标点（最多 300 字），
 *   窗口内吸附不到标点就强制 200 字；之后的分片全部回到正常规划。
 */

export const MIMO_MAX_CHUNK_CHARS = 2400
export const MIMO_FAST_START_FIRST_CHARS = 200
export const MIMO_FAST_START_MAX_CHARS = 300
export const MIMO_MIN_SPLIT_CHARS = 200

const NEWLINE = '\n'
const SENTENCE_PUNCTUATION = '。！？…'
const CLAUSE_PUNCTUATION = '，、；：,;:'
const SPLIT_PRIORITY = [NEWLINE, SENTENCE_PUNCTUATION, CLAUSE_PUNCTUATION]
/** 快速启动吸附用：换行与句读都算切点 */
const SNAP_PUNCTUATION = SPLIT_PRIORITY.join('')

export interface MimoChunk {
  text: string
  start: number
  end: number
  isChapterEnd: boolean
}

export interface ChapterTextIndex {
  text: string
  /** 与 text 对齐的按码点计价的段落区间，[start, end) */
  paragraphRanges: { start: number; end: number }[]
}

/** 段落文本 → 章节文本索引（段落间以换行拼接，与 DOM innerText 一致） */
export function buildChapterTextIndex(paragraphTexts: string[]): ChapterTextIndex {
  const chars: string[] = []
  const paragraphRanges: { start: number; end: number }[] = []
  paragraphTexts.forEach((paragraphText, paragraphIndex) => {
    if (paragraphIndex > 0) chars.push(NEWLINE)
    const start = chars.length
    chars.push(...Array.from(paragraphText))
    paragraphRanges.push({ start, end: chars.length })
  })
  return { text: chars.join(''), paragraphRanges }
}

/** 与 [start, end) 区间有交集的段落下标 */
export function paragraphIndexesInRange(index: ChapterTextIndex, start: number, end: number) {
  const result: number[] = []
  index.paragraphRanges.forEach((range, paragraphIndex) => {
    if (range.start < end && range.end > start) result.push(paragraphIndex)
  })
  return result
}

/** 偏移所在段落；落在段落间换行上时取下一段 */
export function paragraphIndexAtOffset(index: ChapterTextIndex, offset: number) {
  for (let paragraphIndex = 0; paragraphIndex < index.paragraphRanges.length; paragraphIndex += 1) {
    const range = index.paragraphRanges[paragraphIndex]
    if (offset < range.end) return paragraphIndex
  }
  return index.paragraphRanges.length - 1
}

function findSplitPoint(chars: string[], offset: number, target: number) {
  const halfBack = Math.floor((target - offset) / 2)
  const minCut = Math.max(offset + MIMO_MIN_SPLIT_CHARS, target - halfBack)
  if (target <= minCut) return target

  for (const group of SPLIT_PRIORITY) {
    for (let index = target - 1; index >= minCut; index -= 1) {
      if (group.includes(chars[index])) return index + 1
    }
  }
  return target
}

function findBalancedCut(chars: string[], offset: number, total: number) {
  const remaining = total - offset
  const pieces = Math.max(1, Math.ceil(remaining / MIMO_MAX_CHUNK_CHARS))
  const target = offset + Math.floor(remaining / pieces)
  return findSplitPoint(chars, offset, target)
}

/** 计算从 offset 开始的下一片（正常规划）；同一 offset 重算结果稳定 */
export function planNextMimoChunk(fullText: string, offset: number): MimoChunk {
  const chars = Array.from(fullText)
  const total = chars.length
  const safeOffset = Math.max(0, Math.min(offset, total))
  const remaining = total - safeOffset

  if (remaining <= 0) {
    return { text: '', start: safeOffset, end: safeOffset, isChapterEnd: true }
  }

  // 剩余塞得下一片就整段一片，否则均衡分片
  if (remaining <= MIMO_MAX_CHUNK_CHARS) {
    return {
      text: chars.slice(safeOffset).join(''),
      start: safeOffset,
      end: total,
      isChapterEnd: true,
    }
  }

  const cut = Math.min(findBalancedCut(chars, safeOffset, total), total)

  return {
    text: chars.slice(safeOffset, cut).join(''),
    start: safeOffset,
    end: cut,
    isChapterEnd: cut >= total,
  }
}

/**
 * 快速启动分片：无预载音频时第一次请求专用，尽快出声。
 * 从 offset 起取 200 字，向后（文本增大方向）吸附到最近标点，最多 300 字；
 * 窗口内吸附不到标点则强制 200 字；剩余不足 200 字时整段取走。
 * 后续分片应改用 planNextMimoChunk 正常规划。
 */
export function planMimoFastStartChunk(fullText: string, offset: number): MimoChunk {
  const chars = Array.from(fullText)
  const total = chars.length
  const safeOffset = Math.max(0, Math.min(offset, total))
  const remaining = total - safeOffset

  if (remaining <= 0) {
    return { text: '', start: safeOffset, end: safeOffset, isChapterEnd: true }
  }

  const base = safeOffset + MIMO_FAST_START_FIRST_CHARS
  if (base >= total) {
    // 不足 200 字：整段取走
    return {
      text: chars.slice(safeOffset).join(''),
      start: safeOffset,
      end: total,
      isChapterEnd: true,
    }
  }

  let cut = base
  // 第 200 字本身已是标点（或紧邻标点收尾）→ 无需外扩
  if (!SNAP_PUNCTUATION.includes(chars[base - 1])) {
    const maxPunctIndex = Math.min(safeOffset + MIMO_FAST_START_MAX_CHARS - 1, total - 1)
    for (let index = base; index <= maxPunctIndex; index += 1) {
      if (SNAP_PUNCTUATION.includes(chars[index])) {
        cut = index + 1
        break
      }
    }
  }

  return {
    text: chars.slice(safeOffset, cut).join(''),
    start: safeOffset,
    end: cut,
    isChapterEnd: cut >= total,
  }
}

/** 从章节起点顺序推进，拿到 offset 之前的所有分片边界（用于「上一段」） */
export function listMimoChunkStarts(fullText: string, offset: number) {
  const starts: number[] = []
  let cursor = 0
  let guard = 0
  while (cursor < offset && guard < 10000) {
    guard += 1
    starts.push(cursor)
    const chunk = planNextMimoChunk(fullText, cursor)
    if (chunk.end <= cursor) break
    cursor = chunk.end
  }
  return starts
}
