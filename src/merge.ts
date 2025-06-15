import type { Hub } from './hub'
import { sign } from './keychain'
import { Channel } from 'channel/client'
import { settings } from './settings'
const v = '0'

export class HubMerger {
  connections = new Map<string, Connection>()
  connect(address: string, hub: Hub) {
    if (this.connections.has(address)) return
    const connection = new Connection(address, () => Object.keys(hub.services.storage))
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
  update(added: string[], removed: string[]) {
    this.channel.send('hub/proxy/create', { added, removed })
  }
  disconnect() {
    this.channel.stop()
  }
}
