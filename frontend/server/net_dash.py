#!/usr/bin/env python3
"""A live ping dashboard for one host: net_dash.py HOST [--name NAME] [--period S] [--good MS] [--bad MS].

It sends one ICMP echo a second from this workstation itself (the devcontainer has no ping binary): an ICMP datagram
socket, which Linux lets any user open (net.ipv4.ping_group_range), else a raw one. The round-trip time is the kernel's
receive timestamp minus the send time, so drawing the screen never adds to it. A reply later than --timeout counts as
lost. The screen: the latest reply, then min, mean, max, jitter (mean change between replies) and loss over the
current period (the last 60 s; p switches 10 s / 60 s / 5 min) and since the start (r starts the totals over), and a
chart of the latest pings, green up to --good ms, amber up to --bad, red above, × for a lost one. q or Ctrl+C quits.

The Command Center's Fleet health page runs one for each robot added in Setup and one for the router
(frontend/server/setup-hub.ts)."""

import argparse
import math
import os
import select
import signal
import socket
import struct
import sys
import time
from collections import deque

try:
    import termios
    import tty
except ImportError:  # not a Unix terminal: no keys, the rest works
    termios = tty = None

PERIODS_S = (10, 60, 300)
KEEP = 2000  # probes kept for the period and the chart
BARS = " ▁▂▃▄▅▆▇█"
SO_TIMESTAMPNS = getattr(socket, "SO_TIMESTAMPNS", 35)  # Python 3.8 lacks the name; 35 on Linux
PAYLOAD = b"net_dash".ljust(56, b".")  # ping's default size

# ANSI colours: the Command Center's terminal theme maps them to its status tones (src/shared/ui/XtermPane)
OK, WARN, BAD, LIVE, MUTED, TEXT, STRONG = "32", "33", "31", "36", "90", "37", "1;97"


def checksum(data):
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    total = (total >> 16) + (total & 0xFFFF)
    total += total >> 16
    return ~total & 0xFFFF


class Pinger:
    """ICMP echo requests and their replies, from this process"""

    def __init__(self, host):
        self.addr = socket.gethostbyname(host)
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
            self.raw = False
        except OSError:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
            self.raw = True
        self.sock.setblocking(False)
        try:
            self.sock.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS, 1)
        except OSError:
            pass  # then the time it is read at
        self.ident = os.getpid() & 0xFFFF  # a datagram socket's is the kernel's, which only hands it its own replies
        self.seq = 0
        self.error = None

    def send(self):
        """Sends the next echo request: its sequence number and wall-clock send time. OSError when it cannot go out
        (network down, no route, the host not answering ARP)."""
        self.seq = (self.seq + 1) & 0xFFFF
        packet = struct.pack("!BBHHH", 8, 0, 0, self.ident, self.seq) + PAYLOAD
        packet = packet[:2] + struct.pack("!H", checksum(packet)) + packet[4:]
        sent = time.time()
        self.sock.sendto(packet, (self.addr, 0))
        return self.seq, sent

    def replies(self):
        """The echo replies waiting: (sequence number, wall-clock arrival time)"""
        got = []
        while True:
            try:
                data, ancillary, _, _ = self.sock.recvmsg(2048, 256)
            except BlockingIOError:
                return got
            except OSError as e:  # an ICMP error queued on the socket
                self.error = e.strerror or str(e)
                return got
            arrived = time.time()
            for level, kind, cdata in ancillary:
                if level == socket.SOL_SOCKET and kind == SO_TIMESTAMPNS and len(cdata) >= 16:
                    sec, nsec = struct.unpack("@ll", cdata[:16])
                    arrived = sec + nsec / 1e9
            if self.raw:
                data = data[(data[0] & 0x0F) * 4:]
            if len(data) < 8:
                continue
            kind, _, _, ident, seq = struct.unpack("!BBHHH", data[:8])
            if kind == 0 and (not self.raw or ident == self.ident):
                got.append((seq, arrived))


class Probe:
    __slots__ = ("seq", "due", "sent", "rtt", "lost")

    def __init__(self, seq, sent, due):
        self.seq = seq
        self.sent = sent  # wall clock
        self.due = due  # monotonic: lost if no reply by then
        self.rtt = None  # ms
        self.lost = False

    @property
    def settled(self):
        return self.lost or self.rtt is not None


class Totals:
    """min, mean, max, jitter and loss over the probes added"""

    def __init__(self):
        self.since = time.time()
        self.n = self.lost = 0
        self.sum = 0.0
        self.min = self.max = None
        self.jitter_sum, self.jitter_n, self.prev = 0.0, 0, None

    def add(self, probe):
        self.n += 1
        if probe.lost:
            self.lost += 1
            return
        r = probe.rtt
        self.sum += r
        self.min = r if self.min is None else min(self.min, r)
        self.max = r if self.max is None else max(self.max, r)
        if self.prev is not None:
            self.jitter_sum += abs(r - self.prev)
            self.jitter_n += 1
        self.prev = r

    @property
    def replies(self):
        return self.n - self.lost

    @property
    def mean(self):
        return self.sum / self.replies if self.replies else None

    @property
    def jitter(self):
        return self.jitter_sum / self.jitter_n if self.jitter_n else None

    @property
    def loss(self):
        return 100.0 * self.lost / self.n if self.n else None


def totals_of(probes):
    totals = Totals()
    for probe in probes:
        totals.add(probe)
    return totals


def nice_ceil(v):
    """The chart's top: v rounded up to 1, 2, 2.5 or 5 times a power of ten"""
    if v <= 0:
        return 1.0
    base = 10 ** math.floor(math.log10(v))
    return next(m * base for m in (1, 2, 2.5, 5, 10) if v <= m * base * (1 + 1e-9))


def ms(v):
    if v is None:
        return "–"
    return f"{v:.2f} ms" if v < 10 else f"{v:.1f} ms" if v < 100 else f"{v:.0f} ms"


def axis_ms(v):
    return f"{v:.0f} ms" if v >= 10 else f"{v:.3g} ms"


def period_name(s):
    return f"last {s // 60} min" if s >= 120 and s % 60 == 0 else f"last {s} s"


def span(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds} s"
    if seconds < 3600:
        return f"{seconds // 60} min"
    return f"{seconds // 3600} h {seconds % 3600 // 60:02d} min"


def visible(segments):
    return sum(len(text) for text, _ in segments)


def render(segments, width):
    """Coloured segments [(text, sgr)] as one terminal line, cut to width"""
    out, used = [], 0
    for text, sgr in segments:
        if used >= width:
            break
        text = text[: width - used]
        used += len(text)
        out.append(f"\x1b[{sgr}m{text}\x1b[0m" if sgr else text)
    return "".join(out)


def spread(left, right, width):
    """left, and right against the right edge when it fits"""
    gap = width - visible(left) - visible(right)
    return render(left + [(" " * gap, "")] + right, width) if right and gap >= 1 else render(left, width)


class Dashboard:
    def __init__(self, args):
        self.args = args
        self.name = args.name or args.host
        self.pinger = Pinger(args.host)
        self.probes = deque(maxlen=KEEP)
        self.pending = {}
        self.totals = Totals()
        self.period = args.period
        self.error = None
        self.error_at = 0.0

    # ---------------------------------------------------------------------------------------------------------------
    # Pings

    def send(self, now):
        try:
            seq, sent = self.pinger.send()
        except OSError as e:
            probe = Probe(None, time.time(), now)
            probe.lost = True
            self.probes.append(probe)
            self.totals.add(probe)
            self.note_error(e.strerror or str(e), now)
            return
        probe = Probe(seq, sent, now + self.args.timeout)
        self.probes.append(probe)
        self.pending[seq] = probe

    def receive(self, now):
        for seq, arrived in self.pinger.replies():
            probe = self.pending.pop(seq, None)
            if probe is None:  # later than the timeout, already counted lost
                continue
            probe.rtt = max(0.0, (arrived - probe.sent) * 1000)
            self.totals.add(probe)
        if self.pinger.error:
            self.note_error(self.pinger.error, now)
            self.pinger.error = None

    def expire(self, now):
        for seq, probe in list(self.pending.items()):
            if now >= probe.due:
                probe.lost = True
                self.totals.add(probe)
                del self.pending[seq]

    def note_error(self, text, now):
        self.error, self.error_at = text, now

    def next_due(self):
        return min((p.due for p in self.pending.values()), default=math.inf)

    # ---------------------------------------------------------------------------------------------------------------
    # The screen

    def tone(self, v):
        return MUTED if v is None else OK if v <= self.args.good else WARN if v <= self.args.bad else BAD

    def state(self):
        settled = [p for p in self.probes if p.settled]
        if not settled:
            return "starting", MUTED
        lost_run = 0
        for probe in reversed(settled):
            if not probe.lost:
                break
            lost_run += 1
        if lost_run >= 3:
            return f"DOWN · no reply for {span(lost_run * self.args.interval)}", BAD
        if lost_run:
            return "LOSING PINGS", WARN
        last = settled[-1].rtt
        if last > self.args.good:
            return "SLOW", self.tone(last)
        return "UP", OK

    def lines(self, width, height, now):
        args = self.args
        settled = [p for p in self.probes if p.settled]
        last = settled[-1] if settled else None
        state, state_tone = self.state()
        out = [
            spread(
                [(f" {self.name}", STRONG), (f"  {self.pinger.addr}", MUTED)],
                [(f"● {state} ", state_tone)],
                width,
            )
        ]

        if last is None:
            now_part = [(" latency now ", MUTED), ("waiting for the first reply", MUTED)]
        elif last.lost:
            now_part = [(" latency now ", MUTED), ("no reply", BAD)]
        else:
            now_part = [(" latency now ", MUTED), (ms(last.rtt), f"1;{self.tone(last.rtt)}")]
        if self.error and now - self.error_at < 10:
            note = [(self.error, BAD)]
        else:
            every = "1 ping/s" if args.interval == 1 else f"1 ping every {args.interval:g} s"
            note = [(f"{every} · lost after {args.timeout:g} s", MUTED)]
        out.append(spread(now_part, note + [(" ", "")], width))
        compact = height < 20  # a short pane: no rule here, no title or time labels on the chart, room for its bars
        if not compact:
            out.append(render([(" " + "─" * (width - 2), MUTED)], width))

        # Wide: every period side by side; narrow: the one p picks
        wall = time.time()
        wide = width >= 9 + 4 * 13 + 12
        periods = PERIODS_S if wide else (self.period,)
        columns = [(period_name(s), totals_of(p for p in settled if p.sent >= wall - s)) for s in periods]
        columns.append(("since start", self.totals))
        cw = 13 if wide else 15
        rows = [[(" " * 9, "")] + [(name.rjust(cw), LIVE) for name, _ in columns]]
        for label, value in (("min", lambda t: t.min), ("mean", lambda t: t.mean), ("max", lambda t: t.max),
                             ("jitter", lambda t: t.jitter)):
            cells = []
            for _, t in columns:
                v = value(t)
                cells.append((ms(v).rjust(cw), MUTED if v is None else TEXT if label == "jitter" else self.tone(v)))
            rows.append([(f" {label:<8}", MUTED)] + cells)
        loss_cells = []
        for _, t in columns:
            text = "–" if t.loss is None else f"{t.loss:.1f} %"
            tone = MUTED if t.loss is None else OK if t.lost == 0 else WARN if t.loss < 10 else BAD
            loss_cells.append((text.rjust(cw), tone))
        rows.append([(" loss    ", MUTED)] + loss_cells)
        rows.append([(" pings   ", MUTED)] + [(f"{t.n}".rjust(cw), TEXT) for _, t in columns]
                    + [(f"  over {span(wall - self.totals.since)}", MUTED)])
        out += [render(r, width) for r in rows]

        footer = render([(" r restart totals · q quit" if wide else " p period · r restart totals · q quit", MUTED)], width)
        chart_h = min(14, height - len(out) - (2 if compact else 4))  # the axis (title, time labels) and the footer
        chart_h -= chart_h % 2 if chart_h > 2 else 0  # even: the middle label is half the top
        if chart_h >= 2 and width >= 30:
            out += self.chart(width, chart_h, compact)
        if len(out) < height:
            out += [""] * (height - len(out) - 1) + [footer]
        return out[:height]

    def chart(self, width, height, compact=False):
        label_w = 9  # "  100 ms ┤"
        plot_w = max(8, width - label_w - 1)
        shown = list(self.probes)[-plot_w:]
        rtts = [p.rtt for p in shown if p.rtt is not None]
        top = nice_ceil(max(rtts, default=1.0))
        title = f" latency · last {len(shown)} pings "
        out = [] if compact else [render([(" ─" + title + "─" * max(0, width - len(title) - 3), MUTED)], width)]
        pad = plot_w - len(shown)
        for row in range(height):  # 0: the top
            edge = top * (height - row) / height
            label = axis_ms(edge) if row in (0, height // 2) else ""
            segments = [(f"{label:>7} {'┤' if label else '│'}", MUTED), (" " * pad, "")]
            for p in shown:
                if p.lost:
                    cell = ("×" if row == height - 1 else " ", BAD)
                elif p.rtt is None:
                    cell = (" ", "")
                else:
                    eighths = max(1, round(p.rtt / top * height * 8)) - (height - 1 - row) * 8
                    cell = (BARS[max(0, min(8, eighths))], self.tone(p.rtt))
                if segments[-1][1] == cell[1]:
                    segments[-1] = (segments[-1][0] + cell[0], cell[1])
                else:
                    segments.append(cell)
            out.append(render(segments, width))
        out.append(render([(f"{'0 ms':>7} └" + "─" * plot_w, MUTED)], width))
        oldest = f"-{span(time.time() - shown[0].sent)}" if shown else ""
        gap = max(1, plot_w - pad - len(oldest) - 3)
        if not compact:
            out.append(render([(" " * (label_w + pad), ""), (oldest, MUTED), (" " * gap, ""), ("now", MUTED)], width))
        return out

    def summary(self):
        t = self.totals
        if not t.n:
            return f"{self.name} ({self.pinger.addr}): no pings sent"
        loss = f"{t.loss:.1f} % lost"
        return (f"{self.name} ({self.pinger.addr}): {t.n} pings over {span(time.time() - t.since)}, {loss}, "
                f"min {ms(t.min)} · mean {ms(t.mean)} · max {ms(t.max)} · jitter {ms(t.jitter)}")


def terminal_size():
    try:
        size = os.get_terminal_size(sys.stdout.fileno())
        return size.columns, size.lines
    except OSError:
        return 100, 30


def run(args):
    try:
        dash = Dashboard(args)
    except OSError as e:
        sys.exit(f"net_dash.py: {args.host}: {e.strerror or e}")
    out = sys.stdout
    keys = sys.stdin.fileno() if sys.stdin.isatty() and termios else None
    saved = termios.tcgetattr(keys) if keys is not None else None
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    resized = [True]

    def on_resize(*_):
        resized[0] = True

    signal.set_wakeup_fd(wake_w)
    signal.signal(signal.SIGWINCH, on_resize)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: sys.exit(0))
    if keys is not None:
        tty.setcbreak(keys)
    try:
        next_send = time.monotonic()
        drawn = -math.inf
        while True:
            now = time.monotonic()
            dirty = False
            if now >= next_send:
                dash.send(now)
                next_send += args.interval
                if next_send <= now:  # fell behind (the laptop slept): go on from now
                    next_send = now + args.interval
            if dash.next_due() <= now:
                dash.expire(now)
                dirty = True
            if dirty or resized[0] or now - drawn >= 1.0:
                width, height = terminal_size()
                clear = "\x1b[2J" if resized[0] else ""
                resized[0] = False
                frame = "\x1b[K\r\n".join(dash.lines(width, height, now))
                out.write(f"\x1b[?25l{clear}\x1b[H{frame}\x1b[K\x1b[J")
                out.flush()
                drawn = now
            wait = max(0.0, min(next_send, dash.next_due(), drawn + 1.0) - time.monotonic())
            readers = [dash.pinger.sock, wake_r] + ([keys] if keys is not None else [])
            ready, _, _ = select.select(readers, [], [], wait)
            if dash.pinger.sock in ready:
                dash.receive(time.monotonic())
                drawn = -math.inf
            if wake_r in ready:
                try:
                    os.read(wake_r, 256)
                except BlockingIOError:
                    pass
            if keys is not None and keys in ready:
                for key in os.read(keys, 64).decode(errors="ignore").lower():
                    if key == "q":
                        return
                    if key == "r":
                        dash.totals = Totals()
                    if key == "p":
                        dash.period = PERIODS_S[(PERIODS_S.index(dash.period) + 1) % len(PERIODS_S)] \
                            if dash.period in PERIODS_S else PERIODS_S[0]
                    resized[0] = True
    except KeyboardInterrupt:
        pass
    finally:
        if saved is not None:
            termios.tcsetattr(keys, termios.TCSADRAIN, saved)
        try:
            out.write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H" + dash.summary() + "\n")
            out.flush()
        except OSError:
            pass  # the terminal is gone


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("host", help="the IP (or name) to ping")
    parser.add_argument("--name", help="what the dashboard calls it: R1 · 741, Router")
    parser.add_argument("--period", type=int, default=60, help="the current period, in s (default 60)")
    parser.add_argument("--interval", type=float, default=1.0, help="s between pings (default 1)")
    parser.add_argument("--timeout", type=float, default=2.0, help="s after which a ping is lost (default 2)")
    parser.add_argument("--good", type=float, default=30.0, help="green up to this many ms (default 30)")
    parser.add_argument("--bad", type=float, default=100.0, help="red above this many ms (default 100)")
    args = parser.parse_args()
    if args.interval < 0.2 or args.timeout <= 0 or args.period < 1:
        parser.error("--interval is at least 0.2 s, --timeout and --period more than 0")
    run(args)


if __name__ == "__main__":
    main()
