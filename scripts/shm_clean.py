#!/usr/bin/env python3
"""Remove stale Fast DDS shared-memory files from /dev/shm.

A Fast DDS process that dies without a clean shutdown (kill, crash, closed terminal)
leaves its shared-memory segments, port rings and semaphores in /dev/shm. Docker gives
each container only 64 MB there, so leftovers pile up until new participants fail with
"Failed to create segment ... SHM Transport is not supported" (2026-09-28: 888 files,
100% full in the Foxy devcontainer).

A file is removed only if no running process has it mapped or open (/proc/*/maps and
/proc/*/fd), so live nodes are never affected. Run it where every process sharing this
/dev/shm is visible: inside a container with its own /dev/shm (the Foxy devcontainer;
the laptop bridge launch runs it automatically), or on the host with sudo. It refuses
to run in a container that shares the host's /dev/shm (--ipc=host), where host
processes are invisible.

    python3 scripts/shm_clean.py [--dry-run]
"""

import argparse
import os
import re
import sys

SHM = '/dev/shm'
FASTDDS = re.compile(r'^(sem\.)?fastrtps_')


def in_use():
    """Paths under /dev/shm that some process maps or holds open, plus unreadable pids."""
    used, blind = set(), []
    for pid in filter(str.isdigit, os.listdir('/proc')):
        try:
            with open(f'/proc/{pid}/maps') as f:
                for line in f:
                    i = line.find(SHM + '/')
                    if i >= 0:
                        used.add(line[i:].split(' (deleted)')[0].strip())
            for fd in os.listdir(f'/proc/{pid}/fd'):
                try:
                    target = os.readlink(f'/proc/{pid}/fd/{fd}')
                except OSError:
                    continue
                if target.startswith(SHM + '/'):
                    used.add(target)
        except FileNotFoundError:
            continue            # process exited meanwhile
        except PermissionError:
            blind.append(pid)
    return used, blind


def shares_host_shm():
    """True inside a container whose /dev/shm is the host's (docker --ipc=host)."""
    in_container = os.path.exists('/.dockerenv')
    st = os.statvfs(SHM)
    return in_container and st.f_blocks * st.f_frsize > 1 << 30   # container default: 64 MB


def clean(dry_run=False, quiet=False):
    """Remove stale Fast DDS files; returns the number removed (or that would be)."""
    if shares_host_shm():
        if not quiet:
            print('shm_clean: this container shares the host /dev/shm; run it on the host')
        return 0
    used, blind = in_use()
    # If some processes are unreadable (not root), only touch files we own: our own
    # processes are always readable, so those files are judged correctly.
    removed = 0
    me = os.geteuid()
    for name in sorted(os.listdir(SHM)):
        if not FASTDDS.match(name):
            continue
        path = os.path.join(SHM, name)
        if path in used:
            continue
        try:
            if blind and os.stat(path).st_uid != me:
                continue
            if not dry_run:
                os.remove(path)
            removed += 1
        except OSError:
            continue
    if not quiet:
        verb = 'would remove' if dry_run else 'removed'
        st = os.statvfs(SHM)
        free = st.f_bavail * st.f_frsize >> 20
        total = st.f_blocks * st.f_frsize >> 20
        print(f'shm_clean: {verb} {removed} stale Fast DDS file(s); '
              f'{len(used)} in use; /dev/shm {free} of {total} MB free')
    return removed


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dry-run', action='store_true', help='only report what would go')
    a = ap.parse_args()
    clean(a.dry_run)
    return 0


if __name__ == '__main__':
    sys.exit(main())
