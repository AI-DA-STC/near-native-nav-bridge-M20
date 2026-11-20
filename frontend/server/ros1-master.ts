import { request } from 'node:http'

/* The ALOHA's ROS 1 master (roscore, port 11311), asked from this workstation over its XML-RPC API: which topics have
 * publishers and subscribers, by node. It is what `rostopic list -v` asks, without sourcing ROS Noetic or the master
 * calling this workstation back. */

export type XmlRpcValue = string | number | boolean | XmlRpcValue[]

/** Topic → the nodes that publish it, and the nodes that subscribe to it */
export interface SystemState {
  publishers: Map<string, string[]>
  subscribers: Map<string, string[]>
}

const TOKEN = /<(\/?)(methodResponse|params|param|value|array|data|string|int|i4|boolean|double|fault|struct|member|name)\s*>|<(\w+)\s*\/>|([^<]+)/g

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" }

function unescapeXml(text: string): string {
  return text.replace(/&(?:lt|gt|amp|quot|apos);/g, (e) => ENTITIES[e])
}

interface Token {
  close: boolean
  tag: string | null
  text: string | null
}

/** The value of an XML-RPC method response: strings, numbers, booleans and arrays (what the ROS master answers) */
export function parseXmlRpcResponse(xml: string): XmlRpcValue {
  if (/<fault>/.test(xml)) throw new Error('The ROS master answered with a fault')
  const tokens: Token[] = []
  for (const m of xml.matchAll(TOKEN)) {
    if (m[2]) tokens.push({ close: m[1] === '/', tag: m[2], text: null })
    else if (m[3]) {
      // <string/> and the like: an empty element
      tokens.push({ close: false, tag: m[3], text: null }, { close: true, tag: m[3], text: null })
    } else if (m[4] !== undefined) tokens.push({ close: false, tag: null, text: m[4] })
  }
  let i = tokens.findIndex((t) => t.tag === 'value' && !t.close)
  if (i === -1) throw new Error('No value in the ROS master’s answer')

  const isOpen = (tag: string) => tokens[i]?.tag === tag && !tokens[i].close
  const isClose = (tag: string) => tokens[i]?.tag === tag && tokens[i].close
  const skipSpace = () => {
    while (tokens[i] && tokens[i].tag === null && !tokens[i].text?.trim()) i++
  }
  const expectClose = (tag: string) => {
    skipSpace()
    if (!isClose(tag)) throw new Error(`Expected </${tag}> in the ROS master’s answer`)
    i++
  }
  const textUntil = (tag: string): string => {
    let text = ''
    while (tokens[i] && !isClose(tag)) text += tokens[i++].text ?? ''
    expectClose(tag)
    return unescapeXml(text)
  }

  function value(): XmlRpcValue {
    skipSpace()
    if (!isOpen('value')) throw new Error('Expected <value> in the ROS master’s answer')
    i++
    // <value>text</value> is a string without its type
    if (tokens[i]?.tag === null && tokens[i + 1] && isCloseAt(i + 1, 'value')) {
      const text = unescapeXml(tokens[i].text ?? '')
      i += 2
      return text
    }
    if (isClose('value')) {
      i++
      return ''
    }
    skipSpace()
    let result: XmlRpcValue
    if (isOpen('array')) {
      i++
      skipSpace()
      const items: XmlRpcValue[] = []
      if (isOpen('data')) {
        i++
        skipSpace()
        while (isOpen('value')) {
          items.push(value())
          skipSpace()
        }
        expectClose('data')
      }
      expectClose('array')
      result = items
    } else if (isOpen('string')) {
      i++
      result = textUntil('string')
    } else if (isOpen('int') || isOpen('i4') || isOpen('double')) {
      const tag = tokens[i].tag!
      i++
      result = Number(textUntil(tag))
    } else if (isOpen('boolean')) {
      i++
      result = textUntil('boolean').trim() === '1'
    } else throw new Error(`Unexpected <${tokens[i]?.tag ?? 'text'}> in the ROS master’s answer`)
    expectClose('value')
    return result
  }

  function isCloseAt(at: number, tag: string): boolean {
    return tokens[at]?.tag === tag && tokens[at].close
  }

  return value()
}

/** getSystemState's answer: [code, message, [publishers, subscribers, services]] */
export function systemStateOf(value: XmlRpcValue): SystemState {
  if (!Array.isArray(value) || value[0] !== 1 || !Array.isArray(value[2])) throw new Error(`The ROS master refused: ${Array.isArray(value) ? String(value[1]) : 'no answer'}`)
  const [pubs, subs] = value[2] as XmlRpcValue[][]
  const table = (rows: XmlRpcValue[] | undefined) =>
    new Map((rows ?? []).filter(Array.isArray).map((row) => [String(row[0]), Array.isArray(row[1]) ? row[1].map(String) : []] as [string, string[]]))
  return { publishers: table(pubs), subscribers: table(subs) }
}

/** Asks the master at http://<ip>:11311 for its system state; rejects when it does not answer */
export function masterSystemState(ip: string, timeoutMs = 3000): Promise<SystemState> {
  const body =
    '<?xml version="1.0"?><methodCall><methodName>getSystemState</methodName>' +
    '<params><param><value><string>/command_center_setup</string></value></param></params></methodCall>'
  return new Promise((resolve, reject) => {
    const req = request(
      { host: ip, port: 11311, path: '/', method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        let xml = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (xml += chunk))
        res.on('end', () => {
          try {
            resolve(systemStateOf(parseXmlRpcResponse(xml)))
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`No answer from the ROS master at ${ip}:11311`)))
    req.on('error', reject)
    req.end(body)
  })
}
