import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"

import { ThemeProvider } from "@/components/shared/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { Providers } from "@/app/providers"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "LK Budget",
  description: "A personal finance dashboard for tracking accounts, budgets, and financial goals in one place.",
  // Two emblem variants (public/brand/emblem-{light,dark}.png), picked by the
  // browser via `prefers-color-scheme` — the light-background mark for a
  // light browser theme, the dark-background mark for a dark one, so the
  // favicon always has legible contrast regardless of the user's OS/browser
  // theme. `favicon.ico` (this route group's own convention favicon) stays
  // as a plain fallback for browsers that don't evaluate `media` on `<link
  // rel="icon">` at all.
  icons: {
    icon: [
      {
        url: "/brand/emblem-light.png",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/brand/emblem-dark.png",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  },
}

// Root layout: owns global providers only (theme, tooltips, toasts) and
// fonts. Route-group layouts ((auth), (dashboard)) own their own chrome —
// see docs/architecture/folder-tree.md. `suppressHydrationWarning` on
// <html> is required by next-themes, which sets the class attribute before
// React hydrates (see ThemeProvider's usage comment).
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    // The font variables go on <html>, not <body>: globals.css applies
    // `font-sans` to `html`, and a custom property only resolves on the
    // element that defines it or its descendants -- defined on <body>, it
    // was undefined where the font is actually set. next-themes only adds
    // its `dark`/`light` class to this element, so it leaves these alone.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Providers>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  )
}
