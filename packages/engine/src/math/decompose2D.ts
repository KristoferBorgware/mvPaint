// Turning a 2x2 linear transform back into the fields a Node stores.
//
// The inverse of what Node.localMatrix() composes, and the only way to put an arbitrary
// matrix onto a node: the transform is stored as rotation/scale/skew rather than as a
// matrix, so anything that computes a matrix - a transformer gesture, a reparent that has
// to preserve a world position - has to come back through here.
//
// It lives in math/ rather than beside its callers because both of them are scene-graph
// code and this is not: Node needs it (see Node.applyLocalMatrix) and so does
// shapes/transformerMath, and having Node reach into shapes/ for it would close an import
// cycle through Container.

/** What a 2x2 linear part decomposes into, in Node's own transform vocabulary. */
export interface DecomposedTransform {
  rotation: number
  scaleX: number
  scaleY: number
  skewX: number
  skewY: number
}

/**
 * Splits a 2x2 linear transform into rotation, skew and scale, matching the order
 * localMatrix() composes them in (R · skew · S). This is a QR-style decomposition: the
 * rotation and scaleX come from the x axis' direction and length, the determinant fixes
 * scaleY, and whatever obliqueness is left over lands in skewX.
 *
 * Five stored fields describe a four-degree-of-freedom matrix, so one has to be pinned to
 * make the answer unique - skewY is pinned to 0. Every invertible 2x2 is still reachable,
 * which is the point: it makes the decomposition EXACT, so non-uniformly scaling a
 * rotated shape is represented faithfully instead of approximated.
 *
 * `a`/`b` are the x axis (column 0), `c`/`d` the y axis (column 1).
 */
export function decompose2D(a: number, b: number, c: number, d: number): DecomposedTransform {
  const determinant = a * d - b * c
  const xAxisLength = Math.hypot(a, b)

  if (xAxisLength > 1e-12) {
    return {
      rotation: Math.atan2(b, a),
      scaleX: xAxisLength,
      scaleY: determinant / xAxisLength,
      skewX: (a * c + b * d) / determinant,
      skewY: 0,
    }
  }

  // The x axis collapsed (a fully squashed transform), so measure from the y axis instead.
  const yAxisLength = Math.hypot(c, d)
  if (yAxisLength > 1e-12) {
    return {
      rotation: Math.PI / 2 - Math.atan2(d, c),
      scaleX: determinant / yAxisLength,
      scaleY: yAxisLength,
      skewX: 0,
      skewY: (a * c + b * d) / determinant,
    }
  }

  return { rotation: 0, scaleX: 0, scaleY: 0, skewX: 0, skewY: 0 }
}
