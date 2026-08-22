"use client"

/**
 * DashboardShell — thin Client Component wrapper composing `Sidebar` /
 * `TopNav` / `BottomNav` / `children` for the authenticated app shell.
 *
 * Why this file exists (Phase 5a,
 * docs/architecture/phase-5a-technical-design.md §2.2): `BottomNav`'s
 * "More" button and `TopNav`'s hamburger `Sheet` must open/close the exact
 * same mobile-nav surface rather than each owning an independent, competing
 * `Sheet` (see the architecture doc's rejected alternatives). That requires
 * one `useState<boolean>` shared by both — but `(dashboard)/layout.tsx` is a
 * Server Component (it awaits `getCurrentUser()`/`getUserPreference()`), and
 * `useState` requires a Client Component. This file is the minimal
 * `"use client"` boundary that owns that one lifted `mobileNavOpen` boolean
 * and threads it into `TopNav`'s new, optional, controlled-mode props
 * (`mobileNavOpen`/`onMobileNavOpenChange` — see `top-nav.tsx`'s own JSDoc)
 * and `BottomNav`'s `onMoreClick`. It is pure composition/state-lifting, not
 * a new reusable component — mirrors `currency-preference-provider.tsx`'s
 * own "root-layout plumbing, not a components/shared/ primitive" ownership
 * note, and the same co-located `*-client.tsx` pattern this app already uses
 * for every Server Component page that needs a client-side composition root
 * (e.g. `bills/bills-client.tsx`, `transactions/transactions-client.tsx`).
 *
 * `<main>` gains `pb-16 sm:pb-0` here (not in `layout.tsx`) since `<main>` is
 * rendered by this same composition — matching bottom padding to
 * `BottomNav`'s own height so its fixed position never obscures page content
 * below `sm` (640px), per the architecture doc §2.4's "required companion
 * change, not optional."
 *
 * **Bug fix (Bug Hunter, Phase 5a review gate,
 * phase-5a-sheet-focus-return-broken-for-externally-triggered-sheets.md):**
 * Radix's `Sheet` restores focus, on close, to whatever DOM node it has
 * internally tracked as its own `SheetTrigger` (the hamburger button,
 * always) — so closing a Sheet opened via `BottomNav`'s "More" button
 * incorrectly returned focus to the unrelated hamburger button instead.
 * `lastMobileNavOpenTriggerRef` records `document.activeElement` (the
 * "More" button itself, since a clicked element is focused before its own
 * `onClick` fires) at the moment `onMoreClick` opens the Sheet via this
 * *external* path; `handleMobileNavCloseAutoFocus`, wired to `TopNav`'s new
 * `onSheetCloseAutoFocus` prop, manually restores focus there and
 * `preventDefault()`s Radix's own (in this one case, wrong) default —
 * clearing the ref afterward so the next hamburger-triggered open/close
 * cycle is untouched and keeps using Radix's own already-correct default
 * (the ref stays `null` whenever the hamburger's real `SheetTrigger` is
 * what opened it).
 *
 * Everything server-resolved (the signed-in user, notification bell JSX,
 * `children`) is passed in as props from `layout.tsx` — this file fetches
 * nothing itself.
 */

import * as React from "react"
import type { ReactNode } from "react"
import { useRouter } from "next/navigation"

import { Sidebar } from "@/components/shared/sidebar"
import { TopNav, type TopNavUser } from "@/components/shared/top-nav"
import { BottomNav } from "@/components/shared/bottom-nav"
import { signOut } from "@/lib/auth-client"

export interface DashboardShellProps {
  user: TopNavUser
  notificationBell: ReactNode
  children: ReactNode
}

export function DashboardShell({
  user,
  notificationBell,
  children,
}: DashboardShellProps) {
  const router = useRouter()
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)

  // `TopNav`'s "Sign out" menu item previously had no `onSignOut` handler
  // wired anywhere in the authenticated app (auth-client.ts's own JSDoc
  // anticipated this call site but it was never actually connected) — the
  // button rendered but silently did nothing. `router.push` first, then
  // `router.refresh()`, mirrors `(auth)/login/page.tsx`'s own post-auth-change
  // navigation pattern; `router.refresh()` re-runs `(dashboard)/layout.tsx`'s
  // `getCurrentUser()` check on the next render, which is what actually
  // redirects to `/login` once the session cookie is gone.
  const handleSignOut = React.useCallback(async () => {
    await signOut()
    router.push("/login")
    router.refresh()
  }, [router])

  // `TopNav`'s global search box previously had no wiring at all — not even
  // `onSearchChange` was passed here, so typing and pressing Enter did
  // nothing. Transactions is the one page with a real search implementation
  // today (merchant/notes, `transaction-table.tsx`'s own `search` filter);
  // this box is rendered on every authenticated page, so submitting it
  // navigates there with `?search=` rather than trying to filter in place —
  // `transactions/page.tsx` reads that param to seed the table's existing
  // search state on load.
  const handleSearchSubmit = React.useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return
      router.push(`/transactions?search=${encodeURIComponent(trimmed)}`)
    },
    [router],
  )
  // See this file's own top JSDoc "Bug fix" note for the full reasoning.
  const lastMobileNavOpenTriggerRef = React.useRef<HTMLElement | null>(null)

  const handleMoreClick = React.useCallback(() => {
    lastMobileNavOpenTriggerRef.current = document.activeElement as HTMLElement | null
    setMobileNavOpen(true)
  }, [])

  const handleMobileNavCloseAutoFocus = React.useCallback((event: Event) => {
    const trigger = lastMobileNavOpenTriggerRef.current
    if (trigger) {
      event.preventDefault()
      trigger.focus()
      lastMobileNavOpenTriggerRef.current = null
    }
    // else: leave the event un-prevented — this Sheet was opened via its
    // own real SheetTrigger (the hamburger button), so Radix's own default
    // restore-focus-to-trigger behavior is already correct.
  }, [])

  return (
    <>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav
          user={user}
          onSearchSubmit={handleSearchSubmit}
          notificationBell={notificationBell}
          mobileNavOpen={mobileNavOpen}
          onMobileNavOpenChange={setMobileNavOpen}
          onSheetCloseAutoFocus={handleMobileNavCloseAutoFocus}
          onSignOut={handleSignOut}
          profileHref="/settings/account"
        />
        {/* Phase 5a accessibility fix (docs/testing/e2e/accessibility-run-report.md
            finding #4, scrollable-region-focusable): this `overflow-y-auto` region
            is the actual scrollable container on tall routes (e.g. Financial Health
            Score detail) — `tabIndex={0}` makes it keyboard-focusable/scrollable via
            arrow keys on those routes. `<main>` is already a landmark with its own
            accessible name via the browser's implicit role, so no `role`/`aria-label`
            addition is needed here (unlike `ScrollAffordanceContainer`, a
            non-landmark `<div>` that does need one). */}
        <main className="flex-1 overflow-y-auto p-4 pb-16 sm:pb-0 md:p-6" tabIndex={0}>
          {children}
        </main>
      </div>
      <BottomNav onMoreClick={handleMoreClick} />
    </>
  )
}
