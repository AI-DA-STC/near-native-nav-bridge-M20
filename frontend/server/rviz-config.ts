import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* The RViz a robot's setup opens: robot.rviz with ROBOT_ID replaced by the robot's ID, written to
 * server/rviz/robot_<id>.rviz (not in git). RViz names its window after the file, so each robot's window says which
 * robot it is. Your saved ~/.rviz2/default.rviz stays as it is. */

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(SERVER_DIR, 'robot.rviz')
/** The package root, where the laptop terminal types the README's commands */
const PACKAGE_ROOT = resolve(SERVER_DIR, '..', '..')

/** The robot's config, as typed in the laptop terminal: relative to the package root */
export function rvizConfigPath(id: string): string {
  return relative(PACKAGE_ROOT, join(SERVER_DIR, 'rviz', `robot_${id}.rviz`))
}

/** The config for this robot, from the template */
export function robotRviz(id: string): string {
  return readFileSync(TEMPLATE, 'utf8').replaceAll('ROBOT_ID', id)
}

/** Writes the robot's config where rvizConfigPath() says, freshly from the template; returns its path */
export function writeRobotRviz(id: string): string {
  const path = rvizConfigPath(id)
  const file = join(PACKAGE_ROOT, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, robotRviz(id))
  return path
}

/* The ALOHA's Localize step opens aloha.rviz (its own map, laser scan, AMCL's pose and particles, 2D Pose Estimate on
 * /initialpose), written to server/rviz/aloha.rviz like the dogs' configs: fresh every time. */
const ALOHA_TEMPLATE = join(SERVER_DIR, 'aloha.rviz')

/** The ALOHA's config, as typed in its RViz terminal: relative to the package root */
export function alohaRvizPath(): string {
  return relative(PACKAGE_ROOT, join(SERVER_DIR, 'rviz', 'aloha.rviz'))
}

/** RViz on the ALOHA's bridge's ROS_DOMAIN_ID, on its own map */
export function alohaRvizCommand(): string {
  return `ROS_DOMAIN_ID=1 rviz2 -d ${alohaRvizPath()}`
}

/** Writes the ALOHA's config where alohaRvizPath() says, freshly from its template; returns its path */
export function writeAlohaRviz(): string {
  const path = alohaRvizPath()
  const file = join(PACKAGE_ROOT, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, readFileSync(ALOHA_TEMPLATE, 'utf8'))
  return path
}
