import { describe, expect, it } from 'vitest'
import { parseAnswerData } from '../src/services/AnswerDataParser.js'

describe('parseAnswerData', () => {
  it('extracts numeric rows from Markdown tables and skips headers', () => {
    expect(parseAnswerData([
      '| 单价 | 数量 |',
      '| --- | --- |',
      '| 45.50 | 12 |',
      '| 130.00 | 3 |'
    ].join('\n'))).toEqual([[45.5, 12], [130, 3]])
  })

  it('extracts comma-separated rows from generated plain text', () => {
    expect(parseAnswerData('6,7\n19，3\n说明文字\n10,6')).toEqual([[6, 7], [19, 3], [10, 6]])
  })

  it('does not treat explanatory text as table data', () => {
    expect(parseAnswerData('单价和数量的 mock 数据如下：\n请复制到 Excel。')).toEqual([])
  })
})
