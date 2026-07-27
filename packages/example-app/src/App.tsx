import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  Collapse,
  FormControlLabel,
  IconButton,
  Paper,
  Slider,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import CropFreeIcon from '@mui/icons-material/CropFree'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import TuneIcon from '@mui/icons-material/Tune'
import CloseIcon from '@mui/icons-material/Close'
import BlurOnIcon from '@mui/icons-material/BlurOn'
import { Text, type RGBA, type Shape } from '@mvpaint/engine'
import { WebGPUCanvas, type WebGPUCanvasHandle } from './components/WebGPUCanvas'

function hexToRgb(hex: string): RGBA {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}

const panelSx = {
  p: 2.5,
  borderRadius: 3,
  backdropFilter: 'blur(8px)',
  backgroundColor: 'rgba(30, 30, 30, 0.8)',
}

const toggleButtonSx = {
  backgroundColor: 'rgba(30, 30, 30, 0.8)',
  backdropFilter: 'blur(8px)',
  '&:hover': { backgroundColor: 'rgba(30, 30, 30, 0.9)' },
}

export default function App() {
  const [speed, setSpeed] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [cullMargin, setCullMargin] = useState(0)
  const [uniformCornerScale, setUniformCornerScale] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<readonly Shape[]>([])
  // Both panels start collapsed - on mobile they otherwise eat most of the screen; the
  // user opts in via the toggle row instead of having them always on.
  const [infoOpen, setInfoOpen] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false)
  const canvasRef = useRef<WebGPUCanvasHandle>(null)

  // Stable identity so the canvas's effect doesn't see a new callback every render.
  const handleSelectionChange = useCallback((nodes: readonly Shape[]) => setSelected([...nodes]), [])

  // Shadow controls, mirroring the canvas 2D property names the engine uses (plus spread,
  // borrowed from CSS box-shadow). Offset, colour and opacity are per-frame quad
  // parameters, so dragging those sliders costs nothing; blur and spread re-bake the
  // shape's atlas texture, which is what to watch when judging performance. offsetY is
  // downward-positive, so a shadow falling down-and-right under upper-left light wants a
  // positive offsetX AND offsetY.
  const [shadowEnabled, setShadowEnabled] = useState(false)
  const [shadowOffsetX, setShadowOffsetX] = useState(12)
  const [shadowOffsetY, setShadowOffsetY] = useState(16)
  const [shadowBlur, setShadowBlur] = useState(24)
  const [shadowSpread, setShadowSpread] = useState(0)
  const [shadowOpacity, setShadowOpacity] = useState(0.5)
  const [shadowColor, setShadowColor] = useState('#000000')
  // Mesh shapes only: Text has no rasterized silhouette to blur or grow, so it ignores
  // blur/spread/shadowForStroke and just duplicates its glyphs at the offset.
  const [shadowForStroke, setShadowForStroke] = useState(true)

  const shadowConfig = useMemo(
    () => ({
      offsetX: shadowOffsetX,
      offsetY: shadowOffsetY,
      blur: shadowBlur,
      spread: shadowSpread,
      opacity: shadowOpacity,
      color: hexToRgb(shadowColor),
      forStroke: shadowForStroke,
    }),
    [shadowOffsetX, shadowOffsetY, shadowBlur, shadowSpread, shadowOpacity, shadowColor, shadowForStroke],
  )

  // Only touches the CURRENT selection at the moment a control changes - not on every
  // selection change - so merely clicking a shape never clobbers whatever shadow it
  // already had (e.g. the demo scene's own hand-tuned shadows).
  const selectedRef = useRef<readonly Shape[]>(selected)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])
  useEffect(() => {
    let touchedText = false
    for (const node of selectedRef.current) {
      if (node instanceof Text) {
        // Text carries its shadow as per-run styling rather than through the shape-level
        // shadow* properties, and has no blur of its own - it is an offset duplicate of
        // the glyphs. This panel applies one shadow across every run at once.
        node.setRuns(
          node.runs.map((run) => ({
            ...run,
            style: {
              ...run.style,
              shadow: shadowEnabled
                ? {
                    color: shadowConfig.color,
                    offsetX: shadowConfig.offsetX,
                    offsetY: shadowConfig.offsetY,
                    opacity: shadowConfig.opacity,
                  }
                : undefined,
            },
          })),
        )
        touchedText = true
      } else {
        node.shadowEnabled = shadowEnabled
        node.shadowColor = shadowConfig.color
        node.shadowOffsetX = shadowConfig.offsetX
        node.shadowOffsetY = shadowConfig.offsetY
        node.shadowBlur = shadowConfig.blur
        node.shadowSpread = shadowConfig.spread
        node.shadowOpacity = shadowConfig.opacity
        node.shadowForStrokeEnabled = shadowConfig.forStroke
      }
    }
    if (touchedText) canvasRef.current?.markTextDirty()
  }, [shadowEnabled, shadowConfig])

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* WebGPU render surface fills the window */}
      <WebGPUCanvas
        ref={canvasRef}
        speed={speed}
        zoom={zoom}
        onZoomChange={setZoom}
        cullMargin={cullMargin}
        uniformCornerScale={uniformCornerScale}
        onError={setError}
        onSelectionChange={handleSelectionChange}
      />

      {error && (
        <Alert severity="error" sx={{ position: 'absolute', top: 16, left: 16, right: 16 }}>
          {error}
        </Alert>
      )}

      {/* Floating panels - collapsed by default, shown via the toggle row at the bottom. */}
      <Stack spacing={1.5} sx={{ position: 'absolute', left: 16, bottom: 16, right: 16, maxWidth: 420 }}>
        <Collapse in={controlsOpen}>
          {/* Capped + scrollable: the panel is anchored to the bottom of the screen and
              grows upward, so without a cap its top edge runs off-screen on a short mobile
              viewport - there is no page scroll to reach it, only the panel's own. */}
          <Paper elevation={6} sx={{ ...panelSx, maxHeight: '70vh', overflowY: 'auto' }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="subtitle1">Controls</Typography>
              <IconButton size="small" onClick={() => setControlsOpen(false)} aria-label="Hide controls">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            <Stack spacing={1.5}>
              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  Rotation speed: {speed.toFixed(2)}×
                </Typography>
                <Stack direction="row" spacing={2} alignItems="center">
                  <SpeedIcon fontSize="small" />
                  <Slider
                    aria-label="Rotation speed"
                    value={speed}
                    min={0}
                    max={5}
                    step={0.05}
                    onChange={(_, value) => setSpeed(value as number)}
                    valueLabelDisplay="auto"
                  />
                </Stack>
              </Stack>

              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  Camera zoom: {zoom.toFixed(2)}×
                </Typography>
                <Stack direction="row" spacing={2} alignItems="center">
                  <ZoomInIcon fontSize="small" />
                  <Slider
                    aria-label="Camera zoom"
                    value={Math.min(zoom, 10)}
                    min={0.05}
                    max={10}
                    step={0.05}
                    onChange={(_, value) => setZoom(value as number)}
                    valueLabelDisplay="auto"
                  />
                </Stack>
              </Stack>

              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  Cull margin (debug): {cullMargin.toFixed(0)}px
                </Typography>
                <Stack direction="row" spacing={2} alignItems="center">
                  <CropFreeIcon fontSize="small" />
                  <Slider
                    aria-label="Viewport cull margin"
                    value={cullMargin}
                    min={-300}
                    max={300}
                    step={10}
                    onChange={(_, value) => setCullMargin(value as number)}
                    valueLabelDisplay="auto"
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Shrinks or grows the viewport-culling rectangle (drawn as an orange
                  outline whenever it isn't 0) - negative values cull more aggressively,
                  so any popping at the view edge shows up sooner.
                </Typography>
              </Stack>

              <Stack spacing={0.5}>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={uniformCornerScale}
                      onChange={(e) => setUniformCornerScale(e.target.checked)}
                    />
                  }
                  label={<Typography variant="body2">Uniform corner scaling</Typography>}
                />
                <Typography variant="caption" color="text.secondary">
                  Corner anchors keep the aspect ratio; edge anchors always scale one axis.
                  Hold shift while dragging a corner to invert this, alt to scale about the
                  center.
                </Typography>
              </Stack>

              <Stack spacing={1}>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={shadowEnabled}
                      onChange={(e) => setShadowEnabled(e.target.checked)}
                      disabled={selected.length === 0}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <BlurOnIcon fontSize="small" />
                      <Typography variant="body2">Shadow</Typography>
                    </Stack>
                  }
                />
                {selected.length === 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    Select a shape to give it a shadow.
                  </Typography>
                ) : (
                  <Stack spacing={1}>
                    <Typography variant="caption" color="text.secondary">
                      Offset: {shadowOffsetX.toFixed(0)}, {shadowOffsetY.toFixed(0)}
                    </Typography>
                    <Slider
                      aria-label="Shadow offset X"
                      value={shadowOffsetX}
                      min={-60}
                      max={60}
                      step={1}
                      onChange={(_, v) => setShadowOffsetX(v as number)}
                      disabled={!shadowEnabled}
                    />
                    <Slider
                      aria-label="Shadow offset Y"
                      value={shadowOffsetY}
                      min={-60}
                      max={60}
                      step={1}
                      onChange={(_, v) => setShadowOffsetY(v as number)}
                      disabled={!shadowEnabled}
                    />

                    <Typography variant="caption" color="text.secondary">
                      Blur: {shadowBlur.toFixed(0)} · Spread: {shadowSpread.toFixed(0)}
                    </Typography>
                    <Slider
                      aria-label="Shadow blur"
                      value={shadowBlur}
                      min={0}
                      max={80}
                      step={1}
                      onChange={(_, v) => setShadowBlur(v as number)}
                      disabled={!shadowEnabled}
                    />
                    <Slider
                      aria-label="Shadow spread"
                      value={shadowSpread}
                      min={-30}
                      max={40}
                      step={1}
                      onChange={(_, v) => setShadowSpread(v as number)}
                      disabled={!shadowEnabled}
                    />

                    <Stack direction="row" spacing={2} alignItems="center">
                      <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
                        Opacity: {shadowOpacity.toFixed(2)}
                      </Typography>
                      <Box
                        component="input"
                        type="color"
                        aria-label="Shadow color"
                        value={shadowColor}
                        onChange={(e) => setShadowColor(e.target.value)}
                        disabled={!shadowEnabled}
                        sx={{
                          width: 28,
                          height: 28,
                          p: 0,
                          border: 'none',
                          borderRadius: 1,
                          backgroundColor: 'transparent',
                        }}
                      />
                    </Stack>
                    <Slider
                      aria-label="Shadow opacity"
                      value={shadowOpacity}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(_, v) => setShadowOpacity(v as number)}
                      disabled={!shadowEnabled}
                    />

                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={shadowForStroke}
                          onChange={(e) => setShadowForStroke(e.target.checked)}
                          disabled={!shadowEnabled}
                        />
                      }
                      label={<Typography variant="body2">Shadow for stroke</Typography>}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Off casts the shadow from the fill only, skipping the stroke ring - a
                      thick decorative outline otherwise widens the shadow with it. No
                      effect on a selected Text, which duplicates its glyphs rather than
                      blurring a silhouette.
                    </Typography>
                  </Stack>
                )}
              </Stack>
            </Stack>
          </Paper>
        </Collapse>

        <Collapse in={infoOpen}>
          <Paper elevation={6} sx={panelSx}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="h6">WebGPU 2D Shapes</Typography>
              <IconButton size="small" onClick={() => setInfoOpen(false)} aria-label="Hide info">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            <Stack spacing={1.5}>
              <Stack spacing={0.5}>
                <Typography variant="body2" color="text.secondary">
                  Selection
                </Typography>
                {selected.length > 0 ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {selected.slice(0, 4).map((node, i) => (
                      <Chip
                        key={`${node.name}-${i}`}
                        size="small"
                        label={node.name || node.constructor.name}
                        color="primary"
                        variant="outlined"
                      />
                    ))}
                    {selected.length > 4 && (
                      <Chip size="small" label={`+${selected.length - 4} more`} variant="outlined" />
                    )}
                    <Chip
                      size="small"
                      label="clear"
                      onDelete={() => canvasRef.current?.clearSelection()}
                      sx={{ alignSelf: 'flex-start' }}
                    />
                  </Stack>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    Nothing selected - click a shape, or drag a box around several.
                  </Typography>
                )}
              </Stack>

              <Typography variant="caption" color="text.secondary">
                Gradient-filled and stroked shapes in the Z=0 plane, viewed through a 2D
                orthographic camera. Drag a shape to move it; drag empty space to rubber-band
                a selection (on touch, press and hold first). Shift extends the selection.
                Scroll or pinch to zoom, middle-drag or space+drag to pan, Escape to deselect.
              </Typography>
            </Stack>
          </Paper>
        </Collapse>

        <Stack direction="row" spacing={1}>
          <IconButton
            onClick={() => setInfoOpen((open) => !open)}
            aria-label={infoOpen ? 'Hide info' : 'Show info'}
            sx={toggleButtonSx}
          >
            <InfoOutlinedIcon />
          </IconButton>
          <IconButton
            onClick={() => setControlsOpen((open) => !open)}
            aria-label={controlsOpen ? 'Hide controls' : 'Show controls'}
            sx={toggleButtonSx}
          >
            <TuneIcon />
          </IconButton>
        </Stack>
      </Stack>
    </Box>
  )
}
