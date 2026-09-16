const NUMBER_PATTERN = /^[-+]?\d+(?:\.\d+)?$/u

function parseNumber(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/[`*_]/gu, '')
    .replace(/,/gu, '')
  return NUMBER_PATTERN.test(normalized) ? Number(normalized) : null
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/u.test(cell.trim()))
}

function parseCells(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const body = trimmed.replace(/^\|/u, '').replace(/\|$/u, '')
  return body.split('|').map(cell => cell.trim())
}

export function parseAnswerData(content, { maxRows = 500 } = {}) {
  if (typeof content !== 'string' || !content.trim()) return []

  const rows = []
  for (const line of content.split(/\r?\n/u)) {
    const cells = parseCells(line) || line.split(/[,，\t]/u).map(cell => cell.trim())
    if (cells.length !== 2 || isSeparatorRow(cells)) continue
    const values = cells.map(parseNumber)
    if (values.some(value => value === null)) continue
    rows.push(values)
    if (rows.length >= maxRows) break
  }
  return rows
}
