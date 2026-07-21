import { useState } from 'react'
import {
  Alert,
  Box,
  Paper,
  Slider,
  Stack,
  Typography,
} from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import { WebGPUCanvas } from './components/WebGPUCanvas'

export default function App() {
  const [speed, setSpeed] = useState(1)
  const [error, setError] = useState<string | null>(null)

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* WebGPU render surface fills the window */}
      <WebGPUCanvas speed={speed} onError={setError} />

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
          WebGPU Spinning Cube
        </Typography>

        {error ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        ) : (
          <Stack spacing={1}>
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
            <Typography variant="caption" color="text.secondary">
              Free-fly camera — WASD move, Shift faster, right-mouse look, wheel /
              middle-mouse zoom.
            </Typography>
          </Stack>
        )}
      </Paper>
    </Box>
  )
}
