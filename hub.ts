import { Channel, type Sender, ObjectMap } from 'channel/server'
import { LazyState } from 'channel/more'
import { Authorization } from './auth.ts'
import { ApiPermissions } from './permissions.ts'
const auth = new Authorization()
await auth.load()
const apiPermissions = new ApiPermissions()

const defaultHubPort = Number(Bun.env.HUBPORT ?? 1997)

interface State {
  key?: string
  services: string[]
  permissions: Set<string>
  requests: number
}

let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  constructor(port: number = defaultHubPort) {
    const statusState = new LazyState(() => ({
      requests,
      services: this.services.map(a => a.status),
    }))
    this.channel
      .post('hub/service/add', ({ body, state, sender }) => {
        if (!Array.isArray(body)) throw 'invalid command'
        for (const service of body) {
          if (service !== 'auth' && !service.startsWith?.('auth/')) continue
          if (!state.key) throw 'Service have to support authorization'
          const key = auth.verify(state.key)
          if (auth.auth === key) {
            auth.sender = sender
            this.reauthorizeServices()
            break
          } else if (!auth.auth) {
            auth.sender = sender
            auth.auth = key
            auth.save()
            this.reauthorizeServices()
            break
          } else {
            throw 'Hub is using a different authorization service'
          }
        }
        state.services = state.services.concat(body)
        this.addServices(sender, state, body)
        statusState.setNeedsUpdate()
      })
      .post('hub/permissions', ({ state }) => Array.from(state.permissions).toSorted())
      .post('hub/permissions/add', ({ body: { services, permission }, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        apiPermissions.addServices(services, permission)
        let changes = 0
        for (const service of services) {
          const s = this.services.get(service)
          if (s) changes += s.addPermission(permission)
        }
        if (changes) statusState.setNeedsUpdate()
      })
      .post('hub/permissions/remove', ({ body: { services, permission }, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        apiPermissions.removeServices(services, permission)
        let changes = 0
        for (const service of services) {
          const s = this.services.get(service)
          if (s) changes += s.removePermission(permission)
        }
        if (changes) statusState.setNeedsUpdate()
      })
      .post('hub/status', () => ({ requests, services: this.services.map(a => a.status) }))
      .stream('hub/status', () => statusState.makeIterator())
      .postOther(other, async ({ body }, path) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const sender = service.next()
        if (!sender) throw 'api not found'
        service.requests += 1
        requests += 1
        statusState.setNeedsUpdate()
        return await sender.send(path, body)
      })
      .streamOther(other, ({ body }, path) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const sender = service.next()
        if (!sender) throw 'api not found'
        service.requests += 1
        requests += 1
        statusState.setNeedsUpdate()
        return sender.values(path, body)
      })
      .onDisconnect((state, sender) => {
        if (auth.sender === sender) {
          delete auth.sender
        }
        state.services.forEach(s => this.services.get(s)?.remove(sender))
        statusState.setNeedsUpdate()
      })
      .listen(port, async headers => ({
        key: headers.get('auth') ?? undefined,
        permissions: await auth.permissions(headers.get('auth')),
        services: [],
        requests: 0,
      }))
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, state: State, services: string[]) {
    services.forEach(s => {
      if (this.checkAuthorization(sender, state, s)) return
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      this.addService(sender, state, service)
      console.log('Service', s, service.services.length)
    })
  }
  addService(sender: Sender, state: State, service: Services) {
    const enabled = apiPermissions.allowsService(service.name, state.permissions)
    service.add({ sender, state, enabled })
  }
  private checkAuthorization(sender: Sender, state: State, service: string) {
    if (service === 'owner' || service.startsWith?.('owner/')) throw 'invalid service'
    if (service !== 'auth' && !service.startsWith?.('auth/')) return false
    if (!state.key) throw 'Service have to support authorization'
    const key = auth.verify(state.key)
    if (auth.auth === key) {
      auth.sender = sender
      this.reauthorizeServices()
      return true
    } else if (!auth.auth) {
      auth.sender = sender
      auth.auth = key
      auth.save()
      this.reauthorizeServices()
      return true
    } else {
      throw 'Hub is using a different authorization service'
    }
  }
  async reauthorizeServices() {
    const unauthorizedSenders = new Set<Sender>()
    this.services.forEach(a => {
      a.services.forEach(sender => unauthorizedSenders.add(sender.sender))
      a.disabled.forEach(sender => unauthorizedSenders.add(sender.sender))
    })
    unauthorizedSenders.forEach(sender => {
      sender.stop()
    })
  }
}

function other(): boolean {
  return true
}

interface Service {
  state: State
  sender: Sender
  enabled: boolean
}

class Services {
  name: string
  requests = 0
  services: Service[] = []
  disabled: Service[] = []
  index = 0
  constructor(name: string) {
    this.name = name
  }
  add(service: Service) {
    if (service.enabled) {
      if (this.services.findIndex(a => a.sender === service.sender) === -1) {
        this.services.push(service)
      }
    } else {
      if (this.disabled.findIndex(a => a.sender === service.sender) === -1) {
        this.disabled.push(service)
      }
    }
  }
  addPermission(permission: string): number {
    let enabled = new Set<Service>()
    this.disabled.forEach(s => {
      if (s.state.permissions.has(permission)) {
        enabled.add(s)
        s.enabled = true
      }
    })
    if (!enabled.size) return 0
    this.disabled = this.disabled.filter(a => enabled.has(a))
    return enabled.size
  }
  removePermission(permission: string): number {
    let disabled = new Set<Service>()
    this.services.forEach(s => {
      if (s.state.permissions.has(permission)) {
        disabled.add(s)
        s.enabled = false
      }
    })
    if (!disabled.size) return 0
    this.services = this.services.filter(a => disabled.has(a))
    return disabled.size
  }
  remove(sender: Sender) {
    let index = this.services.findIndex(a => a.sender === sender)
    if (index >= 0) this.services.splice(index, 1)
    index = this.disabled.findIndex(a => a.sender === sender)
    if (index >= 0) this.disabled.splice(index, 1)
  }
  next() {
    if (!this.services.length) return
    const id = this.index++ % this.services.length
    return this.services.at(id)?.sender
  }
  get status() {
    return { name: this.name, services: this.services.length, requests: this.requests }
  }
}
