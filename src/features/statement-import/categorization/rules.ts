/**
 * The converter's deterministic categorization rules.
 *
 * This is the file to edit when a transaction lands in the wrong bucket —
 * nothing else in the pipeline encodes any knowledge of what a merchant
 * sells. Rules are plain data so they stay reviewable at a glance and
 * unit-testable without any of the machinery in `classify.ts`.
 *
 * Every `category` here must be one of the Charter's 11 system categories
 * (`features/categories/default-categories.ts`). `classify.ts` checks each
 * rule's category against the *user's* allowed list before applying it, so a
 * rule pointing at a category the user renamed simply stops firing rather
 * than producing an invalid row.
 *
 * Deliberately NOT AI: the basic PDF -> CSV workflow must work offline and
 * identically every run. `features/transactions/server/categorization.ts`
 * (the existing AI suggestion feature) still runs afterward against whatever
 * imports as Uncategorized — these rules are the fast, free first pass, not a
 * replacement for it.
 */

export interface CategoryRule {
  /** Target category name — must match a system category exactly. */
  category: string
  /**
   * Full merchant names, already lowercased and normalized the same way
   * `lib/merchant-normalization.ts` normalizes them. An exact hit here is
   * treated as a confident match and short-circuits keyword scoring.
   */
  merchants?: string[]
  /**
   * Words or phrases matched on word boundaries within the merchant name.
   * Longer keywords win over shorter ones, which is what keeps "tj maxx"
   * (Shopping) from being stolen by "max" (Entertainment).
   */
  keywords?: string[]
}

export const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "Housing",
    merchants: ["home depot", "lowes", "ace hardware"],
    keywords: [
      "rent", "mortgage", "apartments", "apartment homes", "property management",
      "properties", "hoa", "homeowners association", "landlord", "leasing",
      "storage", "lawn care", "pest control", "home depot", "lowes",
    ],
  },
  {
    category: "Utilities",
    merchants: ["alabama power", "spire", "comcast", "xfinity", "spectrum"],
    keywords: [
      "electric", "power co", "power company", "energy", "water works", "water dept",
      "sewer", "utility", "utilities", "waste management", "trash", "sanitation",
      "internet", "broadband", "cable", "comcast", "xfinity", "spectrum",
      "at&t", "verizon", "t-mobile", "mint mobile", "wireless", "natural gas",
      "gas company", "propane",
    ],
  },
  {
    category: "Transportation",
    merchants: ["shell", "chevron", "exxon", "mobil", "bp", "texaco", "circle k", "racetrac"],
    keywords: [
      "gas station", "fuel", "shell", "chevron", "exxon", "mobil", "texaco",
      "circle k", "racetrac", "quiktrip", "wawa", "sheetz", "pilot travel",
      "loves travel", "marathon", "sunoco", "citgo",
      "uber", "lyft", "taxi", "rideshare", "transit", "metro", "parking", "toll",
      "dmv", "tag office", "auto zone", "autozone", "advance auto", "oreilly",
      "jiffy lube", "valvoline", "tire", "car wash", "collision", "auto repair",
    ],
  },
  {
    category: "Food",
    merchants: [
      "walmart", "wal-mart", "wal mart", "kroger", "publix", "aldi", "costco",
      "sams club", "winn dixie", "greer's", "greers", "food giant",
      "piggly wiggly", "trader joes", "whole foods", "tom thumb",
    ],
    keywords: [
      "grocery", "groceries", "supermarket", "market", "food mart", "deli",
      // Statements print this both ways; "walmart" alone does not match the
      // hyphenated form once word boundaries are enforced.
      "walmart", "wal-mart", "wal mart",
      "kroger", "publix", "aldi", "costco", "sams club", "winn dixie",
      "piggly wiggly", "trader joes", "whole foods", "fresh market",
      "restaurant", "cafe", "coffee", "starbucks", "dunkin", "mcdonalds",
      "burger king", "chick-fil-a", "chickfila", "taco bell", "wendys", "subway",
      "pizza", "dominos", "papa johns", "chipotle", "panera", "waffle house",
      "whataburger", "sonic drive", "popeyes", "kfc", "arbys", "hardees",
      "zaxbys", "jimmy johns", "firehouse subs", "olive garden", "applebees",
      "chilis", "cracker barrel", "ihop", "denny", "steakhouse", "grill",
      "sushi", "bbq", "bakery", "doordash", "uber eats", "grubhub", "postmates",
    ],
  },
  {
    category: "Entertainment",
    merchants: ["netflix", "hulu", "spotify", "max", "peacock", "paramount+", "crunchyroll"],
    keywords: [
      "netflix", "hulu", "spotify", "disney", "disney+", "hbo", "peacock",
      "paramount", "apple tv", "prime video", "youtube", "audible", "kindle",
      "steam", "playstation", "xbox", "nintendo", "epic games", "twitch",
      "patreon", "amc theatres", "cinema", "cinemark", "regal", "movie",
      "theatre", "theater", "ticketmaster", "stubhub", "concert", "bowling",
      "golf", "arcade", "museum", "state park", "campground",
    ],
  },
  {
    category: "Shopping",
    merchants: [
      "amazon", "target", "best buy", "ebay", "etsy", "ikea", "temu", "shein",
      "dollar general", "dollar tree", "five below", "marshalls", "ross",
      "tj maxx", "old navy",
    ],
    keywords: [
      "amazon", "amzn", "target", "best buy", "ebay", "etsy", "ikea", "wayfair",
      "temu", "shein", "dollar general", "dollar tree", "family dollar",
      "five below", "big lots", "marshalls", "ross stores", "tj maxx", "tjmaxx",
      "old navy", "gap", "kohls", "belk", "dillards", "macys", "nordstrom",
      "nike", "adidas", "academy sports", "dicks sporting", "bass pro",
      "hobby lobby", "michaels", "joann", "barnes noble", "apple store",
      "google store", "microsoft store", "hot topic", "bath body works",
      "ulta", "sephora",
    ],
  },
  {
    category: "Healthcare",
    merchants: ["cvs", "walgreens", "rite aid", "labcorp", "quest diagnostics"],
    keywords: [
      "cvs", "walgreens", "rite aid", "pharmacy", "prescription", "drug store",
      "dental", "dentist", "orthodont", "medical", "clinic", "hospital",
      "physician", "doctor", "family practice", "urgent care", "emergency room",
      "labcorp", "quest diagnostics", "optometry", "eye care", "vision center",
      "chiropractic", "therapy", "counseling", "wellness", "health center",
      "surgery", "radiology", "pediatric",
    ],
  },
  {
    category: "Insurance",
    merchants: ["geico", "progressive", "state farm", "allstate", "usaa", "aflac"],
    keywords: [
      "insurance", "geico", "progressive", "state farm", "allstate", "usaa",
      "aflac", "nationwide", "liberty mutual", "farmers ins", "travelers",
      "safeco", "esurance", "assurance", "policy premium",
    ],
  },
  {
    category: "Investments",
    merchants: ["vanguard", "fidelity", "charles schwab", "robinhood", "coinbase", "etrade"],
    keywords: [
      "vanguard", "fidelity", "charles schwab", "schwab", "robinhood", "etrade",
      "e*trade", "td ameritrade", "merrill", "betterment", "wealthfront",
      "coinbase", "kraken", "gemini exchange", "brokerage", "securities",
      "mutual fund", "roth ira", "ira contribution", "401k", "acorns", "stash",
    ],
  },
  {
    category: "Savings",
    keywords: [
      "savings", "share savings", "emergency fund", "transfer to savings",
      "certificate of deposit", "share certificate", "money market",
      "christmas club", "vacation club", "dividend",
    ],
  },
  {
    category: "Misc",
    keywords: [
      "atm withdrawal", "cash withdrawal", "service charge", "overdraft",
      "nsf fee", "late fee", "annual fee", "membership fee", "wire fee",
      "returned item", "donation", "church", "goodwill", "salvation army",
      "notary", "post office", "usps", "ups store", "fedex",
    ],
  },
]
