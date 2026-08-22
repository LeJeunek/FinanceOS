"use server"

import type { AccountType, Prisma, PrismaClient } from "@prisma/client"

import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { utapi } from "@/lib/uploadthing"
import { ok, fail, type ApiResult } from "@/lib/api-response"
import {
  canRefreshNow,
  hasReachedRollingWindowCap,
  rollingWindowStart,
} from "@/lib/ai/rate-limit"
import type { AiFeatureResult } from "@/lib/ai/types"
import type { Transaction } from "@/features/transactions/types"
import {
  CreateTransactionSchema,
  UpdateTransactionSchema,
  TransactionIdSchema,
  SplitTransactionSchema,
  ReceiptIdSchema,
  RequestCategorySuggestionSchema,
  SuggestionIdSchema,
} from "@/features/transactions/server/validation"
import {
  TRANSACTION_INCLUDE,
  toTransaction,
} from "@/features/transactions/server/service"
import { removeReceipt as removeReceiptForUser } from "@/features/transactions/server/receipts"
import {
  requestManualSuggestion,
  generateAutomaticSuggestionsForUser,
  type ManualSuggestionResult,
  type CategorizeUserResult,
} from "@/features/transactions/server/categorization"
import {
  adjustBalanceForTransactionAmount,
  reverseBalanceForTransactionAmount,
  applyAggregateBalanceDelta,
} from "@/features/transactions/server/balance-adjustment"

/**
 * Mutating Server Actions for the Transactions module. Per
 * docs/architecture/api-contracts.md's Transactions section: create, update,
 * delete, and split.
 *
 * Every action below, per folder-tree.md's rule:
 *   1. Calls getCurrentUser() and fails closed with "UNAUTHENTICATED".
 *   2. Scopes every Prisma call by that user's id — an id supplied by the
 *      client (e.g. `input.id`, `input.accountId`, `input.categoryId`) is
 *      never trusted on its own; every lookup filters by
 *      `{ id, userId: user.id }` so one user can never read or mutate
 *      another user's data (folder-tree.md's risk register item #4).
 *   3. Converts the Prisma row to the client-safe `Transaction` shape via
 *      `toTransaction()` before returning it.
 */

// A Prisma transaction client (the `tx` argument inside `db.$transaction`)
// has the same query surface as `db` for the models used here. Typed
// explicitly so `resolveTagIds` can be called with either `db` or a `tx`
// client interchangeably.
type DbClient = PrismaClient | Prisma.TransactionClient

/** Minimal account shape `assertUsableAccount` returns on success — just
 * enough for `balance-adjustment.ts`'s functions (which only need `id` and
 * `type`), so callers don't need a second `db.account` round-trip purely to
 * learn the account's type for the balance-adjustment sign rule. */
type UsableAccount = { id: string; type: AccountType }

/**
 * Verifies an account exists, belongs to `userId`, and is not archived.
 * Shared by `createTransaction` and `updateTransaction` (when reassigning
 * `accountId`) so the "Attempting to log a new transaction against an
 * archived account: must be blocked" rule
 * (docs/product/accounts.md edge case, referenced by
 * docs/product/transactions.md AC12) lives in exactly one place.
 *
 * Returns the account's `id`/`type` on success (Account Balance
 * Auto-Adjustment addition, docs/product/accounts-balance-auto-adjustment.md)
 * so every caller that needs to adjust this account's balance already has
 * the `type` its sign rule depends on, without a second query.
 */
async function assertUsableAccount(
  userId: string,
  accountId: string,
): Promise<{ ok: true; account: UsableAccount } | { ok: false; error: string }> {
  const account = await db.account.findFirst({
    where: { id: accountId, userId },
  })
  if (!account) {
    return { ok: false, error: "Account not found" }
  }
  if (account.archivedAt) {
    return {
      ok: false,
      error: "Cannot assign a transaction to an archived account",
    }
  }
  return { ok: true, account: { id: account.id, type: account.type } }
}

/**
 * Verifies a category exists and belongs to `userId`. Shared by every action
 * that accepts a `categoryId` — prevents a user from assigning a transaction
 * to another user's category by guessing/supplying its id.
 */
async function assertOwnedCategory(
  userId: string,
  categoryId: string,
): Promise<boolean> {
  const category = await db.category.findFirst({
    where: { id: categoryId, userId },
    select: { id: true },
  })
  return category !== null
}

/**
 * Resolves a list of raw tag name strings to `Tag.id`s, creating any tag that
 * has no existing case-insensitive match for this user — the concrete
 * implementation of docs/product/transactions.md AC11 ("a tag typed for the
 * first time is created automatically"). Case handling: lookups are
 * case-insensitive (consistent with `features/categories/server/actions.ts`'s
 * duplicate-name convention) but a newly created tag preserves the caller's
 * original casing, since Tag has no canonical "display" vs. "match" casing
 * distinction to normalize to.
 *
 * Runs sequentially (not `Promise.all`) so two identical new tag names in the
 * same call (e.g. `["Coffee", "coffee"]`) resolve to one created row instead
 * of racing to create two — `Tag`'s `@@unique([userId, name])` would only
 * catch that at the DB level as a thrown error, not a graceful de-dupe.
 * Accepts either `db` or a `$transaction` client so it can run inside
 * `updateTransaction`'s atomic tag-replace transaction.
 */
async function resolveTagIds(
  client: DbClient,
  userId: string,
  tagNames: string[],
): Promise<string[]> {
  const uniqueNames = Array.from(
    new Set(tagNames.map((name) => name.trim()).filter((name) => name.length > 0)),
  )

  const ids: string[] = []
  for (const name of uniqueNames) {
    const existing = await client.tag.findFirst({
      where: { userId, name: { equals: name, mode: "insensitive" } },
    })
    if (existing) {
      ids.push(existing.id)
      continue
    }
    const created = await client.tag.create({ data: { userId, name } })
    ids.push(created.id)
  }
  return ids
}

/**
 * Creates a new transaction for the current user.
 *
 * Blocks creation against an archived account (AC12) and against a category
 * owned by another user (see `assertOwnedCategory`) — both are
 * cross-resource ownership/state checks Zod cannot express, so they happen
 * here rather than in `CreateTransactionSchema`.
 *
 * Account Balance Auto-Adjustment (Criterion 1,
 * docs/product/accounts-balance-auto-adjustment.md): the new transaction's
 * signed `amount` is applied to `accountId`'s balance atomically with the
 * row's creation — both live in the same `db.$transaction`, so a
 * transaction can never be recorded without its balance effect (or vice
 * versa). `adjustBalanceForTransactionAmount` itself no-ops for an
 * Investment/Retirement/Crypto account (Criterion 6's guard), so this call
 * is unconditional here rather than branching on `accountCheck.account.type`
 * first.
 */
export async function createTransaction(
  input: unknown,
): Promise<ApiResult<Transaction>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = CreateTransactionSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid transaction data")
  }
  const { date, merchant, amount, accountId, categoryId, notes } = parsed.data

  const accountCheck = await assertUsableAccount(user.id, accountId)
  if (!accountCheck.ok) {
    return fail(accountCheck.error)
  }

  if (categoryId) {
    const categoryOwned = await assertOwnedCategory(user.id, categoryId)
    if (!categoryOwned) {
      return fail("Category not found")
    }
  }

  const created = await db.$transaction(async (tx) => {
    const row = await tx.transaction.create({
      data: {
        userId: user.id,
        accountId,
        categoryId: categoryId ?? null,
        merchant,
        amount,
        date,
        notes: notes ?? null,
      },
      include: TRANSACTION_INCLUDE,
    })

    await adjustBalanceForTransactionAmount(
      tx,
      user.id,
      accountId,
      accountCheck.account.type,
      amount,
    )

    return row
  })

  return ok(toTransaction(created))
}

/**
 * Updates one or more fields on an existing transaction, including
 * re-categorizing (AC9), notes, and the full tag set (AC11).
 *
 * Only fields actually present in the parsed input are written — the same
 * "undefined fields excluded from `data`" convention as
 * `features/accounts/server/actions.ts`'s `updateAccount`. `categoryId`/
 * `notes` accept an explicit `null` (see `validation.ts`'s
 * `categoryIdSchema`/`notesSchema`) to support clearing them, distinct from
 * `undefined` (field omitted, meaning "leave unchanged").
 *
 * Reassigning `accountId` is subject to the same archived-account check as
 * `createTransaction` (AC12's "or as a reassignment target"). Per
 * docs/product/transactions.md's "Archiving an account that has
 * transactions" edge case, a transaction *already* sitting in a now-archived
 * account remains fully editable for every other field — the archived check
 * only applies when `accountId` is present in this update (i.e. actually
 * being reassigned), never as a blanket block on editing the transaction.
 *
 * Account Balance Auto-Adjustment (Criterion 2,
 * docs/product/accounts-balance-auto-adjustment.md): re-derives the balance
 * impact for every combination of `amount`/`accountId` changing, in the same
 * `$transaction` as the row update itself (no intermediate state where only
 * one side has been applied):
 *   - Amount-only change: the pre-edit amount's effect on the (unchanged)
 *     account is reversed and the post-edit amount's effect is applied
 *     fresh, on that same account.
 *   - Account-only change: the pre-edit amount's effect is reversed on the
 *     OLD account (using the old account's own sign rule) and the SAME
 *     amount's effect is applied fresh on the NEW account (using the new
 *     account's own sign rule) — never the old account's arithmetic carried
 *     over (Edge Case: "Reassigning a transaction between two different
 *     account types").
 *   - Both change together: old account/old amount reversed, new
 *     account/new amount applied — the general case both bullets above fall
 *     out of.
 * `reverseBalanceForTransactionAmount`/`adjustBalanceForTransactionAmount`
 * both no-op for an Investment/Retirement/Crypto account (Criterion 6),
 * which is what correctly leaves the out-of-scope side of a
 * reassignment-to/from-such-an-account untouched while still adjusting the
 * in-scope side (Edge Case: "Reassigning ... to/from an out-of-scope
 * account type").
 *
 * A split PARENT's `amount` has been purely informational (zero balance
 * effect) since the moment it was split (Criterion 4) — `isSplitParent`
 * skips this entire block for such a row, so editing a split parent's
 * amount/account (if ever reachable) cannot create an effect that never
 * existed. An ordinary transaction or a split CHILD both go through the
 * normal path above, per the spec's "a split child is an ordinary
 * transaction once created" rule.
 */
export async function updateTransaction(
  input: unknown,
): Promise<ApiResult<Transaction>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = UpdateTransactionSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid transaction data")
  }
  const { id, date, merchant, amount, accountId, categoryId, notes, tags } =
    parsed.data

  const existing = await db.transaction.findFirst({
    where: { id, userId: user.id },
    include: {
      account: { select: { id: true, type: true } },
      splits: { select: { id: true }, take: 1 },
    },
  })
  if (!existing) {
    return fail("Transaction not found")
  }

  const isSplitParent = existing.splits.length > 0

  let newAccount: UsableAccount | null = null
  if (accountId !== undefined) {
    const accountCheck = await assertUsableAccount(user.id, accountId)
    if (!accountCheck.ok) {
      return fail(accountCheck.error)
    }
    newAccount = accountCheck.account
  }

  if (categoryId) {
    const categoryOwned = await assertOwnedCategory(user.id, categoryId)
    if (!categoryOwned) {
      return fail("Category not found")
    }
  }

  const updated = await db.$transaction(async (tx) => {
    await tx.transaction.update({
      where: { id },
      data: {
        ...(date !== undefined ? { date } : {}),
        ...(merchant !== undefined ? { merchant } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(accountId !== undefined ? { accountId } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    })

    if (tags !== undefined) {
      const tagIds = await resolveTagIds(tx, user.id, tags)
      // Full-replace semantics (see UpdateTransactionSchema's JSDoc on
      // `tags`): clear existing links, then recreate exactly the requested
      // set. Both statements run inside this same `$transaction` so a
      // failure partway through never leaves the tag set half-updated.
      await tx.transactionTag.deleteMany({ where: { transactionId: id } })
      if (tagIds.length > 0) {
        await tx.transactionTag.createMany({
          data: tagIds.map((tagId) => ({ transactionId: id, tagId })),
        })
      }
    }

    if (!isSplitParent && (amount !== undefined || accountId !== undefined)) {
      const oldAmount = existing.amount.toNumber()
      const oldAccountId = existing.accountId
      const oldAccountType = existing.account.type

      const newAmount = amount ?? oldAmount
      const newAccountId = accountId ?? oldAccountId
      const newAccountType = newAccount?.type ?? oldAccountType

      await reverseBalanceForTransactionAmount(
        tx,
        user.id,
        oldAccountId,
        oldAccountType,
        oldAmount,
      )
      await adjustBalanceForTransactionAmount(
        tx,
        user.id,
        newAccountId,
        newAccountType,
        newAmount,
      )
    }

    return tx.transaction.findUniqueOrThrow({
      where: { id },
      include: TRANSACTION_INCLUDE,
    })
  })

  return ok(toTransaction(updated))
}

/**
 * Deletes a transaction. If the transaction is a split parent, its split
 * line items are cascade-deleted by the database — `parentTransactionId`'s
 * `onDelete: Cascade` in prisma/schema.prisma (verified against the current
 * schema, not assumed) means deleting the parent row automatically deletes
 * every child row pointing at it via that foreign key, and (by the same
 * cascade rule applied transitively) each child's own `TransactionTag` and
 * `Receipt` rows. No explicit cascade logic is implemented here for those —
 * docs/product/transactions.md AC10's "user is warned about this before
 * confirming" is a Frontend Lead concern (a confirmation dialog before
 * calling this action), not something this action needs to re-implement.
 *
 * **Phase 2 addition (Receipts):** the DB cascade above deletes `Receipt`
 * *rows*, but it cannot reach into UploadThing storage and delete the actual
 * files those rows pointed at — per prisma/schema.prisma's comment on the
 * `Receipt` model, that is this action's job, per
 * docs/architecture/api-contracts.md's Receipts section ("`deleteTransaction`
 * ... must be updated to also call `utapi.deleteFiles(...)` for every
 * receipt attached to the transaction being deleted"). Every receipt on the
 * transaction itself *and* on any of its split children is purged — a split
 * parent's children are cascade-deleted transitively by the same `delete`
 * call below, so their receipts would otherwise become silent storage
 * orphans (no `Receipt` row survives to ever reference them again), which is
 * exactly the "no orphaned file left in storage" requirement from the
 * addendum's Edge Cases. Storage files are purged *before* the transaction
 * row is deleted — same ordering rationale as `server/receipts.ts`'s
 * `removeReceipt`: if the storage purge fails, this returns early and
 * nothing is deleted yet, so the transaction/receipts stay in sync and the
 * user can simply retry, rather than risking a storage failure *after* the
 * DB rows are already gone (which would permanently orphan the files with no
 * row left to ever reference them).
 *
 * **Account Balance Auto-Adjustment addition (Criterion 3,
 * docs/product/accounts-balance-auto-adjustment.md):** reverses this
 * transaction's balance effect atomically with the row's deletion — both
 * live in the same `db.$transaction` below.
 *
 * If this row is a split PARENT (has one or more rows pointing at it via
 * `parentTransactionId`), its own `amount` has had zero balance effect since
 * the moment it was split (Criterion 4) — there is nothing of the parent's
 * own to reverse. Instead, each CHILD's own *current* balance effect is
 * reversed (Criterion 3's cascade rule / the Edge Case "a split child's
 * category or amount was later changed... the cascade-delete must reverse
 * whatever each child's *current* balance effect is at time of deletion, not
 * its original as-created effect" — reading each child's own `amount` and
 * `account.type` fresh here, rather than assuming it still matches whatever
 * the split created it with, is exactly what satisfies that). A plain
 * (non-parent) transaction — including an ordinary split CHILD being
 * deleted on its own, which is how "un-splitting" works per the spec's "no
 * merge back" limitation — reverses its own current effect the same way any
 * ordinary transaction delete would.
 */
export async function deleteTransaction(
  input: unknown,
): Promise<ApiResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = TransactionIdSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid transaction id")
  }
  const { id } = parsed.data

  const existing = await db.transaction.findFirst({
    where: { id, userId: user.id },
    include: { account: { select: { id: true, type: true } } },
  })
  if (!existing) {
    return fail("Transaction not found")
  }

  const splitChildren = await db.transaction.findMany({
    where: { parentTransactionId: id },
    include: { account: { select: { id: true, type: true } } },
  })

  const attachedReceipts = await db.receipt.findMany({
    where: {
      transaction: {
        userId: user.id,
        OR: [{ id }, { parentTransactionId: id }],
      },
    },
    select: { key: true },
  })

  if (attachedReceipts.length > 0) {
    const deleteResult = await utapi.deleteFiles(
      attachedReceipts.map((receipt) => receipt.key),
    )
    if (!deleteResult.success) {
      return fail(
        "Failed to remove attached receipt files; transaction was not deleted",
      )
    }
  }

  await db.$transaction(async (tx) => {
    if (splitChildren.length > 0) {
      for (const child of splitChildren) {
        await reverseBalanceForTransactionAmount(
          tx,
          user.id,
          child.accountId,
          child.account.type,
          child.amount.toNumber(),
        )
      }
    } else {
      await reverseBalanceForTransactionAmount(
        tx,
        user.id,
        existing.accountId,
        existing.account.type,
        existing.amount.toNumber(),
      )
    }

    await tx.transaction.delete({ where: { id } })
  })

  return ok({ id })
}

/**
 * Removes a single receipt from a transaction (docs/product/transactions.md
 * addendum AC3), per docs/architecture/api-contracts.md's Receipts section.
 * Thin Server Action wrapper: authenticates and validates input, then
 * delegates to `server/receipts.ts`'s `removeReceipt` for the actual
 * ownership check + storage/DB delete ordering (see that function's JSDoc).
 */
export async function removeReceipt(
  input: unknown,
): Promise<ApiResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = ReceiptIdSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid receipt id")
  }

  return removeReceiptForUser(user.id, parsed.data.id)
}

/** Formats an integer cents value as a `"$X.XX"` string for error messages
 * below — kept local and minimal rather than importing `lib/utils.ts`'s
 * `formatCurrency` (an `Intl.NumberFormat`-based display helper), since this
 * is a plain validation-error string, not UI presentation. */
function formatCentsAsDollars(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

/**
 * Splits a transaction into two or more category allocations.
 *
 * Critical validation, per docs/product/transactions.md AC13 and its
 * "Split remainder/rounding" edge case: the split amounts MUST sum EXACTLY
 * to the original transaction's amount. This is done in integer cents, never
 * floating point — `splits[].amount` was already validated by
 * `SplitTransactionSchema` to have at most 2 decimal places, so
 * `Math.round(amount * 100)` for each split is an exact, safe conversion
 * (the same technique `features/accounts/server/validation.ts` uses for
 * precision checks), and summing integers has no floating-point drift. The
 * original amount's cents are derived from the Prisma `Decimal` directly via
 * `.mul(100)` (decimal.js exact arithmetic) rather than
 * `existing.amount.toNumber() * 100`, avoiding a float round-trip on the
 * comparison target too.
 *
 * Single-level splitting only, per AC15 ("a transaction that has already
 * been split cannot itself be split again"): rejected if `existing` is
 * itself a split child (`parentTransactionId !== null`) or is already a
 * split parent (has existing rows pointing at it via `parentTransactionId`).
 *
 * On success, creates N new child transactions — same `date`/`merchant`/
 * `accountId` as the parent, per-split `categoryId`/`amount` — each
 * referencing the parent via `parentTransactionId`, per the schema comment
 * on that field and AC14. The parent row itself is left untouched (its own
 * `amount` becomes purely informational once split children exist; see the
 * schema comment) — `listTransactions`'s `EXCLUDE_SPLIT_PARENTS` is what
 * keeps it out of the default table view once this returns.
 *
 * **Account Balance Auto-Adjustment addition (Criterion 4,
 * docs/product/accounts-balance-auto-adjustment.md):** the parent's
 * original create-time balance effect is reversed at the moment of
 * splitting (its `amount` stops being real, so its effect on the balance
 * must stop too), and every split child's own signed amount is applied as
 * its own effect on that same account (split children always share the
 * parent's `accountId`) — both inside the same `$transaction` as the child
 * rows' creation. Because `splits` was just validated above to sum EXACTLY
 * to the parent's original amount, "reverse the parent + apply every
 * child" is mathematically guaranteed to net to exactly zero change on the
 * account's balance (see `balance-adjustment.test.ts`'s exact-equality
 * test) — this is what makes splitting a transaction balance-neutral by
 * construction, never merely by coincidence.
 */
export async function splitTransaction(
  input: unknown,
): Promise<ApiResult<Transaction[]>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = SplitTransactionSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid split data")
  }
  const { id, splits } = parsed.data

  const existing = await db.transaction.findFirst({
    where: { id, userId: user.id },
    include: { account: { select: { id: true, type: true } } },
  })
  if (!existing) {
    return fail("Transaction not found")
  }

  if (existing.parentTransactionId !== null) {
    return fail("A split line item cannot itself be split")
  }

  const alreadySplitCount = await db.transaction.count({
    where: { parentTransactionId: id },
  })
  if (alreadySplitCount > 0) {
    return fail("This transaction has already been split")
  }

  const categoryIds = Array.from(new Set(splits.map((split) => split.categoryId)))
  const ownedCategories = await db.category.findMany({
    where: { id: { in: categoryIds }, userId: user.id },
    select: { id: true },
  })
  if (ownedCategories.length !== categoryIds.length) {
    return fail("One or more categories were not found")
  }

  const originalCents = Math.round(existing.amount.mul(100).toNumber())
  const splitCentsList = splits.map((split) => Math.round(split.amount * 100))
  const sumCents = splitCentsList.reduce((sum, cents) => sum + cents, 0)

  if (sumCents !== originalCents) {
    return fail(
      `Split amounts must sum exactly to ${formatCentsAsDollars(originalCents)} (got ${formatCentsAsDollars(sumCents)})`,
    )
  }

  const created = await db.$transaction(async (tx) => {
    // Reverse the parent's original create-time effect first (Criterion 4)
    // — see this function's JSDoc for why this, combined with applying every
    // child's own effect below, is guaranteed to net to zero.
    await reverseBalanceForTransactionAmount(
      tx,
      user.id,
      existing.accountId,
      existing.account.type,
      existing.amount.toNumber(),
    )

    const rows = await Promise.all(
      splits.map((split) =>
        tx.transaction.create({
          data: {
            userId: user.id,
            accountId: existing.accountId,
            categoryId: split.categoryId,
            merchant: existing.merchant,
            amount: split.amount,
            date: existing.date,
            parentTransactionId: existing.id,
          },
          include: TRANSACTION_INCLUDE,
        }),
      ),
    )

    // All split children share the parent's accountId (enforced above) —
    // applied as one aggregate atomic increment rather than one call per
    // child, the same "aggregate rather than per-row" performance allowance
    // Criterion 5 grants CSV import, for the same reason (avoids an N-write
    // pattern on a split with many line items).
    await applyAggregateBalanceDelta(
      tx,
      user.id,
      existing.accountId,
      existing.account.type,
      splits.map((split) => split.amount),
    )

    return rows
  })

  return ok(created.map(toTransaction))
}

// ---------------------------------------------------------------------------
// Transaction Auto-Categorization (Phase 4a) — per
// docs/architecture/api-contracts.md's Feature 1 section and
// docs/architecture/ai-features-design.md. `requestCategorySuggestion` is the
// manual "reconsider" path's Server Action (AI-generation logic lives in
// `./categorization.ts`); `acceptCategorySuggestion`/`rejectCategorySuggestion`
// are ordinary, non-AI Server Actions that resolve an already-generated
// suggestion's lifecycle. All three follow this file's own standing
// auth-then-validate-then-ownership-check convention.
// ---------------------------------------------------------------------------

/** Minimum time between successive "reconsider" requests for the SAME
 * transaction. This action's concurrency profile — one authenticated user,
 * acting on one of their own rows, within milliseconds of themselves —
 * matches the exact profile `prisma/schema.prisma`'s own
 * `CategorySuggestion` comment uses to justify a plain app-level read-check
 * (rather than the atomic-conditional-update pattern the shared
 * `(userId, month)`/`(userId, period)` cache rows of the Budget
 * Advisor/Spending Insights need) — see `lib/ai/rate-limit.ts`'s
 * `canRefreshNow` doc comment. */
const RECONSIDER_MIN_INTERVAL_MS = 60_000

/** Secondary, per-user rolling-window cap (ai-features-design.md §2/§6,
 * Finding 6a) across ALL of a user's "reconsider" calls in aggregate, not
 * just calls against one transaction — bounds total call volume even if a
 * user cycles through many distinct transactions in quick succession. */
const RECONSIDER_ROLLING_WINDOW_MS = 60 * 60 * 1000
const RECONSIDER_MAX_CALLS_PER_ROLLING_WINDOW = 30

/**
 * The manual "reconsider" path (ai-features.md AC6): requests a fresh
 * suggestion for any transaction, including one that already has a
 * category — this action never changes the transaction's category on its
 * own, it only surfaces a new suggestion for the user to accept or ignore.
 *
 * Rate-limited per `lib/ai/rate-limit.ts`: a per-transaction minimum
 * interval (using the most recent `CategorySuggestion` row for this
 * transaction, of any status, as `lastGeneratedAt`) plus the secondary
 * per-user rolling-window cap above — both checked, and both must pass,
 * before `categorization.ts` ever calls the model (Finding 6a/6b). Being
 * rate-limited is an ordinary request-level rejection (the outer
 * `ApiResult`, same as any other invalid-input case in this file) — not an
 * AI-provider outcome, so it is never expressed through the inner
 * `AiFeatureResult`.
 */
export async function requestCategorySuggestion(
  input: unknown,
): Promise<ApiResult<AiFeatureResult<ManualSuggestionResult>>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = RequestCategorySuggestionSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid request")
  }

  const transactionId =
    "transactionId" in parsed.data
      ? parsed.data.transactionId
      : parsed.data.splitLineItemId

  const existing = await db.transaction.findFirst({
    where: { id: transactionId, userId: user.id },
    select: { id: true },
  })
  if (!existing) {
    return fail("Transaction not found")
  }

  const lastSuggestion = await db.categorySuggestion.findFirst({
    where: { userId: user.id, transactionId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  })
  if (!canRefreshNow(lastSuggestion?.createdAt ?? null, RECONSIDER_MIN_INTERVAL_MS)) {
    return fail(
      "Please wait a moment before requesting another suggestion for this transaction",
    )
  }

  const callsInWindow = await db.categorySuggestion.count({
    where: {
      userId: user.id,
      source: "MANUAL_RECONSIDER",
      createdAt: { gte: rollingWindowStart(RECONSIDER_ROLLING_WINDOW_MS) },
    },
  })
  if (
    hasReachedRollingWindowCap(
      callsInWindow,
      RECONSIDER_MAX_CALLS_PER_ROLLING_WINDOW,
    )
  ) {
    return fail("You've requested too many suggestions recently — try again later")
  }

  const result = await requestManualSuggestion(user.id, transactionId)
  return ok(result)
}

/** Minimum time between successive bulk "suggest categories" requests for
 * one user — prevents spam-clicking from burning through model calls.
 * Reuses `generateAutomaticSuggestionsForUser`'s own existing per-invocation
 * cap (`MAX_BATCHES_PER_USER_PER_INVOCATION` batches of
 * `CATEGORIZATION_BATCH_SIZE` transactions each, `lib/ai/rate-limit.ts`), so
 * this cooldown is the only additional guard this on-demand trigger needs —
 * a longer interval than the single-transaction "reconsider" cooldown
 * (`RECONSIDER_MIN_INTERVAL_MS`) since one call here can cost up to a full
 * batch of model calls instead of one. */
const BULK_SUGGEST_MIN_INTERVAL_MS = 60_000

/**
 * User-triggered "suggest categories for every currently-Uncategorized
 * transaction" action — the bulk counterpart to `requestCategorySuggestion`'s
 * single-transaction "reconsider" path. Delegates entirely to
 * `generateAutomaticSuggestionsForUser` (the same batch-generation logic the
 * categorization cron already runs on a schedule), so a user doesn't have to
 * wait for the next cron invocation to get suggestions for a backlog of
 * Uncategorized transactions (e.g. right after a CSV import).
 *
 * Rate-limited per-user via `BULK_SUGGEST_MIN_INTERVAL_MS` above, checked
 * against this user's most recent AUTOMATIC-source suggestion — the same
 * plain read-then-check pattern `requestCategorySuggestion` already uses for
 * its own single-transaction cooldown (this action's concurrency profile is
 * identical: one authenticated user, acting on their own data).
 * `generateAutomaticSuggestionsForUser` already bounds the actual work done
 * per call (`MAX_BATCHES_PER_USER_PER_INVOCATION` batches), so a backlog
 * larger than one batch is processed a batch at a time across successive
 * clicks, exactly like it is across successive cron invocations.
 */
export async function requestBulkCategorySuggestions(): Promise<
  ApiResult<CategorizeUserResult>
> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const lastBulkSuggestion = await db.categorySuggestion.findFirst({
    where: { userId: user.id, source: "AUTOMATIC" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  })
  if (!canRefreshNow(lastBulkSuggestion?.createdAt ?? null, BULK_SUGGEST_MIN_INTERVAL_MS)) {
    return fail("Please wait a moment before requesting suggestions again")
  }

  const result = await generateAutomaticSuggestionsForUser(user.id)
  return ok(result)
}

/**
 * Accepts a pending suggestion (AC4): sets the transaction's category
 * immediately, via the SAME `updateTransaction` path a manual edit uses —
 * this is the only code path that ever writes `Transaction.categoryId` as a
 * result of a suggestion (ai-features-design.md §4.4's "no autonomous write
 * path" structural rule).
 *
 * Per ai-features.md's own edge case, a suggestion whose category was
 * deleted between generation and acceptance (`suggestedCategoryId` has gone
 * `null` via the FK's `onDelete: SetNull`) is invalidated rather than
 * accepted — the suggestion is marked `REJECTED` and the caller is told the
 * category no longer exists.
 *
 * **Phase 4a review-gate fix (Bug Hunter HIGH finding,
 * `docs/testing/bug-reports/accept-reject-category-suggestion-toctou-race.md`).**
 * The initial `findFirst` + `status !== "PENDING"` check below is a
 * best-effort fast path ONLY (a friendly, cheap "not found"/"already
 * resolved" message for the common sequential case) — it is never trusted
 * as the authority for whether THIS call is the one that gets to resolve
 * the suggestion, because a concurrent Accept/Reject for the same
 * `suggestionId` could read the identical PENDING snapshot at the same
 * moment. The actual mutual-exclusion boundary is the atomic conditional
 * `updateMany({ where: { ..., status: "PENDING" }, data: { status: ... } })`
 * calls below (`claimed.count === 1` iff THIS call is the one that moved
 * the row away from PENDING) — the same "claim by rows-affected" technique
 * `lib/ai/rate-limit.ts`'s / `dashboard/server/monthly-summary.ts`'s
 * `claimGenerationSlot` already establishes elsewhere in this codebase.
 * Only after winning a claim does this function ever perform a
 * transaction-mutating side effect; a losing caller gets an explicit
 * "already resolved" failure instead of silently proceeding, which is what
 * closes the original bug (a losing Accept could previously still change
 * the transaction's category even though the suggestion's final, persisted
 * status was `REJECTED`).
 *
 * **Ordering judgment call:** the ACCEPTED claim is taken *before*
 * `updateTransaction` is called (not after), so the accept-vs-reject race
 * above is closed even though `updateTransaction` can itself still fail
 * (e.g. Bug Hunter LOW-MEDIUM finding below: the category was deleted in
 * the narrow window between this function's own read and
 * `updateTransaction`'s fresh category lookup). Reversing the order
 * (`updateTransaction` first, claim second) would reopen the exact race
 * this fix closes — two concurrent Accepts/Rejects could both pass an
 * unclaimed `updateTransaction` call before either claimed anything. Taking
 * the claim first instead means a specific, *known* failure mode
 * (`updateTransaction` rejecting THIS exact category as "Category not
 * found") must be handled by explicitly walking the claim back — see the
 * "Category not found" branch below, which mirrors the already-null-at-read
 * branch above by marking the row `REJECTED` instead of leaving it
 * incorrectly `ACCEPTED`. Any OTHER `updateTransaction` failure (e.g. the
 * transaction itself was deleted concurrently) instead reverts the claim
 * back to `PENDING` — leaving the row `ACCEPTED` with no actual category
 * change applied would misrepresent the persisted state exactly like the
 * race this fix closes, and `PENDING` (rather than guessing `REJECTED`)
 * keeps a retry possible for a failure this function cannot itself
 * characterize as "the suggestion is invalid."
 */
export async function acceptCategorySuggestion(
  input: unknown,
): Promise<ApiResult<Transaction>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = SuggestionIdSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid suggestion id")
  }
  const { suggestionId } = parsed.data

  const suggestion = await db.categorySuggestion.findFirst({
    where: { id: suggestionId, userId: user.id },
  })
  if (!suggestion) {
    return fail("Suggestion not found")
  }
  if (suggestion.status !== "PENDING") {
    return fail("This suggestion has already been resolved")
  }

  if (!suggestion.suggestedCategoryId) {
    // Already invalidated as of this read (the category was deleted before
    // this request even started) — claim the REJECTED transition
    // atomically too, rather than an unconditional write: a concurrent
    // reject could be racing for this exact same outcome, and `count === 0`
    // here just means it won first (the row ends up `REJECTED` either way,
    // so there is no inconsistent-state risk on this branch — only the
    // caller's own message needs to stay accurate).
    const claimed = await db.categorySuggestion.updateMany({
      where: { id: suggestion.id, userId: user.id, status: "PENDING" },
      data: { status: "REJECTED", resolvedAt: new Date() },
    })
    if (claimed.count === 0) {
      return fail("This suggestion has already been resolved")
    }
    return fail("This suggested category no longer exists")
  }

  // The mutual-exclusion checkpoint (see this function's own doc comment
  // above) — exactly one concurrent Accept/Reject can ever win this claim.
  const claimed = await db.categorySuggestion.updateMany({
    where: { id: suggestion.id, userId: user.id, status: "PENDING" },
    data: { status: "ACCEPTED", resolvedAt: new Date() },
  })
  if (claimed.count === 0) {
    return fail("This suggestion has already been resolved")
  }

  const updateResult = await updateTransaction({
    id: suggestion.transactionId,
    categoryId: suggestion.suggestedCategoryId,
  })

  if (!updateResult.success) {
    // [Bug Hunter LOW-MEDIUM finding,
    // accept-suggestion-category-deleted-mid-flight-stuck-pending.md] This
    // `updateTransaction` call passes ONLY `categoryId` (never `accountId`),
    // so a "Category not found" failure here can only mean its own fresh
    // `assertOwnedCategory` lookup for THIS exact `suggestedCategoryId` came
    // up empty — i.e. the category was deleted in the window between this
    // function's read above and this call (the FK's `onDelete: SetNull`
    // already nulled the column in the DB; this function was still holding
    // the pre-delete id in `suggestion.suggestedCategoryId`). Treat this
    // exactly like the already-null-at-read-time branch above: invalidate
    // the suggestion and report the feature's own specific message, instead
    // of leaving the row stuck on whatever the claim above just set it to
    // and propagating `updateTransaction`'s generic error. This is a plain,
    // uncontested write (not another atomic claim) — this request already
    // owns the row exclusively, since it just won the ACCEPTED claim above
    // and no concurrent Accept/Reject can still be racing for a row that
    // has already left PENDING.
    if (updateResult.error === "Category not found") {
      await db.categorySuggestion.update({
        where: { id: suggestion.id },
        data: { status: "REJECTED", resolvedAt: new Date() },
      })
      return fail("This suggested category no longer exists")
    }

    // Any other failure (e.g. the transaction itself was deleted
    // concurrently, surfacing as "Transaction not found") means the
    // category-change side effect never actually took place, despite this
    // request having just won the ACCEPTED claim above — release the claim
    // back to PENDING (see this function's own doc comment on this
    // ordering judgment call) rather than leaving the row ACCEPTED with no
    // corresponding effect. Best-effort: if the row itself no longer exists
    // (e.g. cascade-deleted alongside its transaction), this simply matches
    // zero rows.
    await db.categorySuggestion.updateMany({
      where: { id: suggestion.id, userId: user.id, status: "ACCEPTED" },
      data: { status: "PENDING", resolvedAt: null },
    })
    return updateResult
  }

  return updateResult
}

/**
 * Rejects a pending suggestion (AC5): leaves the transaction Uncategorized
 * (or however it was categorized before) and dismisses this specific
 * suggestion — the same suggestion is not immediately re-offered
 * automatically for this transaction, since `generateAutomaticSuggestionsForUser`'s
 * own query only ever considers a transaction with no existing PENDING row.
 *
 * **Phase 4a review-gate fix (Bug Hunter HIGH finding, see
 * `acceptCategorySuggestion`'s doc comment above for the full defect and the
 * shared atomic-claim technique):** the actual `PENDING -> REJECTED`
 * transition is an atomic conditional `updateMany`, not a read-then-write —
 * a concurrent Accept racing this exact `suggestionId` can now never "win"
 * after this call has already claimed it.
 */
export async function rejectCategorySuggestion(
  input: unknown,
): Promise<ApiResult<{ suggestionId: string }>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = SuggestionIdSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid suggestion id")
  }
  const { suggestionId } = parsed.data

  // Fast-path existence/ownership check only — see
  // `acceptCategorySuggestion`'s doc comment on why this is never trusted
  // as the authority for the actual state transition below.
  const suggestion = await db.categorySuggestion.findFirst({
    where: { id: suggestionId, userId: user.id },
    select: { id: true },
  })
  if (!suggestion) {
    return fail("Suggestion not found")
  }

  const claimed = await db.categorySuggestion.updateMany({
    where: { id: suggestionId, userId: user.id, status: "PENDING" },
    data: { status: "REJECTED", resolvedAt: new Date() },
  })
  if (claimed.count === 0) {
    return fail("This suggestion has already been resolved")
  }

  return ok({ suggestionId })
}
