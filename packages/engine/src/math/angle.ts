// Degrees and radians, and the one line that converts between them.
//
// WHICH UNIT WHERE. Every angle an application writes or reads is in DEGREES: a node's
// rotation, a camera's, the angles a rotate drag snaps onto, the sweep of an arc drawn into a
// ShapeContext. Every angle the engine computes with is in RADIANS, because that is what
// Math.cos, Math.atan2 and Quaternion.fromAxisAngle take, and converting inside a loop that
// runs per glyph or per pointer event would be conversion for its own sake.
//
// The two meet at a named boundary rather than wherever it happened to be convenient. A value
// crosses in exactly one place per property - Node.localMatrix on the way down,
// Node.applyLocalMatrix on the way back up - so there is one line to read when an angle comes
// out a factor of 57 wrong, instead of a scattering of multiplications to audit.
//
// A field's unit is part of its name's meaning here, so anything holding radians says so in
// its doc comment; anything that does not is degrees.

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

export function degToRad(degrees: number): number {
  return degrees * DEG2RAD
}

export function radToDeg(radians: number): number {
  return radians * RAD2DEG
}
