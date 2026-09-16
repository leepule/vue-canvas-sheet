
const DEFAULT_READ_RANGE = Object.freeze({
  s: Object.freeze({ r: 0, c: 0 }),
  e: Object.freeze({ r: 999, c: 99 })
})

const DEFAULT_WRITE_RANGE = Object.freeze({
  s: Object.freeze({ r: 0, c: 0 }),
  e: Object.freeze({ r: 999, c: 99 })
})

function cloneRange(range) {
  return {
    s: { ...range.s },
    e: { ...range.e }
  }
}

export class ContextBuilder {
  #adapter

  constructor(adapter) {
    if (!adapter || typeof adapter.getSnapshot !== 'function') {
      throw new TypeError('ContextBuilder requires a WorkbookAdapter')
    }
    this.#adapter = adapter
  }

  build({
    readRange = DEFAULT_READ_RANGE,
    writeRange = DEFAULT_WRITE_RANGE,
    documentId = 'local-order-workbook',
    documentEpoch = 'local-preview',
    requestId = 'ai-preview-request',
    prompt = '根据单价和数量生成销售额列',
    includeSample = false,
    history = []
  } = {}) {
    const baseContentRevision = this.#adapter.getContentRevision()
    const envelope = {
      schemaVersion: 1,
      documentId,
      documentEpoch,
      sheetId: this.#adapter.getSheetId(),
      baseContentRevision,
      allowedReadRanges: [cloneRange(readRange)],
      allowedWriteRanges: [cloneRange(writeRange)]
    }

    const request = {
      schemaVersion: 1,
      requestId,
      prompt,
      envelope
    }

    if (includeSample || (Array.isArray(history) && history.length > 0)) {
      request.context = {
        history: Array.isArray(history) ? history : []
      }
      if (includeSample) {
        const sample = []
        for (let row = readRange.s.r; row <= readRange.e.r && sample.length < 5; row++) {
          const sampleRow = []
          for (let column = readRange.s.c; column <= readRange.e.c && sampleRow.length < 20; column++) {
            sampleRow.push(this.#adapter.getCellValue(row, column))
          }
          sample.push(sampleRow)
        }
        request.context.sample = sample
      }
    }

    return { request, envelope }
  }
}
