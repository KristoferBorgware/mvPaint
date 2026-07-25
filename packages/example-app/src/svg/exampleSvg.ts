// A small self-contained SVG used as a live in-scene test of the loader: a square ring
// (outer square with a square hole, even-odd) filled with a linear gradient, a circle
// filled with a radial gradient and stroked, and an open quadratic path that is stroked
// only (fill="none"). Coordinates are in a 0..200 viewBox; the scene places and flips it.

export const EXAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd23f"/>
      <stop offset="1" stop-color="#ee4266"/>
    </linearGradient>
    <radialGradient id="rg" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#c6f7e2"/>
      <stop offset="1" stop-color="#1b998b"/>
    </radialGradient>
  </defs>
  <path d="M20 20 H120 V120 H20 Z M50 50 V90 H90 V50 Z"
        fill="url(#lg)" fill-rule="evenodd"/>
  <circle cx="150" cy="150" r="40" fill="url(#rg)" stroke="#0b3954" stroke-width="4"/>
  <path d="M20 175 Q70 135 120 175 T180 175"
        fill="none" stroke="#8338ec" stroke-width="8" stroke-linecap="round"/>
</svg>`
