import { Channel, type Sender, type BodyContext, ObjectMap } from 'channel/server'
import { LazyState } from 'channel/more'
import { Authorization } from './auth.ts'
import { ApiPermissions } from './permissions.ts'
const auth = new Authorization()
await auth.load()
const apiPermissions = await new ApiPermissions().load()

const defaultHubPort = Number(Bun.env.HUBPORT ?? 1997)

interface State {
  key?: string
  id?: string
  services: string[]
  permissions: Set<string>
  requests: number
}

interface PendingAuthorization {
  id: string
  pending: string[]
}

let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  connections = new Set<BodyContext<State>>()
  constructor(port: number = defaultHubPort) {
    const statusState = new LazyState<StatusState>(() => ({
      requests,
      services: this.services.map(a => a.status),
      pro: true,
    }))
    const statusBadges = new LazyState<StatusBadges>(() => this.statusBadges)
    const pendingAuthorizations = new LazyState<PendingAuthorization[]>(() => {
      let result: { [key: string]: string[] | undefined } = {}
      this.services.forEach(s =>
        s.disabled.forEach(c => {
          if (c.state.id) {
            let services = result[c.state.id]
            if (services) {
              services.push(s.name)
            } else {
              result[c.state.id] = [s.name]
            }
          }
        }),
      )
      return Object.entries(result).map(([id, pending]) => ({ id, pending }) as PendingAuthorization)
    })
    this.channel
      .post('hub/service/add', ({ body, state, sender }) => {
        if (!Array.isArray(body)) throw 'invalid command'
        state.services = state.services.concat(body)
        this.addServices(sender, state, body)
        statusState.setNeedsUpdate()
        pendingAuthorizations.setNeedsUpdate()
        statusBadges.setNeedsUpdate()
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
        if (changes) {
          statusState.setNeedsUpdate()
          pendingAuthorizations.setNeedsUpdate()
          statusBadges.setNeedsUpdate()
        }
      })
      .post('hub/permissions/remove', ({ body: { services, permission }, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        apiPermissions.removeServices(services, permission)
        let changes = 0
        for (const service of services) {
          const s = this.services.get(service)
          if (s) changes += s.removePermission(permission)
        }
        if (changes) {
          statusState.setNeedsUpdate()
          pendingAuthorizations.setNeedsUpdate()
          statusBadges.setNeedsUpdate()
        }
      })
      .stream('hub/permissions/pending', () => pendingAuthorizations.makeIterator())
      .stream('hub/status', () => statusState.makeIterator())
      .stream('hub/status/badges', () => statusBadges.makeIterator())
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
        if (sender === auth.sender) {
          delete auth.sender
        }
      })
      .listen(port, {
        async state(headers: Headers): Promise<State> {
          const { id, permissions } = await auth.permissions(headers.get('auth'))
          return {
            key: headers.get('auth') ?? undefined,
            id,
            permissions,
            services: [],
            requests: 0,
          }
        },
        onConnect: (connection: BodyContext<State>) => {
          this.connections.add(connection)
        },
        onDisconnect: (connection: BodyContext<State>) => {
          this.connections.delete(connection)
        },
      })
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, state: State, services: string[]) {
    services.forEach(s => {
      const isAuth = this.checkAuthorization(sender, state, s)
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      const enabled = isAuth || apiPermissions.allowsService(service.name, state.permissions)
      service.add({ sender, state, enabled })
      console.log('Service', s, service.services.length)
    })
    console.log('Added', services.length, 'services')
    if (state.permissions.has('auth')) this.reauthorizeServices()
  }
  private checkAuthorization(sender: Sender, state: State, service: string) {
    if (service === 'owner' || service.startsWith?.('owner/')) throw 'invalid service'
    if (service !== 'auth' && !service.startsWith?.('auth/')) return false
    if (!state.key) throw 'Service have to support authorization'
    if (state.permissions.has('auth')) return true
    const key = auth.verify(state.key)
    if (auth.auth === key) {
      auth.sender = sender
    } else if (!auth.auth) {
      auth.sender = sender
      auth.auth = key
      auth.save()
    } else {
      throw 'Hub is using a different authorization service'
    }
    state.permissions.add('auth')
    return true
  }
  async reauthorizeServices() {
    this.connections.forEach(a => {
      if (a.state.permissions.has('auth')) return
      a.sender.stop()
    })
  }
  get statusBadges(): StatusBadges {
    let unauthorized = new Set<Sender>()
    this.services.forEach(s => s.disabled.forEach(a => unauthorized.add(a.sender)))
    return {
      services: this.services.size,
      security: unauthorized.size,
    }
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
        this.services.push(s)
      }
    })
    if (!enabled.size) return 0
    this.disabled = this.disabled.filter(a => !enabled.has(a))
    return enabled.size
  }
  removePermission(permission: string): number {
    let disabled = new Set<Service>()
    this.services.forEach(s => {
      if (s.state.permissions.has(permission)) {
        disabled.add(s)
        s.enabled = false
        this.disabled.push(s)
      }
    })
    if (!disabled.size) return 0
    this.services = this.services.filter(a => !disabled.has(a))
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
  get status(): ServicesStatus {
    return { name: this.name, services: this.services.length, disabled: this.disabled.length, requests: this.requests }
  }
}

interface StatusState {
  requests: number
  services: ServicesStatus[]
  pro?: boolean
}
interface ServicesStatus {
  name: string
  requests: number
  services: number
  disabled: number
}
interface StatusBadges {
  services: number
  security: number
}
