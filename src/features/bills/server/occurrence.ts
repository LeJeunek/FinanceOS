import type { BillSchedule } from "@prisma/client"

import { addUtcDays, addUtcMonths, computeNextRecurrenceDate, toUtcMidnight } from "@/lib/recurrence"

import type { OccurrenceStatus } from "../types"

/**
 * PURE status math for the Bills module — no Prisma calls, no
 * `getCurrentUser()`, no I/O of any kind. Per docs/architecture/folder-tree.md's
 * Phase 2 section, this split exists specifically so the recurrence-generation
 * and status-computation logic (the two easiest things to get subtly wrong in
 * this feature, per date-math and boundary-condition bugs) is unit-testable
 * in isolation, without a database, by the Integration Test Engineer's
 * recurrence-correctness test matrix (docs/product/bills.md's Definition of
 * Done).
 *
 * (Phase 3a) The date-cadence math this file used to own directly
 * (`toUtcMidnight`/`addUtcDays`/`addUtcMonths`/next-due-date generation) is
 * now imported from `@/lib/recurrence.ts`, shared with Recurring Income's own
 * `features/recurring-income/server/occurrence.ts`, per
 * docs/architecture/api-contracts.md's Bills section ("its date-cadence math
 * ... is extracted to lib/recurrence.ts ... computeStatus (Bills-specific
 * wording, incl. 'Late') stays in bills/server/occurrence.ts unchanged").
 * This file re-exports those three date helpers under their original names
 * so every existing external caller (`server/service.ts`, `server/
 * actions.ts`) is unaffected by the extraction — a pure refactor, not a
 * behavior change. `computeNextDueDate` keeps its Bills-specific name/
 * signature as a thin wrapper around the shared `computeNextRecurrenceDate`.
 * `computeOccurrenceStatus`/`isOccurrencePaid` (Bills' own status vocabulary)
 * are unchanged below.
 *
 * `server/service.ts` is the only caller — it supplies real `Date`s read from
 * (or about to be written to) Postgres and interprets the results; this file
 * never touches the database itself.
 */

// Re-exported so existing imports of `toUtcMidnight`/`addUtcDays`/
// `addUtcMonths` from "./occurrence" keep working unchanged after the Phase
// 3a extraction to `@/lib/recurrence.ts`.
export { toUtcMidnight, addUtcDays, addUtcMonths }

// ---------------------------------------------------------------------------
// Next-due-date generation
// ---------------------------------------------------------------------------

/**
 * Computes the next occurrence's due date given the current one and the
 * bill's recurring schedule, per docs/product/bills.md AC1/AC2's five
 * supported schedules. Thin, Bills-named wrapper around
 * `@/lib/recurrence.ts`'s shared `computeNextRecurrenceDate` — `BillSchedule`
 * (a Prisma-generated 5-member string-literal union) is structurally
 * identical to that shared function's `RecurrenceSchedule` parameter type, so
 * no mapping/translation step is needed here beyond the pass-through itself.
 */
export function computeNextDueDate(
  currentDueDate: Date,
  schedule: BillSchedule,
): Date {
  return computeNextRecurrenceDate(currentDueDate, schedule)
}

// ---------------------------------------------------------------------------
// Status computation
// ---------------------------------------------------------------------------

/** The minimal fields `computeOccurrenceStatus` needs — a structural subset
 * of `BillOccurrence`'s raw (pre-effective-value) Prisma columns, so callers
 * don't need to construct a full occurrence object just to check status. */
export interface OccurrencePaidState {
  dueDate: Date
  /** Manual paid-amount column (`BillOccurrence.paidAmount`) — `null` unless
   * the manual (non-linked) paid path was used. */
  paidAmount: number | null
  /** Manual paid-date column (`BillOccurrence.paidDate`) — `null` unless the
   * manual (non-linked) paid path was used. */
  paidDate: Date | null
  /** The linked Transaction's id, if any (`BillOccurrence.transactionId`). */
  transactionId: string | null
}

/**
 * `true` when an occurrence counts as paid via either of bills.md AC7's two
 * paths: a linked Transaction (`transactionId` set) or a manual amount+date
 * entry (`paidAmount`/`paidDate` both set). Exported separately from
 * `computeOccurrenceStatus` because `service.ts` needs this exact "is this
 * occurrence paid" boolean on its own (e.g. to filter for "next *unpaid*
 * occurrence" in `getUpcomingOccurrences`/`getBills`) without needing to also
 * resolve the Upcoming/DueToday/Late distinction that requires `today`.
 */
export function isOccurrencePaid(occurrence: OccurrencePaidState): boolean {
  return (
    occurrence.transactionId !== null ||
    (occurrence.paidAmount !== null && occurrence.paidDate !== null)
  )
}

/**
 * Computes an occurrence's status, per docs/product/bills.md AC6: Paid (if
 * either paid path is populated — checked first, since a paid occurrence's
 * status is fixed regardless of how overdue its `dueDate` now looks), else
 * Late (`dueDate` before `today`), else Due Today (`dueDate` equals `today`),
 * else Upcoming.
 *
 * Both `dueDate` and `today` are normalized to UTC midnight before comparison
 * (`toUtcMidnight`) so this never misclassifies a due date as Late/Upcoming
 * because of a stray time-of-day component on either input — `BillOccurrence.
 * dueDate` is a `@db.Date` column (already date-only in Postgres) but
 * `today` is typically `new Date()` from the caller, which does carry a
 * time-of-day component that must be stripped before comparing.
 */
export function computeOccurrenceStatus(
  occurrence: OccurrencePaidState,
  today: Date,
): OccurrenceStatus {
  if (isOccurrencePaid(occurrence)) {
    return "PAID"
  }

  const dueUtc = toUtcMidnight(occurrence.dueDate).getTime()
  const todayUtc = toUtcMidnight(today).getTime()

  if (dueUtc < todayUtc) {
    return "LATE"
  }
  if (dueUtc === todayUtc) {
    return "DUE_TODAY"
  }
  return "UPCOMING"
}

// ---------------------------------------------------------------------------
// Re-anchoring
// ---------------------------------------------------------------------------

/**
 * Safety bound on the walk below. A bill whose anchor sits years in the past
 * on a weekly schedule still converges well inside this, so hitting the cap
 * means a pathological input rather than an expected outcome — same
 * defence-in-depth rationale as `features/debt/payoff-math.ts`'s
 * `MAX_SIMULATION_MONTHS`.
 */
const MAX_OCCURRENCE_STEPS = 10_000

/**
 * Every due date a bill anchored at `anchor` would fall on within
 * `[fromInclusive, throughInclusive]`.
 *
 * This is the piece that makes a due-date *change* take effect. The ordinary
 * generator (`service.ts`'s `ensureOccurrencesGenerated`) always continues
 * from the latest occurrence already on file, which is exactly right for
 * filling the calendar forward but means an edited `Bill.dueDate` can never
 * influence anything: the cursor comes from a row generated under the old
 * date, so future occurrences keep landing on the old day forever. Re-walking
 * from the anchor is what lets "move Electric to the 10th" actually move it.
 *
 * The walk starts at the anchor itself (included when it falls in range), so
 * a bill moved to a day earlier in the month than today still produces the
 * correct sequence — the anchor is simply stepped forward until it reaches
 * the window.
 */
export function computeOccurrenceDatesFrom(
  anchor: Date,
  schedule: BillSchedule,
  fromInclusive: Date,
  throughInclusive: Date,
): Date[] {
  const from = toUtcMidnight(fromInclusive)
  const through = toUtcMidnight(throughInclusive)
  const dates: Date[] = []

  let cursor = toUtcMidnight(anchor)
  for (let step = 0; step < MAX_OCCURRENCE_STEPS; step += 1) {
    if (cursor.getTime() > through.getTime()) break
    if (cursor.getTime() >= from.getTime()) dates.push(cursor)
    cursor = computeNextDueDate(cursor, schedule)
  }

  return dates
}
