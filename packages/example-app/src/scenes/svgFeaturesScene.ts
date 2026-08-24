// What the SVG loader makes of a document, in six documents that each say one thing.
//
// The scene next door (`svg`) is one document drawn as geometry - it shows that the loader
// works. This one is about what the loader READS, and every section is a pair: the document,
// and the control that says what the answer would otherwise have been. Four of the six are
// invisible failures without that pairing, which is the whole reason they are drawn side by
// side rather than described.
//
//   CSS          a document that paints through classes, next to the same document with its
//                <style> removed. SVG's initial fill is BLACK, so the second is not a gap in
//                the drawing - it is a solid silhouette, which is what an unresolved class
//                looks like and why it goes unnoticed.
//   open path    a face written as one arc with no `z`, next to the same path with the `z`.
//                Filling closes an open subpath, so the two are the same picture.
//   fill-rule    two rings wound the same way, read by each rule. Nonzero fills the pair
//                solid; even-odd cuts the inner one out.
//   fit          one document into three boxes of the same shape, under the three
//                preserveAspectRatio values the document itself carries.
//   <use>        one <symbol> instanced three times at three sizes, and a dashed baseline -
//                stroke-dasharray, measured in the document's units and drawn in the scene's.
//   notes        a document full of things the loader does not draw, with what it reported
//                printed beside it. Nothing else here would tell you.
//
// Every document arrives non-listening, which is the default: this is a picture, and clicking
// it is the application's decision.

import { Group, MSDFText, Rect, loadSvgDocument, type Container, type Scene, type SvgDocument } from '@mvpaint/engine'
import { CRIMSON, DARK, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

// --- layout ---------------------------------------------------------------------------------
//
// Two rows of three. Every y is a TOP edge, as an MSDFText node's origin and a Rect's both are,
// so a section occupies its column downwards from ROW_Y by however tall its parts turn out to be.

const COLUMN_X = [-520, -170, 180] as const
const ROW_Y = [-250, 30] as const
const HEADING_TO_CAPTION = 26
const CAPTION_TO_ART = 30

function heading(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontStyle: 'bold', fontSize: 19, color: DARK } })
}

function caption(x: number, y: number, text: string, color = SLATE): MSDFText {
  return new MSDFText({ x, y, text, maxWidth: 320, lineHeight: 1.35, style: { fontSize: 13, color } })
}

function tag(x: number, y: number, text: string, color = SLATE): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 12, color } })
}

/** The frame a fit is drawn into, so the box being fitted TO is visible along with the result. */
function frame(x: number, y: number, width: number, height: number): Rect {
  return new Rect({ x, y, width, height, fill: 'transparent', stroke: `${SLATE}44`, strokeWidth: 1 })
}

/**
 * One document into the scene at a size, and the result for whatever else the section asks of
 * it. The fit lands on the returned group's own transform, so placing it is a parent group with
 * an x and a y rather than anything the geometry has to be told about.
 */
function place(parent: Container, svg: string, x: number, y: number, width: number, height: number): SvgDocument {
  const doc = loadSvgDocument(svg, { fit: { width, height } })
  parent.addChild(new Group({ x, y }).add(doc.root))
  return doc
}

// --- the documents ---------------------------------------------------------------------------

/**
 * Paint said in a stylesheet: one class per colour, one rule per class, which is what an editor
 * emits for a drawing with a shared palette. `class="bar tall"` carries two rules that both set
 * `fill`, and the later of the two in the stylesheet is the one that paints.
 */
const CSS_DOC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <defs><style>
    #base { fill: #172147 }
    .bar  { fill: #007a80 }
    .tall { fill: #cc1f47 }
  </style></defs>
  <rect id="base" x="4" y="48" width="52" height="5"/>
  <rect class="bar" x="8" y="28" width="12" height="20"/>
  <rect class="bar tall" x="24" y="12" width="12" height="36"/>
  <rect class="bar" x="40" y="34" width="12" height="14"/>
</svg>`

/** The same document with nothing to resolve - the state an unread stylesheet leaves it in. */
const CSS_CONTROL = CSS_DOC.replace(/<defs>[\s\S]*?<\/defs>/, '')

/** Twemoji's own face: one arc, and no `z` to close it. */
const FACE = 'M36 18c0 9.941-8.059 18-18 18S0 27.941 0 18 8.059 0 18 0s18 8.059 18 18'

const smiley = (d: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
  <path fill="#ffdb3d" d="${d}"/>
  <ellipse cx="12" cy="15" rx="2.4" ry="3.4" fill="#1a1a1f"/>
  <ellipse cx="24" cy="15" rx="2.4" ry="3.4" fill="#1a1a1f"/>
  <path fill="#1a1a1f" d="M18 29c-4.2 0-7.7-2.6-8.7-6h17.4c-1 3.4-4.5 6-8.7 6"/>
</svg>`

/** Two rings, wound the same way - the case the two fill rules genuinely disagree about. */
const rings = (rule: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path fill="#007a80" fill-rule="${rule}" d="M6 6 H94 V94 H6 Z M32 32 H68 V68 H32 Z"/>
</svg>`

/** A square document, so a fit into a tall box has something to do. */
const fitted = (aspect: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60" preserveAspectRatio="${aspect}">
  <rect x="1" y="1" width="58" height="58" fill="#ffeb66"/>
  <circle cx="30" cy="30" r="20" fill="#007a80"/>
  <path d="M14 30 H46" stroke="#172147" stroke-width="3"/>
</svg>`

/** One definition, three sizes - and a dash, in the document's units. */
const USE_DOC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 90">
  <defs>
    <symbol id="pin" viewBox="0 0 24 24">
      <path fill="#cc1f47" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z"/>
      <circle cx="12" cy="9" r="2.6" fill="#ffeb66"/>
    </symbol>
  </defs>
  <path d="M0 84 H240" stroke="#454f66" stroke-width="2" stroke-dasharray="7 5"/>
  <use href="#pin" x="14" y="44" width="40" height="40"/>
  <use href="#pin" x="78" y="14" width="70" height="70"/>
  <use href="#pin" x="176" y="54" width="30" height="30"/>
</svg>`

/**
 * A document of things the loader does not draw: a clip and a filter it cannot apply, an element
 * it has no lane for, a reference to an id that is not there, and a selector it will not guess
 * at. The rect still draws - which is exactly the problem this section is about, since a drawing
 * that is missing its clip looks like a drawing that never had one.
 */
const NOTES_DOC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">
  <style>.face:hover { fill: #cc1f47 }</style>
  <rect class="face" x="2" y="2" width="56" height="56" fill="#e4e9f2" clip-path="url(#round)"/>
  <circle cx="30" cy="30" r="16" fill="#007a80" filter="url(#blur)"/>
  <text x="14" y="52">label</text>
  <use href="#missing"/>
</svg>`

export function buildSvgFeaturesScene(scene: Scene): SceneContent {
  const root = scene.root

  root.addChild(
    new MSDFText({ x: -520, y: -340, text: 'SVG loader', style: { fontStyle: 'bold', fontSize: 40, color: DARK } }),
  )
  root.addChild(
    caption(
      -520,
      -288,
      'What a document says, read: its stylesheet, its coordinate system, its references - and, printed bottom right, what it says that this does not draw. Every document here arrives non-listening, which is the default.',
    ),
  )

  // --- CSS ------------------------------------------------------------------------------------
  //
  // The pair is the point. The right-hand rect is not an error state anybody would notice from
  // the drawing alone: it is a whole icon in one colour, and that colour is black because that
  // is what SVG's initial fill is.
  {
    const x = COLUMN_X[0]
    const y = ROW_Y[0]
    root.addChild(heading(x, y, 'Paint said in CSS'))
    root.addChild(caption(x, y + HEADING_TO_CAPTION, '<style> rules resolved onto the elements carrying the class'))
    const art = y + CAPTION_TO_ART + 22
    place(root, CSS_DOC, x, art, 130, 130)
    place(root, CSS_CONTROL, x + 165, art, 130, 130)
    root.addChild(tag(x, art + 140, 'the rules applied', TEAL))
    root.addChild(tag(x + 165, art + 140, 'the same document, no <style>', CRIMSON))
  }

  // --- an open subpath -------------------------------------------------------------------------
  {
    const x = COLUMN_X[1]
    const y = ROW_Y[0]
    root.addChild(heading(x, y, 'An unclosed subpath'))
    root.addChild(caption(x, y + HEADING_TO_CAPTION, 'the face is one arc with no `z`; filling closes it'))
    const art = y + CAPTION_TO_ART + 22
    place(root, smiley(FACE), x, art, 130, 130)
    place(root, smiley(`${FACE}Z`), x + 165, art, 130, 130)
    root.addChild(tag(x, art + 140, 'as written', TEAL))
    root.addChild(tag(x + 165, art + 140, 'with the `z` added', SLATE))
  }

  // --- fill-rule -------------------------------------------------------------------------------
  //
  // Both rings run the same way round. Under nonzero the inner one adds winding rather than
  // cancelling it, so the region is solid; under even-odd it is inside another ring and is a hole.
  {
    const x = COLUMN_X[2]
    const y = ROW_Y[0]
    root.addChild(heading(x, y, 'fill-rule'))
    root.addChild(caption(x, y + HEADING_TO_CAPTION, 'two rings wound the same way, read by each rule'))
    const art = y + CAPTION_TO_ART + 22
    place(root, rings('nonzero'), x, art, 130, 130)
    place(root, rings('evenodd'), x + 165, art, 130, 130)
    root.addChild(tag(x, art + 140, "'nonzero' - the default, as in SVG", SLATE))
    root.addChild(tag(x + 165, art + 140, "'evenodd' - the inner ring is a hole", SLATE))
  }

  // --- the fit ---------------------------------------------------------------------------------
  //
  // One 60x60 document into three 88x150 boxes. The frames are drawn so the box being fitted TO
  // is visible: 'none' stretches to it, 'meet' fits inside it and centres, and naming a corner
  // puts the spare space at the other end.
  {
    const x = COLUMN_X[1]
    const y = ROW_Y[1]
    root.addChild(heading(x, y, 'fit, and preserveAspectRatio'))
    root.addChild(
      caption(x, y + HEADING_TO_CAPTION, 'one square document into three tall boxes, by what each document declares'),
    )
    const art = y + CAPTION_TO_ART + 22
    const modes = [
      { aspect: 'xMidYMid meet', label: 'meet (default)' },
      { aspect: 'none', label: 'none - stretch' },
      { aspect: 'xMinYMin meet', label: 'xMinYMin meet' },
    ]
    modes.forEach((mode, i) => {
      const boxX = x + i * 108
      root.addChild(frame(boxX, art, 88, 150))
      place(root, fitted(mode.aspect), boxX, art, 88, 150)
      root.addChild(tag(boxX, art + 158, mode.label))
    })
  }

  // --- <use>, <symbol> and a dash ----------------------------------------------------------------
  {
    const x = COLUMN_X[0]
    const y = ROW_Y[1]
    root.addChild(heading(x, y, '<use> and <symbol>'))
    root.addChild(caption(x, y + HEADING_TO_CAPTION, "one definition at three sizes, each mapping the symbol's own viewBox"))
    const art = y + CAPTION_TO_ART + 22
    place(root, USE_DOC, x, art, 300, 112)
    root.addChild(tag(x, art + 122, 'the baseline is stroke-dasharray="7 5", scaled with the geometry'))
  }

  // --- notes -------------------------------------------------------------------------------------
  //
  // The document draws; what it asked for and did not get is on `notes`. Printed here rather than
  // logged, because the claim is that an application can SEE this - a group that is missing its
  // clip is otherwise indistinguishable from a group that never had one.
  {
    const x = COLUMN_X[2]
    const y = ROW_Y[1]
    root.addChild(heading(x, y, 'What it could not read'))
    root.addChild(caption(x, y + HEADING_TO_CAPTION, 'doc.notes, printed - the drawing alone would not say'))
    const art = y + CAPTION_TO_ART + 22
    const doc = place(root, NOTES_DOC, x, art, 110, 110)
    doc.notes.forEach((note, i) => {
      root.addChild(tag(x + 128, art + i * 19, `${note.detail}  x${note.count}`, DARK))
      root.addChild(tag(x + 128, art + i * 19 + 9, note.kind, `${SLATE}99`))
    })
    root.addChild(tag(x, art + 120, `${doc.notes.length} notes, from a document that still drew`, CRIMSON))
  }

  return {}
}
