import type { ServerWebSocket, Server as BunServer } from 'bun'
import { Server, type Request, type Response, json } from './server'
import { Authorization } from './auth.ts'
const auth = new Authorization()

const defaultHubPort = Number(Bun.env.HUBPORT ?? 1997)
type Socket = ServerWebSocket<Connection>

let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  server: BunServer
  id = 0
  pending = new ObjectMap<number, string>()
  constructor(port: number = defaultHubPort) {
    this.server = new Server<Connection>(port, async req => {
      return {
        key: req.headers.get('auth') ?? undefined,
        services: [],
        requests: 0,
      }
    })
      .connected(ws => this.connected(ws))
      .disconnected(ws => this.disconnected(ws))
      .request((ws, body) => this.request(ws, body))
      .response((ws, body) => this.response(body))
      .start()
  }
  connected(ws: Socket) { }
  disconnected(ws: Socket) {
    ws.data.services.forEach(s => this.services.get(s)?.remove(ws))
  }
  request(ws: Socket, request: Request) {
    requests += 1
    const { path, body } = request
    switch (path) {
      case 'hub/service/add':
        // Checking if service has authorization management
        try {
          if (!Array.isArray(body)) throw 'invalid command'
          for (const service of body) {
            if (service !== 'auth' && !service.startsWith?.('auth/')) continue
            if (!ws.data.key) throw 'Service have to support authorization'
            const key = ws.data.key.split('.').slice(0, 2).join('.')
            if (auth.auth === key) {
              break
            } else if (!auth.auth) {
              auth.auth = key
              break
            } else {
              throw 'Hub is using a different authorization service'
            }
          }
          ws.data.services = ws.data.services.concat(body)
          this.addServices(ws, body)
          ws.send(json({ id: request.id }))
        } catch (error) {
          ws.send(json({ id: request.id, error }))
        }
        break
      case 'hub/status':
        ws.send(
          json({
            id: request.id,
            body: { requests, services: this.services.map(a => a.status) },
          }),
        )
        break
      default:
        const serviceId = path.split('/')[0]
        const service = this.services.get(serviceId)
        if (!service) throw 'api not found'
        const id = this.id++
        this.pending.set(id, serviceId)
        service.send(id, request, ws)
    }
  }
  stats() {
    this.services.map(a => a)
  }
  response(response: Response) {
    const serviceId = this.pending.get(response.id)
    if (!serviceId) return
    this.pending.delete(response.id)
    this.services.get(serviceId)?.received(response)
  }
  addServices(ws: Socket, services: string[]) {
    services.forEach(s => {
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      service.add(ws)
      console.log('Service', s, service.services.length)
    })
  }
}
class Services {
  name: string
  requests = 0
  services: Socket[] = []
  index = 0
  pending = new ObjectMap<number, PendingSocketRequest>()
  constructor(name: string) {
    this.name = name
  }
  add(ws: Socket) {
    this.services.push(ws)
  }
  remove(ws: Socket) {
    const index = this.services.findIndex(a => a === ws)
    if (index >= 0) this.services.splice(index, 1)
  }
  next() {
    if (!this.services.length) return
    const id = this.index++ % this.services.length
    return this.services.at(id)
  }
  send(id: number, request: Request, socket: Socket) {
    const ws = this.next()
    this.pending.set(id, { socket, request })
    if (ws) {
      ws.send(json({ id, path: request.path, body: request.body }))
    }
  }
  received(response: Response) {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    this.requests += 1
    pending.socket.data.requests += 1
    pending.socket.send(json({ id: pending.request.id, body: response.body, error: response.error }))
  }
  get status() {
    return { name: this.name, services: this.services.length, requests: this.requests }
  }
}

interface Connection {
  key?: string
  services: string[]
  requests: number
}

interface PendingSocketRequest {
  socket: Socket
  request: Request
}
class ObjectMap<Key, Value> {
  storage: any = {}
  get(id: Key): Value | undefined {
    return this.storage[id]
  }
  set(id: Key, value: Value) {
    this.storage[id] = value
  }
  delete(id: Key) {
    delete this.storage[id]
  }
  get size(): number {
    return Object.values(this.storage).length
  }
  map<O>(transform: (value: Value) => O): O[] {
    let array: O[] = []
    for (let a of Object.values(this.storage)) {
      array.push(transform(a as Value))
    }
    return array
  }
}
