"use server"

import { Prisma } from "@prisma/client"

import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { ok, fail, type ApiResult } from "@/lib/api-response"
import {
  assertTransactionNotAlreadyLinked,
  TransactionAlreadyLinkedError,
} from "@/lib/transaction-link-guard"
import type { Bill, BillOccurrence } from "@/features/bills/types"
import {
  CreateBillSchema,
  UpdateBillSchema,
  BillIdSchema,
  MarkPaidSchema,
  LinkTransactionSchema,
  UnmarkPaidSchema,
  DeleteOccurrenceSchema,
} from "@/features/bills/server/validation"
import {
  regenerateFutureOccurrences,
  toBill,
  toBillOccurrence,
  OCCURRENCE_TRANSACTION_INCLUDE,
} from "@/features/bills/server/service"
import { computeNextDueDate, toUtcMidnight } from "@/features/bills/server/occurrence"

/**
 * Mutating Server Actions for the Bills module. Per
 * docs/architecture/api-contracts.md's Bills section and
 * docs/product/bills.md's acceptance criteria: create, update,
 * archive/unarchive, mark paid (manual + linked), link, and unmark.
 *
 * Every action below, per folder-tree.md's rule:
 *   1. Calls getCurrentUser() and fails closed with "UNAUTHENTICATED".
 *   2. Scopes every Prisma call by that user's id — an id supplied by the
 *      client (e.g. `input.id`, `input.occurrenceId`, `input.transactionId`)
 *      is never trusted on its own; every lookup filters by
 *      `{ id, userId: user.id }` so one user can never read or mutate
 *      another user's data (folder-tree.md's risk register item #4).
 *   3. Converts the Prisma row to a client-safe shape (`toBill`/
 *      `toBillOccurrence`) before returning it.
 *
 * `ensureOccurrencesGenerated` (server/service.ts) is intentionally never
 * called from here — it is a read-path concern only, per
 * api-contracts.md ("never call this from a Route Handler or Action
 * directly"). Every action here mutates a specific, already-existing
 * `Bill`/`BillOccurrence` row.
 */

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/**
 * Verifies a category exists and belongs to `userId` — prevents a user from
 * assigning a bill to another user's category by guessing/supplying its id.
 * Queries `db.category` directly rather than through
 * `features/categories/server`, matching the existing precedent in
 * `features/transactions/server/actions.ts`'s `assertOwnedCategory` and
 * `features/dashboard/server/service.ts` (both query the shared `Category`
 * table directly rather than importing another feature's `server/*`
 * modules — `Category` is Prisma-schema-owned shared data, not something
 * routed exclusively through the Categories feature's own service layer).
 */
async function assertOwnedCategory(userId: string, categoryId: string): Promise<boolean> {
  const category = await db.category.findFirst({
    where: { id: categoryId, userId },
    select: { id: true },
  })
  return category !== null
}

/**
 * Shared implementation behind both `markOccurrencePaid`'s linked branch and
 * `linkOccurrenceToTransaction` (api-contracts.md lists them as two entries;
 * both ultimately perform the exact same operation — see
 * `server/validation.ts`'s `MarkPaidSchema`/`LinkTransactionSchema` JSDoc for
 * why both exist), so the ownership/already-linked validation rules live in
 * exactly one place.
 *
 * Rejects (bills.md AC7/Edge Cases):
 *   - the occurrence doesn't exist or isn't owned by `userId`.
 *   - the transaction doesn't exist or isn't owned by `userId`.
 *   - the transaction is already linked to a *different* bill occurrence, a
 *     Recurring Income occurrence, or an Irregular Income event ("a
 *     Transaction can back at most one recurring-item occurrence across the
 *     whole product" — see `@/lib/transaction-link-guard.ts`, added Phase 3a
 *     per api-contracts.md's "(Phase 3a update to linkOccurrenceToTransaction)"
 *     note). Re-linking the same transaction to the same occurrence it's
 *     already linked to is a harmless no-op, allowed through rather than
 *     rejected.
 *
 * On success, clears the manual `paidAmount`/`paidDate` columns (per the
 * schema comment on `BillOccurrence.paidAmount`/`paidDate`: "simply
 * unused/null whenever transactionId is set") — the effective paid
 * amount/date are read live from the linked Transaction by `toBillOccurrence`
 * from here on.
 *
 * (Phase 3a) The guard check and the write now run inside one
 * `db.$transaction`, per docs/database/er-diagram.md's Phase 3a design note
 * #5 ("the narrow cross-domain race is closed at the application layer by
 * having lib/transaction-link-guard.ts's check-then-link run inside a single
 * Prisma $transaction") — this closes the window between "not already
 * linked" and the write that the previous (Phase 2) separate-statements
 * version left open. `BillOccurrence.transactionId`'s own `@unique`
 * constraint remains the backstop for the same-table case (two concurrent
 * requests linking the same transaction to two different bill occurrences);
 * the `catch` below still translates that raw P2002 into the same friendly
 * message, never surfacing a raw constraint-violation error to the caller.
 */
async function linkOccurrenceToTransactionInternal(
  userId: string,
  occurrenceId: string,
  transactionId: string,
): Promise<ApiResult<BillOccurrence>> {
  const occurrence = await db.billOccurrence.findFirst({
    where: { id: occurrenceId, userId },
  })
  if (!occurrence) {
    return fail("Bill occurrence not found")
  }

  const transaction = await db.transaction.findFirst({
    where: { id: transactionId, userId },
  })
  if (!transaction) {
    return fail("Transaction not found")
  }

  try {
    const updated = await db.$transaction(async (tx) => {
      await assertTransactionNotAlreadyLinked(tx, userId, transactionId, {
        excluding: { billOccurrenceId: occurrenceId },
      })

      return tx.billOccurrence.update({
        where: { id: occurrenceId },
        data: { transactionId, paidAmount: null, paidDate: null },
        include: OCCURRENCE_TRANSACTION_INCLUDE,
      })
    })
    return ok(toBillOccurrence(updated, new Date()))
  } catch (error) {
    if (error instanceof TransactionAlreadyLinkedError) {
      return fail(error.message)
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return fail(
        "This transaction is already linked to a different bill occurrence",
      )
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Bill CRUD
// ---------------------------------------------------------------------------

/**
 * Creates a new bill for the current user (bills.md AC1). No duplicate-name
 * check — the spec's edge cases explicitly allow two bills with the same
 * name, same rationale as duplicate account names in Accounts.
 *
 * Occurrence generation for this bill is intentionally NOT triggered here —
 * `ensureOccurrencesGenerated` runs lazily on the next read (AC2: "generates
 * its next occurrence automatically"; the *first* read of this bill, e.g.
 * the list page re-rendering right after creation, is what actually
 * materializes it), per api-contracts.md's lazy-generation design.
 */
export async function createBill(input: unknown): Promise<ApiResult<Bill>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = CreateBillSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid bill data")
  }
  const { name, expectedAmount, dueDate, schedule, categoryId } = parsed.data

  if (categoryId) {
    const owned = await assertOwnedCategory(user.id, categoryId)
    if (!owned) {
      return fail("Category not found")
    }
  }

  const bill = await db.bill.create({
    data: {
      userId: user.id,
      name,
      expectedAmount,
      dueDate,
      schedule,
      categoryId: categoryId ?? null,
    },
  })

  return ok(toBill(bill))
}

/**
 * Updates one or more fields on an existing bill (bills.md AC4). Only fields
 * actually present in the parsed input are written — same "undefined fields
 * excluded from `data`" convention as
 * `features/accounts/server/actions.ts`'s `updateAccount`.
 *
 * Per AC4, changing `expectedAmount`/`schedule` here never retroactively
 * changes an already-generated `BillOccurrence` row — this action only ever
 * touches the `Bill` row itself; `server/service.ts`'s lazy generator is what
 * makes the "future occurrences only" guarantee hold, by always reading the
 * *current* `Bill.expectedAmount`/`schedule` at generation time.
 */
export async function updateBill(input: unknown): Promise<ApiResult<Bill>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = UpdateBillSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid bill data")
  }
  const { id, name, expectedAmount, dueDate, schedule, categoryId } = parsed.data

  const existing = await db.bill.findFirst({ where: { id, userId: user.id } })
  if (!existing) {
    return fail("Bill not found")
  }

  if (categoryId) {
    const owned = await assertOwnedCategory(user.id, categoryId)
    if (!owned) {
      return fail("Category not found")
    }
  }

  // Changing when a bill is due has to move the occurrences, not just the
  // anchor row. `ensureOccurrencesGenerated` continues from the latest
  // occurrence already on file, so without this an edited due date changes
  // nothing the user can see — the list, calendar, and "next due" all read
  // occurrences. Paid and already-due occurrences are preserved; see
  // `regenerateFutureOccurrences`.
  //
  // The anchor write and the occurrence re-anchoring run inside one
  // `db.$transaction` — previously these were two separate top-level `db`
  // calls, so anything that interrupted the request between them (a dropped
  // connection, a serverless timeout) could leave `Bill.dueDate` updated
  // with every existing `BillOccurrence` row silently still on the old
  // date/cadence: indistinguishable, from the UI, from the edit having no
  // effect at all.
  const updated = await db.$transaction(async (tx) => {
    const bill = await tx.bill.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(expectedAmount !== undefined ? { expectedAmount } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(schedule !== undefined ? { schedule } : {}),
        ...(categoryId !== undefined ? { categoryId } : {}),
      },
    })

    const scheduleChanged = schedule !== undefined && schedule !== existing.schedule
    const dueDateChanged =
      dueDate !== undefined && dueDate.getTime() !== existing.dueDate.getTime()

    if (scheduleChanged || dueDateChanged) {
      await regenerateFutureOccurrences(tx, bill)
    }

    return bill
  })

  return ok(toBill(updated))
}

/**
 * Archives (soft-deletes) a bill — bills.md AC5. Stops future occurrence
 * generation (`ensureOccurrencesGenerated`'s archived no-op) without
 * deleting payment history; existing `BillOccurrence` rows are untouched.
 *
 * Idempotent by design — same rationale as
 * `features/accounts/server/actions.ts`'s `archiveAccount`.
 */
export async function archiveBill(input: unknown): Promise<ApiResult<Bill>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = BillIdSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid bill id")
  }
  const { id } = parsed.data

  const existing = await db.bill.findFirst({ where: { id, userId: user.id } })
  if (!existing) {
    return fail("Bill not found")
  }

  if (existing.archivedAt) {
    return ok(toBill(existing))
  }

  const archived = await db.bill.update({
    where: { id },
    data: { archivedAt: new Date() },
  })

  return ok(toBill(archived))
}

/**
 * Restores an archived bill — bills.md AC5. Resumes generating occurrences
 * "from that point forward," explicitly WITHOUT backfilling the gap that
 * accumulated while archived (the "long-dormant bill" Late-backfill behavior
 * only applies to a never-archived bill; an *archived* gap is deliberately
 * never materialized, so no Late occurrences ever appear for the archived
 * period).
 *
 * This gap-skip cannot live in `server/service.ts`'s general-purpose
 * `ensureOccurrencesGenerated` (which always anchors from the latest
 * *existing* occurrence and would otherwise backfill exactly like the
 * dormant-bill case) — it is instead handled here, once, at the moment of
 * reactivation: advance the schedule cadence from the latest existing
 * occurrence (without creating rows for the skipped dates) until it lands
 * on/after today, then materialize exactly that one "resume" occurrence.
 * Every subsequent lazy read chains forward from this new latest occurrence
 * exactly as it would for any other bill.
 *
 * If the bill has no occurrences yet, or its latest occurrence is already
 * on/after today (e.g. archived and reactivated the same day, before any
 * occurrence became due), there is no gap to skip — ordinary lazy generation
 * on the next read handles it identically to a never-archived bill.
 *
 * Idempotent for the same reason as `archiveBill`/`unarchiveAccount`.
 */
export async function unarchiveBill(input: unknown): Promise<ApiResult<Bill>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = BillIdSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid bill id")
  }
  const { id } = parsed.data

  const existing = await db.bill.findFirst({ where: { id, userId: user.id } })
  if (!existing) {
    return fail("Bill not found")
  }

  if (!existing.archivedAt) {
    return ok(toBill(existing))
  }

  const today = toUtcMidnight(new Date())

  const unarchived = await db.$transaction(async (tx) => {
    const bill = await tx.bill.update({
      where: { id },
      data: { archivedAt: null },
    })

    const latestOccurrence = await tx.billOccurrence.findFirst({
      where: { billId: id },
      orderBy: { dueDate: "desc" },
      select: { dueDate: true },
    })

    if (latestOccurrence && latestOccurrence.dueDate.getTime() < today.getTime()) {
      let cursor = latestOccurrence.dueDate
      while (cursor.getTime() < today.getTime()) {
        cursor = computeNextDueDate(cursor, bill.schedule)
      }
      await tx.billOccurrence.upsert({
        where: { billId_dueDate: { billId: id, dueDate: cursor } },
        create: { billId: id, userId: user.id, dueDate: cursor },
        update: {},
      })
    }

    return bill
  })

  return ok(toBill(unarchived))
}

// ---------------------------------------------------------------------------
// Occurrence paid-tracking (bills.md AC7/AC8)
// ---------------------------------------------------------------------------

/**
 * Marks a bill occurrence as paid, via either of AC7's two paths — a manual
 * amount+date entry, or linking to an existing Transaction — determined by
 * which branch of `MarkPaidSchema`'s discriminated union the input matches.
 * The linked branch delegates to `linkOccurrenceToTransactionInternal` (see
 * its JSDoc); the manual branch is handled directly below.
 *
 * Marking one occurrence paid never affects any other occurrence's status
 * (AC7's last sentence) — this only ever touches the single row identified
 * by `occurrenceId`.
 */
export async function markOccurrencePaid(
  input: unknown,
): Promise<ApiResult<BillOccurrence>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = MarkPaidSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid mark-paid data")
  }
  const data = parsed.data

  if ("transactionId" in data) {
    return linkOccurrenceToTransactionInternal(user.id, data.occurrenceId, data.transactionId)
  }

  const occurrence = await db.billOccurrence.findFirst({
    where: { id: data.occurrenceId, userId: user.id },
  })
  if (!occurrence) {
    return fail("Bill occurrence not found")
  }

  // Allowed even when `date` is after `dueDate` (bills.md Edge Cases:
  // "paid late" is recorded as such, not blocked or silently reclassified as
  // on-time) — `toBillOccurrence`'s `wasPaidLate` is what surfaces this
  // distinction to callers, computed automatically from the values written
  // here. Clears any prior link (`transactionId: null`) so switching from
  // "linked" to "manual" for the same occurrence leaves it in a single,
  // unambiguous state per AC7's "one of two ways."
  const updated = await db.billOccurrence.update({
    where: { id: data.occurrenceId },
    data: { paidAmount: data.amount, paidDate: data.date, transactionId: null },
    include: OCCURRENCE_TRANSACTION_INCLUDE,
  })

  return ok(toBillOccurrence(updated, new Date()))
}

/**
 * Links a bill occurrence to an existing Transaction — the dedicated
 * Server Action matching api-contracts.md's Bills "Mark occurrence paid
 * (linked)" row. Shares its entire implementation with
 * `markOccurrencePaid`'s linked branch via `linkOccurrenceToTransactionInternal`
 * (see that function's JSDoc) so the ownership/already-linked validation
 * rules are never duplicated between the two entry points.
 */
export async function linkOccurrenceToTransaction(
  input: unknown,
): Promise<ApiResult<BillOccurrence>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = LinkTransactionSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid link data")
  }

  return linkOccurrenceToTransactionInternal(
    user.id,
    parsed.data.occurrenceId,
    parsed.data.transactionId,
  )
}

/**
 * Un-marks a previously-paid occurrence (bills.md AC8) — clears both the
 * manual `paidAmount`/`paidDate` fields and any Transaction link
 * (`transactionId`), unconditionally reverting it to its computed
 * Upcoming/Due Today/Late status. The underlying Transaction itself (if any
 * was linked) is left completely untouched — only the link is removed.
 *
 * Not conditioned on the occurrence currently being paid: calling this on an
 * already-unpaid occurrence is a harmless no-op that still returns success,
 * consistent with this module's other idempotent actions.
 */
export async function unmarkOccurrencePaid(
  input: unknown,
): Promise<ApiResult<BillOccurrence>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = UnmarkPaidSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid occurrence id")
  }

  const occurrence = await db.billOccurrence.findFirst({
    where: { id: parsed.data.occurrenceId, userId: user.id },
  })
  if (!occurrence) {
    return fail("Bill occurrence not found")
  }

  const updated = await db.billOccurrence.update({
    where: { id: parsed.data.occurrenceId },
    data: { paidAmount: null, paidDate: null, transactionId: null },
    include: OCCURRENCE_TRANSACTION_INCLUDE,
  })

  return ok(toBillOccurrence(updated, new Date()))
}

/**
 * Permanently deletes a single `BillOccurrence` row — unlike
 * `unmarkOccurrencePaid`, which only clears its paid fields and leaves the
 * row in place, this removes it outright. Needed because occurrences
 * generated under a schedule that later turns out to be wrong (e.g. a bill
 * mistakenly left on Biweekly for a few cycles before being corrected to
 * Monthly) otherwise sit in the payment history forever — `updateBill`'s
 * `regenerateFutureOccurrences` only ever touches unpaid, not-yet-due
 * occurrences (bills.md's payment-history-is-never-rewritten rule), so a
 * stale *paid* occurrence from the old schedule has no other way to go away.
 *
 * If the occurrence being deleted is linked to a Transaction (AC7's linked
 * paid path), that Transaction is deleted too, not just unlinked — a linked
 * Transaction only exists to represent this occurrence's payment, so
 * removing the occurrence without also removing the transaction it recorded
 * would leave an orphaned withdrawal behind (a duplicate, since the real bill
 * this occurrence never should have existed for was never actually paid
 * twice). Both deletes run inside one `db.$transaction` so a failure partway
 * through can't leave the transaction deleted but the occurrence still
 * present, or vice versa.
 */
export async function deleteOccurrence(
  input: unknown,
): Promise<ApiResult<{ id: string }>> {
  const user = await getCurrentUser()
  if (!user) return fail("UNAUTHENTICATED")

  const parsed = DeleteOccurrenceSchema.safeParse(input)
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid occurrence id")
  }

  const occurrence = await db.billOccurrence.findFirst({
    where: { id: parsed.data.occurrenceId, userId: user.id },
  })
  if (!occurrence) {
    return fail("Bill occurrence not found")
  }

  await db.$transaction(async (tx) => {
    await tx.billOccurrence.delete({ where: { id: occurrence.id } })
    if (occurrence.transactionId) {
      await tx.transaction.deleteMany({
        where: { id: occurrence.transactionId, userId: user.id },
      })
    }
  })

  return ok({ id: occurrence.id })
}
