import { describe, expect, it } from "vitest"

import {
  failureDetail,
  isFailureCode,
  PASSWORD_INCORRECT,
  PASSWORD_REQUIRED,
  SCANNED_PDF,
  TEXT_EXTRACTION_UNAVAILABLE,
  withDetail,
} from "@/features/statement-import/failure-codes"

/**
 * These helpers are what turn a server failure into the right prompt. When
 * the client could not resolve the sentinels, every match silently failed and
 * the user was shown the raw string `TEXT_EXTRACTION_UNAVAILABLE` instead of
 * the offer to read the statement visually — so the matching itself is worth
 * pinning down.
 */
describe("failure codes", () => {
  it("matches a bare sentinel", () => {
    expect(isFailureCode(SCANNED_PDF, SCANNED_PDF)).toBe(true)
    expect(isFailureCode(PASSWORD_REQUIRED, PASSWORD_REQUIRED)).toBe(true)
  })

  it("matches a sentinel carrying diagnostic detail", () => {
    const message = withDetail(TEXT_EXTRACTION_UNAVAILABLE, "DOMMatrix is not defined")
    expect(isFailureCode(message, TEXT_EXTRACTION_UNAVAILABLE)).toBe(true)
    expect(failureDetail(message, TEXT_EXTRACTION_UNAVAILABLE)).toBe("DOMMatrix is not defined")
  })

  it("does not confuse one sentinel for another", () => {
    expect(isFailureCode(PASSWORD_REQUIRED, PASSWORD_INCORRECT)).toBe(false)
    expect(isFailureCode(SCANNED_PDF, TEXT_EXTRACTION_UNAVAILABLE)).toBe(false)
  })

  it("does not match an unrelated message that merely starts similarly", () => {
    expect(isFailureCode("SCANNED_PDF_SOMETHING_ELSE", SCANNED_PDF)).toBe(false)
    expect(isFailureCode("Could not read this PDF: ...", TEXT_EXTRACTION_UNAVAILABLE)).toBe(false)
  })

  it("reports no detail for a bare sentinel", () => {
    expect(failureDetail(SCANNED_PDF, SCANNED_PDF)).toBeNull()
    expect(withDetail(SCANNED_PDF)).toBe(SCANNED_PDF)
  })

  it("preserves detail containing colons", () => {
    const message = withDetail(TEXT_EXTRACTION_UNAVAILABLE, "Failed to load: a: b")
    expect(failureDetail(message, TEXT_EXTRACTION_UNAVAILABLE)).toBe("Failed to load: a: b")
  })
})
