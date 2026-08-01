import { useCallback, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Drawer,
  FormControlLabel,
  IconButton,
  Paper,
  Slider,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import CropFreeIcon from '@mui/icons-material/CropFree'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import TuneIcon from '@mui/icons-material/Tune'
import CloseIcon from '@mui/icons-material/Close'
import CollectionsIcon from '@mui/icons-material/Collections'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera'
import { Shape, type TransformableNode } from '@mvpaint/engine'
import { WebGPUCanvas, type WebGPUCanvasHandle } from './components/WebGPUCanvas'
import { ScenePicker } from './components/ScenePicker'
import { ShadowControls } from './components/ShadowControls'
import { EXAMPLE_SCENES, type ExampleScene } from './scenes'

const SCENE_PANE_WIDTH = 300

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
  const theme = useTheme()
  // The pane is docked beside the canvas on a wide screen and becomes a drawer below it,
  // where giving up 300px of a phone's width to a permanent list would leave little canvas.
  const compact = useMediaQuery(theme.breakpoints.down('md'))
  const [scene, setScene] = useState<ExampleScene>(EXAMPLE_SCENES[0])
  const [scenesOpen, setScenesOpen] = useState(false)
  // Re-picking the scene already showing is a no-op by design, so an explicit reload needs
  // its own signal rather than riding on the scene identity.
  const [reloadToken, setReloadToken] = useState(0)

  const [speed, setSpeed] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [cullMargin, setCullMargin] = useState(0)
  const [uniformCornerScale, setUniformCornerScale] = useState(true)
  // Which render path to ask for, and which one actually happened. They differ whenever
  // 'auto' falls back, which is the case worth being able to see.
  const [backend, setBackend] = useState<'auto' | 'webgpu' | 'webgl2'>('auto')
  const [activePath, setActivePath] = useState<'webgpu' | 'webgl2' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshotBusy, setSnapshotBusy] = useState(false)

  /**
   * Capture, then save it.
   *
   * The two things kept from the version that showed a preview instead are the ones that cost
   * no screen space: the button reads "Capturing..." while it works, and a failure goes to the
   * error banner. Neither is decoration - a capture that fails is otherwise indistinguishable
   * from a capture that saved, which is exactly how this button once came to be reported as
   * broken while it was working.
   */
  const takeSnapshot = async () => {
    setSnapshotBusy(true)
    setError(null)
    try {
      const blob = await canvasRef.current!.captureSnapshot(2)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `mvpaint-${Date.now()}.png`
      link.click()
      // Revoked on the next turn of the loop: the click is synchronous but the fetch the
      // browser does for the download is not. Left un-revoked, each capture pins several
      // megabytes for the life of the page.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (cause) {
      setError(`Snapshot failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setSnapshotBusy(false)
    }
  }
  const [selected, setSelected] = useState<readonly TransformableNode[]>([])
  // Both panels start collapsed - on mobile they otherwise eat most of the screen; the
  // user opts in via the toggle row instead of having them always on.
  const [infoOpen, setInfoOpen] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(false)
  const canvasRef = useRef<WebGPUCanvasHandle>(null)

  // Stable identities so the child effects don't see a new callback every render.
  const handleSelectionChange = useCallback((nodes: readonly TransformableNode[]) => setSelected([...nodes]), [])

  const selectBackend = (next: 'auto' | 'webgpu' | 'webgl2') => {
    // The old path's error - "WebGPU is not supported", say - says nothing about the new one.
    setError(null)
    setActivePath(null)
    setBackend(next)
  }

  const selectScene = (next: ExampleScene) => {
    setScene(next)
    setScenesOpen(false)
  }

  return (
    <Box sx={{ display: 'flex', width: '100%', height: '100%' }}>
      {/* Canvas column: the WebGPU surface plus everything that floats over it. */}
      <Box sx={{ position: 'relative', flex: 1, minWidth: 0, height: '100%' }}>
      <WebGPUCanvas
        ref={canvasRef}
        scene={scene}
        reloadToken={reloadToken}
        speed={speed}
        zoom={zoom}
        onZoomChange={setZoom}
        cullMargin={cullMargin}
        uniformCornerScale={uniformCornerScale}
        backend={backend}
        onError={setError}
        onPathChange={setActivePath}
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
                  Scene: {scene.title}
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<RestartAltIcon />}
                  onClick={() => setReloadToken((t) => t + 1)}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  Reload scene
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Rebuilds the current scene from scratch and re-centres the view, undoing
                  anything dragged, scaled or restyled. The camera zoom is left alone - it's
                  yours, not the scene's.
                </Typography>
                <Button
                  size="small"
                  variant="outlined"
                  disabled={snapshotBusy}
                  startIcon={<PhotoCameraIcon />}
                  onClick={() => void takeSnapshot()}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {snapshotBusy ? 'Capturing...' : 'Save a PNG'}
                </Button>
                <Typography variant="caption" color="text.secondary">
                  Renders the current view again offscreen, at twice the resolution, and saves
                  it. It's a second render rather than a copy of the canvas, so the image can be
                  any size and any region - and the selection frame is left out of it, since
                  handles aren't part of the drawing.
                </Typography>
              </Stack>

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

              <Stack spacing={0.5}>
                <Typography variant="body2">Render path</Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={backend}
                  onChange={(_e, next: 'auto' | 'webgpu' | 'webgl2' | null) => next && selectBackend(next)}
                >
                  <ToggleButton value="auto">Auto</ToggleButton>
                  <ToggleButton value="webgpu">WebGPU</ToggleButton>
                  <ToggleButton value="webgl2">WebGL2</ToggleButton>
                </ToggleButtonGroup>
                <Typography variant="caption" color="text.secondary">
                  {activePath === 'webgl2'
                    ? 'Drawing through the WebGL2 fallback. Every lane is drawn and edges are antialiased (4x MSAA, from the browser\'s multisampled drawing buffer); what differs is scale - per-object records go through a float texture rather than a storage buffer, so this path targets tens of thousands of objects rather than hundreds of thousands.'
                    : activePath === 'webgpu'
                      ? 'Drawing through WebGPU. Pick WebGL2 to see what a machine without it sees.'
                      : 'Auto uses WebGPU and falls back to WebGL2 only if it is unavailable.'}
                </Typography>
              </Stack>

              <ShadowControls selected={selected.filter((node): node is Shape => node instanceof Shape)} />
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
          {/* Only when the pane is a drawer - docked, it is already on screen. */}
          {compact && (
            <IconButton onClick={() => setScenesOpen(true)} aria-label="Show examples" sx={toggleButtonSx}>
              <CollectionsIcon />
            </IconButton>
          )}
        </Stack>
      </Stack>
      </Box>

      {/* The example picker: docked beside the canvas on a wide screen, a drawer below it. */}
      {compact ? (
        <Drawer
          anchor="right"
          open={scenesOpen}
          onClose={() => setScenesOpen(false)}
          slotProps={{ paper: { sx: { width: Math.min(SCENE_PANE_WIDTH, 320) } } }}
        >
          <ScenePicker scenes={EXAMPLE_SCENES} activeId={scene.id} onSelect={selectScene} />
        </Drawer>
      ) : (
        <Box
          component="aside"
          sx={{
            width: SCENE_PANE_WIDTH,
            flexShrink: 0,
            height: '100%',
            borderLeft: 1,
            borderColor: 'divider',
            backgroundColor: 'background.paper',
          }}
        >
          <ScenePicker scenes={EXAMPLE_SCENES} activeId={scene.id} onSelect={selectScene} />
        </Box>
      )}
    </Box>
  )
}
