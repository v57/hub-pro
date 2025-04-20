import { Channel, type Sender, ObjectMap } from 'channel/server'
import { Authorization } from './auth.ts'
const auth = new Authorization()
await auth.load()
const defaultHubPort = Number(Bun.env.HUBPORT ?? 1997)

interface State {
  key?: string
  services: string[]
  requests: number
}

let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  constructor(port: number = defaultHubPort) {
    this.channel
      .post('hub/service/add', ({ body, state, sender }) => {
        if (!Array.isArray(body)) throw 'invalid command'
        for (const service of body) {
          if (service !== 'auth' && !service.startsWith?.('auth/')) continue
          if (!state.key) throw 'Service have to support authorization'
          const key = auth.verify(state.key)
          if (auth.auth === key) {
            break
          } else if (!auth.auth) {
            auth.auth = key
            auth.save()
            break
          } else {
            throw 'Hub is using a different authorization service'
          }
        }
        state.services = state.services.concat(body)
        this.addServices(sender, body)
      })
      .post('hub/status', () => ({ requests, services: this.services.map(a => a.status) }))
      .postOther(other, async ({ body }, path) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const sender = service.next()
        if (!sender) throw 'api not found'
        service.requests += 1
        return await sender.send(path, body)
      })
      .onDisconnect((state, sender) => {
        state.services.forEach(s => this.services.get(s)?.remove(sender))
      })
      .listen(port, headers => ({
        key: headers.get('auth') ?? undefined,
        services: [],
        requests: 0,
      }))
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, services: string[]) {
    services.forEach(s => {
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      service.add(sender)
      console.log('Service', s, service.services.length)
    })
  }
}

function other(): boolean {
  return true
}

class Services {
  name: string
  requests = 0
  services: Sender[] = []
  index = 0
  constructor(name: string) {
    this.name = name
  }
  add(sender: Sender) {
    this.services.push(sender)
  }
  remove(sender: Sender) {
    const index = this.services.findIndex(a => a === sender)
    if (index >= 0) this.services.splice(index, 1)
  }
  next() {
    if (!this.services.length) return
    const id = this.index++ % this.services.length
    return this.services.at(id)
  }
  get status() {
    return { name: this.name, services: this.services.length, requests: this.requests }
  }
}
