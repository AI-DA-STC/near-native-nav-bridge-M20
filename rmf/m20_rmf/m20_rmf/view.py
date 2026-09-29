"""The one place that decides what each robot is "doing", for the GUI and RViz.

Pure functions, no ROS: fed the adapter's robot status, RMF task states and mission
state, it returns a compact fleet view. The status hub publishes it on
/m20/fleet_view; the web GUI and the RViz markers only render it, so the two can never
disagree.

Modes come from the label of the robot's running RMF task (set by primitives.py):
    patrol:<route>     PATROL        explore:<zone>   EXPLORE
    form_up:<name>     REGROUP       inspect:<target> INVESTIGATE
    return_home        RETURN        go_to:, go_to_pose, action:waypoints  MOVE
    action:dwell / action:turn_to / action:wait_for_event                   HOLD
and from the robot itself: OFFLINE (no data), SITTING (not standing, nothing to do),
STOPPED (operator stop, until its next task), IDLE.
"""

import time

# Colour per mode, shared by the GUI and the RViz markers (hex, CSS-friendly).
MODES = {
    'PATROL': '#3b82f6',
    'REGROUP': '#a855f7',
    'EXPLORE': '#14b8a6',
    'INVESTIGATE': '#f97316',
    'RETURN': '#64748b',
    'MOVE': '#0ea5e9',
    'HOLD': '#94a3b8',
    'IDLE': '#cbd5e1',
    'SITTING': '#78716c',
    'STOPPED': '#dc2626',
    'OFFLINE': '#374151',
}

TERMINAL = {'completed', 'failed', 'canceled', 'killed', 'skipped'}
ACTIVE = {'underway', 'standby', 'blocked', 'delayed'}
SITTING_HEIGHT = 0.3        # m; body height below this = sitting / lying
STALE_POSE = 5.0            # s without a pose = offline


def mode_from_label(label):
    """(mode, detail) for an RMF task label written by primitives.py."""
    if not label:
        return 'MOVE', ''
    kind, _, detail = label.partition(':')
    table = {
        'patrol': 'PATROL', 'form_up': 'REGROUP', 'explore': 'EXPLORE',
        'inspect': 'INVESTIGATE', 'return_home': 'RETURN', 'go_to': 'MOVE',
        'go_to_pose': 'MOVE',
    }
    if kind == 'action':
        if detail in ('dwell', 'turn_to', 'wait_for_event'):
            return 'HOLD', ''
        return 'MOVE', detail if detail != 'waypoints' else 'path'
    return table.get(kind, 'MOVE'), detail


def running_tasks(task_states):
    """{robot: (label, task_id)} for each robot's active RMF task."""
    out = {}
    for tid, st in task_states.items():
        if st.get('status') not in ACTIVE:
            continue
        who = (st.get('assigned_to') or {}).get('name')
        if not who:
            continue
        labels = (st.get('booking') or {}).get('labels') or []
        label = labels[0] if labels else ''
        # Prefer 'underway' over queued/standby tasks of the same robot.
        if who not in out or st.get('status') == 'underway':
            out[who] = (label, tid)
    return out


def robot_view(status, task, stopped=False, now=None):
    """One robot's view from its adapter status dict and (label, task_id) or None."""
    now = time.time() if now is None else now
    rid = status['robot']
    pose = status.get('pose')
    height = status.get('height')
    standing = None if height is None else height >= SITTING_HEIGHT
    if status.get('asleep'):
        standing = False
    age = status.get('pose_age')
    online = pose is not None and (age is None or age < STALE_POSE) and \
        status.get('udp_link', True)

    detail = ''
    if not online:
        mode = 'OFFLINE'
    elif task is not None:
        mode, detail = mode_from_label(task[0])
    elif stopped:
        mode = 'STOPPED'
    elif standing is False:
        mode = 'SITTING'
    else:
        mode = 'IDLE'

    action = status.get('action') or {}
    if mode == 'INVESTIGATE' and action.get('awaiting_verdict'):
        detail = f'{detail} · awaiting verdict' if detail else 'awaiting verdict'
    view = {
        'id': rid,
        'mode': mode,
        'color': MODES[mode],
        'detail': detail,
        'pose': pose,
        'goal': status.get('goal'),
        'path': action.get('path') or [],
        'battery': status.get('battery'),
        'standing': standing,
        'task': task[1] if task else None,
    }
    # A task running while the robot is down is worth one warning, nothing more.
    if mode not in ('OFFLINE', 'SITTING', 'IDLE', 'STOPPED') and standing is False:
        view['warning'] = 'sitting'
    return view


def fleet_view(statuses, task_states, mission, stopped, timeline, inspections, now=None):
    tasks = running_tasks(task_states)
    robots = [robot_view(s, tasks.get(s['robot']), s['robot'] in stopped, now)
              for s in statuses]
    return {
        't': time.time() if now is None else now,
        'mission': mission or {},
        'robots': sorted(robots, key=lambda r: r['id']),
        'inspections': inspections,
        'timeline': timeline[-30:],
        'modes': MODES,
    }
