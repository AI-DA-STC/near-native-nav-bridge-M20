import { describe, expect, it } from 'vitest'
import { parseXmlRpcResponse, systemStateOf } from './ros1-master.ts'

/* The ROS master's getSystemState answer, as roscore sends it */

const ANSWER = `<?xml version='1.0'?>
<methodResponse>
<params>
<param>
<value><array><data>
<value><i4>1</i4></value>
<value>current system state</value>
<value><array><data>
<value><array><data>
<value><array><data>
<value>/scan</value>
<value><array><data>
<value>/lslidar_driver_node</value>
</data></array></value>
</data></array></value>
<value><array><data>
<value><string>/rosout_agg</string></value>
<value><array><data>
<value>/rosout</value>
</data></array></value>
</data></array></value>
</data></array></value>
<value><array><data>
<value><array><data>
<value>/aloha/dock/goal</value>
<value><array><data>
<value>/aloha_dock</value>
</data></array></value>
</data></array></value>
</data></array></value>
<value><array><data>
</data></array></value>
</data></array></value>
</data></array></value>
</param>
</params>
</methodResponse>
`

describe('the ROS master’s system state', () => {
  it('parses XML-RPC values: typed and untyped strings, numbers, arrays', () => {
    expect(parseXmlRpcResponse('<methodResponse><params><param><value><array><data><value><int>1</int></value><value>a &amp; b</value><value><string/></value><value><boolean>1</boolean></value></data></array></value></param></params></methodResponse>')).toEqual([1, 'a & b', '', true])
  })

  it('lists who publishes and who subscribes to each topic', () => {
    const state = systemStateOf(parseXmlRpcResponse(ANSWER))
    expect(state.publishers.get('/scan')).toEqual(['/lslidar_driver_node'])
    expect(state.publishers.get('/rosout_agg')).toEqual(['/rosout'])
    expect(state.subscribers.get('/aloha/dock/goal')).toEqual(['/aloha_dock'])
  })

  it('refuses a fault or a failed call', () => {
    expect(() => parseXmlRpcResponse('<methodResponse><fault><value><struct></struct></value></fault></methodResponse>')).toThrow(/fault/)
    expect(() => systemStateOf([-1, 'no', []])).toThrow(/refused: no/)
  })
})
