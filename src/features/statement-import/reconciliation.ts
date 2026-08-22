import type { AccountType } from "@prisma/client"

import type { DraftTransaction, StatementBalance } from "@/features/statement-import/types"

/**
 * Post-import balance reconciliation.
 *
 * The workflow this backs: once a statement's transactions are imported, the
 * account's stored balance *should* now equal the balance printed at the
 * bottom of that statement. This module does that comparison and produces the
 * suggestion the dialog shows ("your NHCU account says $1,180.22, the
 * statement closes at $1,204.55 — update it?").
 *
 * Why it is worth doing at all: `Account.balance` is a manually-entered
 * column that drifts. CSV import moves it by the net of the rows it inserted
 * (`features/transactions/server/balance-adjustment.ts`'s
 * `applyAggregateBalanceDelta`), so after importing a full statement the
 * stored balance and the statement's closing balance agree only if nothing
 * was missed. A mismatch is therefore genuinely informative — it means rows
 * were skipped as duplicates, the account was already partly up to date, or
 * some transactions were never recorded.
 *
 * Pure and isomorphic (no Prisma, no `lib/db`), per naming-standards.md's
 * rule for feature-root calculation modules, so the dialog can compute the
 * suggestion client-side and the whole thing is unit-testable.
 */

/** Money comparisons run in integer cents — the same technique
 * `balance-adjustment.ts` uses — so floating-point noise never reports a
 * one-cent discrepancy that isn't there. */
function toCents(value: number): number {
  return Math.round(value * 100)
}

export interface ReconciliationAccount {
  id: string
  name: string
  type: AccountType
  /** The account's currently stored balance. */
  balance: number
}

export interface ReconciliationSuggestion {
  accountId: string
  accountName: string
  /** What the account currently says. */
  currentBalance: number
  /** What the statement says it should be. */
  statementBalance: number
  /** `statementBalance - currentBalance`, i.e. how far off the account is. */
  difference: number
  /** True when the two already agree to the cent — nothing to do. */
  isReconciled: boolean
  /** Where the statement figure was read from, shown before the user
   * accepts. */
  provenance: string
  /** `"yyyy-mm-dd"` the statement balance is as of, when known. */
  asOfDate: string | null
  /** One-sentence plain-English reading of the difference. */
  explanation: string
}

/**
 * Whether a statement's closing balance is directly comparable to this
 * account type's stored balance.
 *
 * Asset accounts (checking/savings/cash) store the balance as printed. Credit
 * cards store a positive "debt owed" figure — and a card statement's "New
 * Balance" is also a positive amount owed, so the two still line up directly.
 * (The credit-card sign inversion in `balance-adjustment.ts` applies to
 * transaction *deltas*, not to the balance figure itself.)
 *
 * Investment/Retirement/Crypto balances are derived from holdings and are
 * never writable by hand — `updateAccount` rejects a balance edit on them —
 * so reconciliation is not offered.
 */
export function isReconcilableAccountType(type: AccountType): boolean {
  return type === "CHECKING" || type === "SAVINGS" || type === "CASH" || type === "CREDIT_CARD"
}

/**
 * Builds the reconciliation suggestion, or `null` when there is nothing to
 * offer — no closing balance on the statement, or an account type whose
 * balance is derived rather than stored.
 */
export function buildReconciliation(
  account: ReconciliationAccount,
  statementBalance: StatementBalance | null,
): ReconciliationSuggestion | null {
  if (!statementBalance || !isReconcilableAccountType(account.type)) return null

  const currentCents = toCents(account.balance)
  const statementCents = toCents(statementBalance.amount)
  const differenceCents = statementCents - currentCents
  const isReconciled = differenceCents === 0

  const provenance =
    statementBalance.source === "ending-balance-line"
      ? `Read from the statement's closing-balance line (line ${statementBalance.sourceLine}): "${statementBalance.label}"`
      : `Read from the running balance after the last transaction on the statement (line ${statementBalance.sourceLine})`

  return {
    accountId: account.id,
    accountName: account.name,
    currentBalance: account.balance,
    statementBalance: statementBalance.amount,
    difference: differenceCents / 100,
    isReconciled,
    provenance,
    asOfDate: statementBalance.asOfDate,
    explanation: buildExplanation(account, differenceCents / 100, isReconciled),
  }
}

function buildExplanation(
  account: ReconciliationAccount,
  difference: number,
  isReconciled: boolean,
): string {
  if (isReconciled) {
    return `${account.name} already matches the statement's closing balance — nothing to update.`
  }

  const magnitude = Math.abs(difference).toFixed(2)
  const direction = difference > 0 ? "higher" : "lower"

  return (
    `The statement closes $${magnitude} ${direction} than ${account.name}'s stored balance. ` +
    "That usually means some of these transactions were already recorded (and skipped as duplicates), " +
    "or that activity is missing from the account. Check the imported rows before accepting."
  )
}

/**
 * The net effect the rows being imported will have on the account balance,
 * as a plain sum of signed amounts.
 *
 * Shown alongside the suggestion so the user can see the arithmetic rather
 * than being asked to trust a number: stored balance + this net should land
 * on the statement's closing balance. Rows that are invalid, unchecked, or
 * flagged duplicates are excluded by the caller before this is called, since
 * those are exactly the rows that will not be inserted.
 */
export function netAmountOf(drafts: readonly DraftTransaction[]): number {
  const cents = drafts.reduce(
    (total, draft) => total + (draft.amount === null ? 0 : toCents(draft.amount)),
    0,
  )
  return cents / 100
}
