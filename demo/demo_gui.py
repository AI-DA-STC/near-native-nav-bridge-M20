#!/usr/bin/env python3
"""Operator window for the search demo, next to the two RViz2: python3 demo/demo_gui.py [run_demo.sh]

Runs demo/run_demo.sh as a terminal would (in a pseudo-terminal, so the demo behaves exactly the same) and shows what it
says, plainly: the mission plan, generated once the operator sends the instruction and then executed step by step, each
robot's status, every plan generated with its status, and, from the sweep on, the box detection on R3's camera
(demo/detect_box.py): the box's image and place on the map as soon as it is found, then the photo the Aloha takes of
its contents with the objects found in it (aloha/inspect_box.py), which the operator marks as an anomaly or clear. Click
an image to see it in a window of its own. The operator types the instruction, approves or denies each plan, marks the
box's contents and stops the demo (as Ctrl+C would) from here. Start every bridge first, as
for demo/run_demo.sh; the demo gets ROS_DOMAIN_ID=0 and fastdds_profile.xml unless this terminal sets them. R1, R2, R3
name the fleet's robot ids, as in demo/record_waypoints.sh (default 741 665 738)."""

import codecs
import fcntl
import os
import re
import signal
import struct
import subprocess
import sys
import termios
import time

from PyQt5 import QtCore, QtGui, QtWidgets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
HEADER = re.compile(r"=== ([A-Za-z][\w ]*?):")  # a phase header in run_demo.sh's echo lines
PROMPTS = {"Operator approval (approve/deny):": "approval", "Operator verdict (anomaly/clear):": "verdict"}
APPROVAL = "Plan approval"
ALOHA = "aloha"
FLEET = [(f"R{i}", os.environ.get(f"R{i}", rid)) for i, rid in ((1, "741"), (2, "665"), (3, "738"))]
STOP_GRACE_S = 8.0  # after Stop, Force stop
DETAIL_CHARS = 48  # of a phase's detail, in the narrow mission column (the banner and the robots have it all)
GREY = "#8c8c8c"

PENDING, ACTIVE, DONE, FAILED, STOPPED, SKIPPED = "pending", "active", "done", "failed", "stopped", "skipped"
MARKS = {PENDING: "○", ACTIVE: "▶", DONE: "✓", FAILED: "✕", STOPPED: "■", SKIPPED: "–"}
TAGS = {"ready": "READY", "busy": "IN PROGRESS", "input": "ACTION NEEDED", "done": "COMPLETE", "stopped": "STOPPED",
        "error": "FAILED", "found": "BOX FOUND", "anomaly": "ANOMALY", "clear": "CLEAR"}
INVERTED_KINDS = ("input", "error", "found", "anomaly")
IMAGE_HEIGHT = 170  # px, at most, of each image in the box panel
SEARCHER = FLEET[2]  # R3, whose camera looks for the box
BADGES = {"Generating": ("Generating…", ""), "Awaiting approval": ("AWAITING APPROVAL", "inverted"),
          "Approved": ("✓ Approved", ""), "Executing": ("▶ Executing", ""), "Completed": ("✓ Completed", ""),
          "Denied": ("✕ Denied", ""), "Stopped": ("■ Stopped", ""), "Failed": ("✕ Failed", "inverted"),
          "Not decided": ("Not decided", "dim")}

STYLE = f"""
QWidget {{ background: #fff; color: #000; font-family: "DejaVu Sans"; font-size: 11pt; }}
QFrame#panel {{ border: 2px solid #000; }}
QLabel#panelTitle {{ font-size: 9pt; font-weight: bold; padding: 6px 12px; border-bottom: 2px solid #000; }}
QLabel#title {{ font-size: 15pt; font-weight: bold; }}
QLabel#clock {{ font-family: "DejaVu Sans Mono"; font-size: 12pt; padding: 0 10px; }}
QLabel#section {{ font-size: 9pt; font-weight: bold; color: {GREY}; padding-top: 4px; }}
QLabel#note, QLabel#env {{ color: {GREY}; font-size: 10pt; }}
QLabel#rowName {{ font-weight: bold; }}
QLabel#rowDetail {{ font-size: 10pt; }}
QLabel#planTitle {{ font-size: 14pt; font-weight: bold; }}
QLabel#planLabel {{ font-weight: bold; }}
QLabel#planSteps {{ font-size: 10pt; }}
QLabel#boxWhere {{ font-size: 15pt; font-weight: bold; }}
QLabel#boxStrip {{ background: #000; color: #fff; font-weight: bold; font-size: 10pt; padding: 5px 8px; }}
QPushButton#strip {{ background: #000; color: #fff; border: 1px solid #fff; padding: 1px 8px; font-size: 9pt; }}
QPushButton#strip:hover {{ background: #333; }}
QLabel#event {{ font-size: 10pt; padding: 0 2px; }}
QLabel#notice {{ font-weight: bold; padding: 6px 10px; border: 2px dashed #000; }}
QFrame#plan {{ border: 2px solid #000; }}
QPushButton {{ border: 2px solid #000; padding: 8px 16px; font-weight: bold; background: #fff; }}
QPushButton:hover {{ background: #e8e8e8; }}
QPushButton:pressed {{ background: #000; color: #fff; }}
QPushButton:disabled {{ color: #b4b4b4; border-color: #b4b4b4; background: #fff; }}
QPushButton#primary {{ background: #000; color: #fff; }}
QPushButton#primary:hover {{ background: #333; }}
QPushButton#primary:disabled {{ background: #fff; color: #b4b4b4; }}
QPushButton#small {{ padding: 2px 10px; font-size: 9pt; border-width: 1px; }}
QLineEdit {{ border: 2px solid #000; padding: 7px; font-size: 12pt; }}
QLineEdit:disabled {{ border-color: #b4b4b4; color: #b4b4b4; }}
QPlainTextEdit {{ border: none; font-family: "DejaVu Sans Mono"; font-size: 9pt; }}
QTableWidget {{ border: none; font-size: 10pt; }}
QHeaderView::section {{ background: #fff; border: none; border-bottom: 1px solid #000; font-weight: bold;
                        font-size: 9pt; padding: 4px; }}
QCheckBox {{ font-size: 10pt; }}
QMessageBox QLabel {{ font-size: 11pt; }}
"""
INVERTED = "QFrame#row, QLabel { background: #000; color: #fff; }"
DIM = f"QLabel {{ color: {GREY}; }}"
BADGE = "border: 2px solid #000; padding: 3px 10px; font-weight: bold; font-size: 10pt;"
BADGE_STYLES = {"": BADGE, "inverted": BADGE + "background: #000; color: #fff;",
                "dim": BADGE + f"color: {GREY}; border-color: {GREY};"}


def phases_of(script):
    """The demo's phases, from its '=== Name: ...' headers, with the plan approval after the phase it happens in"""
    text = open(script).read()
    names = list(dict.fromkeys(HEADER.findall(text)))
    asked = text.find("Operator approval")
    if asked >= 0:
        before = HEADER.findall(text[:asked])
        names.insert(names.index(before[-1]) + 1 if before else len(names), APPROVAL)
    return names


def plain(text):
    """What the operator reads: what is going on, without waypoints or arm poses"""
    text = re.sub(r"\bWP \d+(?:/\d+)?", "goal", text)
    text = re.sub(r"\b([Ww])aypoint", lambda m: "Goal" if m.group(1) == "W" else "goal", text)
    return re.sub(r"\b([Aa])rm poses?\b", lambda m: m.group(1) + "rms", text)


def inventory(found):
    """'screwdriver ×2, pliers' from [(name, confidence)], most confident first"""
    counts = {}
    for name, _ in found:
        counts[name] = counts.get(name, 0) + 1
    return ", ".join(f"{name} ×{n}" if n > 1 else name for name, n in counts.items()) or "nothing found"


def clock(seconds):
    seconds = int(seconds)
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"


class Phase:
    def __init__(self, name):
        self.name, self.status, self.detail = name, PENDING, ""


class Robot:
    def __init__(self, name):
        self.name, self.text, self.since = name, "—", None


class Demo(QtCore.QObject):
    """run_demo.sh in a pseudo-terminal, and what its output says"""
    changed = QtCore.pyqtSignal()
    logged = QtCore.pyqtSignal(str)

    def __init__(self, script):
        super().__init__()
        self.script = script
        self.cwd = os.path.dirname(os.path.dirname(script))
        found = re.search(r'^INSTRUCTION="(.*)"', open(script).read(), re.M)
        self.default_instruction = found.group(1) if found else ""
        self.env = dict(os.environ, PYTHONUNBUFFERED="1")
        self.env.setdefault("ROS_DOMAIN_ID", "0")
        self.env.setdefault("FASTRTPS_DEFAULT_PROFILES_FILE", os.path.join(ROOT, "fastdds_profile.xml"))
        self.plans = []  # every plan generated, oldest first
        self.proc = self.master = self.notifier = self.decoder = None
        self.started = self.ended = None
        self.reset()
        poll = QtCore.QTimer(self)
        poll.timeout.connect(self._poll)
        poll.start(200)

    def reset(self):
        self.phases = [Phase(name) for name in phases_of(self.script)]
        self.robots = {rid: Robot(f"{label} · {rid}") for label, rid in FLEET}
        self.robots[ALOHA] = Robot("ALOHA")
        self.kind, self.banner = "ready", "Start the demo once every bridge is up"
        self.event = self.notice = ""
        self.expecting = self.instruction = self.stop_at = self.failure = None
        # The box detection on R3's camera: off, starting, searching, novideo, found, error or ended
        self.box = dict(state="off", why="", robot=SEARCHER[1], xy=None, away=None, conf=None, image=None,
                        found=None, updated=None)
        # The Aloha's photo of the box's contents: off, capturing, done or error
        self.contents = dict(state="off", objects=[], image=None, time=None, why="")
        self.verdict = None  # on the contents: sent, then anomaly or clear
        self.capturing = self.stopping = False
        self.buffer = self.last = ""

    # The demo process

    def start(self):
        if self.proc:
            return
        self.reset()
        master, slave = os.openpty()
        attrs = termios.tcgetattr(slave)
        attrs[3] &= ~termios.ECHO  # what the operator sends is logged here, not echoed back
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
        setup = 'source install/setup.bash 2>/dev/null || source /opt/ros/foxy/setup.bash; exec bash "$0"'
        try:
            self.proc = subprocess.Popen(["bash", "-c", setup, self.script], stdin=slave, stdout=slave, stderr=slave,
                                         cwd=self.cwd, env=self.env, start_new_session=True)
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        self.master = master
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.notifier = QtCore.QSocketNotifier(master, QtCore.QSocketNotifier.Read, self)
        self.notifier.activated.connect(self._read)
        self.started, self.ended = time.monotonic(), None
        self.kind, self.banner = "busy", "Starting the demo…"
        self.logged.emit(f"» Started {os.path.relpath(self.script, self.cwd)} (ROS_DOMAIN_ID {self.env['ROS_DOMAIN_ID']})")
        self.changed.emit()

    def decide(self, verdict):
        """The operator's verdict on the box's contents: run_demo.sh reads it when it asks, or at once if it has"""
        self.verdict = "sent"
        self.send(verdict, f"verdict {verdict}")

    def send(self, text, what):
        """Types a line into the demo, as the operator would in its terminal"""
        if self.proc:
            os.write(self.master, (text + "\n").encode())
            self.expecting = None
            self.logged.emit(f"» Operator: {what}")
            self.changed.emit()

    def stop(self, force=False):
        """Ctrl+C for the whole demo, as in its terminal; force: SIGTERM, for a demo that does not stop"""
        if not self.proc:
            return
        try:
            os.killpg(self.proc.pid, signal.SIGTERM if force else signal.SIGINT)
        except ProcessLookupError:
            pass
        if not self.stopping:
            self.stopping, self.stop_at = True, time.monotonic()
        self.expecting = None
        self.kind, self.banner = "busy", "Stopping the demo…"
        self.logged.emit("» Operator: stop" + (" (forced)" if force else ""))
        self.changed.emit()

    def can_force(self):
        return self.proc is not None and self.stopping and time.monotonic() - self.stop_at > STOP_GRACE_S

    def shutdown(self):
        """Stops the demo before quitting, harder and harder"""
        for sig, wait in ((signal.SIGINT, 6), (signal.SIGTERM, 3), (signal.SIGKILL, 1)):
            if not self.proc or self.proc.poll() is not None:
                return
            try:
                os.killpg(self.proc.pid, sig)
                self.proc.wait(wait)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                pass

    def _read(self):
        try:
            data = os.read(self.master, 65536)
        except BlockingIOError:
            return
        except OSError:  # EIO: nothing holds the demo's terminal any more
            data = b""
        if not data:
            self.notifier.setEnabled(False)
            return
        self._feed(self.decoder.decode(data))

    def _poll(self):
        if self.proc and self.proc.poll() is not None:
            self._finish(self.proc.returncode)
        elif self.can_force():
            self.changed.emit()

    def _finish(self, rc):
        self.notifier.setEnabled(False)
        while True:  # what is left of its output
            try:
                data = os.read(self.master, 65536)
            except OSError:
                break
            if not data:
                break
            self._feed(self.decoder.decode(data))
        self._feed(self.decoder.decode(b"", final=True) + "\n")
        os.close(self.master)
        self.proc = self.master = None
        self.ended = time.monotonic()
        self.expecting = None
        stopped = self.stopping or rc in (130, -signal.SIGINT, -signal.SIGTERM)
        end = DONE if rc == 0 else STOPPED if stopped else FAILED
        for phase in self.phases:
            if phase.status == ACTIVE:
                phase.status = end
            elif phase.status == PENDING and end == DONE:  # e.g. the return to formation after an anomaly
                phase.status, phase.detail = SKIPPED, "Skipped"
        for plan in self.plans:
            if plan["status"] in ("Generating", "Awaiting approval"):
                plan["status"] = "Not decided"
            elif plan["status"] in ("Approved", "Executing"):
                plan["status"] = {DONE: "Completed", STOPPED: "Stopped", FAILED: "Failed"}[end]
        if end == DONE:
            self.kind, self.banner = "done", "Demo complete" + (
                f". Box contents: {self.verdict.upper()}" if self.verdict in ("anomaly", "clear") else "")
        elif end == STOPPED:
            self.kind, self.banner = "stopped", "Demo stopped" + (" by the operator" if self.stopping else "")
        else:
            why = self.failure or re.sub(r"^\[\w+\]\s*", "", self.last)  # without its [ALOHA] or [FLEET]
            self.kind, self.banner = "error", f"Demo failed. {why}" if why else f"Demo failed (exit {rc})"
        if self.box["state"] not in ("found", "error", "gaveup"):
            self.box["state"] = "ended"
        aloha = self.robots[ALOHA]
        if aloha.text == "In progress" and end != DONE:
            aloha.text = "Stopped" if end == STOPPED else "Failed"
        self.notice = ""
        self.logged.emit(f"» Demo ended (exit {rc})")
        self.changed.emit()

    # What the demo says

    def _feed(self, text):
        self.buffer += ANSI.sub("", text).replace("\r", "")
        while True:
            newline = self.buffer.find("\n")
            at, prompt = min(((self.buffer.find(p), p) for p in PROMPTS if p in self.buffer), default=(-1, None))
            if prompt and (newline < 0 or at < newline):  # read -p: no newline after it
                if self.buffer[:at].strip():
                    self._line(self.buffer[:at])
                self.buffer = self.buffer[at + len(prompt):].lstrip(" ")
                self._prompt(prompt)
            elif newline >= 0:
                line, self.buffer = self.buffer[:newline], self.buffer[newline + 1:]
                self._line(line)
            else:
                break
        self.changed.emit()

    def _line(self, line):
        self.logged.emit(line)
        s = line.strip()
        if self.capturing:  # the plan's lines, up to a blank one
            row = re.match(r"^([A-Za-z][\w ]*?):\s+(.+)$", s)
            if row:
                self.plans[-1]["rows"].append(row.groups())
                return
            self.capturing = False
        if not s:
            return
        self.last = s
        plan = self.plans[-1] if self.plans else None
        if plan and plan["status"] == "Generating" and not plan["id"]:
            title = re.match(r"^Plan\s+([^\s:]+):?\s*(.*)$", s)
            if title:
                plan["id"], plan["summary"] = title.groups()
                self.capturing = True
                return
        for pattern, handler in ((r"^=== ([A-Za-z][\w ]*?):\s*(.*?)\s*===$", self._header),
                                 (r"^\[DEMO\]\s*(.*)$", self._demo), (r"^\[FLEET\]\s*(.*)$", self._fleet),
                                 (r"^\[ALOHA\]\s*(.*)$", self._aloha), (r"^\[DETECT\]\s*(.*)$", self._detect),
                                 (r"^\[video\]\s*(.*)$", self._video), (r"^\[INSPECT\]\s*(.*)$", self._inspect),
                                 (r"^(.*)$", self._arms)):
            m = re.match(pattern, s)
            if m:
                handler(*m.groups())
                return

    def _phase(self, name):
        return next((p for p in self.phases if p.name == name), None)

    def _current(self):
        return next((p for p in reversed(self.phases) if p.status == ACTIVE and p.name != APPROVAL), None)

    def _event(self, text):
        self.event = f"{time.strftime('%H:%M:%S')}   {text}"

    def _header(self, name, desc):
        if not self._phase(name):
            self.phases.append(Phase(name))
        names = [p.name for p in self.phases]
        i = names.index(name)
        if i > 0 and self.phases[i].status == ACTIVE:  # a part of it, e.g. run_aloha.sh's own headers
            return
        if i == 0:  # the demo loops back to its start, after a denied plan: no mission until the next instruction
            self.instruction = None
            for phase in self.phases:
                phase.status, phase.detail = PENDING, ""
        for phase in self.phases[:i]:
            if phase.status == ACTIVE:
                phase.status = DONE
        phase = self.phases[i]
        phase.status, phase.detail = ACTIVE, desc[:1].upper() + desc[1:]
        plan = self.plans[-1] if self.plans else None
        if plan and plan["status"] == "Approved" and APPROVAL in names and i > names.index(APPROVAL):
            plan["status"] = "Executing"
        self.notice = ""
        if "instruction" in desc.lower():  # read -r instruction, without a prompt
            self.expecting = "instruction"
            phase.detail = "Robots patrolling, waiting for the operator instruction"
            self.kind, self.banner = "input", "Robots patrolling. Type the operator instruction and press Send"
        else:
            self.kind, self.banner = "busy", f"{name}: {phase.detail}"
        if self.expecting == "verdict":
            self._ask_verdict()

    def _ask_verdict(self):
        """The operator marks the box's contents, as soon as there are any, before run_demo.sh asks"""
        if self.verdict is not None:
            return
        self.expecting = "verdict"
        seen = f"Inside the box: {inventory(self.contents['objects'])}. " if self.contents["state"] == "done" else ""
        self.kind, self.banner = "input", f"{seen}Anomaly or clear?"

    def _prompt(self, prompt):
        self.logged.emit(prompt)
        if PROMPTS[prompt] == "verdict":
            self._ask_verdict()
            return
        self.capturing = False
        plan = self.plans[-1] if self.plans else None
        name = f"plan {plan['id']}" if plan and plan["id"] else "the plan"
        if plan:
            plan["status"] = "Awaiting approval"
        approval = self._phase(APPROVAL)
        if approval:
            approval.status, approval.detail = ACTIVE, f"{name[:1].upper() + name[1:]} waiting for the operator"
        self.expecting = "approval"
        self.kind, self.banner = "input", f"Review {name}, then approve or deny it"

    def _demo(self, msg):
        approval = self._phase(APPROVAL)
        plan = self.plans[-1] if self.plans else None
        said = re.match(r"^Operator:\s*(.*)$", msg)
        decided = re.match(r"^Plan (\S+) (approved|denied)", msg)
        verdict = re.match(r"^Operator verdict:\s*(ANOMALY|CLEAR)", msg)
        if said:
            self.instruction, self.expecting = said.group(1), None
            first = self.phases[0]
            short = self.instruction if len(self.instruction) <= 36 else self.instruction[:35] + "…"
            first.status, first.detail = DONE, f'Instruction: "{short}"'
            self.kind, self.banner = "busy", f'Instruction received: "{self.instruction}"'
        elif msg.startswith("Generating a plan"):
            self.plans.append(dict(n=len(self.plans) + 1, time=time.strftime("%H:%M:%S"), id="", summary="", rows=[],
                                   instruction=self.instruction or "", status="Generating"))
            if approval:
                approval.status, approval.detail = ACTIVE, "Generating the plan…"
            self.kind, self.banner = "busy", "Generating a plan…"
        elif decided and plan:
            approved = decided.group(2) == "approved"
            plan["status"] = "Approved" if approved else "Denied"
            if approval:
                approval.status = DONE if approved else FAILED
                approval.detail = f"Plan {decided.group(1)} {decided.group(2)} at {time.strftime('%H:%M')}"
            self.kind, self.banner = "busy", msg
        elif verdict:
            self.verdict, self.expecting = verdict.group(1).lower(), None
            phase = self._current()
            if phase:
                phase.detail = f"Marked {verdict.group(1)} at {time.strftime('%H:%M')}"
            self.kind, self.banner = self.verdict, f"Box contents marked {verdict.group(1)} by the operator"
        else:  # news from the phase under way
            phase = self._current()
            if phase:
                phase.detail = msg
            self.kind, self.banner = "busy", msg
            if self.expecting == "verdict":
                self._ask_verdict()
        self._event(msg)

    def _robot(self, rid, text):
        if rid not in self.robots:
            self.robots[rid] = Robot(f"Robot {rid}")
        phase = self._current()
        self.robots[rid].text = f"{phase.name} · {text}" if phase and rid != ALOHA else text
        self.robots[rid].since = time.monotonic()

    def _fleet(self, msg):
        sent = re.match(r"^Sent: (.*) are starting", msg)
        waiting = re.match(r"^Not sent: (.*)$", msg)
        moving = re.match(r"^Robot (\S+) (?:→ WP|WP \d+/\d+ SUCCEEDED|lap )", msg)
        missed = re.match(r"^Robot (\S+) WP \d+/\d+ (\w+)", msg)
        finished = re.match(r"^Robot (\S+) finished its route", msg)
        halted = re.match(r"^Robot (\S+) stopped at", msg)
        if sent:
            self.notice = ""
            for rid in re.findall(r"(\S+) \(\d+ WP\)", sent.group(1)):
                self._robot(rid, "In progress")
        elif waiting:  # what fleet_management.py waits for, in plain words
            why = waiting.group(1)
            deaf, lost = re.findall(r"/goal_pose_([^\s,]+)", why), re.findall(r"/ODOM_relayed_([^\s,]+)", why)
            busy = re.match(r"^robot (.+?) still driving", why)
            if deaf:
                why = f"robot {', '.join(deaf)} not connected: is its bridge running?"
            elif lost:
                why = f"no position yet from robot {', '.join(lost)}"
            elif busy:
                why = f"robot {busy.group(1)} still busy with its previous task"
            self.notice = f"Fleet waiting: {why}"
        elif moving:
            self._robot(moving.group(1), "In progress")
        elif missed:  # it goes on to the next one
            self._robot(missed.group(1), "In progress")
            self._event(f"Robot {missed.group(1)} could not reach a goal ({missed.group(2).lower()}), going on")
        elif finished:
            self._robot(finished.group(1), "Done")
        elif halted:
            self._robot(halted.group(1), "Stopped")

    def _aloha(self, msg):
        if re.match(r"^Robot \S+ (?:→ WP|WP \d+/\d+ SUCCEEDED|docking onto|docked:|finished its route)", msg):
            self._robot(ALOHA, "In progress")
        elif msg.startswith("Waiting for"):
            self.notice = f"Aloha {msg[0].lower() + msg[1:]}"
        else:  # what went wrong
            missed = re.match(r"^Robot \S+ WP \d+/\d+ (.+)$", msg)
            why = f"could not reach the box ({missed.group(1).lower()})" if missed else re.sub(r"^Robot \S+ ", "", msg)
            why = why[:1].upper() + why[1:]
            self._robot(ALOHA, "Failed")
            self.failure = f"Aloha: {why}"
            self._event(self.failure)

    def _name(self, rid):
        return self.robots[rid].name if rid in self.robots else f"Robot {rid}"

    def _detect(self, msg):
        box = self.box
        report = re.match(r"^Box (found|update) by robot (\S+) (?:at x=(\S+) y=(\S+) \(map\), ([\d.]+) m away|"
                          r"position not measured yet), confidence ([\d.]+), image (.+)$", msg)
        if report:
            _, rid, x, y, away, conf, image = report.groups()
            first = box["state"] != "found"
            box.update(state="found", robot=rid, conf=float(conf), image=image.strip(), updated=time.strftime("%H:%M:%S"))
            if x is not None:
                box["xy"], box["away"] = (float(x), float(y)), float(away)
            where = f"at x {float(x):.2f}, y {float(y):.2f}" if x is not None else "(position being measured)"
            if first:
                box["found"] = box["updated"]
                self.kind, self.banner = "found", f"Suspicious box found by {self._name(rid)} {where}"
                self._event(self.banner)
                phase = self._current()
                if phase:
                    phase.detail = f"Box found {where}"
            elif x is not None:
                self._event(f"Box position refined: x {float(x):.2f}, y {float(y):.2f}")
        elif msg.startswith("Starting"):
            box["state"] = "starting"
        elif msg.startswith("Watching") and box["state"] != "found":
            box["state"] = "searching"
        elif msg.startswith("No video") and box["state"] != "found":  # it gave up: the demo goes on to the cordon
            box["state"] = "gaveup"
        elif msg.startswith("Cannot start"):
            box.update(state="error", why=re.sub(r"^Cannot start:\s*", "", msg))
            self.notice = f"Box detection not running: {box['why']}"

    def _inspect(self, msg):
        contents = self.contents
        result = re.match(r"^Box contents: (.*); image (.+)$", msg)
        if msg.startswith("Taking a photo"):
            contents["state"] = "capturing"
        elif result:
            found = [] if result.group(1) == "nothing found" else \
                [(name, float(p)) for name, p in (item.rsplit(" ", 1) for item in result.group(1).split(", "))]
            contents.update(state="done", objects=found, image=result.group(2).strip(), time=time.strftime("%H:%M:%S"))
            self._event(f"Inside the box: {inventory(found)}")
            phase = self._current()
            if phase:
                phase.detail = f"Contents: {inventory(found)}"
            self._ask_verdict()
        elif msg.startswith(("No photo", "Cannot run")):
            contents.update(state="error", why=msg)
            self._event(f"Aloha: {msg}")
            self._ask_verdict()

    def _video(self, msg):  # the camera stream of the box detection
        if self.box["state"] in ("starting", "searching", "novideo"):
            if msg.startswith(("cannot open", "stream lost")):
                self.box["state"] = "novideo"
            elif msg.startswith("connected"):
                self.box["state"] = "searching"

    def _arms(self, s):
        if re.match(r"^Pose \d+/\d+$", s):
            self._robot(ALOHA, "In progress")
        elif s.startswith("Done: the arms"):
            self._robot(ALOHA, "Done")
        elif s.startswith("Stopped: the arms"):
            self._robot(ALOHA, "Stopped")
        elif re.match(r"^Still .* off after", s):
            self.notice = f"Aloha: {s}"


class WrapLabel(QtWidgets.QLabel):
    """A word-wrapped label that asks for the height its text needs at its width, which layouts do not do"""

    def __init__(self, text=""):
        super().__init__(text)
        self.setWordWrap(True)
        self.setSizePolicy(QtWidgets.QSizePolicy.Preferred, QtWidgets.QSizePolicy.Minimum)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._fit()

    def setText(self, text):
        super().setText(text)
        self._fit()

    def _fit(self):
        height = self.heightForWidth(self.width())
        if height > 0 and height != self.minimumHeight():
            self.setMinimumHeight(height)


class Picture(QtWidgets.QLabel):
    """An image as wide as the label, at the image's own aspect; a click on it is for a larger view"""
    clicked = QtCore.pyqtSignal()

    def __init__(self):
        super().__init__()
        self.source = None
        self.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Fixed)
        self.setAlignment(QtCore.Qt.AlignCenter)
        self.setCursor(QtCore.Qt.PointingHandCursor)
        self.setToolTip("Click to enlarge")

    def mousePressEvent(self, event):
        if self.source is not None and event.button() == QtCore.Qt.LeftButton:
            self.clicked.emit()

    def show_file(self, path):
        image = QtGui.QPixmap(path)
        self.source = None if image.isNull() else image
        self.setVisible(self.source is not None)
        self._fit()

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._fit()

    def _fit(self):
        if self.source is not None:
            scaled = self.source.scaledToWidth(max(self.width() - 4, 40), QtCore.Qt.SmoothTransformation)
            if scaled.height() > IMAGE_HEIGHT:
                scaled = self.source.scaledToHeight(IMAGE_HEIGHT, QtCore.Qt.SmoothTransformation)
            self.setPixmap(scaled)
            self.setFixedHeight(scaled.height() + 4)


class Viewer(QtWidgets.QWidget):
    """An image in a window of its own, as large as the window: maximize it (or double-click, or F) to fill the screen.
    Esc closes it."""

    def __init__(self, parent, path, title):
        super().__init__(parent, QtCore.Qt.Window)
        self.setAttribute(QtCore.Qt.WA_DeleteOnClose)
        self.setWindowTitle(title)
        self.source = QtGui.QPixmap(path)
        self.image = QtWidgets.QLabel()
        self.image.setAlignment(QtCore.Qt.AlignCenter)
        self.image.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Ignored)
        self.image.setStyleSheet("background: #000;")
        layout = QtWidgets.QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.image)
        screen = QtWidgets.QApplication.primaryScreen().availableGeometry()
        self.resize(self.source.size().scaled(int(screen.width() * 0.8), int(screen.height() * 0.8),
                                              QtCore.Qt.KeepAspectRatio))

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.image.setPixmap(self.source.scaled(self.image.size(), QtCore.Qt.KeepAspectRatio,
                                                QtCore.Qt.SmoothTransformation))

    def _toggle(self):
        self.showNormal() if self.isMaximized() else self.showMaximized()

    def mouseDoubleClickEvent(self, event):
        self._toggle()

    def keyPressEvent(self, event):
        if event.key() == QtCore.Qt.Key_Escape:
            self.close()
        elif event.key() == QtCore.Qt.Key_F:
            self._toggle()


class Row(QtWidgets.QFrame):
    """A line of status: a mark, a name and a detail under it (or beside it), inverted while it is under way"""

    def __init__(self, mark=True, rich=False, inline=False):
        super().__init__()
        self.setObjectName("row")
        grid = QtWidgets.QGridLayout(self)
        grid.setContentsMargins(8, 6, 8, 6)
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(2)
        self.mark, self.name, self.detail = QtWidgets.QLabel(), QtWidgets.QLabel(), WrapLabel()
        self.mark.setFixedWidth(16)
        self.name.setObjectName("rowName")
        self.detail.setObjectName("rowDetail")
        self.detail.setTextFormat(QtCore.Qt.RichText if rich else QtCore.Qt.PlainText)
        if mark:
            grid.addWidget(self.mark, 0, 0, QtCore.Qt.AlignTop)
        grid.addWidget(self.name, 0, 1, QtCore.Qt.AlignTop)
        if inline:
            self.detail.setAlignment(QtCore.Qt.AlignRight)
            grid.addWidget(self.detail, 0, 2)
            grid.setColumnStretch(2, 1)
        else:
            grid.addWidget(self.detail, 1, 1)
            grid.setColumnStretch(1, 1)

    def set(self, mark, name, detail, style=""):
        self.mark.setText(mark)
        self.name.setText(name)
        self.detail.setText(detail)
        self.detail.setVisible(bool(detail))
        self.setStyleSheet({"inverted": INVERTED, "dim": DIM}.get(style, ""))


def panel(title):
    frame = QtWidgets.QFrame()
    frame.setObjectName("panel")
    outer = QtWidgets.QVBoxLayout(frame)
    outer.setContentsMargins(0, 0, 0, 0)
    outer.setSpacing(0)
    head = QtWidgets.QLabel(title)
    head.setObjectName("panelTitle")
    outer.addWidget(head)
    body = QtWidgets.QVBoxLayout()
    body.setContentsMargins(12, 10, 12, 12)
    body.setSpacing(6)
    outer.addLayout(body, 1)
    return frame, body


def section(text):
    label = QtWidgets.QLabel(text)
    label.setObjectName("section")
    return label


def clear(layout):
    while layout.count():
        item = layout.takeAt(0)
        if item.widget():
            item.widget().deleteLater()


class Window(QtWidgets.QWidget):
    def __init__(self, demo):
        super().__init__()
        self.demo = demo
        self.force_quit = False
        self.phase_rows, self.robot_rows = [], {}
        self.plan_shown = None
        self.setWindowTitle("Multi-robot coordinated search and discovery")
        page = QtWidgets.QVBoxLayout(self)
        page.setContentsMargins(14, 12, 14, 14)
        page.setSpacing(10)

        head = QtWidgets.QHBoxLayout()
        title = QtWidgets.QLabel("MULTI-ROBOT COORDINATED SEARCH AND DISCOVERY")
        title.setObjectName("title")
        self.on_top = QtWidgets.QCheckBox("Keep on top")
        self.on_top.toggled.connect(self._keep_on_top)
        self.clock = QtWidgets.QLabel()
        self.clock.setObjectName("clock")
        self.start_btn = QtWidgets.QPushButton("Start demo")
        self.start_btn.setObjectName("primary")
        self.start_btn.clicked.connect(demo.start)
        self.stop_btn = QtWidgets.QPushButton("Stop demo")
        self.stop_btn.clicked.connect(self._stop)
        for w in (title, None, self.on_top, self.clock, self.start_btn, self.stop_btn):
            head.addStretch() if w is None else head.addWidget(w)
        page.addLayout(head)

        self.banner = QtWidgets.QFrame()
        banner = QtWidgets.QHBoxLayout(self.banner)
        banner.setContentsMargins(14, 10, 14, 10)
        banner.setSpacing(14)
        self.banner_tag, self.banner_text = QtWidgets.QLabel(), QtWidgets.QLabel()
        self.banner_tag.setMinimumWidth(150)
        self.banner_text.setWordWrap(True)
        banner.addWidget(self.banner_tag)
        banner.addWidget(self.banner_text, 1)
        page.addWidget(self.banner)
        self.notice = QtWidgets.QLabel()
        self.notice.setObjectName("notice")
        self.notice.setWordWrap(True)
        page.addWidget(self.notice)
        self.event = QtWidgets.QLabel()
        self.event.setObjectName("event")
        page.addWidget(self.event)

        # Mission plan and operator over all plans and the log; the box and the robots down the right
        body = QtWidgets.QGridLayout()
        body.setSpacing(10)
        frame, self.mission = panel("MISSION PLAN")
        self.mission_shown = None
        body.addWidget(frame, 0, 0)
        body.addWidget(self._operator_panel(), 0, 1)
        body.addWidget(self._plans_panel(), 1, 0, 1, 2)
        body.addWidget(self._log_panel(), 2, 0, 1, 2)
        right = QtWidgets.QVBoxLayout()
        right.setSpacing(10)
        right.addWidget(self._box_panel())
        frame, self.robots = panel("ROBOTS")
        self.robots.setSpacing(0)
        self.robots.addStretch()
        right.addWidget(frame, 1)
        body.addLayout(right, 0, 2, 3, 1)
        for column, stretch in enumerate((3, 6, 3)):
            body.setColumnStretch(column, stretch)
        body.setRowStretch(0, 1)
        page.addLayout(body, 1)

        demo.changed.connect(self.refresh)
        demo.logged.connect(self.log.appendPlainText)
        tick = QtCore.QTimer(self)
        tick.timeout.connect(self._tick)
        tick.start(1000)
        self.refresh()

    def _operator_panel(self):
        frame, body = panel("OPERATOR")
        body.addWidget(section("INSTRUCTION"))
        line = QtWidgets.QHBoxLayout()
        self.instruction = QtWidgets.QLineEdit()
        self.instruction.setPlaceholderText(f"Empty: {self.demo.default_instruction}")
        self.instruction.returnPressed.connect(self._send)
        self.send_btn = QtWidgets.QPushButton("Send")
        self.send_btn.setObjectName("primary")
        self.send_btn.clicked.connect(self._send)
        line.addWidget(self.instruction, 1)
        line.addWidget(self.send_btn)
        body.addLayout(line)
        body.addSpacing(6)
        body.addWidget(section("PLAN"))
        self.plan = QtWidgets.QFrame()
        self.plan.setObjectName("plan")
        self.plan.setSizePolicy(QtWidgets.QSizePolicy.Preferred, QtWidgets.QSizePolicy.Minimum)
        card = QtWidgets.QVBoxLayout(self.plan)
        card.setContentsMargins(12, 10, 12, 12)
        card.setSpacing(6)
        top = QtWidgets.QHBoxLayout()
        self.plan_title, self.plan_badge = QtWidgets.QLabel(), QtWidgets.QLabel()
        self.plan_title.setObjectName("planTitle")
        top.addWidget(self.plan_title)
        top.addStretch()
        top.addWidget(self.plan_badge)
        card.addLayout(top)
        self.plan_summary = WrapLabel()
        card.addWidget(self.plan_summary)
        self.plan_rows = QtWidgets.QGridLayout()
        self.plan_rows.setHorizontalSpacing(12)
        self.plan_rows.setVerticalSpacing(6)
        self.plan_rows.setColumnStretch(1, 1)
        card.addLayout(self.plan_rows)
        decide = QtWidgets.QHBoxLayout()
        self.approve_btn = QtWidgets.QPushButton("Approve plan")
        self.approve_btn.setObjectName("primary")
        self.approve_btn.clicked.connect(self._approve)
        self.deny_btn = QtWidgets.QPushButton("Deny")
        self.deny_btn.clicked.connect(lambda: self.demo.send("deny", "deny"))
        for button in (self.approve_btn, self.deny_btn):
            button.setMinimumHeight(46)
            decide.addWidget(button, 1)
        card.addSpacing(4)
        card.addLayout(decide)
        body.addWidget(self.plan)
        body.addStretch()
        return frame

    def _box_panel(self):
        frame, body = panel(f"SUSPICIOUS BOX · {SEARCHER[0]} · {SEARCHER[1]} AND ALOHA")
        self.box_strip, self.contents_strip = QtWidgets.QLabel(), QtWidgets.QLabel()
        self.box_image, self.contents_image = Picture(), Picture()
        self.box_where = QtWidgets.QLabel()
        self.box_where.setObjectName("boxWhere")
        self.box_note, self.contents_note = WrapLabel(), WrapLabel()
        for strip in (self.box_strip, self.contents_strip):
            strip.setObjectName("boxStrip")
        for note in (self.box_note, self.contents_note):
            note.setObjectName("rowDetail")
        for w in (self.box_strip, self.box_image, self.box_where, self.box_note):
            body.addWidget(w)
        body.addSpacing(6)
        self.contents_bar = QtWidgets.QFrame()
        self.contents_bar.setStyleSheet("QFrame { background: #000; }")
        bar = QtWidgets.QHBoxLayout(self.contents_bar)
        bar.setContentsMargins(0, 0, 6, 0)
        bar.addWidget(self.contents_strip, 1)
        self.enlarge_btn = QtWidgets.QPushButton("⤢ Enlarge")
        self.enlarge_btn.setObjectName("strip")
        bar.addWidget(self.enlarge_btn)
        self.verdict_buttons = QtWidgets.QWidget()
        decide = QtWidgets.QHBoxLayout(self.verdict_buttons)
        decide.setContentsMargins(0, 4, 0, 0)
        self.anomaly_btn, self.clear_btn = QtWidgets.QPushButton("Anomaly"), QtWidgets.QPushButton("Clear")
        self.anomaly_btn.setObjectName("primary")
        for button, verdict in ((self.anomaly_btn, "anomaly"), (self.clear_btn, "clear")):
            button.setMinimumHeight(40)
            button.clicked.connect(lambda _, v=verdict: self._decide(v))
            decide.addWidget(button, 1)
        self.verdict = QtWidgets.QLabel()
        self.verdict.setAlignment(QtCore.Qt.AlignCenter)
        for w in (self.contents_bar, self.contents_image, self.contents_note, self.verdict_buttons, self.verdict):
            body.addWidget(w)
        self.box_image.clicked.connect(lambda: self._enlarge(self.demo.box["image"],
                                                             f"Suspicious box · {self.demo.box['found']}"))
        for widget in (self.contents_image, self.enlarge_btn):
            widget.clicked.connect(lambda: self._enlarge(self.demo.contents["image"],
                                                         f"Box contents · {self.demo.contents['time']}"))
        self.box_shown = self.contents_shown = None
        return frame

    def _plans_panel(self):
        frame, body = panel("ALL PLANS")
        body.setContentsMargins(12, 4, 12, 6)
        self.history = QtWidgets.QTableWidget(0, 5)
        self.history.setHorizontalHeaderLabels(["#", "Time", "Plan", "Instruction", "Status"])
        self.history.verticalHeader().hide()
        self.history.setShowGrid(False)
        self.history.setEditTriggers(QtWidgets.QAbstractItemView.NoEditTriggers)
        self.history.setSelectionMode(QtWidgets.QAbstractItemView.NoSelection)
        self.history.setFocusPolicy(QtCore.Qt.NoFocus)
        header = self.history.horizontalHeader()
        header.setDefaultAlignment(QtCore.Qt.AlignLeft)
        for col in (0, 1, 2, 4):
            header.setSectionResizeMode(col, QtWidgets.QHeaderView.ResizeToContents)
        header.setSectionResizeMode(3, QtWidgets.QHeaderView.Stretch)
        self.history.setFixedHeight(104)
        body.addWidget(self.history)
        return frame

    def _log_panel(self):
        frame = QtWidgets.QFrame()
        frame.setObjectName("panel")
        outer = QtWidgets.QVBoxLayout(frame)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        bar = QtWidgets.QHBoxLayout()
        bar.setContentsMargins(0, 0, 8, 0)
        title = QtWidgets.QLabel("LOG")
        title.setObjectName("panelTitle")
        title.setStyleSheet("border: none;")
        env = QtWidgets.QLabel(f"{os.path.relpath(self.demo.script, self.demo.cwd)}   ·   "
                               f"ROS_DOMAIN_ID {self.demo.env['ROS_DOMAIN_ID']}   ·   "
                               f"{os.path.basename(self.demo.env['FASTRTPS_DEFAULT_PROFILES_FILE'])}")
        env.setObjectName("env")
        self.log_btn = QtWidgets.QPushButton("Show")
        self.log_btn.setObjectName("small")
        self.log_btn.clicked.connect(self._toggle_log)
        bar.addWidget(title)
        bar.addStretch()
        bar.addWidget(env)
        bar.addSpacing(10)
        bar.addWidget(self.log_btn)
        outer.addLayout(bar)
        self.log = QtWidgets.QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(3000)
        self.log.setFixedHeight(150)
        self.log.setStyleSheet("QPlainTextEdit { border-top: 2px solid #000; padding: 4px; }")
        self.log.hide()
        outer.addWidget(self.log)
        return frame

    # Operator actions

    def _send(self):
        if self.demo.expecting == "instruction":
            text = self.instruction.text().strip()
            self.demo.send(text, f'instruction "{text or self.demo.default_instruction}"')
            self.instruction.clear()

    def _approve(self):
        plan = self.demo.plans[-1] if self.demo.plans else None
        name = f"plan {plan['id']}" if plan and plan["id"] else "the plan"
        if self._ask("Approve plan", f"Approve {name}? The robots set off on it."):
            self.demo.send("approve", "approve")

    def _decide(self, verdict):
        if self._ask("Box contents", f"Mark the box's contents as {verdict.upper()}?"):
            self.demo.decide(verdict)

    def _enlarge(self, path, title):
        if path:
            Viewer(self, path, title).show()

    def _stop(self):
        if self.demo.can_force():
            if self._ask("Force stop", "The demo has not stopped yet. Kill it?"):
                self.demo.stop(force=True)
        elif self._ask("Stop demo", "Stop the demo? Each robot still drives to the waypoint it has; "
                                    "the Aloha's arms stop where they are."):
            self.demo.stop()

    def _ask(self, title, text):
        return QtWidgets.QMessageBox.question(self, title, text) == QtWidgets.QMessageBox.Yes

    def _keep_on_top(self, on):
        self.setWindowFlag(QtCore.Qt.WindowStaysOnTopHint, on)
        self.show()

    def _toggle_log(self):
        self.log.setVisible(not self.log.isVisible())
        self.log_btn.setText("Hide" if self.log.isVisible() else "Show")

    def closeEvent(self, event):
        if self.demo.proc and not self.force_quit and not self._ask(
                "Quit", "The demo is running. Stop it and close this window?"):
            event.ignore()
            return
        self.demo.shutdown()
        event.accept()

    # Showing the demo

    def _tick(self):
        d = self.demo
        if d.started is not None:
            self.clock.setText(clock((d.ended or time.monotonic()) - d.started))
        self._show_robots()
        self.stop_btn.setText("Force stop" if d.can_force() else "Stop demo")

    def refresh(self):
        d = self.demo
        running = d.proc is not None
        self.start_btn.setEnabled(not running)
        self.stop_btn.setEnabled(running)
        if d.started is None:
            self.clock.setText("--:--:--")
        inverted = d.kind in INVERTED_KINDS
        fg, bg = ("#fff", "#000") if inverted else ("#000", "#fff")
        self.banner.setStyleSheet(f"QFrame {{ border: 2px solid #000; background: {bg}; }}"
                                  f"QLabel {{ border: none; background: {bg}; color: {fg}; }}")
        self.banner_tag.setText(TAGS[d.kind])
        self.banner_tag.setStyleSheet("font-size: 10pt; font-weight: bold;")
        self.banner_text.setText(plain(d.banner))
        self.banner_text.setStyleSheet("font-size: 15pt; font-weight: bold;")
        self.notice.setText(f"!   {plain(d.notice)}")
        self.notice.setVisible(bool(d.notice))
        self.event.setText(f"Last event   {plain(d.event)}" if d.event else "")
        self.event.setVisible(bool(d.event))

        # The mission plan: what follows the operator's instruction, once there is one
        steps = d.phases[1:] if d.instruction is not None else []
        if self.mission_shown != [p.name for p in steps]:
            self.mission_shown = [p.name for p in steps]
            clear(self.mission)
            self.phase_rows = [Row() for _ in steps]
            for row in self.phase_rows:
                self.mission.addWidget(row)
            if not steps:
                empty = WrapLabel("The mission plan is generated once the operator sends an instruction, "
                                  "then executed step by step.")
                empty.setObjectName("note")
                self.mission.addWidget(empty)
            self.mission.addStretch()
        for n, (row, phase) in enumerate(zip(self.phase_rows, steps), 1):
            detail = plain(phase.detail)
            detail = detail if len(detail) <= DETAIL_CHARS else detail[:DETAIL_CHARS - 1] + "…"
            row.set(MARKS[phase.status], f"{n}.  {phase.name}", detail,
                    "inverted" if phase.status == ACTIVE else "dim" if phase.status in (PENDING, SKIPPED) else "")

        asking = d.expecting == "instruction"
        self.instruction.setEnabled(asking)
        self.send_btn.setEnabled(asking)
        if asking and not self.instruction.hasFocus():
            self.instruction.setFocus()
        self.approve_btn.setEnabled(d.expecting == "approval")
        self.deny_btn.setEnabled(d.expecting == "approval")
        self._show_plan()
        self._show_history()
        self._show_robots()
        self._show_box()

    def _show_box(self):
        box = self.demo.box
        robot = self.demo._name(box["robot"])
        found = box["state"] == "found"
        self.box_strip.setVisible(found)
        self.box_where.setVisible(found)
        if found:
            self.box_strip.setText(f"SUSPICIOUS BOX FOUND · {box['found']}")
            if box["image"] != self.box_shown:
                self.box_shown = box["image"]
                self.box_image.show_file(box["image"])
            if box["xy"] is not None:
                x, y = (f"{v:.2f}".replace("-", "−") for v in box["xy"])
                self.box_where.setText(f"x {x} m    y {y} m")
                note = f"On the map · {box['away']:.1f} m from {robot} · confidence {box['conf']:.0%}"
            else:
                self.box_where.setText("Position being measured…")
                note = f"Seen by {robot} · confidence {box['conf']:.0%}"
            if box["updated"] != box["found"]:
                note += f" · refined {box['updated']}"
        else:
            self.box_image.hide()
            self.box_shown = None
            note = {"off": f"Starts with the sweep, on {robot}'s camera.",
                    "starting": f"Starting the detection on {robot}'s camera…",
                    "searching": f"Searching: {robot}'s camera is looking for the box.",
                    "novideo": f"No video from {robot}'s camera yet. Retrying…",
                    "error": f"Not running: {box['why']}",
                    "gaveup": f"No video from {robot}'s camera after 3 tries. The demo went on to the cordon.",
                    "ended": "No box was found."}[box["state"]]
        self.box_note.setText(note)
        self.box_note.setStyleSheet("font-weight: bold;" if box["state"] in ("searching", "novideo", "error", "gaveup")
                                    else "")

        contents, verdict = self.demo.contents, self.demo.verdict
        shown = contents["state"] != "off"
        for w in (self.contents_bar, self.contents_note):
            w.setVisible(shown)
        self.enlarge_btn.setVisible(contents["state"] == "done")
        self.verdict_buttons.setVisible(shown and verdict is None)
        for button in (self.anomaly_btn, self.clear_btn):
            button.setEnabled(self.demo.expecting == "verdict")
        self.verdict.setVisible(verdict is not None)
        if verdict is not None:
            self.verdict.setText("Verdict sent…" if verdict == "sent" else f"VERDICT · {verdict.upper()}")
            style = BADGE_STYLES["inverted" if verdict == "anomaly" else ""]
            self.verdict.setStyleSheet(style + "font-size: 12pt; padding: 6px;")
        if contents["state"] == "done":
            self.contents_strip.setText(f"CONTENTS · ALOHA · {contents['time']}")
            if contents["image"] != self.contents_shown:
                self.contents_shown = contents["image"]
                self.contents_image.show_file(contents["image"])
            self.contents_note.setText("   ·   ".join(f"{name[:1].upper() + name[1:]} {p:.0%}"
                                                      for name, p in contents["objects"]) or "Nothing found inside.")
        else:
            self.contents_image.hide()
            self.contents_shown = None
            self.contents_strip.setText("CONTENTS · ALOHA")
            self.contents_note.setText("Taking a photo of the contents…" if contents["state"] == "capturing"
                                       else contents["why"])

    def _show_plan(self):
        d = self.demo
        plan = d.plans[-1] if d.plans else None
        if not plan:
            self.plan_title.setText("No plan yet")
            self.plan_summary.setText("The plan appears here once the operator instruction is sent.")
            self.plan_badge.hide()
            clear(self.plan_rows)
            self.plan_shown = None
            return
        self.plan_title.setText(f"Plan {plan['id']}" if plan["id"] else "Plan")
        self.plan_summary.setText(plan["summary"][:1].upper() + plan["summary"][1:] if plan["summary"]
                                  else "Generating…")
        text, style = BADGES[plan["status"]]
        self.plan_badge.setText(text)
        self.plan_badge.setStyleSheet(BADGE_STYLES[style])
        self.plan_badge.show()
        if self.plan_shown != (plan["n"], len(plan["rows"])):
            self.plan_shown = (plan["n"], len(plan["rows"]))
            clear(self.plan_rows)
            for i, (label, steps) in enumerate(plan["rows"]):
                name, what = QtWidgets.QLabel(label), WrapLabel(steps)
                name.setObjectName("planLabel")
                what.setObjectName("planSteps")
                self.plan_rows.addWidget(name, i, 0, QtCore.Qt.AlignTop)
                self.plan_rows.addWidget(what, i, 1)

    def _show_history(self):
        plans = list(reversed(self.demo.plans))
        self.history.setRowCount(len(plans))
        for r, plan in enumerate(plans):
            cells = (str(plan["n"]), plan["time"], plan["id"] or "…", plan["instruction"] or "—",
                     BADGES[plan["status"]][0])
            for c, text in enumerate(cells):
                item = QtWidgets.QTableWidgetItem(text)
                if c == 4:
                    font = item.font()
                    font.setBold(True)
                    item.setFont(font)
                self.history.setItem(r, c, item)

    def _show_robots(self):
        d = self.demo
        if list(self.robot_rows) != list(d.robots):
            clear(self.robots)
            self.robot_rows = {rid: Row(mark=False, inline=True) for rid in d.robots}
            for row in self.robot_rows.values():
                self.robots.addWidget(row)
            self.robots.addStretch()
        for rid, robot in d.robots.items():
            self.robot_rows[rid].set("", robot.name, plain(robot.text), "dim" if robot.since is None else "")


def application():
    app = QtWidgets.QApplication(sys.argv[:1])
    app.setStyleSheet(STYLE)
    app.setFont(QtGui.QFont("DejaVu Sans", 11))
    return app


def main():
    script = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "run_demo.sh"))
    app = application()
    window = Window(Demo(script))
    window.resize(1180, 780)
    window.show()

    def interrupted(*_):  # Ctrl+C in this terminal: stop the demo and quit
        window.force_quit = True
        window.close()
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    wake = QtCore.QTimer()  # lets Python run its signal handlers while Qt waits
    wake.timeout.connect(lambda: None)
    wake.start(250)
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
