/**
 * Minimal DOM-geometry globals for running pdfjs under a serverless Node
 * runtime.
 *
 * **The problem.** `pdfjs-dist` (which `pdf-parse` wraps) expects a browser's
 * `DOMMatrix`/`Path2D`/`ImageData`. In Node it tries to supply them itself,
 * with roughly this shape:
 *
 *     try { ...require a canvas package... }
 *     catch (e) { warn(`Cannot access the \`require\` function: "${e}"`) }
 *     globalThis.DOMMatrix ||= required?.DOMMatrix ?? warn(...)
 *
 * On a normal Node install that `require` either succeeds or fails
 * harmlessly — text extraction never touches the matrix code, so the missing
 * global costs nothing (this is exactly why extraction works locally on a
 * Node build that has no `DOMMatrix` at all). Inside a bundled serverless
 * function the same `require` cannot resolve, the global is never defined,
 * and module evaluation dies with `ReferenceError: DOMMatrix is not defined`
 * before a single page is read.
 *
 * **The fix.** Define the globals ourselves *before* pdfjs loads. pdfjs
 * guards with `globalThis.DOMMatrix ||`, so a value already present makes it
 * skip its own lookup entirely and the failing path is never reached.
 *
 * **On correctness.** These are deliberately small rather than
 * spec-complete. The matrix maths below is the standard 2-D affine
 * composition, which is correct for the operations pdfjs performs with it;
 * `Path2D` and `ImageData` are inert stand-ins, because the only pdfjs
 * features that genuinely need them are canvas *rendering* paths this app
 * never calls (it uses `getText`, never `getScreenshot`). If image rendering
 * is ever added here, these must be replaced with a real canvas
 * implementation rather than extended in place.
 */

interface Matrix2D {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** Standard 2-D affine matrix, sufficient for pdfjs's transform bookkeeping. */
class ServerDOMMatrix implements Matrix2D {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0

  constructor(init?: number[] | string) {
    if (Array.isArray(init) && init.length >= 6) {
      ;[this.a, this.b, this.c, this.d, this.e, this.f] = init
    }
  }

  /** `this × other`, in the same order the CSS/DOM spec composes them. */
  multiply(other: Matrix2D): ServerDOMMatrix {
    return new ServerDOMMatrix([
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f,
    ])
  }

  translate(tx = 0, ty = 0): ServerDOMMatrix {
    return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty })
  }

  scale(sx = 1, sy = sx): ServerDOMMatrix {
    return this.multiply({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 })
  }

  /** pdfjs reads transforms back out in this array form. */
  toFloat32Array(): Float32Array {
    return new Float32Array([this.a, this.b, this.c, this.d, this.e, this.f])
  }

  getTransform(): ServerDOMMatrix {
    return new ServerDOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f])
  }
}

/** Inert stand-in — see this module's note on rendering paths. */
class ServerPath2D {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
  rect(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
}

/** Inert stand-in — see this module's note on rendering paths. */
class ServerImageData {
  readonly data: Uint8ClampedArray
  constructor(
    readonly width: number = 0,
    readonly height: number = 0,
  ) {
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4))
  }
}

/** Deliberately a loose record rather than an intersection with
 * `typeof globalThis`: the latter keeps `lib.dom`'s full browser signatures,
 * which these intentionally partial stand-ins do not implement. */
type MutableGlobals = Record<string, unknown>

/**
 * Installs the shims if — and only if — the runtime does not already provide
 * them. Safe to call repeatedly; every call after the first is a no-op.
 *
 * Must run before pdfjs is imported, since the globals are read during that
 * module's evaluation.
 */
export function ensurePdfDomGlobals(): void {
  const target = globalThis as unknown as MutableGlobals

  if (typeof target.DOMMatrix === "undefined") target.DOMMatrix = ServerDOMMatrix
  if (typeof target.Path2D === "undefined") target.Path2D = ServerPath2D
  if (typeof target.ImageData === "undefined") target.ImageData = ServerImageData
}
