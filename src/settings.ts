import type { Name as LoadBalancer } from './load balancers'
import { mkdir } from 'fs/promises'
try {
  await mkdir('data', { recursive: true })
} catch {}

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
  storage: Storage
  constructor() {
    this.storage = new Storage(
      'data/hub.json',
      () => this.data,
      data => {
        this.data = data
        this.data.merge ??= []
        this.data.proxies ??= []
        this.data.api ??= {}
        this.data.pendingLimit ??= 0
      },
    )
  }
  async load() {
    await this.storage.load()
    return this
  }
  async setNeedsSave() {
    this.storage.save()
  }
  addMerge(address: string) {
    if (this.data.merge.includes(address)) return
    this.data.merge.push(address)
    this.storage.save()
  }
  removeMerge(address: string) {
    const i = this.data.merge.findIndex(a => a === address)
    if (i == -1) return
    this.data.merge.splice(i, 1)
    this.storage.save()
  }
  addProxy(address: string) {
    if (this.data.proxies.includes(address)) return
    this.data.proxies.push(address)
    this.storage.save()
  }
  removeProxy(address: string) {
    const i = this.data.proxies.findIndex(a => a === address)
    if (i == -1) return
    this.data.proxies.splice(i, 1)
    this.storage.save()
  }
  updateApi(path: string, update: (settings: ApiSettings) => boolean) {
    const settings = this.data.api[path] ?? {}
    if (update(settings)) this.storage.save()
  }
}

export let settings = await new HubSettings().load()

export class Storage {
  path: string
  encode: () => any
  decode: (data: any) => void
  isSavePending = false
  constructor(path: string, encode: () => any, decode: (data: any) => void) {
    this.path = path
    this.encode = encode
    this.decode = decode
  }
  async load() {
    try {
      const data = await Bun.file(this.path).json()
      this.decode(data)
    } catch {}
  }
  async save() {
    if (this.isSavePending) return
    this.isSavePending = true
    setTimeout(() => {
      this.isSavePending = false
      Bun.file(this.path)
        .write(JSON.stringify(this.encode(), null, 2))
        .then()
    }, 1000)
  }
}
