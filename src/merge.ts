import type { Hub } from './hub'
import { sign } from './keychain'
import { Channel } from 'channel/client'
import { settings } from './settings'
import { LazyState } from 'channel/more'
const v = '0'

export class HubMerger {
  connections = new Map<string, Connection>()
  proxies = new Map<string, Connection>()
  state: LazyState<ConnectionStatus[]>
  constructor() {
    this.state = new LazyState<ConnectionStatus[]>(async () =>
      this.connections
        .values()
        .map(a => a.status)
        .toArray(),
    )
  }
  connect(address: string, hub: Hub, save: boolean = true) {
    if (this.connections.has(address)) return
    const connection = new Connection(address, hub, true)
    this.connections.set(address, connection)
    if (save) settings.addMerge(address)
  }
  disconnect(address: string) {
    const connection = this.connections.get(address)
    if (!connection) return
    this.connections.delete(address)
    connection.disconnect()
    settings.removeMerge(address)
  }
  connectProxy(address: string, hub: Hub, save: boolean = true) {
    if (this.proxies.has(address)) return
    const connection = new Connection(address, hub, false)
    this.proxies.set(address, connection)
    if (save) settings.addProxy(address)
  }
  disconnectProxy(address: string) {
    const connection = this.proxies.get(address)
    if (!connection) return
    this.proxies.delete(address)
    connection.disconnect()
    settings.removeProxy(address)
  }
  context(): ServiceUpdateContext {
    return new ServiceUpdateContext(this)
  }
}

interface ConnectionStatus {
  address: string
  error?: string
  isConnected: boolean
}

export class ServiceUpdateContext {
  added: string[] = []
  removed: string[] = []
  merger: HubMerger
  isActive: boolean
  constructor(merger: HubMerger) {
    this.merger = merger
    this.isActive = merger.connections.size > 0
  }
  add(service: string) {
    if (!this.isActive) return
    if (!allows(service)) return
    this.added.push(service)
  }
  remove(service: string) {
    if (!this.isActive) return
    this.removed.push(service)
  }
  applyChanges() {
    if (!this.added.length && !this.removed.length) return
    this.merger.connections.forEach(a => a.update(this.added, this.removed))
  }
}

class Connection {
  address: string
  channel?
  error?: string
  constructor(address: string, hub: Hub, merge: boolean) {
    this.address = address
    console.log('Merging to', address)
    const t = this
    this.channel = hub.channel.connect(this.address, {
      headers: async () => ({ auth: await sign(), v }),
      async onConnect(sender) {
        if (merge) {
          const add = Object.keys(hub.services.storage).filter(allows)
          if (!add.length) return
          try {
            await sender.send('hub/service/update', { add })
          } catch (error) {
            t.error = `${error}`
          }
        } else {
          await sender.send('hub/proxy/join')
        }
      },
    })
  }
  async update(add: string[], remove: string[]) {
    try {
      await this.channel?.send('hub/service/update', { add, remove })
    } catch (error) {
      this.error = `${error}`
    }
  }
  disconnect() {
    this.channel?.stop()
    delete this.channel
  }
  get status(): ConnectionStatus {
    return {
      address: this.address,
      error: this.error,
      isConnected: this.channel?.ws.isConnected ?? false,
    }
  }
}

function allows(service: string): boolean {
  return (
    !(service.startsWith('auth/') || service === 'auth' || service.startsWith('launcher/') || service === 'auth') ||
    service.startsWith('hub/') ||
    service === 'hub'
  )
}
