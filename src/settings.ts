import type { Name as LoadBalancer } from './load balancers'

interface Settings {
  merge: string[]
  proxies: string[]
  api: { [key: string]: ApiSettings | undefined }
  pendingLimit: number
}
interface ApiSettings {
  loadBalancer?: LoadBalancer
}

class HubSettings {
  data: Settings = {
    merge: [],
    proxies: [],
    api: {},
    pendingLimit: 0,
  }
  private isSavePending = false
  async load() {
    try {
      this.data = await Bun.file('hub.json').json()
      this.data.merge ??= []
      this.data.proxies ??= []
      this.data.api ??= {}
      this.data.pendingLimit ??= 0
      console.log(this.data)
    } catch {}
    return this
  }
  private async save() {
    this.isSavePending = false
    await Bun.file('hub.json').write(JSON.stringify(this.data, null, 2))
  }
  async setNeedsSave() {
    if (this.isSavePending) return
    this.isSavePending = true
    setTimeout(() => this.save(), 1000)
  }
  addMerge(address: string) {
    if (this.data.merge.includes(address)) return
    this.data.merge.push(address)
    this.setNeedsSave()
  }
  removeMerge(address: string) {
    const i = this.data.merge.findIndex(a => a === address)
    if (i == -1) return
    this.data.merge.splice(i, 1)
    this.setNeedsSave()
  }
  addProxy(address: string) {
    if (this.data.proxies.includes(address)) return
    this.data.proxies.push(address)
    this.setNeedsSave()
  }
  removeProxy(address: string) {
    const i = this.data.proxies.findIndex(a => a === address)
    if (i == -1) return
    this.data.proxies.splice(i, 1)
    this.setNeedsSave()
  }
  updateApi(path: string, update: (settings: ApiSettings) => boolean) {
    const settings = this.data.api[path] ?? {}
    if (update(settings)) {
      this.setNeedsSave()
    }
  }
}

export let settings = await new HubSettings().load()
