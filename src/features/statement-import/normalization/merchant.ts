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

/**
 * Card-network and posting-type preambles banks print before the merchant —
 * `"POS DEBIT WALGREENS"`, `"VISA CHECK STARBUCKS STORE 10249"`,
 * `"WITHDRAWAL POS #622100736300 SAMS CLUB"`,
 * `"RECURRING WITHDRAWAL BILL PAYMENT #622900526385 HULU"`.
 *
 * An optional `#<digits>` terminal-or-trace number is consumed with the
 * keyword, since it always trails the posting type rather than belonging to
 * the merchant. The `\b` after the alternation is load-bearing: without it
 * the bare `ACH` branch would bite into a merchant genuinely starting with
 * those letters (turning "ACHIEVA" into "IEVA").
 */
const TRANSACTION_TYPE_PREFIX_PATTERN = new RegExp(
  "^(?:RECURRING\\s+)?(?:" +
    "VISA\\s+CHECK|CHECK\\s*CARD(?:\\s+PURCHASE)?|DEBIT\\s+CARD\\s+PURCHASE|" +
    "POS\\s+(?:DEBIT|CREDIT|PURCHASE)|BILL\\s+PAYMENT|" +
    "PURCHASE\\s+AUTHORIZED(?:\\s+ON\\s+\\d{1,2}[/-]\\d{1,2})?|" +
    "ELECTRONIC\\s+(?:WITHDRAWAL|DEPOSIT)|RECURRING\\s+PAYMENT|" +
    "WITHDRAWAL|DEPOSIT|POS|ACH" +
    ")\\b(?:\\s*#\\d+)?\\s*",
  "i",
)

/**
 * ACH/bill-pay metadata appended after the merchant
 * (`"CAPITAL ONE TYPE: CRCARDPMT ID: 9541719318 CO: CAPITAL ONE NAME: KYLE
 * LEJEUNE"`). Everything from the first `KEY:` marker on is bookkeeping, not
 * merchant — and it routinely contains the account holder's own name, which
 * has no business being written into a merchant field.
 */
const TRAILING_METADATA_PATTERN = /\s+(?:TYPE|ID|CO|NAME|REF|MEMO|DESC|TRN)\s*:.*$/i

/** A trailing two-letter state code, the last token of the location tail
 * these statements print after the merchant. */
const TRAILING_STATE_PATTERN = /\s+[A-Z]{2}\s*$/

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

  // Cut the bookkeeping tail first, while its `KEY:` markers are still intact
  // and before any other step can disturb them.
  text = text.replace(TRAILING_METADATA_PATTERN, "").trim()

  // Prefix stripping runs before anything else — both patterns are anchored,
  // so they must see the string's real start. Applied repeatedly because
  // some statements stack them ("WITHDRAWAL POS #622100736799 SAMS CLUB",
  // "POS DEBIT SQ *MERCHANT").
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

  // Strip the location tail these statements append after the merchant:
  // "<merchant> <street/city> <STATE>". The state code is the reliable
  // anchor, so it comes off first; the city word before it is then removed
  // only when enough of the name survives to still identify the merchant.
  if (TRAILING_STATE_PATTERN.test(text) && text.split(" ").length >= 2) {
    text = text.replace(TRAILING_STATE_PATTERN, "").trim()

    const words = text.split(" ")
    if (words.length >= 3 && /^[A-Za-z]+$/.test(words[words.length - 1])) {
      text = words.slice(0, -1).join(" ")
    }
  }

  // Everything from the first bare numeric token onward is a street address
  // or trace number, never part of the name ("CHEVRON 0389365 SPANISH FORT"
  // -> "CHEVRON"). Position 0 is exempt so a merchant that legitimately opens
  // with a number ("7 BREW COFFEE") keeps it. A store number written with a
  // "#" is not bare, so it survives to the dedicated strip below.
  const tokens = text.split(" ")
  for (let index = 1; index < tokens.length; index++) {
    if (/^\d+$/.test(tokens[index])) {
      text = tokens.slice(0, index).join(" ")
      break
    }
  }

  // Contact details the bill-pay descriptor tacks on ("BALDWIN EMC
  // MWHITE@BALDWI").
  text = text
    .split(" ")
    .filter((token) => !token.includes("@"))
    .join(" ")
    .trim()

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
