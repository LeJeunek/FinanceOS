/**
 * Date normalization: printed statement text -> `"yyyy-mm-dd"`.
 *
 * `"yyyy-mm-dd"` is the target because it is what
 * `features/transactions/server/validation.ts`'s `dateOnlySchema` accepts and
 * what `server/import.ts` re-derives its dedup key from — emitting anything
 * else would push interpretation onto the importer, where it can no longer be
 * reviewed.
 *
 * Every ambiguity this module cannot resolve from the text alone is recorded
 * as an assumption string rather than resolved silently. The two that come
 * up in practice are a missing year (`"08/21"`) and a two-digit year
 * (`"08/21/26"`).
 */

const ISO_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
/** `MM/DD/YYYY`, `MM-DD-YYYY`, `MM.DD.YY`, and the year-less `MM/DD`. */
const NUMERIC_PATTERN = /^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/
/** `Aug 21, 2026`, `August 21 2026`, `Aug 21`. */
const MONTH_NAME_PATTERN = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:(?:,\s*|\s+)(\d{2}|\d{4}))?$/

const MONTH_BY_NAME: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

export interface NormalizedDate {
  /** `"yyyy-mm-dd"`. */
  iso: string
  assumptions: string[]
}

export interface NormalizeDateOptions {
  /**
   * Year to use when the statement prints only a month and day. The pipeline
   * derives this from the statement itself (`inferStatementYear` below)
   * rather than defaulting to "now", so re-converting last year's statement
   * does not silently stamp every row with the current year.
   */
  fallbackYear?: number
}

/** Two-digit years are expanded into the 2000s. A personal bank statement
 * for 1926 is not a case worth handling; a statement for 2026 printed as
 * `26` very much is. */
function expandTwoDigitYear(value: number): number {
  return 2000 + value
}

/** Rejects impossible calendar dates (`02/30`, `13/01`) that a plain
 * `new Date()` would happily roll over into the next month. */
function buildIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/**
 * Normalizes one printed date, or returns `null` if the text is not a date
 * this module recognizes.
 *
 * Numeric dates are read as `MM/DD` (US statement convention) unless the
 * first component is greater than 12, in which case it cannot be a month and
 * the components are swapped — with the swap recorded, since it means the
 * statement is not using the convention the rest of the file assumed.
 */
export function normalizeDate(
  raw: string,
  options: NormalizeDateOptions = {},
): NormalizedDate | null {
  const text = raw.trim()
  if (text.length === 0) return null
  const assumptions: string[] = []

  const isoMatch = ISO_PATTERN.exec(text)
  if (isoMatch) {
    const iso = buildIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]))
    return iso ? { iso, assumptions } : null
  }

  const monthNameMatch = MONTH_NAME_PATTERN.exec(text)
  if (monthNameMatch) {
    const month = MONTH_BY_NAME[monthNameMatch[1].slice(0, 3).toLowerCase()]
    if (!month) return null
    const day = Number(monthNameMatch[2])
    const year = resolveYear(monthNameMatch[3], options, assumptions, text)
    if (year === null) return null
    const iso = buildIsoDate(year, month, day)
    return iso ? { iso, assumptions } : null
  }

  const numericMatch = NUMERIC_PATTERN.exec(text)
  if (numericMatch) {
    let month = Number(numericMatch[1])
    let day = Number(numericMatch[2])
    if (month > 12 && day <= 12) {
      assumptions.push(
        `Read "${text}" as day/month — the first number is above 12, so it cannot be a month.`,
      )
      const swap = month
      month = day
      day = swap
    }
    const year = resolveYear(numericMatch[3], options, assumptions, text)
    if (year === null) return null
    const iso = buildIsoDate(year, month, day)
    return iso ? { iso, assumptions } : null
  }

  return null
}

/** Shared year resolution for both date shapes: a printed 4-digit year is
 * used as-is, a 2-digit year is expanded (and recorded), and a missing year
 * falls back to the caller-supplied statement year (also recorded). Returns
 * `null` when there is no year and no fallback — the row then fails
 * validation with an empty date rather than being dated by guesswork. */
function resolveYear(
  printed: string | undefined,
  options: NormalizeDateOptions,
  assumptions: string[],
  originalText: string,
): number | null {
  if (printed && printed.length === 4) return Number(printed)

  if (printed && printed.length === 2) {
    const year = expandTwoDigitYear(Number(printed))
    assumptions.push(`Read the two-digit year in "${originalText}" as ${year}.`)
    return year
  }

  if (options.fallbackYear !== undefined) {
    assumptions.push(
      `"${originalText}" has no year — used ${options.fallbackYear} from elsewhere in the statement.`,
    )
    return options.fallbackYear
  }

  return null
}

/**
 * Scans already-extracted statement text for a 4-digit year to use as the
 * fallback for year-less rows, preferring the most frequently occurring one.
 *
 * Bank statements essentially always print a full date somewhere (the
 * statement period header, the first transaction, the "Statement Date"
 * line), so this is reliable in practice — and when it finds nothing the
 * caller gets `undefined` and year-less rows correctly fail validation
 * instead of being silently stamped with today's year.
 */
export function inferStatementYear(text: string): number | undefined {
  const counts = new Map<number, number>()
  for (const match of text.matchAll(/\b(19|20)\d{2}\b/g)) {
    const year = Number(match[0])
    counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  if (counts.size === 0) return undefined

  let best: number | undefined
  let bestCount = 0
  for (const [year, count] of counts) {
    if (count > bestCount) {
      best = year
      bestCount = count
    }
  }
  return best
}
