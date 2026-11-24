import { describe, expect, it } from 'vitest'
import { gridRead } from './ros-checks.ts'

/* What map_grid.py says, as the server reads it: where the map's known part lies, or why there is none */

describe('reading map_grid.py', () => {
  it('takes its JSON line: where the image lies in the map frame', () => {
    const out = '{"x": -11.0, "y": -6.0, "w": 32.0, "h": 22.0, "yaw": 0.0, "cells": [640, 440], "of": [4000, 4000]}\n'
    expect(gridRead(out)).toEqual({ ok: true, x: -11, y: -6, w: 32, h: 22, yaw: 0 })
  })
  it('says why there is no map', () => {
    expect(gridRead('map_grid.py: no map on /map within 40 s (0 publisher(s) of it)\n')).toEqual({ ok: false, reason: 'no map on /map within 40 s (0 publisher(s) of it)' })
    expect(gridRead('Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named rclpy\n')).toEqual({ ok: false, reason: 'ModuleNotFoundError: No module named rclpy' })
    expect(gridRead('')).toEqual({ ok: false, reason: 'map_grid.py printed nothing' })
  })
})
