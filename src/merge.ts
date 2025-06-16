import type { Hub } from './hub'
import { sign } from './keychain'
import { Channel } from 'channel/client'
import { settings } from './settings'
const v = '0'

export class HubMerger {
  connections = new Map<string, Connection>()
  connect(address: string, hub: Hub) {
    if (this.connections.has(address)) return
    const connection = new Connection(address, () => Object.keys(hub.services.storage).filter(allows))
    this.connections.set(address, connection)
    settings.addMerge(address)
  }
  disconnect(address: string) {
    const connection = this.connections.get(address)
    if (!connection) return
    this.connections.delete(address)
    connection.disconnect()
    settings.removeMerge(address)
  }
  context(): ServiceUpdateContext {
    return new ServiceUpdateContext(this)
  }
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
  address: string | number
  channel
  constructor(address: string, services: () => string[]) {
    this.address = address
    this.channel = new Channel().connect(this.address, {
      headers: async () => ({ auth: await sign(), v }),
      async onConnect(sender) {
        await sender.send('hub/service/add', services())
      },
    })
  }
  update(add: string[], remove: string[]) {
    this.channel.send('hub/service/update', { add, remove })
  }
  disconnect() {
    this.channel.stop()
  }
}

function allows(service: string): boolean {
  return (
    !(service.startsWith('auth/') || service === 'auth' || service.startsWith('launcher/') || service === 'auth') ||
    service.startsWith('hub/') ||
    service === 'hub'
  )
}
