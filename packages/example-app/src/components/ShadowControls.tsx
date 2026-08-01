import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, FormControlLabel, Slider, Stack, Switch, Typography } from '@mui/material'
import BlurOnIcon from '@mui/icons-material/BlurOn'
import { parseColor, Text, type RGBA, type Shape } from '@mvpaint/engine'

/** The shadow fields this panel edits, in UI units (colour as a hex string). */
interface ShadowUi {
  enabled: boolean
  offsetX: number
  offsetY: number
  blur: number
  spread: number
  opacity: number
  color: string
  forStroke: boolean
}

const DEFAULTS: ShadowUi = {
  enabled: false,
  offsetX: 12,
  offsetY: 16,
  blur: 24,
  spread: 0,
  opacity: 0.5,
  color: '#000000',
  forStroke: true,
}

function hexToRgb(hex: string): RGBA {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}

function rgbToHex(color: RGBA): string {
  const byte = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(color[0])}${byte(color[1])}${byte(color[2])}`
}

/**
 * Reads a node's current shadow back into UI terms. Text keeps its shadow as per-run
 * styling rather than on the shape-level shadow* properties, so it reads from its first
 * run - and has no blur, spread or stroke option of its own, which stay at whatever the
 * panel last showed rather than snapping to a default the node never had.
 */
function readShadow(node: Shape, fallback: ShadowUi): ShadowUi {
  if (node instanceof Text) {
    const shadow = node.runs[0]?.style?.shadow
    if (!shadow) return { ...fallback, enabled: false }
    return {
      ...fallback,
      enabled: true,
      offsetX: shadow.offsetX,
      offsetY: shadow.offsetY,
      opacity: shadow.opacity ?? 1,
      // The style may hold either form; the picker wants a hex, so it goes through the parser
      // rather than assuming the tuple.
      color: rgbToHex(parseColor(shadow.color)),
    }
  }
  return {
    enabled: node.hasShadow(),
    offsetX: node.shadowOffsetX,
    offsetY: node.shadowOffsetY,
    blur: node.shadowBlur,
    spread: node.shadowSpread,
    opacity: node.shadowOpacity,
    color: rgbToHex(node.shadowColor),
    forStroke: node.shadowForStrokeEnabled,
  }
}

function applyShadow(node: Shape, ui: ShadowUi): void {
  const color = hexToRgb(ui.color)
  if (node instanceof Text) {
    node.setRuns(
      node.runs.map((run) => ({
        ...run,
        style: {
          ...run.style,
          shadow: ui.enabled
            ? { color, offsetX: ui.offsetX, offsetY: ui.offsetY, opacity: ui.opacity }
            : undefined,
        },
      })),
    )
    return
  }
  node.shadowEnabled = ui.enabled
  node.shadowColor = color
  node.shadowOffsetX = ui.offsetX
  node.shadowOffsetY = ui.offsetY
  node.shadowBlur = ui.blur
  node.shadowSpread = ui.spread
  node.shadowOpacity = ui.opacity
  node.shadowForStrokeEnabled = ui.forStroke
}

interface ShadowControlsProps {
  selected: readonly Shape[]
  /** Called after editing a Text node, whose runs need the text lane to re-shape them. */
}

/**
 * Shadow editor for the current selection, kept in sync BOTH ways: selecting a shape loads
 * its actual values into the controls, and moving a control writes back to the selection.
 *
 * The two directions are deliberately not driven by the same effect. Applying keys off an
 * edit counter that only user interaction bumps, so loading a shape's values can never be
 * mistaken for an edit - otherwise selecting several shapes at once would immediately stamp
 * the first one's shadow onto all of them.
 */
export function ShadowControls({ selected }: ShadowControlsProps) {
  const [ui, setUi] = useState<ShadowUi>(DEFAULTS)
  const [editSeq, setEditSeq] = useState(0)
  const uiRef = useRef(ui)
  const selectedRef = useRef(selected)
  uiRef.current = ui
  selectedRef.current = selected

  // Selection -> controls. Multi-selection shows the first node's values, which is also the
  // one the transformer orients itself to.
  useEffect(() => {
    const first = selected[0]
    if (!first) return
    setUi(readShadow(first, uiRef.current))
  }, [selected])

  // Controls -> selection, on user edits only. Editing a Text rewrites its runs, which the
  // engine notices on its own - the host used to have to poke the renderer afterwards.
  useEffect(() => {
    if (editSeq === 0) return
    for (const node of selectedRef.current) applyShadow(node, uiRef.current)
  }, [editSeq])

  const edit = useCallback((patch: Partial<ShadowUi>) => {
    setUi((current) => ({ ...current, ...patch }))
    setEditSeq((n) => n + 1)
  }, [])

  const empty = selected.length === 0
  const textOnly = !empty && selected.every((node) => node instanceof Text)

  return (
    <Stack spacing={1}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={ui.enabled}
            onChange={(e) => edit({ enabled: e.target.checked })}
            disabled={empty}
          />
        }
        label={
          <Stack direction="row" spacing={0.5} alignItems="center">
            <BlurOnIcon fontSize="small" />
            <Typography variant="body2">Shadow</Typography>
          </Stack>
        }
      />

      {empty ? (
        <Typography variant="caption" color="text.secondary">
          Select a shape to give it a shadow.
        </Typography>
      ) : (
        <Stack spacing={1}>
          <Typography variant="caption" color="text.secondary">
            Offset: {ui.offsetX.toFixed(0)}, {ui.offsetY.toFixed(0)}
          </Typography>
          <Slider
            aria-label="Shadow offset X"
            value={ui.offsetX}
            min={-60}
            max={60}
            step={1}
            onChange={(_, v) => edit({ offsetX: v as number })}
            disabled={!ui.enabled}
          />
          <Slider
            aria-label="Shadow offset Y"
            value={ui.offsetY}
            min={-60}
            max={60}
            step={1}
            onChange={(_, v) => edit({ offsetY: v as number })}
            disabled={!ui.enabled}
          />

          <Typography variant="caption" color="text.secondary">
            Blur: {ui.blur.toFixed(0)} · Spread: {ui.spread.toFixed(0)}
            {textOnly && ' (text ignores both)'}
          </Typography>
          <Slider
            aria-label="Shadow blur"
            value={ui.blur}
            min={0}
            max={80}
            step={1}
            onChange={(_, v) => edit({ blur: v as number })}
            disabled={!ui.enabled || textOnly}
          />
          <Slider
            aria-label="Shadow spread"
            value={ui.spread}
            min={-30}
            max={40}
            step={1}
            onChange={(_, v) => edit({ spread: v as number })}
            disabled={!ui.enabled || textOnly}
          />

          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
              Opacity: {ui.opacity.toFixed(2)}
            </Typography>
            <Box
              component="input"
              type="color"
              aria-label="Shadow color"
              value={ui.color}
              onChange={(e) => edit({ color: e.target.value })}
              disabled={!ui.enabled}
              sx={{ width: 28, height: 28, p: 0, border: 'none', borderRadius: 1, backgroundColor: 'transparent' }}
            />
          </Stack>
          <Slider
            aria-label="Shadow opacity"
            value={ui.opacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(_, v) => edit({ opacity: v as number })}
            disabled={!ui.enabled}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={ui.forStroke}
                onChange={(e) => edit({ forStroke: e.target.checked })}
                disabled={!ui.enabled || textOnly}
              />
            }
            label={<Typography variant="body2">Shadow for stroke</Typography>}
          />
          <Typography variant="caption" color="text.secondary">
            Off casts the shadow from the fill only, skipping the stroke ring - a thick
            decorative outline otherwise widens the shadow with it. No effect on Text, which
            duplicates its glyphs rather than blurring a silhouette.
          </Typography>
        </Stack>
      )}
    </Stack>
  )
}
