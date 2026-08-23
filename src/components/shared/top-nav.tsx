"use client"

/**
 * TopNav — top bar for the authenticated app shell: mobile nav trigger
 * (opens `Sidebar` in a `Sheet`), a global search input (presentation
 * only — no fetching), a theme toggle slot, a notification bell slot, and a
 * user menu.
 *
 * Usage:
 * ```tsx
 * <TopNav
 *   user={{ name: "Ada Lovelace", email: "ada@example.com" }}
 *   onSignOut={() => signOutAction()}
 *   onSearchChange={(value) => setQuery(value)}
 *   notificationBell={<NotificationBell />}
 * />
 *
 * // No user loaded yet (e.g. still fetching in a Server Component parent)
 * <TopNav />
 * ```
 *
 * `onSearchChange` only forwards the raw input value — wiring it to real
 * search/filtering logic is a feature module's responsibility.
 * `onSignOut` is left unimplemented here on purpose — auth logic belongs
 * to the Backend Engineer's `lib/auth.ts` / server actions.
 * `notificationBell` has no default (unlike `themeToggle`, which defaults to
 * `<ThemeToggle />`) because this component must stay domain-agnostic and
 * fetch-free — it cannot import `features/notifications/components/notification-bell`
 * itself. Callers (currently `app/(dashboard)/layout.tsx`) pass it in; when
 * omitted, no bell renders.
 */

import * as React from "react"
import Link from "next/link"
import { LogOut, Menu, Search, User as UserIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Sidebar, type NavSection } from "@/components/shared/sidebar"
import { ThemeToggle } from "@/components/shared/theme-toggle"

export interface TopNavUser {
  name: string
  email?: string
  avatarUrl?: string
}

export interface TopNavProps {
  className?: string
  /** Signed-in user summary for the avatar/menu. Omit to render a generic placeholder. */
  user?: TopNavUser
  /** Called when "Sign out" is selected — implement the actual sign-out elsewhere. */
  onSignOut?: () => void
  searchPlaceholder?: string
  /** Presentational only — forwards the raw input value, never calls an API. */
  onSearchChange?: (value: string) => void
  /**
   * Fired when Enter is pressed in the search box — distinct from
   * `onSearchChange`'s per-keystroke forwarding, since this box is global
   * (rendered by every authenticated page, not just Transactions) and has no
   * search results surface of its own to filter live. The real authenticated
   * shell (`dashboard-shell.tsx`) wires this to navigate to
   * `/transactions?search=<value>`, the one page with an actual search
   * implementation today — previously this box had no wiring at all (neither
   * `onSearchChange` nor this), so typing and pressing Enter did nothing.
   */
  onSearchSubmit?: (value: string) => void
  /** Override the default `<ThemeToggle />` slot if needed. */
  themeToggle?: React.ReactNode
  /** Notification bell slot, rendered between the theme toggle and the user
   * menu. No default — see this file's top JSDoc for why. Pass
   * `<NotificationBell />` (`features/notifications/components/notification-bell.tsx`)
   * from a page/layout that has access to that feature module. */
  notificationBell?: React.ReactNode
  /**
   * Phase 5a addition (`docs/architecture/phase-5a-technical-design.md`
   * §2.2): controlled-mode override for the mobile-nav `Sheet`'s open state,
   * so a parent can share this one boolean with `BottomNav`'s own "More"
   * button rather than each owning an independent, competing `Sheet`. Both
   * `mobileNavOpen` and `onMobileNavOpenChange` must be supplied together to
   * take effect — when either is omitted, `TopNav` falls back to its own
   * internal `useState` exactly as before, so every existing consumer that
   * doesn't pass these is completely unaffected.
   */
  mobileNavOpen?: boolean
  /** Paired with `mobileNavOpen` — see that prop's doc above. */
  onMobileNavOpenChange?: (open: boolean) => void
  /**
   * Bug fix (Bug Hunter, Phase 5a review gate,
   * phase-5a-sheet-focus-return-broken-for-externally-triggered-sheets.md):
   * Radix's `Sheet` restores focus, on close, to whatever DOM node it has
   * internally tracked as its own `SheetTrigger` — the hamburger button
   * below, always. That is correct when the Sheet was opened via the
   * hamburger itself, but wrong when it was opened via `BottomNav`'s "More"
   * button (an external control with no `SheetTrigger` of its own driving
   * this same `mobileNavOpen` boolean) — closing then always returns focus
   * to the hamburger, not to "More." Passed straight through to
   * `SheetContent`'s own `onCloseAutoFocus` prop; when the caller (only
   * `dashboard-shell.tsx`, which knows whether "More" was the actual
   * trigger) has nothing to override, it should leave the event
   * un-prevented so Radix's own correct default (the hamburger case) still
   * applies. Omitted entirely for every consumer that doesn't need it.
   */
  onSheetCloseAutoFocus?: (event: Event) => void
  /**
   * Public Demo Mode addition (`docs/architecture/public-demo-technical-design.md`
   * §6.1): forwarded straight through to the mobile `Sheet`'s own `Sidebar`
   * instance below. Optional — when omitted, `Sidebar` falls back to its own
   * default `NAV_SECTIONS` exactly as before, so every existing consumer
   * that doesn't pass this is completely unaffected. Exists because the
   * mobile hamburger menu renders a second, independent `Sidebar` instance
   * that `Sidebar`'s own `sections` prop (when passed to the *desktop* rail
   * elsewhere) does not automatically reach.
   */
  sidebarSections?: NavSection[]
  /**
   * Where the user-menu's "Profile" item links to. Optional and omitted by
   * default — previously this item rendered with no `href`/`onSelect` at
   * all (a real bug: it did nothing when clicked). Rather than default it
   * to some assumed route, the item is only rendered when a caller
   * explicitly supplies one — the real authenticated shell passes
   * `/settings/account`; `/demo` deliberately omits this prop (no real
   * profile exists there), so the item simply doesn't render rather than
   * linking to an authenticated route the demo must never reference.
   */
  profileHref?: string
  /**
   * Label for the sign-out menu item — defaults to "Sign out". `/demo`
   * overrides this to "Back to login" and wires `onSignOut` to a plain
   * client-side navigation to `/login` instead of a real Better Auth
   * sign-out call (there is no session to end in a read-only, unauthenticated
   * route) — closes the gap where that menu item previously did nothing at
   * all for a demo visitor.
   */
  signOutLabel?: string
}

function getInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
  return initials || "?"
}

export function TopNav({
  className,
  user,
  onSignOut,
  searchPlaceholder = "Search transactions, accounts...",
  onSearchChange,
  onSearchSubmit,
  themeToggle,
  notificationBell,
  mobileNavOpen: controlledMobileNavOpen,
  onMobileNavOpenChange,
  onSheetCloseAutoFocus,
  sidebarSections,
  profileHref,
  signOutLabel = "Sign out",
}: TopNavProps) {
  const [internalMobileNavOpen, setInternalMobileNavOpen] =
    React.useState(false)
  // Controlled/uncontrolled split, the ordinary React pattern (and the same
  // shape Sheet's own underlying Radix `open`/`onOpenChange` API already
  // uses) — see `mobileNavOpen`'s own doc comment above for why this exists.
  const isControlled =
    controlledMobileNavOpen !== undefined && onMobileNavOpenChange !== undefined
  const mobileNavOpen = isControlled
    ? controlledMobileNavOpen
    : internalMobileNavOpen
  const setMobileNavOpen = isControlled
    ? onMobileNavOpenChange
    : setInternalMobileNavOpen

  return (
    <header
      data-slot="top-nav"
      className={cn(
        "flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4",
        className
      )}
    >
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation menu"
          >
            <Menu className="size-5" aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="left"
          className="p-0"
          onCloseAutoFocus={onSheetCloseAutoFocus}
        >
          <SheetTitle className="sr-only">Navigation menu</SheetTitle>
          <Sidebar
            mobile
            sections={sidebarSections}
            onNavigate={() => setMobileNavOpen(false)}
            className="pt-10"
          />
        </SheetContent>
      </Sheet>

      <div className="relative max-w-md flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder={searchPlaceholder}
          aria-label="Search"
          className="pl-8"
          onChange={(event) => onSearchChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onSearchSubmit?.(event.currentTarget.value)
            }
          }}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        {themeToggle ?? <ThemeToggle />}
        {notificationBell}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label="Open user menu"
            >
              <Avatar size="sm">
                {user?.avatarUrl && (
                  <AvatarImage src={user.avatarUrl} alt="" />
                )}
                <AvatarFallback>
                  {user ? (
                    getInitials(user.name)
                  ) : (
                    <UserIcon className="size-4" aria-hidden="true" />
                  )}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">
                {user?.name ?? "Account"}
              </span>
              {user?.email && (
                <span className="text-xs font-normal text-muted-foreground">
                  {user.email}
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {profileHref && (
              <DropdownMenuItem asChild>
                <Link href={profileHref}>
                  <UserIcon aria-hidden="true" />
                  Profile
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onSignOut?.()}>
              <LogOut aria-hidden="true" />
              {signOutLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
