"""Load m20_stack.yaml (repo root): laptop-side settings shared by launch files and CLI.

Search order: $M20_STACK, then m20_stack.yaml in /repo (Jazzy devcontainer mount) or
/root/ros2_ws/src/nav_cmd_bridge (Foxy devcontainer mount), then the current directory
and its parents. Relative paths inside the file are resolved against the file.
"""

import os

import yaml

CANDIDATES = ('/repo/m20_stack.yaml', '/root/ros2_ws/src/nav_cmd_bridge/m20_stack.yaml')


def find(path=None):
    if path:
        return path
    if os.environ.get('M20_STACK'):
        return os.environ['M20_STACK']
    for c in CANDIDATES:
        if os.path.exists(c):
            return c
    d = os.getcwd()
    while True:
        c = os.path.join(d, 'm20_stack.yaml')
        if os.path.exists(c):
            return c
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def path(p):
    """A file path given to any m20 tool. Relative paths mean what they mean in
    m20_stack.yaml, relative to that file (the repo root), wherever the shell is: the
    devcontainer terminals start in /, where `rmf/m20_rmf/sites/x.yaml` would otherwise
    land outside the repo. A relative path that exists from the current directory is
    taken as it is. Returns an absolute path (or p unchanged if empty)."""
    if not p:
        return p
    if os.path.isabs(p) or os.path.exists(p):
        return os.path.abspath(p)
    cfg = find()
    if cfg:
        return os.path.join(os.path.dirname(os.path.abspath(cfg)), p)
    return os.path.abspath(p)


def root():
    """The repo root (where m20_stack.yaml is), or None."""
    cfg = find()
    return os.path.dirname(os.path.abspath(cfg)) if cfg else None


def own(new_file):
    """Give a file the tools just created to the owner of its folder: the devcontainers
    run as root, and a root-owned file in the repo cannot be edited on the host."""
    try:
        st = os.stat(os.path.dirname(os.path.abspath(new_file)))
        os.chown(new_file, st.st_uid, st.st_gid)
    except OSError:
        pass


def robots_for(site_path, cfg=None):
    """Stack robots, but only when site_path is the stack's own site; another site
    (e.g. the mock sim_lab.yaml) gets None = all robots of that site."""
    cfg = load() if cfg is None else cfg
    if site_path and cfg.get('site') and \
            os.path.realpath(site_path) == os.path.realpath(cfg['site']):
        return cfg.get('robots') or None
    return None


def load(path=None):
    """Return the stack settings (empty dict if no file), with absolute paths."""
    path = find(path)
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    base = os.path.dirname(os.path.abspath(path))
    for key in ('site', 'laptop_profile'):
        if cfg.get(key) and not os.path.isabs(cfg[key]):
            cfg[key] = os.path.join(base, cfg[key])
    cfg['robots'] = [str(r) for r in cfg.get('robots') or []]
    cfg['_path'] = path
    return cfg
