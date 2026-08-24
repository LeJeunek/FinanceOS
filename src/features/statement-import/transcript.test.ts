import { describe, expect, it } from "vitest"

import { convertStatementText, summarize } from "@/features/statement-import/pipeline"
import { TRANSCRIPT_HEADER } from "@/features/statement-import/parsing/transcript-parser"
import type { DraftTransaction } from "@/features/statement-import/types"

/**
 * Regression fixture taken from a real New Horizons Credit Union statement
 * that has no text layer (two scanned JPEG pages), transcribed by
 * `server/vision-text.ts`.
 *
 * Kept verbatim — including its duplicate rows, its ACH metadata, and its
 * credit-card payments — because it is the only ground truth available for
 * the scanned path, and because the sign handling on those card payments is
 * exactly the bug this fixture exists to keep fixed.
 */
const REAL_TRANSCRIPT = [
  TRANSCRIPT_HEADER,
  "8/22/2026 | PUBLIX #1400 | DEBIT | 26.47 | ",
  "8/22/2026 | BURGER KING #927 | DEBIT | 10.45 | ",
  "8/21/2026 | DEPOSIT ACH CRC DISTRIBUTION TYPE: PAYROLL ID: 4237313001 CO: CRC DISTRIBUTION | CREDIT | 1271.97 | ",
  "8/21/2026 | DEPOSIT ACH CRC DISTRIBUTION TYPE: PAYROLL ID: 4237313001 CO: CRC DISTRIBUTION | CREDIT | 796.69 | ",
  "8/20/2026 | VISA CHECK ALTAPOINTE HEALTH SYSTE FAIRHOPE AL | DEBIT | 25.00 | ",
  "8/20/2026 | VISA CHECK ALTAPOINTE HEALTH SYSTE FAIRHOPE AL | DEBIT | 25.00 | ",
  "8/19/2026 | VISA CHECK PAYPAL STEAM GAMES 402-935-7733 WA | DEBIT | 6.79 | ",
  "8/19/2026 | VISA CHECK BURGER KING #9270 ROBERTSDALE AL | DEBIT | 10.45 | ",
  "8/19/2026 | WITHDRAWAL ACH CAPITAL ONE TYPE: CRCARDPMT ID: 9541719318 CO: CAPITAL ONE NAME: KYLE LEJEUNE | DEBIT | 80.00 | ",
  "8/17/2026 | RECURRING WITHDRAWAL BILL PAYMENT #622900526385 HULU HLUHULUPLUS SANTA MONICA CA | DEBIT | 35.99 | ",
  "8/17/2026 | WITHDRAWAL ACH PLANET FITNESS D TYPE: ICLUB FEES ID: G710602737 CO: PLANET FITNESS | DEBIT | 10.00 | ",
  "8/16/2026 | VISA CHECK PUBLIX #1400 SPANISH FORT AL | DEBIT | 116.94 | ",
  "8/11/2026 | RECURRING VISA CHECK ANTHROPIC CLAUDE SUB ANTHROPIC.COM CA | DEBIT | 20.00 | ",
  "8/11/2026 | WITHDRAWAL BILL PAYMENT #622221854340 BALDWIN EMC MWHITE@BALDWI AL | DEBIT | 190.00 | ",
  "8/10/2026 | WITHDRAWAL ACH CAPITAL ONE TYPE: MOBILE PMT ID: 9279744380 CO: CAPITAL ONE NAME: KYLE LEJEUNE | DEBIT | 450.00 | ",
  "8/10/2026 | VISA CHECK STARBUCKS STORE 10249 SPANISH FORT AL | DEBIT | 6.69 | ",
  "8/9/2026 | WITHDRAWAL POS #622100736300 SAMS CLUB #4990 29683 FREDERICK BLVD DAPHNE AL | DEBIT | 54.48 | ",
  "8/3/2026 | VISA CHECK CHEVRON 0389365 SPANISH FORT AL | DEBIT | 20.24 | ",
  "ENDING_BALANCE | 1204.55",
].join("\n")

const result = convertStatementText(REAL_TRANSCRIPT)

function row(index: number): DraftTransaction {
  return result.transactions[index]
}

function find(predicate: (draft: DraftTransaction) => boolean): DraftTransaction {
  const found = result.transactions.find(predicate)
  if (!found) throw new Error("No matching transaction")
  return found
}

describe("scanned statement transcript", () => {
  it("routes to the transcript parser", () => {
    expect(result.parserId).toBe("vision-transcript")
  })

  it("reads every transaction line", () => {
    expect(result.transactions).toHaveLength(18)
  })

  it("normalizes M/D/YYYY dates", () => {
    expect(row(0).date).toBe("2026-08-22")
    expect(find((d) => d.source.rawDate === "8/9/2026").date).toBe("2026-08-09")
  })

  it("signs debits negative and credits positive", () => {
    expect(row(0).amount).toBe(-26.47)
    expect(find((d) => d.merchant.includes("Crc Distribution")).amount).toBe(1271.97)
  })

  it("keeps credit-card payments as money OUT, not income", () => {
    // The reported bug: a Capital One card payment is a withdrawal from
    // checking. If it lands positive it reads as income and pushes the
    // account balance the wrong way.
    const cardPayments = result.transactions.filter((draft) =>
      draft.source.rawDescription.includes("CAPITAL ONE"),
    )
    expect(cardPayments).toHaveLength(2)
    for (const payment of cardPayments) {
      expect(payment.amount).toBeLessThan(0)
    }
    expect(cardPayments.map((p) => p.amount ?? 0).sort((a, b) => a - b)).toEqual([-450, -80])
  })

  it("makes no sign assumptions — every direction came from the statement", () => {
    const assumed = result.transactions.filter((draft) =>
      draft.assumptions.some((note) => note.includes("treated as money out")),
    )
    expect(assumed).toEqual([])
  })

  it("cleans POS and processor noise out of merchant names", () => {
    expect(find((d) => d.source.rawDescription.includes("STARBUCKS")).merchant).toContain(
      "Starbucks",
    )
    expect(find((d) => d.source.rawDescription.includes("CHEVRON")).merchant).toContain("Chevron")
  })

  it("categorizes recognizable merchants", () => {
    expect(find((d) => d.source.rawDescription.includes("PUBLIX")).category).toBe("Food")
    expect(find((d) => d.source.rawDescription.includes("CHEVRON")).category).toBe("Transportation")
    expect(find((d) => d.source.rawDescription.includes("HULU")).category).toBe("Entertainment")
    expect(find((d) => d.source.rawDescription.includes("BALDWIN EMC")).category).toBe("Utilities")
  })

  it("flags the repeated ALTAPOINTE charge without deleting it", () => {
    const altapointe = result.transactions.filter((draft) =>
      draft.source.rawDescription.includes("ALTAPOINTE"),
    )
    expect(altapointe).toHaveLength(2)
    expect(altapointe[0].duplicateOfId).toBeNull()
    expect(altapointe[1].duplicateOfId).toBe(altapointe[0].id)
  })

  it("reads the closing balance", () => {
    expect(result.endingBalance).toMatchObject({ amount: 1204.55 })
  })

  it("produces no validation errors", () => {
    expect(result.transactions.flatMap((draft) => draft.errors)).toEqual([])
  })

  it("summarizes the batch", () => {
    expect(summarize(result.transactions)).toMatchObject({ total: 18, invalid: 0, duplicates: 1 })
  })
})
