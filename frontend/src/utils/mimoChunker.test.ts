import { describe, expect, it } from 'vitest'
import {
  MIMO_FAST_START_FIRST_CHARS,
  MIMO_FAST_START_MAX_CHARS,
  MIMO_MAX_CHUNK_CHARS,
  buildChapterTextIndex,
  listMimoChunkStarts,
  paragraphIndexAtOffset,
  paragraphIndexesInRange,
  planMimoFastStartChunk,
  planNextMimoChunk,
} from './mimoChunker'

function textOfLength(length: number) {
  return '字'.repeat(length)
}

function allChunks(fullText: string) {
  const chunks: { text: string; start: number; end: number; isChapterEnd: boolean }[] = []
  let offset = 0
  let guard = 0
  while (offset < Array.from(fullText).length && guard < 1000) {
    guard += 1
    const chunk = planNextMimoChunk(fullText, offset)
    if (!chunk.text) break
    chunks.push(chunk)
    offset = chunk.end
  }
  return chunks
}

describe('planNextMimoChunk', () => {
  it('短章整章一片', () => {
    const chunk = planNextMimoChunk(textOfLength(700), 0)
    expect(chunk.text).toHaveLength(700)
    expect(chunk.isChapterEnd).toBe(true)
  })

  it('偏移已在章节末尾时返回空片', () => {
    const chunk = planNextMimoChunk(textOfLength(1000), 1000)
    expect(chunk.text).toBe('')
    expect(chunk.isChapterEnd).toBe(true)
  })

  it('剩余塞得下一片时整段一片（正常规划不再走阶梯）', () => {
    const text = textOfLength(2400)
    const chunk = planNextMimoChunk(text, 0)
    expect(chunk.text).toHaveLength(2400)
    expect(chunk.isChapterEnd).toBe(true)
  })

  it('超长章直接按均衡分片', () => {
    const text = textOfLength(2401)
    const first = planNextMimoChunk(text, 0)
    expect(first.text).toHaveLength(1200)
    expect(first.isChapterEnd).toBe(false)

    const second = planNextMimoChunk(text, first.end)
    expect(second.start).toBe(1200)
    expect(second.text).toHaveLength(1201)
    expect(second.isChapterEnd).toBe(true)
  })

  it('同一偏移重算结果一致', () => {
    const text = textOfLength(3000)
    const first = planNextMimoChunk(text, 0)
    const again = planNextMimoChunk(text, 0)
    expect(again.end).toBe(first.end)
    const second = planNextMimoChunk(text, first.end)
    expect(second.start).toBe(first.end)
  })

  it('均衡分片不会超出 2400 且覆盖全章', () => {
    const chunks = allChunks(textOfLength(10000))
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(Array.from(chunk.text).length).toBeLessThanOrEqual(MIMO_MAX_CHUNK_CHARS)
      expect(Array.from(chunk.text).length).toBeGreaterThan(MIMO_MAX_CHUNK_CHARS / 2)
    }
    expect(chunks.at(-1)?.isChapterEnd).toBe(true)
    expect(chunks.reduce((sum, chunk) => sum + Array.from(chunk.text).length, 0)).toBe(10000)
  })

  it('2401 字切成 1200/1201 两片', () => {
    const sizes = allChunks(textOfLength(2401)).map((chunk) => Array.from(chunk.text).length)
    expect(sizes).toEqual([1200, 1201])
  })

  it('4801 字均衡分片且最后一片不小于半片', () => {
    const sizes = allChunks(textOfLength(4801)).map((chunk) => Array.from(chunk.text).length)
    expect(sizes.every((size) => size <= MIMO_MAX_CHUNK_CHARS)).toBe(true)
    expect(sizes.at(-1)).toBeGreaterThan(MIMO_MAX_CHUNK_CHARS / 2)
  })

  it('优先按换行切分', () => {
    // offset 700，总长 4000 → 剩余 3300 → pieces 2 → target 2350；2300 处有换行，2340 处有逗号
    const text = textOfLength(2300) + '\n' + textOfLength(1699)
    const chunk = planNextMimoChunk(text, 700)
    expect(chunk.end).toBe(2301)
  })

  it('没有换行时按句号切分', () => {
    const text = textOfLength(2300) + '。' + textOfLength(1699)
    const chunk = planNextMimoChunk(text, 700)
    expect(chunk.end).toBe(2301)
  })

  it('句号也没有时按逗号切分', () => {
    const text = textOfLength(2300) + '，' + textOfLength(1699)
    const chunk = planNextMimoChunk(text, 700)
    expect(chunk.end).toBe(2301)
  })

  it('切点太靠近章节开头时向后回退到其他标点', () => {
    // 换行在 750（距 offset 700 仅 50 字，低于最小片长），应改取 2320 处的逗号
    const text = textOfLength(50) + '\n' + textOfLength(2269) + '，' + textOfLength(1679)
    const chunk = planNextMimoChunk(text, 700)
    expect(chunk.end).toBe(2321)
  })

  it('找不到合格标点时在目标点硬切', () => {
    const chunk = planNextMimoChunk(textOfLength(4000), 700)
    expect(chunk.end).toBe(700 + Math.floor(3300 / 2))
  })

  it('最小片长内的标点被忽略', () => {
    // target 2350，唯一逗号在 750（< minCut 1525）→ 硬切
    const text = textOfLength(750) + '，' + textOfLength(3249)
    const chunk = planNextMimoChunk(text, 700)
    expect(chunk.end).toBe(2350)
  })

  it('按码点计字，emoji 不拆碎', () => {
    const text = '😀'.repeat(3000)
    const chunk = planNextMimoChunk(text, 0)
    expect(Array.from(chunk.text)).toHaveLength(1500)
    expect(chunk.text).not.toContain('\uFFFD')
  })
})

describe('planMimoFastStartChunk', () => {
  it('窗口内无标点时强制 200 字', () => {
    const chunk = planMimoFastStartChunk(textOfLength(500), 0)
    expect(chunk.end).toBe(MIMO_FAST_START_FIRST_CHARS)
    expect(chunk.text).toHaveLength(MIMO_FAST_START_FIRST_CHARS)
    expect(chunk.isChapterEnd).toBe(false)
  })

  it('向后吸附到最近标点', () => {
    const text = textOfLength(250) + '。' + textOfLength(500)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(251)
  })

  it('换行也参与吸附', () => {
    const text = textOfLength(210) + '\n' + textOfLength(500)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(211)
  })

  it('吸附最多到 300 字', () => {
    const text = textOfLength(299) + '。' + textOfLength(500)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(MIMO_FAST_START_MAX_CHARS)
  })

  it('标点超出 300 字窗口时强制 200 字', () => {
    const text = textOfLength(300) + '。' + textOfLength(500)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(MIMO_FAST_START_FIRST_CHARS)
  })

  it('第 200 字本身是标点时不外扩', () => {
    const text = textOfLength(199) + '。' + textOfLength(500)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(MIMO_FAST_START_FIRST_CHARS)
  })

  it('第 200 字后的下一个字符是标点时只收一个标点', () => {
    const text = textOfLength(200) + '，' + textOfLength(500)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(201)
  })

  it('剩余不足 200 字时整段取走', () => {
    const chunk = planMimoFastStartChunk(textOfLength(150), 0)
    expect(chunk.end).toBe(150)
    expect(chunk.isChapterEnd).toBe(true)
  })

  it('吸附到章末时整片收尾', () => {
    const text = textOfLength(200) + '。'
    const chunk = planMimoFastStartChunk(text, 0)
    expect(chunk.end).toBe(201)
    expect(chunk.isChapterEnd).toBe(true)
  })

  it('从非零偏移起算 200 字并吸附', () => {
    const text = textOfLength(1000)
    const chunk = planMimoFastStartChunk(text, 400)
    expect(chunk.start).toBe(400)
    expect(chunk.end).toBe(600)
  })

  it('偏移已在章节末尾时返回空片', () => {
    const chunk = planMimoFastStartChunk(textOfLength(300), 300)
    expect(chunk.text).toBe('')
    expect(chunk.isChapterEnd).toBe(true)
  })

  it('按码点计字，emoji 不拆碎', () => {
    const text = '😀'.repeat(3000)
    const chunk = planMimoFastStartChunk(text, 0)
    expect(Array.from(chunk.text)).toHaveLength(MIMO_FAST_START_FIRST_CHARS)
    expect(chunk.text).not.toContain('\uFFFD')
  })
})

describe('listMimoChunkStarts', () => {
  it('返回 offset 之前的全部分片起点', () => {
    const text = textOfLength(2401)
    expect(listMimoChunkStarts(text, 0)).toEqual([])
    expect(listMimoChunkStarts(text, 200)).toEqual([0])
    expect(listMimoChunkStarts(text, 1200)).toEqual([0])
    expect(listMimoChunkStarts(text, 2401)).toEqual([0, 1200])
  })
})

describe('chapter text index', () => {
  const index = buildChapterTextIndex(['第一段内容', '第二段内容', '第三段内容'])

  it('段落区间与文本对齐', () => {
    expect(index.text).toBe('第一段内容\n第二段内容\n第三段内容')
    expect(index.paragraphRanges).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ])
  })

  it('按偏移定位段落', () => {
    expect(paragraphIndexAtOffset(index, 0)).toBe(0)
    expect(paragraphIndexAtOffset(index, 4)).toBe(0)
    expect(paragraphIndexAtOffset(index, 5)).toBe(1)
    expect(paragraphIndexAtOffset(index, 6)).toBe(1)
    expect(paragraphIndexAtOffset(index, 16)).toBe(2)
  })

  it('按区间取交集段落', () => {
    expect(paragraphIndexesInRange(index, 0, 5)).toEqual([0])
    expect(paragraphIndexesInRange(index, 0, 17)).toEqual([0, 1, 2])
    expect(paragraphIndexesInRange(index, 4, 7)).toEqual([0, 1])
  })
})
