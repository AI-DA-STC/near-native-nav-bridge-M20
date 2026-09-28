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
