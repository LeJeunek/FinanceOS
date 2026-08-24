import { describe, expect, it } from "vitest"

import { ensurePdfDomGlobals } from "@/features/statement-import/server/pdf-dom-shim"

type Matrix = {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  multiply: (other: Matrix) => Matrix
  translate: (tx: number, ty: number) => Matrix
  scale: (sx: number, sy?: number) => Matrix
  toFloat32Array: () => Float32Array
}

type GlobalWithMatrix = typeof globalThis & {
  DOMMatrix?: new (init?: number[]) => Matrix
  Path2D?: new () => unknown
  ImageData?: new (w: number, h: number) => { data: Uint8ClampedArray }
}

describe("ensurePdfDomGlobals", () => {
  it("defines the globals pdfjs reads while loading", () => {
    ensurePdfDomGlobals()
    const target = globalThis as GlobalWithMatrix

    expect(typeof target.DOMMatrix).toBe("function")
    expect(typeof target.Path2D).toBe("function")
    expect(typeof target.ImageData).toBe("function")
  })

  it("is idempotent — a second call does not replace the first", () => {
    ensurePdfDomGlobals()
    const first = (globalThis as GlobalWithMatrix).DOMMatrix
    ensurePdfDomGlobals()
    expect((globalThis as GlobalWithMatrix).DOMMatrix).toBe(first)
  })

  it("defaults to the identity matrix", () => {
    ensurePdfDomGlobals()
    const DOMMatrixCtor = (globalThis as GlobalWithMatrix).DOMMatrix!
    const identity = new DOMMatrixCtor()

    expect([identity.a, identity.b, identity.c, identity.d, identity.e, identity.f]).toEqual([
      1, 0, 0, 1, 0, 0,
    ])
  })

  it("composes affine transforms correctly", () => {
    ensurePdfDomGlobals()
    const DOMMatrixCtor = (globalThis as GlobalWithMatrix).DOMMatrix!

    // Translating by (5, 7) then scaling by 2 must scale the translation too,
    // which is what distinguishes correct composition from element-wise
    // multiplication.
    const composed = new DOMMatrixCtor().scale(2, 2).translate(5, 7)
    expect([...composed.toFloat32Array()]).toEqual([2, 0, 0, 2, 10, 14])
  })

  it("multiplies in DOM order", () => {
    ensurePdfDomGlobals()
    const DOMMatrixCtor = (globalThis as GlobalWithMatrix).DOMMatrix!

    const scale = new DOMMatrixCtor([2, 0, 0, 3, 0, 0])
    const translate = new DOMMatrixCtor([1, 0, 0, 1, 4, 5])

    expect([...scale.multiply(translate).toFloat32Array()]).toEqual([2, 0, 0, 3, 8, 15])
  })

  it("allocates a correctly sized ImageData buffer", () => {
    ensurePdfDomGlobals()
    const ImageDataCtor = (globalThis as GlobalWithMatrix).ImageData!
    expect(new ImageDataCtor(3, 2).data.length).toBe(24)
  })
})
