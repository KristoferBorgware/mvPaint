import { useRef, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  Paper,
  Slider,
  Stack,
  Typography,
} from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import ZoomInIcon from '@mui/icons-material/ZoomIn'
import CropFreeIcon from '@mui/icons-material/CropFree'
import type { PickableNode } from '@mvpaint/engine'
import { WebGPUCanvas, type WebGPUCanvasHandle } from './components/WebGPUCanvas'

export default function App() {
  const [speed, setSpeed] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [cullMargin, setCullMargin] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PickableNode | null>(null)
  const canvasRef = useRef<WebGPUCanvasHandle>(null)

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* WebGPU render surface fills the window */}
      <WebGPUCanvas
        ref={canvasRef}
        speed={speed}
        zoom={zoom}
        onZoomChange={setZoom}
        cullMargin={cullMargin}
        onError={setError}
        onSelect={setSelected}
      />

      {/* Floating control panel */}
      <Paper
        elevation={6}
        sx={{
          position: 'absolute',
          left: 24,
          bottom: 24,
          right: 24,
          maxWidth: 420,
          p: 2.5,
          borderRadius: 3,
          backdropFilter: 'blur(8px)',
          backgroundColor: 'rgba(30, 30, 30, 0.8)',
        }}
      >
        <Typography variant="h6" gutterBottom>
          WebGPU 2D Shapes
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        ) : (
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
                Shrinks or grows the viewport-culling rectangle - negative values cull
                more aggressively, so any popping at the view edge shows up sooner.
              </Typography>
            </Stack>

            <Stack spacing={0.5}>
              <Typography variant="body2" color="text.secondary">
                Selection
              </Typography>
              {selected ? (
                <Chip
                  size="small"
                  label={`${selected.constructor.name}${selected.name ? ` "${selected.name}"` : ''}`}
                  onDelete={() => canvasRef.current?.clearSelection()}
                  color="primary"
                  variant="outlined"
                  sx={{ alignSelf: 'flex-start' }}
                />
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Nothing selected - click or tap a shape.
                </Typography>
              )}
            </Stack>

            <Typography variant="caption" color="text.secondary">
              Gradient-filled and stroked shapes in the Z=0 plane, viewed through a 2D
              orthographic camera. Drag to pan, scroll or pinch to zoom, click/tap to
              select, Escape to deselect.
            </Typography>
          </Stack>
        )}
      </Paper>
    </Box>
  )
}
