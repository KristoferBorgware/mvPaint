// The names a raw input event is dispatched under.
//
// Input arrives through the Pointer Events API alone - one code path covering mouse, pen
// and touch - so the pointer-family name is the canonical one and always fires. Alongside
// it, the name for the device that produced the event fires too, letting a handler be as
// specific or as general as it wants: on('pointerdown') hears every device, on('mousedown')
// only a mouse or pen, on('touchstart') only a finger.
//
// Pen groups with mouse rather than touch: it is a precise, hovering pointer, and code that
// asks for mouse behaviour wants it to apply to a stylus.
//
// Some aliases have no DOM event of the same name behind them - 'mousecancel' and the
// touch-family hover names (touchover/touchout/touchenter/touchleave). They exist because
// the situations they describe are real here: a mouse pointer can be cancelled, and a
// finger dragging across the canvas does cross from one shape to another. They are
// dispatched from hit-testing, not forwarded from the DOM.
//
// click/tap and dblclick/dbltap have no DOM event behind them either - they are synthesized
// from press/release pairs by the input layer, which is also what decides how far a pointer
// may travel and how long two clicks may be apart and still count.

export type PointerDevice = 'mouse' | 'touch'

/** The canonical, always-dispatched name for each thing the input layer reports. */
export type PointerAction =
  | 'pointerdown'
  | 'pointermove'
  | 'pointerup'
  | 'pointercancel'
  | 'pointerover'
  | 'pointerout'
  | 'pointerenter'
  | 'pointerleave'
  | 'pointerclick'
  | 'pointerdblclick'

export const POINTER_ACTIONS: readonly PointerAction[] = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'pointerclick',
  'pointerdblclick',
]

const ALIASES: Record<PointerAction, Record<PointerDevice, string>> = {
  pointerdown: { mouse: 'mousedown', touch: 'touchstart' },
  pointermove: { mouse: 'mousemove', touch: 'touchmove' },
  pointerup: { mouse: 'mouseup', touch: 'touchend' },
  pointercancel: { mouse: 'mousecancel', touch: 'touchcancel' },
  pointerover: { mouse: 'mouseover', touch: 'touchover' },
  pointerout: { mouse: 'mouseout', touch: 'touchout' },
  pointerenter: { mouse: 'mouseenter', touch: 'touchenter' },
  pointerleave: { mouse: 'mouseleave', touch: 'touchleave' },
  pointerclick: { mouse: 'click', touch: 'tap' },
  pointerdblclick: { mouse: 'dblclick', touch: 'dbltap' },
}

// Built once here so dispatching is a table lookup returning a shared array, rather than
// assembling a fresh pair of names on every pointer move.
const NAMES = {} as Record<PointerAction, Record<PointerDevice, readonly string[]>>
for (const action of POINTER_ACTIONS) {
  NAMES[action] = {
    mouse: [action, ALIASES[action].mouse],
    touch: [action, ALIASES[action].touch],
  }
}

/** Which alias family a raw event's `pointerType` belongs to. */
export function deviceFor(pointerType: string): PointerDevice {
  return pointerType === 'touch' ? 'touch' : 'mouse'
}

/** The canonical name plus the device alias, in dispatch order. Shared - do not mutate. */
export function eventNamesFor(action: PointerAction, device: PointerDevice): readonly string[] {
  return NAMES[action][device]
}

/** Types that fire under one name whatever the device produced them. */
export const DEVICE_INDEPENDENT_EVENTS: readonly string[] = [
  'wheel',
  'contextmenu',
  'gotpointercapture',
  'lostpointercapture',
]

// Everything that can only be resolved by working out which node is under the pointer, and
// so costs a hit-test on every pointer move. Derived from the table above rather than
// listed by hand, so it cannot fall out of step with it.
const HOVER_ACTIONS: readonly PointerAction[] = [
  'pointermove',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
]

/** See HOVER_ACTIONS - the types whose delivery depends on per-move hit-testing. */
export const HOVER_EVENTS: ReadonlySet<string> = new Set(
  HOVER_ACTIONS.flatMap((action) => [...NAMES[action].mouse, ...NAMES[action].touch]),
)
