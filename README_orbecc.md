# Orbbec Dabai DC1 camera on the M20

This guide covers setting up the Orbbec Dabai DC1 depth camera on the M20 and streaming its colour and depth images to the laptop.

The camera plugs into the robot over USB. `lsusb` shows two devices:
- `2bc5:0657 ORBBEC Depth Sensor`
- `2bc5:0557 Dabai DC1`

The driver runs on the robot. It streams compressed colour (JPEG) and compressed depth (PNG) over WiFi, and the laptop views them there.

```
M20 (robot)                                          laptop (devcontainer)
orbbec_camera driver  ── WiFi, compressed only ──►  rqt_image_view / RViz
  /topcam/color/image_raw/compressed     (JPEG straight from the camera)
  /topcam/depth/image_raw/compressedDepth (PNG, encoded by the driver)
```

The driver only encodes and sends a stream while something is subscribed to it. Nothing crosses the WiFi when no one is watching.

---

## 1. Build the driver (on the robot)

**Use the `main` branch of OrbbecSDK_ROS2.**
- The `v2-main` branch, which is also what the apt package `ros-<distro>-orbbec-camera` ships, doesn't support the Dabai series.
- Its device list silently comes back empty, even as root, even though `lsusb` and the kernel both see the camera.

```bash
mkdir -p ~/orbbec_ws/src && cd ~/orbbec_ws/src
git clone -b main https://github.com/orbbec/OrbbecSDK_ROS2.git orbbec_camera
cd ~/orbbec_ws
rosdep install --from-paths src --ignore-src -r -y
sudo apt install ros-foxy-image-transport-plugins
colcon build --symlink-install --packages-up-to orbbec_camera
source install/setup.bash
```

- **Clone only one branch.** Both branches define packages with the same names (`orbbec_camera`, `orbbec_camera_msgs`, `orbbec_description`). With both in `src/`, colcon refuses to build.
- **Install `ros-foxy-image-transport-plugins` on the robot.** That's what gives the driver its `compressedDepth` topic. The compressed colour topic doesn't need it.

## 2. udev rules (once)

Run this from the inner `orbbec_camera` package folder, not the outer clone folder:

```bash
cd ~/orbbec_ws/src/orbbec_camera/orbbec_camera
sudo bash scripts/install_udev_rules.sh
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug the camera and plug it back in afterwards.

## 3. Confirm the SDK sees the camera

```bash
ros2 run orbbec_camera list_devices_node
```

It should print a serial number and a USB port. If it prints nothing, check the branch (step 1) and the udev rules (step 2).

## 4. Find the supported stream profiles

The model-specific launch files, such as `dabai_d1.launch.py`, can have wrong defaults for this unit. They can crash the whole node on an unsupported profile instead of skipping it. Use the generic `ob_camera.launch.py` with values your unit actually supports:

```bash
ros2 run orbbec_camera list_camera_profile_mode_node
```

This prints every resolution, fps and format combination the connected camera supports. Use values from that list in step 5.

**The DC1 is a USB 2.0 device.** Colour plus depth at high fps can exceed its bandwidth. If frames drop, lower `color_fps` first.

## 5. Launch on the robot for streaming

**Use the relay's Fast DDS profile.**
- The M20's default profile (`/opt/robot/fastdds.xml`, loaded by `/opt/robot/scripts/setup_ros2.sh`) only allows localhost and the internal Ethernet, so the laptop would see nothing.
- Point this process at the same profile the relays use. The profile itself doesn't change.

```bash
export FASTRTPS_DEFAULT_PROFILES_FILE=/home/user/fastdds_relay.xml
export ROS_DOMAIN_ID=0
source ~/orbbec_ws/install/setup.bash

ros2 launch orbbec_camera ob_camera.launch.py \
  camera_name:=topcam \
  enable_depth:=true depth_width:=640 depth_height:=400 depth_fps:=15 depth_format:=Y12 \
  enable_color:=true color_width:=640 color_height:=480 color_fps:=15 color_format:=MJPG \
  enable_ir:=false enable_point_cloud:=false publish_tf:=false
```

Take the resolution, fps and format values from step 4. Use 15 fps if it's listed, otherwise 30.

| Setting | Why |
|---|---|
| `color_format:=MJPG` | The driver publishes the camera's own JPEG frames on `color/image_raw/compressed`, with no re-encoding on the robot. |
| `enable_ir:=false` | Not needed for viewing, and it saves USB 2.0 bandwidth. |
| `enable_point_cloud:=false` | A 640×400 cloud is about 4 MB per frame, too much for WiFi (see section 8). |
| `publish_tf:=false` | Camera TF must not be published on the robot (see section 8). |
| `depth_fps` / `color_fps` 15 | Halves the WiFi load compared with 30 fps. |

Topics with `camera_name:=topcam`:

| Topic | Use from the laptop? |
|---|---|
| `/topcam/color/image_raw/compressed` | yes (JPEG) |
| `/topcam/depth/image_raw/compressedDepth` | yes (16-bit PNG, depth in mm) |
| `/topcam/color/camera_info`, `/topcam/depth/camera_info` | yes (small) |
| `/topcam/color/image_raw`, `/topcam/depth/image_raw` | **no**, these are raw |

The frames are named `topcam_link`, `topcam_color_optical_frame` and `topcam_depth_optical_frame`.

If a second robot gets a camera, give each one a unique `camera_name`, for example `topcam_741` and `topcam_665`.

## 6. View on the laptop

These steps run in the devcontainer. The laptop must be on "near-robots-5G" at `192.168.123.160`, because that's the address `fastdds_profile.xml` allows.

```bash
apt-get update && apt-get install -y ros-foxy-image-transport-plugins   # once; needed to decode compressed images

cd /root/ros2_ws/src/nav_cmd_bridge
export ROS_DOMAIN_ID=0
export FASTRTPS_DEFAULT_PROFILES_FILE=fastdds_profile.xml
```

Check that both streams arrive:

```bash
ros2 topic hz /topcam/color/image_raw/compressed
ros2 topic hz /topcam/depth/image_raw/compressedDepth
```

**rqt_image_view** can show the compressed topics directly:

```bash
ros2 run rqt_image_view rqt_image_view
```

Pick `/topcam/color/image_raw/compressed` or `/topcam/depth/image_raw/compressedDepth` from the dropdown.

**For RViz:** the Foxy Image display takes raw images, so decompress on the laptop first. The decompressed topics stay on the laptop and never cross the WiFi.

```bash
ros2 run image_transport republish compressed raw --ros-args \
  -r in/compressed:=/topcam/color/image_raw/compressed -r out:=/laptop/topcam/color

ros2 run image_transport republish compressedDepth raw --ros-args \
  -r in/compressedDepth:=/topcam/depth/image_raw/compressedDepth -r out:=/laptop/topcam/depth
```

Then add two Image displays in RViz, on `/laptop/topcam/color` and `/laptop/topcam/depth`.

On Foxy, the remap has to name `in/compressed` and `in/compressedDepth`; remapping plain `in` does nothing.

## 7. WiFi bandwidth: never subscribe to raw topics from the laptop

| Stream | Per frame | 30 fps | 15 fps |
|---|---|---|---|
| raw colour 640×480 | 0.9 MB | ~28 MB/s | ~14 MB/s |
| raw depth 640×400 | 0.5 MB | ~15 MB/s | ~8 MB/s |
| point cloud 640×400 | ~4 MB | ~120 MB/s | ~60 MB/s |
| JPEG colour | ~50–100 KB | ~1.5–3 MB/s | ~0.8–1.5 MB/s |
| PNG depth | ~150–300 KB | ~5–9 MB/s | ~2–4.5 MB/s |

Raw images or clouds over WiFi can starve the navigation bridge's UDP heartbeat and goal traffic. That includes RViz picking a raw topic from its dropdown.

- **Laptop:** subscribe only to `…/compressed` and `…/compressedDepth`.
- **Robot:** depth is the stream to throttle for WiFi. Colour is the one to throttle for USB.

## 8. TF and point clouds (optional)

**Why not publish camera TF on the robot:**
- Every robot's relay container re-publishes any `/tf` or `/tf_static` it can see, with the robot's own `<id>/` prefix. A camera TF published on 741 would also show up as `665/topcam_link`.
- The images keep the unprefixed `topcam_*_optical_frame`, so they wouldn't match the relayed tree anyway.
- So keep `publish_tf:=false`, and don't run `static_transform_publisher` on the robot.

Showing the images needs no TF. TF only matters for displays attached to the camera, such as point clouds.

**Publish the camera mount from the laptop instead**, straight into the relayed static TF. The robots never subscribe to `/tf_static_relayed`, so this can't loop back.

Replace `741/base_link` with the robot's actual body frame, which you can see in `ros2 topic echo --once /tf_static_relayed`. Replace `X Y Z YAW PITCH ROLL` with the measured mount; in ROS, a positive pitch tilts the camera down.

```bash
ros2 run tf2_ros static_transform_publisher X Y Z YAW PITCH ROLL 741/base_link topcam_link \
  --ros-args -r /tf_static:=/tf_static_relayed

ros2 run tf2_ros static_transform_publisher 0 0 0 -1.5708 0 -1.5708 topcam_link topcam_depth_optical_frame \
  --ros-args -r /tf_static:=/tf_static_relayed
```

- The second transform is the standard rotation from a camera body frame to its optical frame (x forward, y left, z up → x right, y down, z forward).
- Foxy's `static_transform_publisher` only takes positional arguments, in the order `x y z yaw pitch roll parent child`. The `--x … --frame-id` form is Humble and later.
- In RViz, remap TF to the relayed topics, as in the main README: `rviz2 --ros-args -r /tf:=/tf_relayed -r /tf_static:=/tf_static_relayed`.

**Point clouds:**
- Build the cloud on the laptop from the decoded depth (`/laptop/topcam/depth` plus `/topcam/depth/camera_info`) with `depth_image_proc` (`apt-get install ros-foxy-depth-image-proc`). Don't stream `/points` from the robot.
- If a PointCloud2 display stays empty while its topic is live and TF is connected, set the display's Reliability Policy to Best Effort.
- The driver stamps frames with the camera's clock by default (`time_domain: device`), and `ob_camera.launch.py` doesn't expose that setting. If RViz drops the cloud with a TF extrapolation/timing error, this is the cause.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| `list_devices_node` prints nothing | You're on the `v2-main` branch (use `main`), or the udev rules are missing (step 2, then replug). |
| Node crashes at start | A profile isn't supported. Use `ob_camera.launch.py` with values from `list_camera_profile_mode_node`. |
| Laptop sees no `/topcam/...` topics | On the robot, `echo $FASTRTPS_DEFAULT_PROFILES_FILE` must be the relay profile. The laptop must be at `.160`, and both sides need `ROS_DOMAIN_ID=0`. |
| `compressedDepth` topic missing | `ros-foxy-image-transport-plugins` isn't installed on the robot. |
| rqt_image_view has no compressed entries | `ros-foxy-image-transport-plugins` isn't installed on the laptop. |
| Choppy or stalling stream | Lower `color_fps` (USB 2.0) and `depth_fps` (WiFi). Make sure nothing on the laptop is subscribed to a raw topic. |
| Empty PointCloud2 in RViz | TF isn't connected (section 8), the QoS needs Best Effort, or it's the `time_domain` timestamps. |
