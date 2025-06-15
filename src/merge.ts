import type { Hub } from './hub'
import { sign } from './keychain'
import { Channel } from 'channel/client'
const v = '0'

class HubMerger {
  connections = new Map<string, Connection>()
  addConnection(address: string, hub: Hub) {
    if (this.connections.has(address)) return
    const connection = new Connection(address, () => Object.keys(hub.services.storage))
    this.connections.set(address, connection)
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
}
