import type {
  Bill as PrismaBill,
  BillOccurrence as PrismaBillOccurrence,
  Prisma,
} from "@prisma/client"

import { db } from "@/lib/db"

import type {
  Bill,
  BillOccurrence,
  BillWithNextOccurrence,
  CalendarDay,
  CalendarOccurrence,
  GetBillsOptions,
  UpcomingOccurrence,
} from "../types"
import { MonthSchema } from "./validation"
import {
  addUtcMonths,
  computeNextDueDate,
  computeOccurrenceDatesFrom,
  computeOccurrenceStatus,
  toUtcMidnight,
} from "./occurrence"

// This module is imported directly by Server Components (per
// docs/architecture/api-contracts.md's Bills/Calendar v1 sections) and by
// `server/actions.ts`. It must never be imported from a Client Component —
// every exported function takes a pre-resolved `userId` from
// `getCurrentUser()` (see lib/auth.ts), never a client-supplied value, per
// folder-tree.md's note on scoping every query by the caller's id.

// ---------------------------------------------------------------------------
// Bounded lazy-generation horizon
// ---------------------------------------------------------------------------

// How far into the future `ensureOccurrencesGenerated` will materialize
// `BillOccurrence` rows on an ordinary read (bill list, upcoming list, bill
// detail). Per docs/database/performance-considerations.md's Phase 2
// guidance: "generation must be bounded, not unbounded-lookback ... only
// generate occurrences up to a fixed forward horizon (e.g. next N months) on
// each read, not attempt to backfill or generate arbitrarily far into the
// future in one request." Three months comfortably covers even the sparsest
// supported schedule (QUARTERLY still gets at least one future occurrence
// materialized) while keeping the per-read row count small for the densest
// schedule (WEEKLY: ~13 rows/quarter/bill).
const DEFAULT_HORIZON_MONTHS = 3

/**
 * Converts a Prisma `Bill` row (whose `expectedAmount` is a decimal.js
 * `Decimal` instance) into the plain-number `Bill` shape safe to pass across
 * the Server Component / Client Component boundary — mirrors
 * `features/accounts/server/service.ts`'s `toAccount`.
 */
export function toBill(row: PrismaBill): Bill {
  return {
    ...row,
    expectedAmount: row.expectedAmount.toNumber(),
  }
}

type OccurrenceWithTransaction = PrismaBillOccurrence & {
  transaction: { amount: Prisma.Decimal; date: Date } | null
}

/**
 * Converts a Prisma `BillOccurrence` row (joined with its linked
 * Transaction, if any) into the client-safe `BillOccurrence` shape,
 * resolving the "effective" paid amount/date live from the linked
 * Transaction per bills.md AC7 (see the JSDoc on `../types.ts`'s
 * `BillOccurrence`) rather than ever trusting the row's own `paidAmount`/
 * `paidDate` columns when `transactionId` is set.
 */
function toBillOccurrence(row: OccurrenceWithTransaction, today: Date): BillOccurrence {
  const manualPaidAmount = row.paidAmount?.toNumber() ?? null
  const manualPaidDate = row.paidDate ?? null

  const effectivePaidAmount = row.transaction
    ? row.transaction.amount.toNumber()
    : manualPaidAmount
  const effectivePaidDate = row.transaction ? row.transaction.date : manualPaidDate

  const status = computeOccurrenceStatus(
    {
      dueDate: row.dueDate,
      paidAmount: manualPaidAmount,
      paidDate: manualPaidDate,
      transactionId: row.transactionId,
    },
    today,
  )

  const wasPaidLate =
    status === "PAID" && effectivePaidDate !== null
      ? toUtcMidnight(effectivePaidDate).getTime() > toUtcMidnight(row.dueDate).getTime()
      : null

  return {
    id: row.id,
    billId: row.billId,
    userId: row.userId,
    dueDate: row.dueDate,
    transactionId: row.transactionId,
    paidAmount: effectivePaidAmount,
    paidDate: effectivePaidDate,
    status,
    wasPaidLate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const OCCURRENCE_TRANSACTION_INCLUDE = {
  transaction: { select: { amount: true, date: true } },
} satisfies Prisma.BillOccurrenceInclude

// ---------------------------------------------------------------------------
// Lazy occurrence generation (internal — never call from a Route Handler or
// Server Action directly; see api-contracts.md's Bills section)
// ---------------------------------------------------------------------------

type BillGenerationSource = Pick<
  PrismaBill,
  "id" | "userId" | "dueDate" | "schedule" | "archivedAt"
>

/**
 * Generates any missing `BillOccurrence` rows for `bill`, from its latest
 * already-generated occurrence (or its own `dueDate` if none exist yet) up
 * to a bounded forward horizon, then persists them via
 * `createMany({ skipDuplicates: true })`.
 *
 * Idempotency: `@@unique([billId, dueDate])` (prisma/schema.prisma) is what
 * makes `skipDuplicates` safe to rely on instead of an existence check before
 * every insert — two concurrent reads racing to generate the same occurrence
 * both succeed, at most one row is ever created for a given (billId,
 * dueDate) pair, per the schema comment on that constraint.
 *
 * Deliberately takes the already-fetched `bill` row (not just a `billId`)
 * rather than re-querying `Bill` internally — every caller below already has
 * the row in hand from its own list/detail query, and api-contracts.md's own
 * description of this mechanism ("ensureOccurrencesGenerated(bill,
 * throughDate)") is framed the same way; re-fetching would be a redundant
 * round-trip for no benefit.
 *
 * `minThroughDate`, when supplied, extends the horizon to at least that date
 * (used by `getCalendarMonth` so a user paging several months ahead still
 * sees materialized occurrences for that specific month) — this remains
 * bounded (a single requested month, not an open-ended range) per the
 * performance guidance cited above, it just isn't hardcoded to always equal
 * `DEFAULT_HORIZON_MONTHS`.
 *
 * Archived bills (bills.md AC5) are a deliberate no-op here — they generate
 * no further occurrences while archived. Resuming generation on reactivation
 * "from that point forward" (without backfilling the archived gap) is handled
 * by `server/actions.ts`'s `unarchiveBill`, not here — see that function's
 * JSDoc for why that specific behavior can't live in this general-purpose,
 * always-anchor-from-the-latest-occurrence generator.
 */
async function ensureOccurrencesGenerated(
  bill: BillGenerationSource,
  minThroughDate?: Date,
): Promise<void> {
  if (bill.archivedAt) {
    return
  }

  const defaultHorizon = addUtcMonths(toUtcMidnight(new Date()), DEFAULT_HORIZON_MONTHS)
  const horizon =
    minThroughDate && minThroughDate.getTime() > defaultHorizon.getTime()
      ? minThroughDate
      : defaultHorizon

  const latestOccurrence = await db.billOccurrence.findFirst({
    where: { billId: bill.id },
    orderBy: { dueDate: "desc" },
    select: { dueDate: true },
  })

  const toCreate: { billId: string; userId: string; dueDate: Date }[] = []

  if (!latestOccurrence) {
    // First-ever generation for this bill: its own `dueDate` (bills.md AC1's
    // "first occurrence") must itself be materialized, not just dates after it.
    if (bill.dueDate.getTime() <= horizon.getTime()) {
      toCreate.push({ billId: bill.id, userId: bill.userId, dueDate: bill.dueDate })
    }
  }

  let cursor = latestOccurrence?.dueDate ?? bill.dueDate
  while (true) {
    const next = computeNextDueDate(cursor, bill.schedule)
    if (next.getTime() > horizon.getTime()) {
      break
    }
    toCreate.push({ billId: bill.id, userId: bill.userId, dueDate: next })
    cursor = next
  }

  if (toCreate.length > 0) {
    await db.billOccurrence.createMany({ data: toCreate, skipDuplicates: true })
  }
}

/**
 * Re-anchors a bill's *future* occurrences after its `dueDate` or `schedule`
 * changes.
 *
 * Why this is needed: `ensureOccurrencesGenerated` always continues from the
 * latest occurrence already on file. Once any occurrence exists, an edited
 * `Bill.dueDate` therefore has no effect whatsoever — the cursor comes from a
 * row generated under the old date, so every future occurrence keeps landing
 * on the old day. Editing a bill to "the 10th" would update the `Bill` row and
 * change nothing a user can actually see, since the list, the calendar, and
 * "next due" all read occurrences rather than the anchor.
 *
 * What it deliberately does NOT touch:
 *   - **Anything paid**, by either of bills.md AC7's paths (a linked
 *     Transaction, or a manual amount+date). Payment history is a record of
 *     what happened and is never rewritten by a schedule change.
 *   - **Anything already due**, i.e. dated before today. A missed or pending
 *     bill from last week does not retroactively move because next month's
 *     due date changed.
 *
 * Everything from today forward that is still unpaid is replaced by the
 * sequence the new anchor implies. `skipDuplicates` plus
 * `@@unique([billId, dueDate])` keeps this safe against a concurrent
 * generation racing it.
 */
export async function regenerateFutureOccurrences(
  bill: BillGenerationSource,
): Promise<void> {
  if (bill.archivedAt) {
    return
  }

  const today = toUtcMidnight(new Date())
  const horizon = addUtcMonths(today, DEFAULT_HORIZON_MONTHS)

  await db.billOccurrence.deleteMany({
    where: {
      billId: bill.id,
      dueDate: { gte: today },
      // Unpaid on both of AC7's paths — see this function's JSDoc.
      transactionId: null,
      paidAmount: null,
      paidDate: null,
    },
  })

  const dates = computeOccurrenceDatesFrom(bill.dueDate, bill.schedule, today, horizon)
  if (dates.length === 0) {
    return
  }

  await db.billOccurrence.createMany({
    data: dates.map((dueDate) => ({ billId: bill.id, userId: bill.userId, dueDate })),
    skipDuplicates: true,
  })
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Lists the caller's bills, per bills.md AC3. Defaults to the active
 * (non-archived) list; pass `{ includeArchived: true }` for the archived
 * view — same toggle semantics as `features/accounts/server/service.ts`'s
 * `getAccounts`.
 *
 * Each bill's `nextOccurrence` is its earliest *unpaid* occurrence (never
 * `"PAID"` by construction), resolved with a single `findMany` across every
 * listed bill's occurrences (ordered by `dueDate` ascending, first hit per
 * `billId` kept) rather than one query per bill — avoids an N+1 query
 * pattern for a user with many bills.
 */
export async function getBills(
  userId: string,
  options: GetBillsOptions = {},
): Promise<BillWithNextOccurrence[]> {
  const { includeArchived = false } = options

  const bills = await db.bill.findMany({
    where: { userId, archivedAt: includeArchived ? { not: null } : null },
    orderBy: { createdAt: "asc" },
  })

  await Promise.all(bills.map((bill) => ensureOccurrencesGenerated(bill)))

  const billIds = bills.map((bill) => bill.id)
  const unpaidOccurrences = billIds.length
    ? await db.billOccurrence.findMany({
        where: { billId: { in: billIds }, transactionId: null, paidAmount: null },
        orderBy: { dueDate: "asc" },
      })
    : []

  const nextOccurrenceByBillId = new Map<
    string,
    { id: string; dueDate: Date }
  >()
  for (const occurrence of unpaidOccurrences) {
    if (!nextOccurrenceByBillId.has(occurrence.billId)) {
      nextOccurrenceByBillId.set(occurrence.billId, {
        id: occurrence.id,
        dueDate: occurrence.dueDate,
      })
    }
  }

  const today = toUtcMidnight(new Date())

  return bills.map((bill) => {
    const next = nextOccurrenceByBillId.get(bill.id)
    return {
      ...toBill(bill),
      nextOccurrence: next
        ? {
            id: next.id,
            dueDate: next.dueDate,
            // Unpaid by construction (filtered above), so this is always
            // Upcoming/DueToday/Late, never Paid.
            status: computeOccurrenceStatus(
              { dueDate: next.dueDate, paidAmount: null, paidDate: null, transactionId: null },
              today,
            ),
          }
        : null,
    }
  })
}

/**
 * True if the caller has EVER created a Bill row at all — active OR
 * archived, since a bill is never physically removed on archive (bills.md
 * AC5), only flagged via `archivedAt`. Backs Calendar v2's combined
 * empty-state check (calendar-v2.md's Edge Case: "the user has genuinely
 * never set up any bill or income stream anywhere in the app") — see
 * `app/(dashboard)/calendar/page.tsx`'s own JSDoc for why this replaced two
 * full `getBills` list reads there (Phase 4c performance follow-up,
 * phase-4c-performance-review.md Finding 2: that page previously called
 * `getBills` twice — active and archived — purely to compute this one
 * boolean, quadrupling an already-N+1-shaped read on every calendar page
 * load).
 *
 * Deliberately a single indexed `findFirst` existence probe (`Bill.userId`
 * is indexed, `@@index([userId])`) that never calls
 * `ensureOccurrencesGenerated` at all — this only needs to know "does at
 * least one row exist," never each bill's next-occurrence detail the
 * ordinary list views (`getBills`) compute.
 */
export async function hasAnyBills(userId: string): Promise<boolean> {
  const bill = await db.bill.findFirst({ where: { userId }, select: { id: true } })
  return bill !== null
}

/**
 * Fetches a single bill by id, scoped to the calling user, with its full
 * occurrence history (bills.md AC10) — most recent due date first, matching
 * `features/transactions/server`'s default "most recent first" list
 * convention. Returns `null` for a missing id *or* an id owned by a
 * different user, same "don't leak existence" rule as
 * `features/accounts/server/service.ts`'s `getAccountById`.
 */
export async function getBillById(
  userId: string,
  id: string,
): Promise<(Bill & { occurrences: BillOccurrence[] }) | null> {
  const bill = await db.bill.findFirst({ where: { id, userId } })
  if (!bill) {
    return null
  }

  await ensureOccurrencesGenerated(bill)

  const occurrenceRows = await db.billOccurrence.findMany({
    where: { billId: bill.id },
    orderBy: { dueDate: "desc" },
    include: OCCURRENCE_TRANSACTION_INCLUDE,
  })

  const today = toUtcMidnight(new Date())

  return {
    ...toBill(bill),
    occurrences: occurrenceRows.map((row) => toBillOccurrence(row, today)),
  }
}

/**
 * Every active bill's next unpaid occurrence, sorted by due date ascending —
 * bills.md AC9's upcoming list, matching
 * docs/architecture/api-contracts.md's exact output shape.
 *
 * Archived bills are excluded entirely (not just "stopped generating new
 * occurrences") — an archived bill has nothing upcoming to show by
 * definition (bills.md AC5).
 */
export async function getUpcomingOccurrences(
  userId: string,
): Promise<UpcomingOccurrence[]> {
  const bills = await db.bill.findMany({
    where: { userId, archivedAt: null },
  })

  await Promise.all(bills.map((bill) => ensureOccurrencesGenerated(bill)))

  const billIds = bills.map((bill) => bill.id)
  const unpaidOccurrences = billIds.length
    ? await db.billOccurrence.findMany({
        where: { billId: { in: billIds }, transactionId: null, paidAmount: null },
        orderBy: { dueDate: "asc" },
      })
    : []

  const nextOccurrenceByBillId = new Map<string, PrismaBillOccurrence>()
  for (const occurrence of unpaidOccurrences) {
    if (!nextOccurrenceByBillId.has(occurrence.billId)) {
      nextOccurrenceByBillId.set(occurrence.billId, occurrence)
    }
  }

  const today = toUtcMidnight(new Date())
  const billById = new Map(bills.map((bill) => [bill.id, bill]))

  const upcoming: UpcomingOccurrence[] = []
  for (const [billId, occurrence] of nextOccurrenceByBillId) {
    const bill = billById.get(billId)
    if (!bill) {
      continue
    }
    upcoming.push({
      billId,
      billName: bill.name,
      occurrenceId: occurrence.id,
      dueDate: occurrence.dueDate,
      expectedAmount: bill.expectedAmount.toNumber(),
      status: computeOccurrenceStatus(
        {
          dueDate: occurrence.dueDate,
          paidAmount: null,
          paidDate: null,
          transactionId: null,
        },
        today,
      ),
    })
  }

  return upcoming.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
}

// ---------------------------------------------------------------------------
// Calendar v1 (docs/architecture/api-contracts.md's Calendar v1 section) —
// a pure read view over Bills, no new data/mutations of its own.
// ---------------------------------------------------------------------------

/** Builds the `[start, end]` UTC-midnight bounds for a `"YYYY-MM"` month
 * string — `start` is the 1st, `end` is the last calendar day of that month,
 * mirroring `features/dashboard/server/service.ts`'s `utcMonthStart`
 * convention (UTC-only, never the host process's local timezone). */
function resolveMonthBounds(month: string): { start: Date; end: Date; daysInMonth: number } {
  const [yearStr, monthStr] = month.split("-")
  const year = Number(yearStr)
  const monthIndex = Number(monthStr) - 1

  const start = new Date(Date.UTC(year, monthIndex, 1))
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const end = new Date(Date.UTC(year, monthIndex, daysInMonth))

  return { start, end, daysInMonth }
}

/** `"YYYY-MM-DD"` key for a UTC date — used to bucket occurrences by day and
 * to key each `CalendarDay.day`. */
function formatDateOnlyKey(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/**
 * All occurrences due within `month` (`"YYYY-MM"`), grouped by day — backs
 * Calendar v1 (docs/product/calendar-and-notifications.md), which has no
 * data model of its own (see folder-tree.md's rationale for why this lives
 * in `features/bills/` rather than a separate `features/calendar/` module).
 *
 * Returns one entry for every calendar day in the month, in order, even days
 * with zero occurrences (`occurrences: []`), so the calendar grid UI can
 * render every cell directly from this array without separately computing
 * "how many days are in this month."
 *
 * Scoped to active bills only for generation purposes (an archived bill's
 * *already-generated* past occurrences still show on the calendar if they
 * fall in the requested month — only *new* generation is skipped for
 * archived bills, per `ensureOccurrencesGenerated`'s own archived no-op) —
 * the final occurrence query below is not restricted to active bills, only
 * the generation step is.
 */
export async function getCalendarMonth(
  userId: string,
  month: string,
): Promise<CalendarDay[]> {
  const parsedMonth = MonthSchema.parse(month)
  const { start, end, daysInMonth } = resolveMonthBounds(parsedMonth)

  const activeBills = await db.bill.findMany({
    where: { userId, archivedAt: null },
  })
  await Promise.all(
    activeBills.map((bill) => ensureOccurrencesGenerated(bill, end)),
  )

  const occurrences = await db.billOccurrence.findMany({
    where: { userId, dueDate: { gte: start, lte: end } },
    orderBy: { dueDate: "asc" },
    include: { bill: { select: { id: true, name: true, expectedAmount: true } } },
  })

  const today = toUtcMidnight(new Date())
  const occurrencesByDay = new Map<string, CalendarOccurrence[]>()

  for (const occurrence of occurrences) {
    const dayKey = formatDateOnlyKey(occurrence.dueDate)
    const status = computeOccurrenceStatus(
      {
        dueDate: occurrence.dueDate,
        paidAmount: occurrence.paidAmount?.toNumber() ?? null,
        paidDate: occurrence.paidDate,
        transactionId: occurrence.transactionId,
      },
      today,
    )

    const entry: CalendarOccurrence = {
      billId: occurrence.billId,
      billOccurrenceId: occurrence.id,
      billName: occurrence.bill.name,
      amount: occurrence.bill.expectedAmount.toNumber(),
      status,
    }

    const existing = occurrencesByDay.get(dayKey)
    if (existing) {
      existing.push(entry)
    } else {
      occurrencesByDay.set(dayKey, [entry])
    }
  }

  const days: CalendarDay[] = []
  const [yearStr, monthStr] = parsedMonth.split("-")
  const year = Number(yearStr)
  const monthIndex = Number(monthStr) - 1

  for (let day = 1; day <= daysInMonth; day++) {
    const dayKey = formatDateOnlyKey(new Date(Date.UTC(year, monthIndex, day)))
    days.push({ day: dayKey, occurrences: occurrencesByDay.get(dayKey) ?? [] })
  }

  return days
}

// Exported so `server/actions.ts` can build the same client-safe
// `BillOccurrence` shape (with the transaction-joined "effective paid
// amount/date" resolution) after a mutation, without duplicating this
// conversion logic. `ensureOccurrencesGenerated` itself is deliberately NOT
// exported — per api-contracts.md's Bills section, it is purely a read-path
// concern invoked at the top of this file's own read functions; Server
// Actions mutate specific rows directly and never need to trigger generation.
export { OCCURRENCE_TRANSACTION_INCLUDE, toBillOccurrence }
