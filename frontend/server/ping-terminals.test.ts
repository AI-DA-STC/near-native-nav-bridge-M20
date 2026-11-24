import { describe, expect, it } from 'vitest'
import { defaultGateway, pingCommand, pingTargets } from './ping-terminals.ts'

// This laptop's /proc/net/route on 2026-11-24: the Wi-Fi to the robots' router, docker0
const TABLE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
wlp128s20f3	00000000	017BA8C0	0003	0	0	600	00000000	0	0	0
wlp128s20f3	0000FEA9	00000000	0001	0	0	1000	0000FFFF	0	0	0
docker0	000011AC	00000000	0001	0	0	0	0000FFFF	0	0	0
wlp128s20f3	007BA8C0	00000000	0001	0	0	600	00FFFFFF	0	0	0
`

describe('the router: this workstation’s default gateway', () => {
  it('reads it from the route table', () => {
    expect(defaultGateway(TABLE)).toBe('192.168.123.1')
  })
  it('takes the lowest metric’s when there are two', () => {
    expect(defaultGateway(`${TABLE}eth0	00000000	0100000A	0003	0	0	100	00000000	0	0	0\n`)).toBe('10.0.0.1')
  })
  it('has none without a default route', () => {
    expect(defaultGateway(TABLE.split('\n').filter((l) => !l.includes('017BA8C0')).join('\n'))).toBeNull()
  })
})

describe('the ping terminals', () => {
  const robots = [
    { id: '665', kind: 'm20' as const, ip: '192.168.123.101' },
    { id: '741', kind: 'm20' as const, ip: '192.168.123.100' },
    { id: '999', kind: 'm20' as const, ip: '192.168.123.109' },
    { id: 'aloha', kind: 'aloha' as const, ip: '192.168.123.200' },
  ]
  it('one per robot added, named by mission role, then the router', () => {
    expect(pingTargets(robots, '192.168.123.1')).toEqual([
      { key: '665', name: 'R2 · 665', ip: '192.168.123.101' },
      { key: '741', name: 'R1 · 741', ip: '192.168.123.100' },
      // a dog the fleet does not know takes the role left
      { key: '999', name: 'R3 · 999', ip: '192.168.123.109' },
      { key: 'aloha', name: 'ALOHA', ip: '192.168.123.200' },
      { key: 'router', name: 'Router', ip: '192.168.123.1' },
    ])
  })
  it('no router without a gateway', () => {
    expect(pingTargets(robots, null).map((t) => t.key)).toEqual(['665', '741', '999', 'aloha'])
  })
  it('types net_dash.py with the name quoted for bash', () => {
    expect(pingCommand({ key: '741', name: 'R1 · 741', ip: '192.168.123.100' })).toBe("python3 frontend/server/net_dash.py --name 'R1 · 741' 192.168.123.100")
    expect(pingCommand({ key: 'x', name: "it's", ip: '10.0.0.1' })).toBe("python3 frontend/server/net_dash.py --name 'it'\\''s' 10.0.0.1")
  })
})
