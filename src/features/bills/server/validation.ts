import { BillSchedule } from "@prisma/client"
import { z } from "zod"

/**
 * Zod schemas for the Bills module's server boundary (every Server Action's
 * input, plus `server/service.ts`'s `getCalendarMonth` month parameter), per
 * docs/architecture/api-contracts.md's Bills/Calendar v1 sections and
 * naming-standards.md's Zod schema conventions (PascalCase + "Schema").
 */

// ---------------------------------------------------------------------------
// Shared constants / helpers
// ---------------------------------------------------------------------------

// Matches the DB column precision (`prisma/schema.prisma`: both
// `Bill.expectedAmount` and `BillOccurrence.paidAmount` are `Decimal(14, 2)`)
// — same rationale/value as `features/accounts/server/validation.ts`'s
// `MAX_BALANCE_ABS` and `features/transactions/server/validation.ts`'s
// `MAX_TRANSACTION_AMOUNT_ABS`.
const MAX_AMOUNT_ABS = 999_999_999_999.99

const NAME_MAX_LENGTH = 120

/**
 * Guards against floating-point noise (e.g. 19.999999999999996 from a form
 * input) while still rejecting genuinely over-precise values like 19.999.
 * Duplicated from `features/accounts/server/validation.ts`/
 * `features/transactions/server/validation.ts` rather than imported, per
 * folder-tree.md's module boundary rule (features/<domain>/server is not a
 * shared import target across domains) — if this logic ever needs to change,
 * update all three copies.
 */
function hasAtMostTwoDecimalPlaces(value: number): boolean {
  const cents = value * 100
  return Math.abs(Math.round(cents) - cents) < 1e-6
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Builds a UTC-midnight `Date` from a `"yyyy-mm-dd"` string — identical
 * technique to `features/transactions/server/validation.ts`'s
 * `toUtcDateOnly`, duplicated here for the same module-boundary reason as
 * `hasAtMostTwoDecimalPlaces` above. Matches `Bill.dueDate`/
 * `BillOccurrence.dueDate`/`paidDate`'s `@db.Date` + UTC convention. */
function toUtcDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`)
}

/** A `"yyyy-mm-dd"` string, parsed into a UTC-midnight `Date`. Accepts either
 * a string (typical form/JSON input) or an already-constructed `Date`
 * (e.g. a caller that already has one) — `z.union` rather than a stricter
 * string-only schema, since both `dueDate` (create/update) and `paidDate`/
 * calendar params flow through this from slightly different call sites. */
const dateOnlySchema = z.union([
  z
    .string()
    .regex(DATE_ONLY_PATTERN, "Date must be in YYYY-MM-DD format")
    .transform(toUtcDateOnly),
  z.date(),
])

const amountSchema = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .finite(`${label} must be a finite number`)
    .refine(hasAtMostTwoDecimalPlaces, {
      message: `${label} supports at most 2 decimal places`,
    })
    .refine((value) => Math.abs(value) <= MAX_AMOUNT_ABS, {
      message: `${label} must be no larger than ${MAX_AMOUNT_ABS.toLocaleString("en-US")} in magnitude`,
    })

/** `expectedAmount` must be strictly positive — bills.md AC1 ("expected
 * amount ... required"); a $0 "typical amount" is not a meaningful planning
 * estimate for a recurring bill. */
const expectedAmountSchema = amountSchema("Expected amount").positive(
  "Expected amount must be greater than zero",
)

/** `paidAmount` (the manual mark-paid path) allows zero (e.g. a fee waived
 * this cycle) but never negative — distinct from `expectedAmountSchema`,
 * which must be strictly positive. */
const paidAmountSchema = amountSchema("Paid amount").nonnegative(
  "Paid amount cannot be negative",
)

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(NAME_MAX_LENGTH, `Name must be ${NAME_MAX_LENGTH} characters or fewer`)

const scheduleSchema = z.nativeEnum(BillSchedule, {
  error: "Schedule must be one of: weekly, biweekly, monthly, quarterly, annually",
})

/**
 * Category field with "leave unchanged vs. explicitly clear" semantics —
 * identical shape/rationale to
 * `features/transactions/server/validation.ts`'s `categoryIdSchema`: an
 * empty-string input (the "no category" option) is normalized to `null`
 * (bills.md AC1: category is optional), `undefined` (omitted) means leave
 * unchanged on update.
 */
const categoryIdSchema = z.preprocess(
  (value) => (value === "" ? null : value),
  z.string().min(1, "Invalid category id").nullable().optional(),
)

const idSchema = (label: string) => z.string().min(1, `${label} is required`)

// ---------------------------------------------------------------------------
// Public schemas — see docs/architecture/api-contracts.md's Bills/Calendar v1
// sections for the required names/shapes.
// ---------------------------------------------------------------------------

/**
 * `createBill` input, per bills.md AC1 and api-contracts.md's Bills "Create
 * bill" row: name, expectedAmount > 0, dueDate (the first/next occurrence),
 * schedule, optional categoryId. Whether a supplied `categoryId` belongs to
 * the caller is not checkable here (Zod has no DB access) — that check
 * happens in `server/actions.ts`, mirroring
 * `features/transactions/server/actions.ts`'s `assertOwnedCategory` pattern.
 */
export const CreateBillSchema = z.object({
  name: nameSchema,
  expectedAmount: expectedAmountSchema,
  dueDate: dateOnlySchema,
  schedule: scheduleSchema,
  categoryId: categoryIdSchema,
})

export type CreateBillInput = z.infer<typeof CreateBillSchema>

/**
 * `updateBill` input. Every field besides `id` is optional so callers can
 * patch a single field — same "undefined fields excluded from the write"
 * convention as `features/accounts/server/actions.ts`'s `updateAccount`.
 *
 * Per bills.md AC4, changing `expectedAmount`/`schedule` here applies to
 * future (not-yet-generated) occurrences only — enforced naturally by
 * `server/service.ts`'s lazy generator always reading the *current*
 * `Bill.expectedAmount`/`schedule` at generation time, never retroactively
 * touching already-persisted `BillOccurrence` rows; there is nothing extra
 * for this schema itself to enforce.
 */
export const UpdateBillSchema = z.object({
  id: idSchema("Bill id"),
  name: nameSchema.optional(),
  expectedAmount: expectedAmountSchema.optional(),
  dueDate: dateOnlySchema.optional(),
  schedule: scheduleSchema.optional(),
  categoryId: categoryIdSchema,
})

export type UpdateBillInput = z.infer<typeof UpdateBillSchema>

/** `archiveBill` / `unarchiveBill` input — both take just the id, mirroring
 * `features/accounts/server/validation.ts`'s `AccountIdSchema`. */
export const BillIdSchema = z.object({
  id: idSchema("Bill id"),
})

export type BillIdInput = z.infer<typeof BillIdSchema>

/**
 * `markOccurrencePaid` input, per bills.md AC7's two mutually exclusive paid
 * paths: recording a manual amount+date, OR linking to an existing
 * Transaction — never both, never neither. Modeled as a discriminated union
 * (on the presence of `transactionId`) rather than one schema with optional
 * fields for both paths, so "exactly one path" is a structural guarantee
 * Zod itself enforces (each branch is `.strict()`, so supplying fields from
 * both — or neither branch's required fields — fails validation) rather than
 * an ad hoc runtime `if` check in `server/actions.ts` that could drift out of
 * sync with what's actually accepted.
 */
const MarkPaidManualSchema = z
  .object({
    occurrenceId: idSchema("Occurrence id"),
    amount: paidAmountSchema,
    date: dateOnlySchema,
  })
  .strict()

const MarkPaidLinkedSchema = z
  .object({
    occurrenceId: idSchema("Occurrence id"),
    transactionId: idSchema("Transaction id"),
  })
  .strict()

export const MarkPaidSchema = z.union([MarkPaidLinkedSchema, MarkPaidManualSchema])

export type MarkPaidInput = z.infer<typeof MarkPaidSchema>

/**
 * `linkOccurrenceToTransaction` input — the dedicated linking action from
 * api-contracts.md's Bills section (kept as its own action/schema, alongside
 * `MarkPaidSchema`'s linked branch above, so the contract's literal
 * `linkOccurrenceToTransaction` row has a matching Server Action; see
 * `server/actions.ts` for how both share one underlying implementation to
 * avoid duplicating the ownership/already-linked checks).
 */
export const LinkTransactionSchema = z.object({
  occurrenceId: idSchema("Occurrence id"),
  transactionId: idSchema("Transaction id"),
})

export type LinkTransactionInput = z.infer<typeof LinkTransactionSchema>

/** `unmarkOccurrencePaid` input — clears both the manual paid fields and any
 * link (AC8), reverting the occurrence to its computed status. */
export const UnmarkPaidSchema = z.object({
  occurrenceId: idSchema("Occurrence id"),
})

export type UnmarkPaidInput = z.infer<typeof UnmarkPaidSchema>

/** `deleteOccurrence` input — removes a single `BillOccurrence` row outright
 * (unlike `unmarkOccurrencePaid`, which only clears its paid fields and
 * leaves the row in place). Exists for cleaning up a stale/incorrect
 * occurrence — e.g. one generated under a schedule that was later corrected
 * (see `server/actions.ts`'s `deleteOccurrence` JSDoc) — that would otherwise
 * sit in the payment history forever with no way to remove it. */
export const DeleteOccurrenceSchema = z.object({
  occurrenceId: idSchema("Occurrence id"),
})

export type DeleteOccurrenceInput = z.infer<typeof DeleteOccurrenceSchema>

// ---------------------------------------------------------------------------
// Calendar v1 (backed entirely by Bills' data — see api-contracts.md)
// ---------------------------------------------------------------------------

const MONTH_PATTERN = /^\d{4}-\d{2}$/

/**
 * `"YYYY-MM"` validator for `service.getCalendarMonth`, per
 * api-contracts.md's Calendar v1 section. `getCalendarMonth` is a direct
 * Server Component call (no Route Handler in front of it), but the month
 * value ultimately originates from a page's `?month=` search param — an
 * untrusted client-controlled string per folder-tree.md's "validate at every
 * boundary" rule — so it is still parsed through Zod rather than trusted
 * as already well-formed.
 */
export const MonthSchema = z
  .string()
  .regex(MONTH_PATTERN, "Month must be in YYYY-MM format")

export type MonthInput = z.infer<typeof MonthSchema>
