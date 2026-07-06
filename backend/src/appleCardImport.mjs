import crypto from 'node:crypto'

function splitCsvLine(line) {
  const out = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    const next = line[i + 1]
    if (ch === '"' && inQuotes && next === '"') {
      current += '"'
      i += 1
    } else if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      out.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current.trim())
  return out
}

function normalizeHeader(header) {
  return header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function parseDate(value) {
  if (!value) return null
  const trimmed = value.trim()
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return iso[0]
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (!us) return trimmed
  const year = us[3].length === 2 ? `20${us[3]}` : us[3]
  return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
}

function parseAmount(value) {
  if (!value) return 0
  const cleaned = String(value).replace(/[$,]/g, '').replace(/[()]/g, '-')
  const amount = Number(cleaned)
  return Number.isFinite(amount) ? amount : 0
}

export function parseAppleCardCsv(csvText) {
  const lines = String(csvText || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  if (lines.length < 2) return []

  const headers = splitCsvLine(lines[0]).map(normalizeHeader)
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    const row = Object.fromEntries(headers.map((h, i) => [h, cells[i] || '']))
    const date = parseDate(row.transaction_date || row.date || row.posted_date || row.clearing_date)
    const merchant = row.description || row.merchant || row.name || row.payee || 'Apple Card transaction'
    const rawAmount = row.amount || row.debit || row.credit || row.transaction_amount
    const amount = parseAmount(rawAmount)
    const category = row.category || row.type || row.transaction_type || 'Uncategorized'
    const idSeed = `apple-card:${date}:${merchant}:${amount}:${row.daily_cash || ''}`

    return {
      id: `apple_${crypto.createHash('sha1').update(idSeed).digest('hex')}`,
      source: 'apple_card_csv',
      provider: 'apple',
      accountId: 'apple_card_manual',
      date,
      merchant,
      description: merchant,
      amount,
      currency: 'USD',
      category,
      pending: false,
      raw: row,
    }
  })
}
