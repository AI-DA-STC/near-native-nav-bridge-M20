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
