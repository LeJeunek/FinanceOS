import type {
  Receipt as PrismaReceipt,
  Transaction as PrismaTransaction,
} from "@prisma/client"
import type { TransactionSortField } from "@/features/transactions/server/validation"

// Re-export the Uncategorized sentinel from the Dashboard module rather than
// declaring a second one here. Both modules need the exact same string value
// ("uncategorized" is not a real Category.id — Prisma cuids never take this
// literal form): Dashboard's `getSpendingByCategory` groups untagged spend
// into it, and this module's `listTransactions`/`TransactionFilterSchema`
// need the identical value so a user picking "Uncategorized" in the
// transaction table's category filter matches the same bucket the Dashboard
// chart shows. Duplicating the literal in two files would risk them drifting
// out of sync silently (e.g. one file typo'd to "uncategorised"); re-exporting
// the single source of truth makes that impossible. See
// features/dashboard/types.ts for the full rationale.
export { UNCATEGORIZED_CATEGORY_ID } from "@/features/dashboard/types"

/**
 * Client-safe representation of a financial Account.
 *
 * Prisma's `Decimal` (balance, interestRate) is a decimal.js class instance,
 * not a plain serializable value. Passing it as-is across the Server
 * Component -> Client Component boundary, or through a Server Action's
 * response, is unsafe. `server/service.ts` and `server/actions.ts` always
 * convert Decimal -> number before returning data, so every consumer outside
 * `features/transactions/server` works with this plain-number shape instead
 * of the raw Prisma type — mirrors `features/accounts/types.ts`'s `Account`/
 * `toAccount()` pattern.
 */

/** Minimal Category fields needed to render a transaction row without a
 * separate round-trip to `features/categories`. Kept intentionally narrow
 * (id/name/color, not the full Category shape) — the transaction table only
 * ever needs these three fields to render the category cell/badge. */
export interface TransactionCategorySummary {
  id: string
  name: string
  color: string
}

/** Minimal Account fields needed to render a transaction row — see
 * `TransactionCategorySummary`'s JSDoc for why this is narrow rather than the
 * full `features/accounts/types.ts` `Account` shape. */
export interface TransactionAccountSummary {
  id: string
  name: string
  color: string
}

/** A single tag attached to a transaction. */
export interface TransactionTagSummary {
  id: string
  name: string
}

/**
 * Client-safe Transaction shape returned by every function in
 * `server/service.ts` and `server/actions.ts`, per
 * docs/architecture/api-contracts.md's Transactions section (every action's
 * `Output` column is `ApiResult<Transaction>` or `ApiResult<Transaction[]>`).
 *
 * `amount` is converted from Prisma's `Decimal` to `number` (same reasoning
 * as `features/accounts/types.ts`'s `Account.balance`). `category`/`account`/
 * `tags` are joined-in summaries so the transaction table can render a full
 * row (merchant, category, account, tags) without N+1 client-side fetches —
 * see `server/service.ts`'s `TRANSACTION_INCLUDE` for the exact Prisma
 * `include` this shape is built from.
 *
 * Split transactions: for a parent that has been split, `amount` remains the
 * original total but is purely informational once split children exist (see
 * the schema comment on `Transaction.parentTransactionId`) — parents are
 * excluded from `listTransactions` results entirely (see
 * `EXCLUDE_SPLIT_PARENTS` in server/service.ts), so UI code only ever
 * encounters this "informational parent" shape via `getTransactionById` if
 * explicitly looked up by id.
 */
export type Transaction = Omit<PrismaTransaction, "amount"> & {
  amount: number
  category: TransactionCategorySummary | null
  account: TransactionAccountSummary
  tags: TransactionTagSummary[]
}

/**
 * Client-side filter/pagination state for the transaction table, consumed by
 * `hooks/use-transactions.ts`'s `useTransactions` and (later) the Frontend
 * Lead's filter UI. Deliberately distinct from `server/validation.ts`'s
 * `TransactionFilterInput`: that type is the *post-Zod-parse* shape (e.g.
 * `dateFrom`/`dateTo` already transformed into `Date` objects), whereas a
 * Client Component builds these values as plain strings (from a date picker,
 * a search input, etc.) before they're ever sent to
 * `GET /api/transactions` as query params. `page`/`pageSize` are optional
 * here since `TransactionFilterSchema` supplies defaults server-side.
 */
export interface TransactionListFilters {
  page?: number
  pageSize?: number
  accountId?: string
  categoryId?: string
  search?: string
  /** `"yyyy-mm-dd"` — see `server/validation.ts`'s `dateOnlySchema`. */
  dateFrom?: string
  /** `"yyyy-mm-dd"` — see `server/validation.ts`'s `dateOnlySchema`. */
  dateTo?: string
  sortBy?: TransactionSortField
  sortDir?: "asc" | "desc"
}

/**
 * Client-safe representation of a `Receipt` (Phase 2 addendum — see
 * prisma/schema.prisma's Receipt model and
 * docs/product/transactions.md's "Phase 2 Addendum: Receipt Attachment").
 *
 * Unlike `Transaction`/`Account`, every `Receipt` column is already a plain,
 * directly-serializable type (`String`/`Int`/`DateTime` — no Prisma
 * `Decimal`), so no field-by-field conversion is needed here; the Prisma row
 * shape is already the client-safe shape, so this is a direct re-export
 * rather than a mapped type.
 */
export type Receipt = PrismaReceipt

/**
 * Transaction shape for the detail view (a single transaction's own page),
 * distinct from the table-row `Transaction` shape above per
 * docs/architecture/api-contracts.md's Receipts section: `receipts` is
 * deliberately NOT a field on `Transaction` itself, since `listTransactions`
 * would otherwise need to fetch every row's receipts on every page load of a
 * table that can have thousands of rows (an N+1-style cost for data almost
 * no row actually has). `receipts` is only ever populated by
 * `server/service.ts`'s `getTransactionDetail`, used solely by the
 * transaction detail Server Component.
 */
export interface TransactionDetail extends Transaction {
  receipts: Receipt[]
}

/** Return shape of `service.listTransactions` — matches
 * `ApiResult<{ items: Transaction[]; total: number }>` from
 * docs/architecture/api-contracts.md's Transactions "List" row. `total` is
 * the full filtered/searched count (not just `items.length`), required by
 * TanStack Table's manual/server-side pagination mode to compute page count. */
export interface TransactionListResult {
  items: Transaction[]
  total: number
}

/** One row-level error from a CSV import — the specific row number (see
 * `server/import.ts` for how row numbers are counted) and a human-readable
 * reason, per docs/product/transactions.md AC17 ("reported back to the user
 * with the specific row and reason"). */
export interface TransactionImportRowError {
  row: number
  message: string
}

/** Return shape of `POST /api/transactions/import`, matching
 * `ApiResult<{ imported, skippedDuplicates, errors }>` from
 * docs/architecture/api-contracts.md's Transactions "Import CSV" row. */
export interface TransactionImportSummary {
  imported: number
  skippedDuplicates: number
  errors: TransactionImportRowError[]
}
