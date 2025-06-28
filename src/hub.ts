import { Channel, type Sender, type BodyContext, ObjectMap } from 'channel/server'
import 'channel/client'
import { LazyState } from 'channel/more'
import { Authorization } from './auth.ts'
import { ApiPermissions } from './permissions.ts'
import { HubMerger, ServiceUpdateContext } from './merge.ts'
import { settings } from './settings.ts'
import { publicKey } from './keychain.ts'
import * as LoadBalancer from './load balancers.ts'

export type { Sender } from 'channel/client'

const auth = new Authorization()
await auth.load()
const apiPermissions = await new ApiPermissions().load()

const paddr = (a?: string) => (a ? (isNaN(Number(a)) ? a : Number(a)) : 1997)

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
  merger = new HubMerger()
  proxies = new Map<string, Sender>()
  constructor(address = paddr(Bun.env.HUBLISTEN)) {
    const services = this.services
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
    const sendUpdates = () => {
      statusState.setNeedsUpdate()
      pendingAuthorizations.setNeedsUpdate()
      statusBadges.setNeedsUpdate()
    }
    this.channel
      .post('hub/service/update', ({ body: { add, remove }, state, sender }) => {
        const context = this.merger.context()
        if (add && Array.isArray(add)) this.addServices(sender, state, add, context)
        if (remove && Array.isArray(remove)) this.removeServices(sender, state, remove, context)
        context.applyChanges()
        sendUpdates()
      })
      .post('hub/merge/add', ({ body: address, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        this.merger.connect(address, this)
      })
      .post('hub/merge/remove', ({ body: address, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        this.merger.disconnect(address)
      })
      .stream('hub/merge/status', () => this.merger.state.makeIterator())
      .post('hub/key', ({ state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        return publicKey()
      })
      .post('hub/proxy', ({ body: { body, path, name } }) => {
        const proxy = this.proxies.get(name)
        if (!proxy) throw 'proxy not found'
        return proxy.send(path, body)
      })
      .stream('hub/proxy', ({ body: { body, path, name } }) => {
        const proxy = this.proxies.get(name)
        if (!proxy) throw 'proxy not found'
        return proxy.values(path, body)
      })
      .post('hub/proxy/add', ({ body: address, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        this.merger.connectProxy(address, this)
      })
      .post('hub/proxy/remove', ({ body: address, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        this.merger.disconnectProxy(address)
      })
      .post('hub/proxy/join', ({ sender, state }) => {
        console.log('Joining proxy', state.id)
        if (!state.id) throw 'unauthorized'
        this.proxies.set(state.id, sender)
        return state.id
      })
      .post('hub/balancer/set', ({ body: { path, type }, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        settings.updateApi(path, settings => {
          if ((settings.loadBalancer ?? 'counter') === type) return false
          settings.loadBalancer = type
          return true
        })
        this.services.get(path)?.setBalancer(type)
      })
      .post('hub/permissions', ({ state }) => Array.from(state.permissions).toSorted())
      .post('hub/permissions/add', ({ body: { services, permission }, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        apiPermissions.addServices(services, permission)
        const context = this.merger.context()
        let changes = 0
        for (const service of services) {
          const s = this.services.get(service)
          if (s) changes += s.addPermission(permission, context)
        }
        context.applyChanges()
        if (changes) sendUpdates()
      })
      .post('hub/permissions/remove', ({ body: { services, permission }, state: { permissions } }) => {
        if (!permissions.has('owner')) throw 'unauthorized'
        apiPermissions.removeServices(services, permission)
        let changes = 0
        const context = this.merger.context()
        for (const service of services) {
          const s = this.services.get(service)
          if (s) changes += s.removePermission(permission, context)
        }
        context.applyChanges()
        if (changes) sendUpdates()
      })
      .stream('hub/permissions/pending', () => pendingAuthorizations.makeIterator())
      .stream('hub/status', () => statusState.makeIterator())
      .stream('hub/status/badges', () => statusBadges.makeIterator())
      .postOther(other, async ({ body }, path) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        const s = await service.next()
        if (!s) throw 'api not found'
        service.requests += 1
        requests += 1
        statusState.setNeedsUpdate()
        try {
          s.sending += 1
          return await s.sender.send(path, body)
        } finally {
          s.sending -= 1
          service.completed(s)
        }
      })
      .streamOther(other, async function* ({ body }, path) {
        const service = services.get(path)
        if (!service) throw 'api not found'
        const s = await service.next()
        if (!s) throw 'api not found'
        service.requests += 1
        requests += 1
        s.sending += 1
        statusState.setNeedsUpdate()
        try {
          for await (const value of s.sender.values(path, body)) {
            yield value
          }
        } finally {
          s.sending -= 1
          service.completed(s)
        }
      })
      .onDisconnect((state, sender) => {
        if (auth.sender === sender) {
          delete auth.sender
        }
        const context = this.merger.context()
        state.services.forEach(s => this.services.get(s)?.remove(sender, context))
        if (state.id) this.proxies.delete(state.id)
        context.applyChanges()
        statusState.setNeedsUpdate()
        if (sender === auth.sender) {
          delete auth.sender
        }
      })
      .listen(address, {
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

    settings.data.merge.forEach(address => this.merger.connect(address, this))
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, state: State, services: string[], context: ServiceUpdateContext) {
    state.services = state.services.concat(services) // very bad
    services.forEach(s => {
      const isAuth = this.checkAuthorization(sender, state, s)
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
        context.add(s)
      }
      const enabled = isAuth || apiPermissions.allowsService(service.name, state.permissions)
      service.add({ sender, state, enabled, sending: 0 }, context)
      console.log('Service', s, service.services.length)
    })
    console.log('Added', services.length, 'services')
    if (state.permissions.has('auth')) this.reauthorizeServices()
  }
  removeServices(sender: Sender, state: State, services: string[], context: ServiceUpdateContext) {
    state.services = state.services.filter(a => services.includes(a)) // very unoptimized
    services.forEach(s => {
      let service = this.services.get(s)
      if (!service) return
      service.remove(sender, context)
    })
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

const other = () => true

export interface Service {
  state: State
  sender: Sender
  sending: number
  enabled: boolean
}

class Services {
  name: string
  requests = 0
  services: Service[] = []
  disabled: Service[] = []
  pending: ((service: Service | undefined) => void)[] = []
  loadBalancer: LoadBalancer.Type
  constructor(name: string) {
    this.name = name
    this.loadBalancer = new LoadBalancer.Counter()
  }
  add(service: Service, context: ServiceUpdateContext) {
    if (service.enabled) {
      if (this.services.findIndex(a => a.sender === service.sender) === -1) {
        this.loadBalancer.add(this.services, service)
        if (this.services.length === 1) context.add(this.name)
      }
    } else {
      if (this.disabled.findIndex(a => a.sender === service.sender) === -1) {
        this.disabled.push(service)
      }
    }
  }
  addPermission(permission: string, context: ServiceUpdateContext): number {
    let enabled = new Set<Service>()
    this.disabled.forEach(s => {
      if (s.state.permissions.has(permission)) {
        enabled.add(s)
        s.enabled = true
        this.loadBalancer.add(this.services, s)
        if (this.services.length === 1) context.add(this.name)
      }
    })
    if (!enabled.size) return 0
    this.disabled = this.disabled.filter(a => !enabled.has(a))
    return enabled.size
  }
  removePermission(permission: string, context: ServiceUpdateContext): number {
    let disabled: Service[] = []
    this.services.forEach(s => {
      if (s.state.permissions.has(permission)) {
        disabled.push(s)
        s.enabled = false
        this.disabled.push(s)
      }
    })
    if (!disabled.length) return 0
    for (const service of disabled) {
      this.loadBalancer.remove(this.services, service.sender)
    }
    if (this.services.length === 0) context.remove(this.name)
    return disabled.length
  }
  remove(sender: Sender, context: ServiceUpdateContext) {
    this.loadBalancer.remove(this.services, sender)
    if (this.services.length === 0) context.remove(this.name)
    const index = this.disabled.findIndex(a => a.sender === sender)
    if (index >= 0) this.disabled.splice(index, 1)
  }
  private _next() {
    return this.loadBalancer.next(this.services)
  }
  async next(): Promise<Service | undefined> {
    if (this.pending.length > 0) return this.addPending()
    const service = this._next()
    if (service) return service
    return this.addPending()
  }
  private addPending(): Promise<Service | undefined> {
    if (settings.data.pendingLimit > 0) {
      const deleteCount = this.pending.length + 1 - settings.data.pendingLimit
      if (deleteCount > 0) this.pending.splice(0, deleteCount)
    }
    return new Promise(success => this.pending.push(service => success(service)))
  }
  get status(): ServicesStatus {
    return {
      name: this.name,
      services: this.services.length,
      disabled: this.disabled.length,
      requests: this.requests,
      balancer: this.loadBalancer.name,
    }
  }
  setBalancer(name: LoadBalancer.Name) {
    if (this.loadBalancer.name === name) return
    switch (name) {
      case 'random':
        this.loadBalancer = new LoadBalancer.Random()
        break
      case 'counter':
        this.loadBalancer = new LoadBalancer.Counter()
        break
      case 'first':
        this.loadBalancer = new LoadBalancer.FirstAvailable()
        break
      case 'available':
        this.loadBalancer = new LoadBalancer.CounterAvailable()
        break
    }
  }
  completed(service: Service) {
    if (service.sending > 0 || this.pending.length === 0) return
    this.pending.shift()?.(service)
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
  balancer: string
}
interface StatusBadges {
  services: number
  security: number
}
