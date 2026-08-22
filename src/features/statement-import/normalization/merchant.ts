/**
 * Merchant normalization: a statement's description text -> a readable
 * merchant name.
 *
 * Scope note — this is deliberately NOT `lib/merchant-normalization.ts`.
 * That module produces a lowercased *grouping key* for Analytics ("NETFLIX.COM"
 * and "Netflix" must land in one bucket); this one produces a
 * human-facing *display name* that gets written to `Transaction.merchant` and
 * shown in the transaction table. Different outputs, different failure costs:
 * over-normalizing here destroys information the user reads, so this module
 * strips only noise it can identify positively (payment-processor prefixes,
 * terminal/reference numbers, trailing store numbers) and leaves anything it
 * does not recognize alone.
 *
 * The untouched original always survives on `DraftTransaction.source.
 * rawDescription` and in the row's notes, so a bad cleanup is always
 * recoverable — by the user in the review table, or by a developer reading
 * the row's provenance.
 */

/** Payment-processor and card-network prefixes that carry no merchant
 * information. Anchored at the start and matched case-insensitively; each
 * consumes its own trailing separator (`*`, `-`, or whitespace) so
 * `"SQ *WALMART"` and `"TST* Local Bistro"` both reduce cleanly. */
const PROCESSOR_PREFIX_PATTERN =
  /^(?:SQ|TST|SP|PY|PAYPAL|IC|EB|WL|CKE|DD|MSP|LS|POS|PPD)\s*\*+\s*/i

/** Card-network transaction-type preambles some banks print before the
 * merchant (`"POS DEBIT WALGREENS"`, `"PURCHASE AUTHORIZED ON 08/21 SHELL"`). */
const TRANSACTION_TYPE_PREFIX_PATTERN =
  /^(?:POS\s+(?:DEBIT|CREDIT|PURCHASE)|DEBIT\s+CARD\s+PURCHASE|CHECK\s*CARD\s+PURCHASE|PURCHASE\s+AUTHORIZED(?:\s+ON\s+\d{1,2}[/-]\d{1,2})?|RECURRING\s+PAYMENT|ELECTRONIC\s+(?:WITHDRAWAL|DEPOSIT))\s+/i

/** A run of 10+ digits — an authorization/reference/trace number, never a
 * meaningful part of a merchant name. Same threshold the existing
 * `scripts/convert-statement-pdf.ts` used. */
const LONG_REFERENCE_PATTERN = /\b\d{10,}\b/g

/** A US phone number printed after the merchant (common on service and
 * utility charges). */
const PHONE_PATTERN = /\b\d{3}[-.]\d{3}[-.]\d{4}\b/g

/** A trailing store/location number (`"#1234"`, `"# 1234"`) — dropped
 * because it splits one merchant into many in every downstream chart. */
const TRAILING_STORE_NUMBER_PATTERN = /\s*#\s*\d+\s*$/

/** Trailing bare digit runs (`"TOM THUMB 0065"`, street numbers). Only
 * stripped when at least one word survives, so a merchant whose entire name
 * is numeric is never erased. */
const TRAILING_DIGITS_PATTERN = /\s+\d+\s*$/

/** Words that are noise wherever they appear at the end of a description. */
const TRAILING_NOISE_WORDS = new Set(["purchase", "payment", "pos", "debit", "credit", "card"])

/** Detects an all-caps description (how nearly every statement prints
 * merchants) so title-casing is applied only where it improves readability
 * and never mangles a name the statement already cased deliberately
 * (`"iTunes"`, `"eBay"`). */
function isAllCaps(value: string): boolean {
  return value === value.toUpperCase() && /[A-Z]/.test(value)
}

/** Title-cases one token, leaving tokens containing digits or symbols alone
 * (`"7-ELEVEN"` stays recognizable, `"CVS"` becomes `"Cvs"` only if it is
 * not in the acronym set below). */
const PRESERVED_ACRONYMS = new Set([
  "ATM", "USA", "US", "UK", "CVS", "BP", "H-E-B", "HEB", "AT&T", "TJ", "IKEA",
  "AMC", "DMV", "IRS", "USPS", "UPS", "ACH", "LLC", "INC",
])

function titleCaseToken(token: string): string {
  const upper = token.toUpperCase()
  if (PRESERVED_ACRONYMS.has(upper)) return upper
  if (/\d/.test(token)) return token
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
}

/**
 * Cleans one description into a display-ready merchant name.
 *
 * Returns `""` only when the input was empty or consisted entirely of noise
 * — callers treat that as "merchant missing" and let validation flag the row
 * rather than inventing a placeholder.
 */
export function normalizeMerchant(raw: string): string {
  let text = raw.trim().replace(/\s+/g, " ")
  if (text.length === 0) return ""

  // Prefix stripping runs before anything else — both patterns are anchored,
  // so they must see the string's real start. Applied repeatedly because
  // some statements stack them ("POS DEBIT SQ *MERCHANT").
  let previous: string
  do {
    previous = text
    text = text.replace(TRANSACTION_TYPE_PREFIX_PATTERN, "")
    text = text.replace(PROCESSOR_PREFIX_PATTERN, "")
    text = text.trim()
  } while (text !== previous && text.length > 0)

  text = text.replace(PHONE_PATTERN, " ")
  text = text.replace(LONG_REFERENCE_PATTERN, " ")
  text = text.replace(/\s+/g, " ").trim()

  text = text.replace(TRAILING_STORE_NUMBER_PATTERN, "").trim()

  // Only strip a trailing number when something is left to keep.
  if (TRAILING_DIGITS_PATTERN.test(text) && text.split(" ").length > 1) {
    text = text.replace(TRAILING_DIGITS_PATTERN, "").trim()
  }

  const words = text.split(" ").filter(Boolean)
  while (
    words.length > 1 &&
    TRAILING_NOISE_WORDS.has(words[words.length - 1].toLowerCase())
  ) {
    words.pop()
  }
  text = words.join(" ")

  // Strip stray punctuation the point-of-sale system left behind, but keep
  // characters that are part of real names ("&", "'", "-").
  text = text.replace(/[*_|]+/g, " ").replace(/\s+/g, " ").trim()
  text = text.replace(/^[.,\-\s]+|[.,\-\s]+$/g, "").trim()

  if (text.length === 0) return ""

  return isAllCaps(text) ? text.split(" ").map(titleCaseToken).join(" ") : text
}
