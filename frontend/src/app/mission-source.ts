import { connectMission, createReplaySource } from '@/shared/api'

/* Where the app's mission snapshots come from, connected once before the first render. This round it is the scenario
 * replay of the brief's 16 states (?state=7 opens on one of them); the mission backend's live source plugs in here. */

const state = Number(new URLSearchParams(window.location.search).get('state')) || undefined
connectMission(createReplaySource({ state }))
