// Fleet panel: one card per robot, its mode (colour + word) and one detail line. Open-RMF's
// own Robots panel has the table (battery, level, task); this is the at-a-glance view.

import { Box, Button, Stack, Typography } from '@mui/material';

import { Robot, send, useHub } from './hub';

function detail(r: Robot): string {
  if (!r.detail) return '';
  const d = r.detail.replace(/_/g, ' ');
  return ({ PATROL: `route ${d}`, EXPLORE: `zone ${d}`, REGROUP: `formation ${d}` } as Record<string, string>)[r.mode] || d;
}

// Pale mode colours (IDLE, SITTING) are unreadable as text on the light theme.
function readable(hex: string): string | undefined {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.7 ? undefined : hex;
}

export default function FleetPanel() {
  const { view, busy } = useHub();
  if (!view) return null;
  const running = !!view.mission?.running;
  return (
    <Stack spacing={1} sx={{ p: 1.5, height: '100%', overflow: 'auto' }}>
      {view.robots.map((r) => (
        <Box
          key={r.id}
          sx={{
            position: 'relative',
            border: 1,
            borderColor: 'divider',
            borderRadius: 2,
            pl: 2.5,
            pr: 1.5,
            py: 1,
            overflow: 'hidden',
            '&::before': {
              content: '""',
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 8,
              bgcolor: r.color,
            },
          }}
        >
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">
              M20 · {r.id}
            </Typography>
            {/* Outside a mission only: during one, a stop ends the mission (STOP ALL). */}
            {!running && r.mode !== 'OFFLINE' && (
              <Button size="small" disabled={busy.size > 0} onClick={() => send({ cmd: 'stop', robot: r.id })}>
                Stop
              </Button>
            )}
          </Stack>
          <Typography
            variant="h6"
            fontWeight={800}
            color={readable(r.color) ? undefined : 'text.secondary'}
            sx={{ color: readable(r.color), lineHeight: 1.2 }}
          >
            {r.mode}
          </Typography>
          <Typography variant="body2">{detail(r)}</Typography>
          <Stack direction="row" spacing={1.5} sx={{ mt: 0.5 }}>
            {r.battery != null && (
              <Typography variant="caption" color="text.secondary">
                {Math.round(r.battery * 100)}%
              </Typography>
            )}
            {r.warning && (
              <Typography variant="caption" color="warning.main">
                ⚠ {r.warning}
              </Typography>
            )}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}
