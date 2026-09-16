function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function normalizeRange(range) {
  if (!range || !range.s || !range.e) {
    throw new TypeError('Range must contain s and e coordinates')
  }
  for (const point of [range.s, range.e]) {
    if (!Number.isInteger(point.r) || !Number.isInteger(point.c) || point.r < 0 || point.c < 0) {
      throw new TypeError('Range coordinates must be non-negative integers')
    }
  }
  return {
    s: { r: Math.min(range.s.r, range.e.r), c: Math.min(range.s.c, range.e.c) },
    e: { r: Math.max(range.s.r, range.e.r), c: Math.max(range.s.c, range.e.c) }
  }
}

export class WorkbookAdapter {
  #workbook
  #contentUnsubscribers = new Set()

  constructor(workbook) {
    const requiredMethods = [
      'toJSON',
      'getCell',
      'getCellValue',
      'getContentRevision',
      'inspectFormula',
      'translateFormula',
      'on'
    ]
    if (!workbook || requiredMethods.some(method => typeof workbook[method] !== 'function')) {
      throw new TypeError('WorkbookAdapter requires a Workbook instance')
    }
    this.#workbook = workbook
  }

  getSelection() {
    return normalizeRange(this.#workbook.selection)
  }

  getSnapshot() {
    return clone(this.#workbook.toJSON())
  }

  getContentRevision() {
    return this.#workbook.getContentRevision()
  }

  getSheetId() {
    return this.#workbook.activeSheetId
  }

  getCell(row, column) {
    return clone(this.#workbook.getCell(row, column))
  }

  getCellValue(row, column) {
    return this.#workbook.getCellValue(row, column)
  }

  getCellRef({ r, c }) {
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0) {
      throw new TypeError('Cell coordinates must be non-negative integers')
    }

    let columnNumber = c + 1
    let columnRef = ''
    while (columnNumber > 0) {
      const remainder = (columnNumber - 1) % 26
      columnRef = String.fromCharCode(65 + remainder) + columnRef
      columnNumber = Math.floor((columnNumber - 1) / 26)
    }
    return `${columnRef}${r + 1}`
  }

  inspectFormula(formula) {
    return this.#workbook.inspectFormula(formula)
  }

  translateFormula(formula, options) {
    return this.#workbook.translateFormula(formula, options)
  }

  subscribeContent(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Content listener must be a function')
    }
    const unsubscribe = this.#workbook.on('mutation-committed', listener)
    const unsubscribeWrapper = () => {
      unsubscribe()
      this.#contentUnsubscribers.delete(unsubscribeWrapper)
    }
    this.#contentUnsubscribers.add(unsubscribeWrapper)
    return unsubscribeWrapper
  }

  dispose() {
    for (const unsubscribe of [...this.#contentUnsubscribers]) unsubscribe()
    this.#contentUnsubscribers.clear()
  }
}
