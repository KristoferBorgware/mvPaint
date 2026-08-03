import { List, ListItemButton, ListItemText, Stack, Typography } from '@mui/material'
import type { ExampleScene } from '../scenes'

interface ScenePickerProps {
  scenes: readonly ExampleScene[]
  activeId: string
  onSelect: (scene: ExampleScene) => void
}

/**
 * The example list, shared verbatim by the desktop side pane and the mobile drawer - the
 * only difference between the two is the container it sits in.
 */
export function ScenePicker({ scenes, activeId, onSelect }: ScenePickerProps) {
  return (
    <Stack sx={{ height: '100%' }}>
      <Stack sx={{ px: 2, pt: 2, pb: 1 }}>
        <Typography variant="subtitle1">Examples</Typography>
        <Typography variant="caption" color="text.secondary">
          Selecting a scene unloads the current one, then builds the new one and resets the view to the origin at 1.00×, which is the zoom every scene is laid out for.
        </Typography>
      </Stack>

      <List sx={{ overflowY: 'auto', flex: 1, py: 0 }}>
        {scenes.map((scene) => (
          <ListItemButton
            key={scene.id}
            selected={scene.id === activeId}
            onClick={() => onSelect(scene)}
            sx={{ alignItems: 'flex-start', py: 1.5 }}
          >
            <ListItemText
              primary={scene.title}
              secondary={scene.description}
              slotProps={{
                primary: { variant: 'body2', fontWeight: 600 },
                // Descriptions run to a couple of lines, so they need to wrap rather than
                // ellipsize the way a single-line list item would.
                secondary: { variant: 'caption', sx: { display: 'block', mt: 0.5 } },
              }}
            />
          </ListItemButton>
        ))}
      </List>
    </Stack>
  )
}
