"""Edit a site file from the command line: places, lanes, routes.

Line-based, so the file's comments and layout survive: only the entries being changed
are rewritten. Every edit is checked by loading the result as a Site (and against the
missions) before anything is written; a failing edit leaves the file untouched.

    ed = SiteText(open(path).read())
    ed.set_place('scan_1', [1.0, 2.0, 0.0], comment='from 834')
    ed.add_lane(['scan_1', 'fwd_2'])
    new_text = ed.text()
"""

import difflib
import re

import yaml

from .sitefile import Site, SiteError


class EditError(ValueError):
    pass


def _fmt(v):
    return f'{round(float(v), 3):g}'


def pose_str(pose):
    return '[' + ', '.join(_fmt(v) for v in pose) + ']'


def _flow(value):
    """A YAML value on one line, as a person would write it."""
    return yaml.safe_dump(value, default_flow_style=True, width=10 ** 6, sort_keys=False).strip()


def _indent(line):
    return len(line) - len(line.lstrip(' '))


def _is_top(line):
    """A column-0 line (a key or a comment) ends the section above it."""
    return line.strip() != '' and not line.startswith((' ', '\t'))


class SiteText:
    def __init__(self, text):
        self.lines = text.splitlines(keepends=True)
        if self.lines and not self.lines[-1].endswith('\n'):
            self.lines[-1] += '\n'

    def text(self):
        return ''.join(self.lines)

    # ------------------------------------------------------------ sections
    def _section(self, key, create=True):
        """(first content line, end) of a top-level `key:` block; end is exclusive and
        excludes trailing blank lines."""
        head = re.compile(rf'^{re.escape(key)}:\s*(\{{\}}|\[\])?\s*(#.*)?$')
        for i, line in enumerate(self.lines):
            m = head.match(line.rstrip('\n'))
            if m:
                if m.group(1):                   # `places: {}` -> a block to add to
                    self.lines[i] = f'{key}:' + (f'  {m.group(2)}' if m.group(2) else '') + '\n'
                end = i + 1
                while end < len(self.lines) and not _is_top(self.lines[end]):
                    end += 1
                while end > i + 1 and self.lines[end - 1].strip() == '':
                    end -= 1
                return i + 1, end
        if not create:
            return None
        if self.lines and self.lines[-1].strip():
            self.lines.append('\n')
        self.lines.append(f'{key}:\n')
        n = len(self.lines)
        return n, n

    def _child_indent(self, start, end):
        for line in self.lines[start:end]:
            if line.strip() and not line.lstrip().startswith('#'):
                return ' ' * _indent(line)
        return '  '

    def _entries(self, key):
        """[(start, end, first line)] of the entries of a section (mapping keys or list
        items at the section's child indent)."""
        sec = self._section(key, create=False)
        if sec is None:
            return []
        start, end = sec
        ind = len(self._child_indent(start, end))
        out = []
        i = start
        while i < end:
            line = self.lines[i]
            if line.strip() and not line.lstrip().startswith('#') and _indent(line) == ind:
                j = i + 1
                while j < end and (self.lines[j].strip() == '' or _indent(self.lines[j]) > ind):
                    j += 1
                while j > i + 1 and self.lines[j - 1].strip() == '':
                    j -= 1
                out.append((i, j, line))
                i = j
            else:
                i += 1
        return out

    def _map_entry(self, key, name):
        pat = re.compile(rf'^\s*["\']?{re.escape(name)}["\']?\s*:')
        for s, e, line in self._entries(key):
            if pat.match(line):
                return s, e
        return None

    def _entry_value(self, s, e):
        """The parsed value of one mapping entry."""
        return next(iter((yaml.safe_load(''.join(self.lines[s:e]).replace('\t', ' ')
                                         .lstrip()) or {}).values()), None)

    def _put_map_entry(self, key, name, value_str, comment=''):
        tail = f'   # {comment}' if comment else ''
        found = self._map_entry(key, name)
        if found:
            s, e = found
            ind = ' ' * _indent(self.lines[s])
            self.lines[s:e] = [f'{ind}{name}: {value_str}{tail}\n']
        else:
            start, end = self._section(key)
            ind = self._child_indent(start, end)
            self.lines.insert(end, f'{ind}{name}: {value_str}{tail}\n')

    def _del_map_entry(self, key, name):
        found = self._map_entry(key, name)
        if not found:
            raise EditError(f'no {key[:-1]} named {name!r}')
        del self.lines[found[0]:found[1]]

    # --------------------------------------------------------------- places
    def set_place(self, name, pose, comment=''):
        found = self._map_entry('places', name)
        value = pose_str(pose)
        if found:
            old = self._entry_value(*found)
            if isinstance(old, dict):          # keep flags such as parking: true
                old = dict(old)
                old['pose'] = [round(float(v), 3) for v in pose]
                value = _flow(old)
        self._put_map_entry('places', name, value, comment)

    def remove_place(self, name):
        self._del_map_entry('places', name)
        # its lanes go with it
        for s, e, _ in reversed(self._entries('lanes')):
            path, extra = self._lane_value(s, e)
            if name not in path:
                continue
            pieces, cur = [], []
            for p in path:
                if p == name:
                    pieces.append(cur)
                    cur = []
                else:
                    cur.append(p)
            pieces.append(cur)
            self._replace_lane(s, e, [c for c in pieces if len(c) >= 2], extra)

    # ---------------------------------------------------------------- lanes
    def _lane_value(self, s, e):
        v = yaml.safe_load(''.join(self.lines[s:e]).strip()[1:].strip())  # drop '- '
        if isinstance(v, dict):
            return [str(p) for p in v.get('path', [])], {k: x for k, x in v.items() if k != 'path'}
        return [str(p) for p in v or []], {}

    def _replace_lane(self, s, e, paths, extra):
        ind = ' ' * _indent(self.lines[s])
        new = []
        for p in paths:
            value = _flow({'path': p, **extra}) if extra else _flow(p)
            new.append(f'{ind}- {value}\n')
        self.lines[s:e] = new

    def lane_exists(self, a, b):
        for s, e, _ in self._entries('lanes'):
            path, _extra = self._lane_value(s, e)
            if any({x, y} == {a, b} for x, y in zip(path, path[1:])):
                return True
        return False

    def add_lane(self, path):
        start, end = self._section('lanes')
        ind = self._child_indent(start, end)
        self.lines.insert(end, f'{ind}- {_flow([str(p) for p in path])}\n')

    def remove_lane(self, a, b):
        for s, e, _ in self._entries('lanes'):
            path, extra = self._lane_value(s, e)
            for i, (x, y) in enumerate(zip(path, path[1:])):
                if {x, y} == {a, b}:
                    pieces = [path[:i + 1], path[i + 1:]]
                    self._replace_lane(s, e, [c for c in pieces if len(c) >= 2], extra)
                    return
        raise EditError(f'no lane between {a} and {b}')

    # --------------------------------------------------------------- routes
    def set_route(self, name, places, comment=''):
        self._put_map_entry('routes', name, _flow([str(p) for p in places]), comment)

    def remove_route(self, name):
        self._del_map_entry('routes', name)


# ------------------------------------------------------------------- checks
def place_uses(site, name):
    """Where a place is referenced, other than lanes."""
    uses = []
    for k, r in site.routes.items():
        if name in r:
            uses.append(f'route {k}')
    for k, f in site.formations.items():
        if name in f['slots']:
            uses.append(f'formation {k}')
    for k, z in site.zones.items():
        if name in (z['entry'], z['exit']):
            uses.append(f'zone {k}')
    for k, t in site.targets.items():
        if t['approach'] == name:
            uses.append(f'target {k}')
    for k, r in site.robots.items():
        if r.get('home') == name:
            uses.append(f'robot {k} home')
    return uses


def neighbours(site, name):
    return sorted({b for a, b, _ in site.lanes if a == name} |
                  {a for a, b, _ in site.lanes if b == name})


def check_text(text, path, missions=(), old_site=None):
    """Load the edited text as a Site; return (site, missions the edit breaks), the
    latter as ['file: problem; ...'] for problems the old site did not have."""
    try:
        site = Site(yaml.safe_load(text) or {}, path)
    except SiteError as e:
        raise EditError(f'the site would be invalid: {e}') from None
    from .mission import check, load
    broken = []
    for f in missions:
        try:
            m = load(f)
            before = set(check(m, old_site)) if old_site else set()
            new = [p for p in check(m, site) if p not in before]
        except Exception:  # noqa: BLE001 - not a mission file
            continue
        if new:
            broken.append(f'{f}: {"; ".join(new)}')
    return site, broken


def diff(old, new, path):
    return ''.join(difflib.unified_diff(old.splitlines(keepends=True),
                                        new.splitlines(keepends=True), path, path + ' (new)'))
