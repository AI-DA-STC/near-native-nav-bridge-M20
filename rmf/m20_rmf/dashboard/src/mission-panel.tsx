// Mission panel: what the mission is doing, what it needs from the operator, and how to
// start one. Stopping is the red STOP ALL button, always on screen.

import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';

import { clearError, Mission, send, useHub } from './hub';

const FINAL: Record<string, string> = {
  complete: 'Mission complete',
  aborted: 'Mission stopped',
  failed: 'Mission failed',
  lost: 'Mission lost',
};

function elapsed(s: number): string {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function signalData(m: Mission, event: string) {
  return (m.signals || []).find((s) => s.event === event)?.data || {};
}

export default function MissionPanel() {
  const { connected, view, missions, error, busy } = useHub();
  const [file, setFile] = useState('');
  useEffect(() => {
    if (!missions.some((m) => m.file === file)) setFile(missions[0]?.file || '');
  }, [missions, file]);

  if (!connected || !view) {
    return (
      <Alert severity="error" sx={{ m: 1 }}>
        No connection to the M20 hub. Stop robots with Ctrl-C in the tmux <b>mission</b> pane or
        <code> m20 stop</code>.
      </Alert>
    );
  }
  const m = view.mission || {};
  const running = !!m.running;
  const w = m.waiting;
  const left = w && w.seconds ? Math.max(0, Math.round(w.seconds - (view.t - w.since))) : null;
  const offered = (running ? m.signals || [] : []).filter(
    (s) => !(w && w.event === s.event) && !(m.used || []).includes(s.event),
  );
  const pending = busy.size > 0;

  return (
    <Stack spacing={1.5} sx={{ p: 1.5, height: '100%', overflow: 'auto' }}>
      {error && (
        <Alert severity="error" onClose={clearError}>
          {error}
        </Alert>
      )}

      <Box>
        <Typography variant="overline" color="text.secondary">
          {m.name || 'mission'}
        </Typography>
        <Typography variant="h5" fontWeight={700} lineHeight={1.2}>
          {running ? m.phase || 'Starting…' : FINAL[m.state || ''] || 'No mission running'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {running && m.started ? elapsed(view.t - m.started) : m.error || (m.state === 'aborted' && m.reason) || ''}
        </Typography>
      </Box>

      {!running && (
        <Stack direction="row" spacing={1} alignItems="center">
          <Select
            size="small"
            value={file}
            displayEmpty
            onChange={(e) => setFile(e.target.value)}
            sx={{ flex: 1 }}
          >
            {missions.length === 0 && (
              <MenuItem value="" disabled>
                no mission fits this site
              </MenuItem>
            )}
            {missions.map((x) => (
              <MenuItem key={x.file} value={x.file}>
                {x.name}
              </MenuItem>
            ))}
          </Select>
          <Button
            variant="contained"
            disabled={!file || !view.host?.up || pending}
            title={view.host?.up ? 'run the selected mission' : 'no mission host: the tmux "mission" pane'}
            onClick={() => send({ cmd: 'start', file })}
          >
            Start
          </Button>
        </Stack>
      )}

      {w && (
        <Alert
          severity="warning"
          variant="outlined"
          action={
            w.event && (
              <Button
                variant="contained"
                color="warning"
                disabled={pending}
                onClick={() => send({ cmd: 'signal', event: w.event, data: signalData(m, w.event) })}
              >
                {w.label}
              </Button>
            )
          }
        >
          <Typography fontWeight={600}>{w.prompt || w.label}</Typography>
          {left != null && <Typography variant="body2">continues by itself in {left} s</Typography>}
        </Alert>
      )}

      {Object.entries(view.inspections || {}).map(([id, ins]) => (
        <Alert
          key={id}
          severity="warning"
          variant="outlined"
          action={
            <Stack direction="row" spacing={1}>
              <Button disabled={pending} onClick={() => send({ cmd: 'verdict', id, verdict: 'clear' })}>
                Clear
              </Button>
              <Button
                variant="contained"
                color="warning"
                disabled={pending}
                onClick={() => send({ cmd: 'verdict', id, verdict: 'threat' })}
              >
                Threat
              </Button>
            </Stack>
          }
        >
          <Typography fontWeight={600}>
            {ins.robot} is inspecting {ins.label}
          </Typography>
          <Typography variant="body2">what does it find?</Typography>
        </Alert>
      ))}

      {offered.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
          <Typography variant="overline" color="text.secondary">
            Signal
          </Typography>
          {offered.map((s) =>
            (m.queued || []).includes(s.event) ? (
              <Chip key={s.event} label={`✓ ${s.label || s.event} (queued)`} />
            ) : (
              <Button
                key={s.event}
                variant="outlined"
                size="small"
                disabled={pending}
                onClick={() => send({ cmd: 'signal', event: s.event, data: s.data || {} })}
              >
                {s.label || s.event}
              </Button>
            ),
          )}
        </Stack>
      )}

      <Divider />
      <Typography variant="overline" color="text.secondary">
        Log
      </Typography>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, fontSize: 13 }}>
        {[...(view.timeline || [])].reverse().map((e, i) => (
          <Box
            component="li"
            key={i}
            sx={{
              display: 'flex',
              gap: 1.5,
              color: e.kind === 'alert' ? 'warning.main' : e.kind === 'signal' ? '#b45309' : 'text.primary',
            }}
          >
            <Box component="time" sx={{ color: 'text.secondary', minWidth: 60, fontVariantNumeric: 'tabular-nums' }}>
              {new Date(e.t * 1000).toLocaleTimeString([], { hour12: false })}
            </Box>
            {e.text}
          </Box>
        ))}
      </Box>
    </Stack>
  );
}
