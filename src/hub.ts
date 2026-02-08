import { Channel, type Sender, type BodyContext, ObjectMap } from 'channel/server'
import 'channel/client'
import { LazyState, LazyStates } from 'channel/more'
import { HubMerger, ServiceUpdateContext } from './merge.ts'
import { settings } from './settings.ts'
import { publicKey } from './keychain.ts'
import * as LoadBalancer from './load balancers.ts'
import type { Cancellable } from 'channel/channel'
import { Security } from './security.ts'
import { randomUUIDv7 } from 'bun'

export type { Sender } from 'channel/client'

export const security = await new Security().load()

const paddr = (a?: string) => (a ? (isNaN(Number(a)) ? a : Number(a)) : 1997)

interface State {
  id: string
  key?: string
  services: Set<string>
  apps: Set<string>
}

let requests = 0
export class Hub {
  services = new ObjectMap<string, Services>()
  channel = new Channel<State>()
  connections = new Set<BodyContext<State>>()
  merger = new HubMerger(this)
  proxies = new Map<string, Sender>()
  apps = new Apps()
  api = new Set<string>()
  apiList = new LazyStates<State, string[]>(state => {
    return security.allowedApi(state.key, this.api)
  })
  constructor(address = paddr(Bun.env.HUBLISTEN)) {
    const services = this.services
    const statusState = new LazyState<StatusState>(() => ({
      requests,
      services: this.services.map(a => a.status),
      pro: true,
    }))
    const connectionsState = new LazyState(() => this.connectionsInfo()).delay(1)
    const statusBadges = new LazyState<StatusBadges>(() => this.statusBadges)
    const sendUpdates = () => {
      statusState.setNeedsUpdate()
      statusBadges.setNeedsUpdate()
    }
    this.channel
      .post('hub/api', ({ state }) => security.allowedApi(state.key, this.api))
      .stream('hub/api', ({ state }) => this.apiList.makeIterator(state))
      .post('hub/service/update', ({ body: { add, remove, addApps, removeApps, services, apps }, state, sender }) => {
        const context = this.merger.context()
        if (services && Array.isArray(services)) {
          const s = services as ServiceHeader[]
          const paths = new Set(s.map(a => a.path))
          const add = paths.difference(state.services)
          const remove = state.services.difference(paths)
          this.addServices(sender, state, Array.from(add), context)
          this.removeServices(sender, state, Array.from(remove), context)
          for (const service of s) {
            const p = service.permissions
            if (p) {
              const group = p.group ?? service.path.split('/')[0]
              security.group.names.add(service.path, `${group}: ${p.name}`)
            }
          }
        }
        if (apps && Array.isArray(apps)) {
          const paths = new Set((apps as AppHeader[]).map(a => a.path))
          const add = paths.difference(state.apps)
          const remove = state.apps.difference(paths)
          const newApps = (apps as AppHeader[]).filter(app => add.has(app.path))
          this.apps.add(sender, state, newApps)
          this.apps.remove(sender, state, Array.from(remove))
        }
        if (add && Array.isArray(add)) this.addServices(sender, state, add, context)
        if (remove && Array.isArray(remove)) this.removeServices(sender, state, remove, context)
        if (addApps && Array.isArray(addApps)) this.apps.add(sender, state, addApps)
        if (removeApps && Array.isArray(removeApps)) this.apps.remove(sender, state, removeApps)
        context.applyChanges()
        sendUpdates()
      })
      .post('hub/merge/add', ({ body: address, state, path }) => {
        security.requireOwner(state.key, path)
        this.merger.connect(address, this)
      })
      .post('hub/merge/remove', ({ body: address, state, path }) => {
        security.requireOwner(state.key, path)
        this.merger.disconnect(address)
      })
      .stream('hub/merge/status', () => this.merger.state.makeIterator())
      .post('hub/key', ({ state, path }) => {
        security.requireOwner(state.key, path)
        return publicKey()
      })
      .stream('hub/connections', () => connectionsState.makeIterator())
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
      .post('hub/proxy/add', ({ body: address, state, path }) => {
        security.requireOwner(state.key, path)
        this.merger.connectProxy(address, this)
      })
      .post('hub/proxy/remove', ({ body: address, state, path }) => {
        security.requireOwner(state.key, path)
        this.merger.disconnectProxy(address)
      })
      .post('hub/proxy/join', ({ sender, state }) => {
        if (!state.key) throw 'unauthorized'
        this.proxies.set(state.key, sender)
        return state.key
      })
      .post('hub/balancer/set', ({ body: { path, type }, state, path: api }) => {
        security.requireOwner(state.key, api)
        settings.updateApi(path, settings => {
          if ((settings.loadBalancer ?? 'counter') === type) return false
          settings.loadBalancer = type
          return true
        })
        this.services.get(path)?.setBalancer(type)
      })
      .post('hub/balancer/limit', ({ body: { limit }, state, path }) => {
        security.requireOwner(state.key, path)
        if (settings.data.pendingLimit !== limit) {
          settings.data.pendingLimit = limit
          settings.setNeedsSave()
        }
      })
      .post('hub/host/update', async ({ body: { key, allow, revoke }, state, path }) => {
        security.requireOwner(state.key, path)
        security.host.allow(key, allow)
        security.host.revoke(key, revoke)
      })
      .stream('hub/host/pending', ({ state, path }) => {
        security.requireOwner(state.key, path)
        return security.host.pendingSubscription.makeIterator()
      })
      .post('hub/host/allowed', async ({ body: key, state, path }) => {
        security.requireOwner(state.key, path)
        return Array.from(security.host.allowed(key))
      })
      .post('hub/call/update', async ({ body: { key, allow, revoke }, state, path }) => {
        security.requireOwner(state.key, path)
        security.call.allow(key, allow)
        security.call.revoke(key, revoke)
      })
      .stream('hub/call/pending', ({ state, path }) => {
        security.requireOwner(state.key, path)
        return security.call.pendingSubscription.makeIterator()
      })
      .post('hub/call/allowed', async ({ body: key, state, path }) => {
        security.requireOwner(state.key, path)
        return Array.from(security.call.allowed(key))
      })
      .post('hub/group/create', async ({ body: name, state, path }) => {
        security.requireOwner(state.key, path)
        security.group.create(name)
      })
      .post('hub/group/rename', async ({ body: { group, name }, state, path }) => {
        security.requireOwner(state.key, path)
        security.group.rename(group, name)
      })
      .post('hub/group/remove', async ({ body: group, state, path }) => {
        security.requireOwner(state.key, path)
        security.group.remove(group)
      })
      .post('hub/group/update', async ({ body: { group, add, remove, set }, state, path }) => {
        security.requireOwner(state.key, path)
        if (set) {
          security.group.replace(group, set)
        } else {
          security.group.update(group, add, remove)
        }
      })
      .post('hub/group/update/users', async ({ body: { group, add, remove }, state, path }) => {
        security.requireOwner(state.key, path)
        security.group.users.edit(group, add, remove)
        const users = security.group.users.users(group)
        let changes = 0
        const context = this.merger.context()
        add?.forEach((service: string) => {
          const s = this.services.get(service)
          if (!s) return
          users.forEach(user => (changes += s.allowKey(user, context)))
        })
        remove?.forEach((service: string) => {
          const s = this.services.get(service)
          if (!s) return
          users.forEach(user => (changes += s.revokeKey(user, context)))
        })
        context.applyChanges()
        if (changes) sendUpdates()
      })
      .stream('hub/group/list', () => security.group.subscription.makeIterator())
      .stream('hub/group/users', () => security.group.users.subscription.makeIterator())
      .stream('hub/group/names', () => security.group.names.subscription.makeIterator())
      .stream('hub/status', () => statusState.makeIterator())
      .stream('hub/status/badges', () => statusBadges.makeIterator())
      .postOther(other, async ({ body, path, task, state: { key } }) => {
        const service = this.services.get(path)
        if (!service) throw 'api not found'
        if (!security.allowsCall(key, path)) throw 'permissions required'
        const s = await service.next()
        if (!s) throw 'api not found'
        if (task?.isCancelled) throw 'cancelled'
        service.requests += 1
        requests += 1
        statusState.setNeedsUpdate()
        const request = s.sender.request(path, body)
        try {
          if (task) s.sending.add(task)
          task?.onCancel(request.cancel)
          return await request.response
        } finally {
          if (task) s.sending.delete(task)
          service.completed(s)
        }
      })
      .streamOther(other, async function* ({ body, path, state: { key } }) {
        const service = services.get(path)
        if (!service) throw 'api not found'
        if (!security.allowsCall(key, path)) throw 'permissions required'
        const s = await service.next()
        if (!s) throw 'api not found'
        service.requests += 1
        requests += 1
        s.streams += 1
        statusState.setNeedsUpdate()
        try {
          for await (const value of s.sender.values(path, body)) {
            yield value
          }
        } finally {
          s.streams -= 1
          service.completed(s)
        }
      })
      .onDisconnect((state, sender) => {
        const context = this.merger.context()
        this.removeServices(sender, state, Array.from(state.services), context)
        const sendUpdates = state.apps.size > 0
        this.apps.removeSender(sender, state)
        if (state.id) this.proxies.delete(state.id)
        context.applyChanges()
        statusState.setNeedsUpdate()
        if (sendUpdates) statusBadges.setNeedsUpdate()
      })
      .listen(address, {
        async state(headers: Headers): Promise<State> {
          const key = security.keys.verify(headers.get('auth') ?? undefined)
          return {
            id: randomUUIDv7(),
            key,
            services: new Set<string>(),
            apps: new Set<string>(),
          }
        },
        onConnect: (connection: BodyContext<State>) => {
          this.connections.add(connection)
          statusBadges.setNeedsUpdate()
        },
        onDisconnect: (connection: BodyContext<State>) => {
          this.connections.delete(connection)
          statusBadges.setNeedsUpdate()
        },
      })

    this.api = new Set([...Object.keys(this.channel.postApi.storage), ...Object.keys(this.channel.streamApi.storage)])
    settings.data.merge.forEach(address => this.merger.connect(address, this))
  }
  stats() {
    this.services.map(a => a)
  }
  addServices(sender: Sender, state: State, services: string[], context: ServiceUpdateContext) {
    services.forEach(s => {
      if (state.services.has(s)) return
      state.services.add(s)
      let service = this.services.get(s)
      if (!service) {
        service = new Services(s)
        this.services.set(s, service)
      }
      const enabled = security.allowsHost(state.key, s)
      service.add({ sender, state, enabled, sending: new Set(), streams: 0 }, context)
    })
    console.log('+', services.length, 'api')
  }
  removeServices(sender: Sender, state: State, services: string[], context: ServiceUpdateContext) {
    services.forEach(s => {
      if (!state.services.has(s)) return
      state.services.delete(s)
      let service = this.services.get(s)
      if (!service) return
      service.remove(sender, context)
    })
  }
  private connectionsInfo(): ConnectionInfo[] {
    return Array.from(this.connections, c => ({
      id: c.state.id,
      key: c.state.key,
      services: c.state.services.size,
      apps: c.state.apps.size,
    }))
  }
  get statusBadges(): StatusBadges {
    return {
      connections: this.connections.size,
      services: this.services.size,
      security: security.host.pendingList.size,
      apps: this.apps.headers,
    }
  }
}

const other = () => true

export interface Service {
  state: State
  sender: Sender
  sending: Set<Cancellable>
  streams: number
  enabled: boolean
}

class Services {
  name: string
  requests = 0
  services: Service[] = []
  disabled: Service[] = []
  pending: ((service: Service | undefined) => void)[] = []
  loadBalancer: LoadBalancer.Type
  isEnabled = false
  constructor(name: string) {
    this.name = name
    this.loadBalancer = new LoadBalancer.Counter()
  }
  add(service: Service, context: ServiceUpdateContext) {
    if (service.enabled) {
      if (this.services.findIndex(a => a.sender === service.sender) === -1) {
        this.loadBalancer.add(this.services, service)
        this.enableServiceIfNeeded(context)
        if (this.pending.length) {
          const service = this.loadBalancer.next(this.services)
          this.pending.shift()?.(service)
        }
      }
    } else {
      if (this.disabled.findIndex(a => a.sender === service.sender) === -1) {
        this.disabled.push(service)
      }
    }
  }
  allowKey(key: string, context: ServiceUpdateContext): number {
    let enabled = new Set<Service>()
    this.disabled.forEach(s => {
      if (s.state.key !== key) return
      enabled.add(s)
      s.enabled = true
      this.loadBalancer.add(this.services, s)
      this.enableServiceIfNeeded(context)
    })
    if (!enabled.size) return 0
    this.disabled = this.disabled.filter(a => !enabled.has(a))
    return enabled.size
  }
  revokeKey(key: string, context: ServiceUpdateContext): number {
    let disabled: Service[] = []
    this.services.forEach(s => {
      if (s.state.key !== key) return
      disabled.push(s)
      s.enabled = false
      this.disabled.push(s)
    })
    if (!disabled.length) return 0
    for (const service of disabled) {
      this.loadBalancer.remove(this.services, service.sender)?.sending.forEach(a => a.cancel())
    }
    this.disableServiceIfNeeded(context)
    return disabled.length
  }
  remove(sender: Sender, context: ServiceUpdateContext) {
    const s = this.loadBalancer.remove(this.services, sender)
    s?.sending.forEach(a => a.cancel())
    this.disableServiceIfNeeded(context)
    const index = this.disabled.findIndex(a => a.sender === sender)
    if (index >= 0) this.disabled.splice(index, 1)
  }
  private enableServiceIfNeeded(context: ServiceUpdateContext) {
    // console.log('Enable if needed', this.name, this.isEnabled, this.services.length)
    if (this.isEnabled || !this.services.length) return
    this.isEnabled = true
    context.add(this.name)
  }
  private disableServiceIfNeeded(context: ServiceUpdateContext) {
    if (!this.isEnabled || this.services.length) return
    this.isEnabled = false
    context.remove(this.name)
    if (this.pending.length) {
      this.pending.forEach(a => a(undefined))
      this.pending = []
    }
  }
  private _next(): Service | undefined {
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
      pending: this.pending.length,
      running: this.services.reduce((a, b) => a + b.sending.size + b.streams, 0),
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
    if (service.sending.size > 0 || this.pending.length === 0) return
    this.pending.shift()?.(service)
  }
}

class Apps {
  states = new ObjectMap<string, AppState>()
  headers: AppHeader[] = []
  add(sender: Sender, senderState: State, headers: AppHeader[]) {
    headers.forEach(header => {
      this.addOne(sender, senderState, header)
    })
  }
  addOne(sender: Sender, senderState: State, header: AppHeader) {
    if (senderState.apps.has(header.path)) return
    senderState.apps.add(header.path)
    let state: AppState | undefined = this.states.get(header.path)
    if (!state) {
      state = { senders: new Set([sender]), header }
      this.states.set(header.path, state)
      header.services = 1
      this.headers.push(header)
    } else {
      const i = this.headers.findIndex(h => h.path === header.path)
      if (i !== -1) this.headers[i].services = (this.headers[i].services ?? 0) + 1
      state.senders.add(sender)
    }
  }
  removeSender(sender: Sender, senderState: State) {
    senderState.apps.forEach(path => {
      this.removeOne(sender, path)
    })
    senderState.apps = new Set()
  }
  remove(sender: Sender, senderState: State, paths: string[]) {
    for (const path of paths) {
      if (!senderState.apps.has(path)) continue
      senderState.apps.delete(path)
      this.removeOne(sender, path)
    }
  }
  removeOne(sender: Sender, path: string) {
    let state: AppState | undefined = this.states.get(path)
    if (!state) return
    state.senders.delete(sender)
    const i = this.headers.findIndex(h => h.path === path)
    if (i !== -1) this.headers[i].services = Math.max((this.headers[i].services ?? 0) - 1, 0)
  }
}
interface AppState {
  senders: Set<Sender>
  header: AppHeader
}

interface AppHeader {
  type: 'app'
  name: string
  path: string
  services?: number
}

interface ServiceHeader {
  path: string
  permissions?: ServicePermissions
}
interface ServicePermissions {
  group?: string
  name: string
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
  balancer: LoadBalancer.Name
  pending: number
  running: number
}
interface StatusBadges {
  services: number
  security: number
  connections: number
  apps: AppHeader[]
}
interface ConnectionInfo {
  id?: string
  services?: number
  apps?: number
}
