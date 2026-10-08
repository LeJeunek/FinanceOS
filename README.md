# FinanceOS

A full-stack personal finance platform: accounts, transactions, budgeting, debt payoff, investments, goals, and AI-generated insights that are checked against the real numbers before they are shown.

**[Try the live demo](https://budget-eight-gules.vercel.app/demo)** — no sign-up, populated with fictional sample data.

Built with Next.js 15, TypeScript, Prisma, and PostgreSQL.

## What it does

| Area | What you get |
|---|---|
| **Dashboard** | Net worth, monthly income and expenses, cash flow, savings rate, and trend charts |
| **Accounts and transactions** | Multiple account types, split transactions, receipt attachments, CSV import with duplicate detection, and PDF bank statement import |
| **Budgeting** | Monthly category budgets with allocated, spent, and remaining amounts, plus a budget health score |
| **Debt** | Snowball and avalanche payoff projections |
| **Investments** | Holdings, gain and loss, and allocation |
| **Goals** | Savings goals with contribution tracking, and financial goals for net worth, debt payoff, and savings rate targets |
| **Bills and income** | Recurring bills with paid and late status, recurring income streams, and a calendar that combines both |
| **Analytics and reports** | Spending trends, category breakdowns, a financial health score, and six PDF report types |
| **Notifications** | In-app inbox and optional email for low balances, large purchases, achieved goals, and monthly summaries |
| **Admin** | User management, audit log, feature flags, and category templates |

### AI features

Five features run on the Vercel AI SDK with Google Gemini:

- Transaction auto-categorization
- Budget advisor
- Automatic monthly summaries
- Spending insights
- Financial health score

Every AI-written narrative passes through a grounding check that rejects any figure not present in the user's actual data, so the model cannot invent numbers. User-entered text is length-capped and sanitized before it reaches a prompt to limit prompt injection, calls are rate-limited, and the provider sits behind a single file so it can be swapped without touching any feature.

## Tech stack

| Layer | Tools |
|---|---|
| Framework | Next.js 15 (App Router, Turbopack), React 19, TypeScript |
| Data | PostgreSQL (Neon), Prisma 6 |
| Auth | Better Auth (email and password, Google OAuth) |
| UI | Tailwind CSS v4, shadcn/ui, Radix, Recharts, Framer Motion |
| Forms and data | React Hook Form, Zod, TanStack Query, TanStack Table |
| AI | Vercel AI SDK, Google Gemini |
| Email and files | Resend, React Email, UploadThing, `@react-pdf/renderer` |
| Testing | Vitest, React Testing Library, Playwright, axe-core |
| Hosting | Vercel |

## Engineering highlights

- **Feature-module architecture.** Each of the 20 feature modules follows the same shape (`types.ts`, `server/` for services, actions, and validation, and `components/`), across 42 Prisma models.
- **Boundaries enforced by tooling.** Rules such as "the demo must never import a Server Action or Prisma" are scoped ESLint `no-restricted-imports` blocks, so a violation fails the build instead of relying on code review.
- **Derived state, not cached state.** Late bills, over-budget categories, goal progress, and health scores are computed at read time from raw data, so they cannot drift out of sync.
- **Read-only public demo.** `/demo` is a separate route tree backed by static fixture data. It performs no database reads or writes and needs no maintenance to stay populated.
- **Accessibility as a test gate.** Playwright runs axe-core against every route at mobile, tablet, and desktop widths, with regression tests for accent color contrast and reduced-motion behavior.
- **Layered tests.** Over 60 unit and integration test files in Vitest, plus 13 Playwright end-to-end specs covering authentication, transaction entry, budgeting, goals, import, export, and reports.

## How it was built

FinanceOS was planned and shipped through a simulated 17-role engineering studio. Each role (Product Owner, Solution Architect, Backend Engineer, Security Architect, Release Manager, and others) is a Claude Code subagent with its own scoped tools and written charter, defined in [`.claude/agents`](.claude/agents).

Every feature went through the same pipeline: product spec, architecture design, implementation, a review gate (security, performance, and bug hunting), then a Release Manager approval. A rejection meant a real fix and a fresh verification in a live browser before the next pass.

The [case study](docs/CASE-STUDY.md) covers all ten phases, including what broke and how it was fixed.

## Running locally

**Prerequisites:** Node.js 20 or later, and Docker (or any PostgreSQL 16 database).

```bash
git clone https://github.com/LeJeunek/FinanceOS.git
cd FinanceOS
npm install
docker compose up -d        # local Postgres on port 5432
```

Create a `.env` file in the project root:

```bash
# Required
DATABASE_URL="postgresql://financeos:financeos@localhost:5432/financeos"
BETTER_AUTH_SECRET="<a long random string>"
BETTER_AUTH_URL="http://localhost:3000"

# Optional: each one enables a feature and the app runs without it
GOOGLE_CLIENT_ID=""                 # Google sign-in
GOOGLE_CLIENT_SECRET=""
GOOGLE_GENERATIVE_AI_API_KEY=""     # AI features
RESEND_API_KEY=""                   # email notifications and password reset
EMAIL_FROM_ADDRESS=""
EMAIL_UNSUBSCRIBE_SECRET=""
UPLOADTHING_TOKEN=""                # receipt uploads
CRON_SECRET=""                      # scheduled jobs under /api/cron
E2E_TEST_USER_PASSWORD=""           # Playwright test accounts
```

Then set up the database and start the app:

```bash
npm run db:migrate
npm run db:seed             # optional: demo user with sample data
npm run dev                 # http://localhost:3000
```

The demo at `http://localhost:3000/demo` needs none of the optional keys.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint, including the architecture boundary rules |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | End-to-end and accessibility tests (Playwright) |
| `npm run seed:e2e` | Create the accounts the Playwright suite signs in with |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:studio` | Browse the database in Prisma Studio |
| `npm run grant:admin` | Give a user the admin role |

## Project structure

```
src/
  app/
    (auth)/          login, password reset
    (dashboard)/     authenticated app, behind a single server-side auth gate
    admin/           internal admin tools
    demo/            public read-only demo
    api/             route handlers, including cron jobs
  features/          one module per domain (accounts, budgeting, debt, ...)
  components/        shared UI and shadcn/ui primitives
  lib/               auth, database client, AI, email
prisma/              schema, migrations, seed scripts
tests/e2e/           Playwright specs: flows, accessibility, responsive
docs/                product specs, architecture, security, and release notes
```

## Documentation

The [`docs`](docs) folder holds more than 100 documents written alongside the code:

- [Case study](docs/CASE-STUDY.md): the phase-by-phase engineering record
- [Architecture](docs/architecture/Architecture.md)
- [AI features design](docs/architecture/ai-features-design.md)
- [Database ER diagram](docs/database/er-diagram.md)
- [Roadmap](docs/planning/roadmap.md)
- [Product specs](docs/product)

## Author

Built by Kyle LeJeune ([@LeJeunek](https://github.com/LeJeunek)).
