import { describe, expect, it } from "vitest"

import {
  computeOccurrenceDatesFrom,
  toUtcMidnight,
} from "@/features/bills/server/occurrence"

/**
 * `computeOccurrenceDatesFrom` is what makes a due-date change take effect.
 * Before it existed, editing a bill's due date updated the `Bill` row and
 * changed nothing visible: occurrence generation always continued from the
 * latest occurrence already on file, so future occurrences kept landing on
 * the old day forever.
 */

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const iso = (date: Date) => date.toISOString().slice(0, 10)

describe("computeOccurrenceDatesFrom", () => {
  it("moves a monthly bill to its new day of the month", () => {
    // The reported case: an Electric bill anchored on the 24th, moved to the
    // 10th, with "today" late in the month so the new anchor is already past.
    const dates = computeOccurrenceDatesFrom(
      utc("2026-08-10"),
      "MONTHLY",
      utc("2026-08-24"),
      utc("2026-12-31"),
    )

    expect(dates.map(iso)).toEqual([
      "2026-09-10",
      "2026-10-10",
      "2026-11-10",
      "2026-12-10",
    ])
  })

  it("includes the anchor itself when it falls inside the window", () => {
    const dates = computeOccurrenceDatesFrom(
      utc("2026-09-10"),
      "MONTHLY",
      utc("2026-08-24"),
      utc("2026-11-30"),
    )

    expect(dates.map(iso)[0]).toBe("2026-09-10")
  })

  it("walks an anchor years in the past forward into the window", () => {
    const dates = computeOccurrenceDatesFrom(
      utc("2019-03-05"),
      "MONTHLY",
      utc("2026-08-24"),
      utc("2026-10-31"),
    )

    expect(dates.map(iso)).toEqual(["2026-09-05", "2026-10-05"])
  })

  it("handles every supported schedule", () => {
    const from = utc("2026-08-24")
    const through = utc("2026-10-24")

    expect(
      computeOccurrenceDatesFrom(utc("2026-08-24"), "WEEKLY", from, through).length,
    ).toBeGreaterThan(8)
    expect(computeOccurrenceDatesFrom(utc("2026-08-24"), "MONTHLY", from, through).map(iso)).toEqual(
      ["2026-08-24", "2026-09-24", "2026-10-24"],
    )
    expect(
      computeOccurrenceDatesFrom(utc("2026-08-24"), "QUARTERLY", from, through).map(iso),
    ).toEqual(["2026-08-24"])
    expect(computeOccurrenceDatesFrom(utc("2026-08-24"), "ANNUALLY", from, through).map(iso)).toEqual(
      ["2026-08-24"],
    )
  })

  it("returns nothing when the window closes before the anchor", () => {
    expect(
      computeOccurrenceDatesFrom(utc("2027-01-10"), "MONTHLY", utc("2026-08-01"), utc("2026-12-31")),
    ).toEqual([])
  })

  it("normalizes stray time-of-day on its inputs", () => {
    const dates = computeOccurrenceDatesFrom(
      new Date("2026-09-10T18:45:12.000Z"),
      "MONTHLY",
      new Date("2026-08-24T23:59:59.000Z"),
      new Date("2026-10-31T07:00:00.000Z"),
    )

    expect(dates.map(iso)).toEqual(["2026-09-10", "2026-10-10"])
    expect(dates.every((d) => d.getTime() === toUtcMidnight(d).getTime())).toBe(true)
  })

  it("clamps a month-end anchor the way the shared recurrence helper does", () => {
    // A bill due the 31st still has to produce a date in 30-day months; the
    // exact clamping is `lib/recurrence.ts`'s concern, this asserts the walk
    // does not skip or duplicate a month because of it.
    const dates = computeOccurrenceDatesFrom(
      utc("2026-01-31"),
      "MONTHLY",
      utc("2026-01-31"),
      utc("2026-05-31"),
    )

    expect(dates).toHaveLength(5)
    expect(iso(dates[0])).toBe("2026-01-31")
  })
})
