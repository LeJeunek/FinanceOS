"use client"

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query"

import type { ApiResult } from "@/lib/api-response"
import type {
  Transaction,
  TransactionListFilters,
  TransactionListResult,
} from "@/features/transactions/types"
import type {
  CreateTransactionInput,
  SplitTransactionInput,
  UpdateTransactionInput,
} from "@/features/transactions/server/validation"
import {
  createTransaction,
  deleteTransaction,
  splitTransaction,
  updateTransaction,
} from "@/features/transactions/server/actions"

/**
 * TanStack Query hook(s) for the transaction table, following the exact
 * pattern established by `features/accounts/hooks/use-accounts.ts`: a query
 * key builder + fetcher for reads (via the `GET /api/transactions` Route
 * Handler, since Server Components can't be called from Client Components),
 * and `useMutation` wrappers around this feature's Server Actions for
 * writes, each invalidating the list query on success so the table reflects
 * the change without a full page reload.
 */

/** Shared TanStack Query cache key prefix for this feature. The full filter
 * object is included in the key (mirrors `accountsQueryKey`'s pattern) so
 * each distinct page/filter/search combination caches independently — e.g.
 * paging from page 1 to page 2 doesn't reuse page 1's cached rows. Mutation
 * hooks below invalidate every key under the `"transactions"` prefix
 * (`exact: false`, TanStack Query's default) rather than one specific filter
 * combination, since a create/update/delete/split can change which page a
 * transaction now belongs to. */
export function transactionsQueryKey(filters: TransactionListFilters = {}) {
  return ["transactions", filters] as const
}

/**
 * Client-safe fetcher for the transaction list. Calls
 * `GET /api/transactions` (see src/app/api/transactions/route.ts) rather
 * than `service.listTransactions` directly — Server-only modules under
 * `features/transactions/server` can't be imported from a Client Component.
 */
async function fetchTransactions(
  filters: TransactionListFilters,
): Promise<TransactionListResult> {
  const params = new URLSearchParams()
  if (filters.page !== undefined) params.set("page", String(filters.page))
  if (filters.pageSize !== undefined) params.set("pageSize", String(filters.pageSize))
  if (filters.accountId) params.set("accountId", filters.accountId)
  if (filters.categoryId) params.set("categoryId", filters.categoryId)
  if (filters.search) params.set("search", filters.search)
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom)
  if (filters.dateTo) params.set("dateTo", filters.dateTo)
  if (filters.sortBy) params.set("sortBy", filters.sortBy)
  if (filters.sortDir) params.set("sortDir", filters.sortDir)
  const queryString = params.toString()

  const response = await fetch(
    `/api/transactions${queryString ? `?${queryString}` : ""}`,
  )
  const result = (await response.json()) as ApiResult<TransactionListResult>

  if (!result.success) {
    throw new Error(result.error)
  }

  return result.data
}

/**
 * TanStack Query hook backing the transaction table's server-side pagination
 * (TanStack Table's manual pagination mode, per
 * docs/architecture/api-contracts.md's note that this is why `GET
 * /api/transactions` is a real Route Handler rather than a Server Action).
 * Callers typically pass `{ page, pageSize, ...activeFilters }` sourced from
 * TanStack Table's pagination state and whatever filter UI the Frontend Lead
 * builds.
 */
export function useTransactions(
  filters: TransactionListFilters = {},
): UseQueryResult<TransactionListResult, Error> {
  return useQuery({
    queryKey: transactionsQueryKey(filters),
    queryFn: () => fetchTransactions(filters),
  })
}

/** Unwraps an `ApiResult`, throwing on failure so `useMutation`'s `onError`/
 * `isError` machinery works the same way `fetchTransactions` above already
 * relies on for reads — a single, consistent "throw the error string"
 * convention across this hook file. */
function unwrap<T>(result: ApiResult<T>): T {
  if (!result.success) {
    throw new Error(result.error)
  }
  return result.data
}

/** Invalidates every cached transaction list, regardless of filter/page —
 * shared by every mutation hook below since any create/update/delete/split
 * can change which page/filter bucket a transaction now falls into, making a
 * single targeted invalidation unreliable. */
function useInvalidateTransactions() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ["transactions"] })
}

/** `useMutation` wrapper around the `createTransaction` Server Action —
 * docs/architecture/api-contracts.md's Transactions "Create" row. */
export function useCreateTransaction(): UseMutationResult<
  Transaction,
  Error,
  CreateTransactionInput
> {
  const invalidate = useInvalidateTransactions()
  return useMutation({
    mutationFn: async (input: CreateTransactionInput) =>
      unwrap(await createTransaction(input)),
    onSuccess: () => invalidate(),
  })
}

/** `useMutation` wrapper around the `updateTransaction` Server Action —
 * docs/architecture/api-contracts.md's Transactions "Update" row. */
export function useUpdateTransaction(): UseMutationResult<
  Transaction,
  Error,
  UpdateTransactionInput
> {
  const invalidate = useInvalidateTransactions()
  return useMutation({
    mutationFn: async (input: UpdateTransactionInput) =>
      unwrap(await updateTransaction(input)),
    onSuccess: () => invalidate(),
  })
}

/** `useMutation` wrapper around the `deleteTransaction` Server Action —
 * docs/architecture/api-contracts.md's Transactions "Delete" row. */
export function useDeleteTransaction(): UseMutationResult<
  { id: string },
  Error,
  { id: string }
> {
  const invalidate = useInvalidateTransactions()
  return useMutation({
    mutationFn: async (input: { id: string }) => unwrap(await deleteTransaction(input)),
    onSuccess: () => invalidate(),
  })
}

/** `useMutation` wrapper around the `splitTransaction` Server Action —
 * docs/architecture/api-contracts.md's Transactions "Split" row. Resolves
 * with the newly created split line items (`Transaction[]`), not the
 * now-informational parent — matches `splitTransaction`'s own return shape. */
export function useSplitTransaction(): UseMutationResult<
  Transaction[],
  Error,
  SplitTransactionInput
> {
  const invalidate = useInvalidateTransactions()
  return useMutation({
    mutationFn: async (input: SplitTransactionInput) =>
      unwrap(await splitTransaction(input)),
    onSuccess: () => invalidate(),
  })
}
