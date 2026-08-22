import { redirect } from "next/navigation"

import { getCurrentUser } from "@/lib/auth"
import { getCategories, getCategoryUsageCount } from "@/features/categories/server/service"
import { getPendingSuggestions } from "@/features/transactions/server/categorization"

import { TransactionsClient } from "./transactions-client"

/**
 * Transactions page (Phase 1) — replaces the Phase 0 placeholder.
 *
 * A Server Component, not a Client Component, specifically so it can fetch
 * categories: per docs/architecture/api-contracts.md's Categories "List
 * categories" row, that module has no client hook or REST list route
 * (unlike Accounts/Transactions) — it's "a Server Component direct call to
 * `service.getCategories(userId)`". `getCategoryUsageCount` is likewise a
 * plain Server-only function, not a Server Action, so it can only be called
 * from here too. Both are threaded down as props to `TransactionsClient`,
 * the Client Component that actually owns the interactive table/dialogs.
 *
 * `getCurrentUser()` + redirect mirrors `(dashboard)/layout.tsx`'s own
 * guard — defensive, not load-bearing (the layout already redirects
 * unauthenticated visitors before this page renders), but required so
 * `getCategories`/`getCategoryUsageCount` have a non-null `userId` to scope
 * their queries by, per folder-tree.md's rule that every server query must
 * be scoped by the authenticated user's id.
 *
 * Usage counts are only computed for custom (non-system) categories — only
 * those are deletable (system categories are protected), so a usage count
 * for a system category would never be read. Counts are precomputed once
 * per page load, not fetched live at delete-confirmation time; see
 * `CategoryManagerDialog`'s JSDoc for how it stays reasonably fresh
 * (`router.refresh()` on every dialog open and after every mutation).
 *
 * **Phase 4a addition (Transaction Auto-Categorization):** `pendingSuggestions`
 * is fetched here for the same reason `categories` is — per
 * docs/architecture/api-contracts.md's Feature 1 row, `getPendingSuggestions`
 * is a plain Server Component direct call, not a client-fetchable route, so
 * it can only be read from this Server Component and threaded down as a
 * prop. It is intentionally unfiltered (every currently-PENDING suggestion
 * for this user, both automatic and manual "reconsider" origin) — see
 * `categorization.ts`'s own JSDoc on why the `importBatchId` scoping named in
 * the API contract isn't implemented yet (no column exists to group
 * transactions by import batch).
 *
 * `searchParams.search` (Next.js 15's `searchParams` page prop is a
 * `Promise` — see `budgeting/page.tsx`'s own note on this) seeds
 * `TransactionTable`'s existing merchant/notes search filter on load — how
 * `dashboard-shell.tsx`'s global TopNav search box (previously entirely
 * unwired) reaches this page's own already-working search implementation
 * rather than duplicating it.
 */
export interface TransactionsPageProps {
  searchParams: Promise<{ search?: string }>
}

export default async function TransactionsPage({ searchParams }: TransactionsPageProps) {
  const user = await getCurrentUser()
  if (!user) {
    redirect("/login")
  }

  const resolvedSearchParams = await searchParams

  const categories = await getCategories(user.id)

  const customCategories = categories.filter((category) => !category.isSystem)
  const usageCountEntries = await Promise.all(
    customCategories.map(
      async (category) => [category.id, await getCategoryUsageCount(user.id, category.id)] as const,
    ),
  )
  const categoryUsageCounts = Object.fromEntries(usageCountEntries)

  const pendingSuggestions = await getPendingSuggestions(user.id)

  return (
    <TransactionsClient
      categories={categories}
      categoryUsageCounts={categoryUsageCounts}
      pendingSuggestions={pendingSuggestions}
      initialSearch={resolvedSearchParams.search}
    />
  )
}
