import { normalizeMerchantName } from "@/lib/merchant-normalization"
import {
  canonicalizeCategory,
  UNCATEGORIZED,
} from "@/features/statement-import/categories"
import { CATEGORY_RULES, type CategoryRule } from "@/features/statement-import/categorization/rules"
import type { CategoryConfidence } from "@/features/statement-import/types"

/**
 * The rule-based classifier.
 *
 * Precedence, highest first:
 *   1. **Exact merchant match** — the normalized merchant name is listed
 *      verbatim on a rule. Confident.
 *   2. **Keyword match on the merchant** — longest matching keyword wins.
 *      Confident if one category holds the longest match, weak if two
 *      categories tie (a genuine ambiguity the user should look at).
 *   3. **Keyword match on the notes** — the raw statement description often
 *      still carries the merchant even when the cleaned name does not. Always
 *      weak, because notes contain addresses and reference text that produce
 *      more incidental hits.
 *   4. Nothing matched — `Uncategorized`.
 *
 * The merchant key is built with `lib/merchant-normalization.ts`'s
 * `normalizeMerchantName`, the app's existing fuzzy grouping key. Reusing it
 * (rather than a private lowercase/trim here) means the classifier buckets
 * merchants exactly the way Analytics' Top Merchants already does.
 */

export interface Classification {
  category: string
  confidence: CategoryConfidence
}

/** Word-boundary matcher, cached per keyword. Boundaries matter: a plain
 * `includes("bp")` would fire on "bpay" and "bp" alike, and short fuel-brand
 * keywords are exactly the ones prone to that. */
const matcherCache = new Map<string, RegExp>()

function keywordMatcher(keyword: string): RegExp {
  const cached = matcherCache.get(keyword)
  if (cached) return cached

  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // `\b` fails next to a non-word character (the "+" in "disney+", the "*" in
  // "e*trade"), so the boundary is only asserted on the sides where the
  // keyword actually starts/ends with a word character.
  const left = /^\w/.test(keyword) ? "\\b" : ""
  const right = /\w$/.test(keyword) ? "\\b" : ""
  const matcher = new RegExp(`${left}${escaped}${right}`, "i")
  matcherCache.set(keyword, matcher)
  return matcher
}

interface KeywordHit {
  category: string
  length: number
}

/** Longest keyword hit per category, across every rule targeting it. */
function findKeywordHits(haystack: string, rules: readonly CategoryRule[]): KeywordHit[] {
  const bestByCategory = new Map<string, number>()

  for (const rule of rules) {
    for (const keyword of rule.keywords ?? []) {
      if (!keywordMatcher(keyword).test(haystack)) continue
      const current = bestByCategory.get(rule.category) ?? 0
      if (keyword.length > current) bestByCategory.set(rule.category, keyword.length)
    }
  }

  return [...bestByCategory].map(([category, length]) => ({ category, length }))
}

/** Resolves the hit list into a single outcome. A clear longest match is
 * confident; a tie between categories is reported as weak so the review
 * table flags it instead of quietly picking whichever rule was declared
 * first. */
function resolveHits(hits: KeywordHit[], forceWeak: boolean): Classification | null {
  if (hits.length === 0) return null

  const longest = Math.max(...hits.map((hit) => hit.length))
  const winners = hits.filter((hit) => hit.length === longest)

  return {
    category: winners[0].category,
    confidence: forceWeak || winners.length > 1 ? "weak" : "confident",
  }
}

/**
 * Classifies one transaction.
 *
 * `allowed` is the user's real category list (see `categories.ts`); any rule
 * whose category is not in it is skipped, so the returned category is always
 * valid for this user and `validation.ts` never has to reject the
 * classifier's own output.
 */
export function classifyTransaction(
  merchant: string,
  notes: string,
  allowed: readonly string[],
): Classification {
  const applicableRules = CATEGORY_RULES.filter(
    (rule) => canonicalizeCategory(rule.category, allowed) !== null,
  )
  if (applicableRules.length === 0) {
    return { category: UNCATEGORIZED, confidence: "uncategorized" }
  }

  const merchantKey = normalizeMerchantName(merchant)

  if (merchantKey.length > 0) {
    for (const rule of applicableRules) {
      if (rule.merchants?.includes(merchantKey)) {
        return {
          category: canonicalizeCategory(rule.category, allowed) ?? UNCATEGORIZED,
          confidence: "confident",
        }
      }
    }

    const merchantHit = resolveHits(findKeywordHits(merchantKey, applicableRules), false)
    if (merchantHit) {
      return {
        category: canonicalizeCategory(merchantHit.category, allowed) ?? UNCATEGORIZED,
        confidence: merchantHit.confidence,
      }
    }
  }

  if (notes.trim().length > 0) {
    const notesHit = resolveHits(findKeywordHits(notes, applicableRules), true)
    if (notesHit) {
      return {
        category: canonicalizeCategory(notesHit.category, allowed) ?? UNCATEGORIZED,
        confidence: "weak",
      }
    }
  }

  return { category: UNCATEGORIZED, confidence: "uncategorized" }
}
