import { describe, expect, it } from "vitest"

import {
  buildReconciliation,
  isReconcilableAccountType,
  netAmountOf,
  type ReconciliationAccount,
} from "@/features/statement-import/reconciliation"
import type { DraftTransaction, StatementBalance } from "@/features/statement-import/types"

const CHECKING: ReconciliationAccount = {
  id: "acc-1",
  name: "NHCU Checking",
  type: "CHECKING",
  balance: 1180.22,
}

const STATEMENT_BALANCE: StatementBalance = {
  amount: 3755.82,
  source: "ending-balance-line",
  label: "Ending Balance 3,755.82",
  sourceLine: 42,
  asOfDate: "2026-08-09",
}

function draft(amount: number, id = "row-1"): DraftTransaction {
  return {
    id,
    date: "2026-08-21",
    merchant: "Test",
    amount,
    category: "Misc",
    notes: "",
    confidence: "confident",
    isEdited: false,
    assumptions: [],
    errors: [],
    duplicateOfId: null,
    source: {
      sourceLine: 1,
      rawDate: "08/21/2026",
      rawDescription: "TEST",
      rawAmount: String(Math.abs(amount)),
      direction: amount < 0 ? "debit" : "credit",
    },
  }
}

describe("isReconcilableAccountType", () => {
  it("covers the account types whose balance is stored, not derived", () => {
    expect(isReconcilableAccountType("CHECKING")).toBe(true)
    expect(isReconcilableAccountType("SAVINGS")).toBe(true)
    expect(isReconcilableAccountType("CREDIT_CARD")).toBe(true)
  })

  it("excludes holdings-derived accounts, whose balance updateAccount rejects", () => {
    expect(isReconcilableAccountType("INVESTMENT")).toBe(false)
    expect(isReconcilableAccountType("RETIREMENT")).toBe(false)
    expect(isReconcilableAccountType("CRYPTO")).toBe(false)
  })
})

describe("buildReconciliation", () => {
  it("reports the gap between the account and the statement", () => {
    const suggestion = buildReconciliation(CHECKING, STATEMENT_BALANCE)
    expect(suggestion).toMatchObject({
      currentBalance: 1180.22,
      statementBalance: 3755.82,
      difference: 2575.6,
      isReconciled: false,
      asOfDate: "2026-08-09",
    })
  })

  it("recognizes an account that already matches", () => {
    const suggestion = buildReconciliation({ ...CHECKING, balance: 3755.82 }, STATEMENT_BALANCE)
    expect(suggestion?.isReconciled).toBe(true)
    expect(suggestion?.difference).toBe(0)
    expect(suggestion?.explanation).toMatch(/already matches/)
  })

  it("compares in cents so float noise never invents a discrepancy", () => {
    const suggestion = buildReconciliation(
      { ...CHECKING, balance: 0.1 + 0.2 },
      { ...STATEMENT_BALANCE, amount: 0.3 },
    )
    expect(suggestion?.isReconciled).toBe(true)
  })

  it("says where the number came from", () => {
    expect(buildReconciliation(CHECKING, STATEMENT_BALANCE)?.provenance).toMatch(
      /closing-balance line/,
    )
    expect(
      buildReconciliation(CHECKING, { ...STATEMENT_BALANCE, source: "last-running-balance" })
        ?.provenance,
    ).toMatch(/running balance after the last transaction/)
  })

  it("offers nothing when the statement has no closing balance", () => {
    expect(buildReconciliation(CHECKING, null)).toBeNull()
  })

  it("offers nothing for a holdings-derived account", () => {
    expect(
      buildReconciliation({ ...CHECKING, type: "INVESTMENT" }, STATEMENT_BALANCE),
    ).toBeNull()
  })
})

describe("netAmountOf", () => {
  it("sums signed amounts in cents", () => {
    expect(netAmountOf([draft(-42.19, "a"), draft(-15.99, "b"), draft(2950, "c")])).toBe(2891.82)
  })

  it("ignores rows with no parseable amount", () => {
    expect(netAmountOf([draft(-10, "a"), { ...draft(0, "b"), amount: null }])).toBe(-10)
  })

  it("is zero for an empty selection", () => {
    expect(netAmountOf([])).toBe(0)
  })
})
