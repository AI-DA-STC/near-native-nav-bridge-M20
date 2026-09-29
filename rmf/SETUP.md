# Setup — reproducing the `dev-openrmf` state on another laptop

Checking out `dev-openrmf` gives you the code. It does **not** give you the installed
Open-RMF, built containers and workspaces, SSH keys, robot-side profile or your own
network settings. This file lists every such step, in order. Work in progress: update it
when a step changes. Day-to-day operation is in [RUNBOOK.md](RUNBOOK.md); what changed
and why is in [CHANGELOG.md](CHANGELOG.md).

State reached on the reference laptop (2026-09-29): Ubuntu 22.04 host with ROS 2 Humble
installed (not used by this stack), Docker 29.8, VS Code 1.138 + Dev Containers
0.469, tmux 3.2a.

---

## 1. Host prerequisites (once per laptop)

| Need | Why | Install |
|---|---|---|
| Docker (user in the `docker` group) | both devcontainers | docs.docker.com, then `sudo usermod -aG docker $USER` and re-login |
| VS Code + **Dev Containers** extension | builds/opens the devcontainers; its bundled CLI is used by `scripts/m20_stack.sh` | code.visualstudio.com; extension `ms-vscode-remote.remote-containers` |
| tmux | the one-command launcher | `sudo apt install tmux` |
| python3 + PyYAML | the launcher reads `m20_stack.yaml` | `sudo apt install python3-yaml` |
| X11 access for root containers | RViz from the containers | done by the devcontainers' `xhost +SI:localuser:root` |
| A browser | the demo GUI (http://localhost:8080) | any |

Wi-Fi: join `near-robots-5G`; note your address (`ip -4 addr`, e.g. `192.168.123.196`).

## 2. Get the code

```bash
cd ~/<your workspace>
git clone <repo url> near-native-nav-bridge-M20 && cd near-native-nav-bridge-M20
git switch dev-openrmf
```

## 3. Laptop DDS profile (per laptop)

`fastdds_profile.xml` (repo root) whitelists the laptop's Wi-Fi address. Replace the
address with **yours**:

```xml
<interfaceWhiteList>
  <address>127.0.0.1</address>
  <address>192.168.123.XXX</address>   <!-- your laptop -->
</interfaceWhiteList>
```

Do not commit your address over someone else's; each laptop keeps its own.

## 4. Build the devcontainers — this is where Open-RMF gets installed

Two containers, both from this repo:

| Container | Config | Base | What it installs |
|---|---|---|---|
| **ROS2 Foxy** (the team's, unchanged) | `.devcontainer/devcontainer.json` | `osrf/ros:foxy-desktop` | Foxy tools; builds `nav_cmd_bridge` (relays, laptop bridge) |
| **Open-RMF (ROS2 Jazzy)** (new) | `.devcontainer/rmf-jazzy/devcontainer.json` | `ros:jazzy-ros-base` | **Open-RMF from the ROS apt repo** + our `m20_rmf` package |

Open-RMF packages installed by `.devcontainer/rmf-jazzy/Dockerfile` (apt, Jazzy binary
release; versions on the reference laptop):

| Package | Version | Role |
|---|---|---|
| `ros-jazzy-rmf-fleet-adapter` | 2.7.2 | fleet adapter framework (C++) |
| `ros-jazzy-rmf-fleet-adapter-python` | 2.7.2 | Python bindings (EasyFullControl) used by `m20_rmf` |
| `ros-jazzy-rmf-task-ros2` | 2.7.2 | task dispatcher |
| `ros-jazzy-rmf-traffic-ros2` | 2.7.2 | traffic schedule + blockade moderator |
| `ros-jazzy-rmf-building-map-tools` | 1.9.2 | map/nav-graph tooling |
| `ros-jazzy-rmf-demos-tasks` | 2.3.0 | reference task scripts (`dispatch_patrol`, …) |
| `ros-jazzy-rmf-visualization` | 2.3.2 | RMF RViz visualizers |
| `ros-jazzy-rviz2` | — | RViz |
| `python3-websockets` | 10.4 | task-state monitor, demo GUI |

Why Jazzy and not the team's Foxy: Open-RMF for Foxy is 1.4 (end-of-life) and has no
composed tasks or custom actions; Humble's 2.1.8 lacks the EasyFullControl API used here.

**Build them:**

1. Open the repo folder in VS Code → **Dev Containers: Reopen in Container** → *ROS2
   Foxy*. Wait for the build.
2. New VS Code window → **Dev Containers: Open Folder in Container…** → same folder →
   *Open-RMF (ROS2 Jazzy)*. First build downloads Open-RMF (several minutes). On creation
   it builds our package into `/ws` (`rmf/build.sh`).

(Alternatively `scripts/m20_stack.sh up` creates both through the VS Code CLI.)

The Jazzy container comes preconfigured: `ROS_DOMAIN_ID=20`,
`FASTRTPS_DEFAULT_PROFILES_FILE=/repo/rmf/fastdds_jazzy.xml`, `m20` on the PATH.
**Rebuild it** (Dev Containers: Rebuild Container) whenever
`.devcontainer/rmf-jazzy/` changes.

## 5. Build the workspaces

The launcher does both on every start; by hand:

```bash
# Foxy devcontainer
source /opt/ros/foxy/setup.bash && cd /root/ros2_ws && colcon build --packages-select nav_cmd_bridge
# Jazzy devcontainer
bash /repo/rmf/build.sh
```

## 6. SSH key for the robots (per laptop, per robot)

The launcher starts each robot's relay over SSH. Use a dedicated key, not your GitHub key:

```bash
ssh-keygen -t ed25519 -N "" -C "m20 robots, <your name> laptop" -f ~/.ssh/id_m20
ssh-copy-id -i ~/.ssh/id_m20.pub user@192.168.123.<robot>     # the robots' password
```

Remove your line from each robot's `~/.ssh/authorized_keys` when you are done with the
project. Set the key path as `ssh_key:` in `m20_stack.yaml`.

## 7. Each robot: the relay DDS profile (once per robot, robot-side state)

Nothing else is installed on the robots; they run the team's image unchanged. But the
relays need a Fast DDS profile inside the relay container, or the laptop sees no
topics / no `/ODOM`:

1. Copy `robot/fastdds_relay.xml`, change `192.168.123.102` (robot 834) to the robot's
   own Wi-Fi address — keep the three `10.21.3x.103` lines.
2. Install it:
   ```bash
   scp my_relay.xml user@<ip>:/tmp/fastdds_relay.xml
   ssh user@<ip> 'docker cp /tmp/fastdds_relay.xml user-nav_cmd_bridge-1:/root/fastdds_relay.xml'
   ```
   It survives container stop/start; a container recreated from the image needs it again.

Done so far: **834** only.

## 8. Your settings: `m20_stack.yaml` (repo root)

```yaml
robots: ["834"]                       # the robots you run (only these are touched)
site: rmf/m20_rmf/sites/<your site>.yaml
ssh_key: ~/.ssh/id_m20
robot_relay: odom                     # odometry relay only (light on Wi-Fi)
```

Build a site file for your robots' positions (RUNBOOK §7); robot IPs live there.

## 9. Verify

```bash
scripts/m20_stack.sh up
```
- `relay <id>` pane: `Relay: /ODOM -> /ODOM_relayed_<id>`
- `bridge` pane: `robots [...], domain 0 -> 20` and `Relay:` lines
- `rmf` pane: `[<id>] registered with RMF at (x, y)`
- operator pane: `m20 status` → `registered: true`, `pose_source: odom`
- demo GUI at http://localhost:8080 shows the robots (RUNBOOK §5)

Offline check without robots (mock robots, domain 42):
```bash
export ROS_DOMAIN_ID=42
ros2 launch m20_rmf m20_rmf.launch.py site:=/repo/rmf/m20_rmf/sites/sim_lab.yaml sim:=true
m20 --site /repo/rmf/m20_rmf/sites/sim_lab.yaml mission /repo/rmf/m20_rmf/missions/examples.yaml
cd /repo/rmf/m20_rmf && python3 -m pytest -q test
```

## Not reproduced by any of the above

- **Robot localization** is per session (on-robot RViz for now).
- **The team's robot image** still lacks the `initialpose_set` / matching-error relays
  added to `relays.launch.py`; rebuilding it is the image owner's call.
