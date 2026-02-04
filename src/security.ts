import { ObjectMap } from 'channel/channel'
import { createPublicKey, verify } from 'crypto'
import { Storage } from './settings'
import { LazyState } from 'channel/more'

interface SecurityInterface {
  requireOwner(user: string | undefined, path: string): void
  addOwner(user: string): void
  allowsCall(user: string | undefined, path: string): boolean
  allowsHost(user: string | undefined, path: string): boolean

  // Keys
  keys: {
    verify(signedKey: string | undefined): string | undefined
  }

  // Create api
  host: {
    allows(user: string, path: string): boolean
    ask(user: string, path: string): void
    allow(user: string, paths: string[] | undefined): void
    revoke(user: string, paths: string[] | undefined): void
    allowed(user: string): Set<string>
    pending(user: string): Set<string>
    pendingUsers(): string[]
  }

  // Call api
  call: {
    allows(user: string, path: string): boolean
    ask(user: string, path: string): void
    allow(user: string, paths: string[]): void
    allowed(user: string): Set<string>
    pending(user: string): Set<string>
  }

  // Groups
  group: {
    allowsUser(user: string, path: string): boolean
    restricted(user: string | undefined): Set<string>

    allows(group: string, path: string): boolean
    create(group: string): void
    remove(group: string): void
    rename(group: string, name: string): void
    update(group: string, add: string[], remove: string[]): void
    replace(group: string, paths: string[]): void
    allowed(group: string): Set<string>

    // User groups
    users: {
      group(user: string): string | undefined
      users(group: string): Set<string>
      add(user: string, group: string): void
      remove(user: string): void
      rename(oldValue: string, group: string): void
    }

    // Path names
    names: {
      add(path: string, name: string): void
      remove(path: string): void
      contains(path: string): boolean
      list(): { path: string; name: string }[]
    }
  }
}

const hubApi = {
  'hub/merge/add': 'Hub: Merge Hubs',
  'hub/merge/remove': 'Hub: Merge Hubs',
  'hub/key': 'Hub: Merge Hubs',
  'hub/proxy/add': 'Hub: Add Proxy Hubs',
  'hub/proxy/remove': 'Hub: Add Proxy Hubs',
  'hub/balancer/set': 'Hub: Manage Load Balancer',
  'hub/balancer/limit': 'Hub: Manage Load Balancer',
  'hub/host/update': 'Hub: Manage Permissions',
  'hub/host/pending': 'Hub: Manage Permissions',
  'hub/host/allowed': 'Hub: Manage Permissions',
  'hub/call/update': 'Hub: Manage Permissions',
  'hub/call/pending': 'Hub: Manage Permissions',
  'hub/call/allowed': 'Hub: Manage Permissions',
  'hub/group/create': 'Hub: Manage Permissions',
  'hub/group/rename': 'Hub: Manage Permissions',
  'hub/group/remove': 'Hub: Manage Permissions',
  'hub/group/update': 'Hub: Manage Permissions',
  'hub/group/update/users': 'Hub: Manage Permissions',
}

export const ownerApi = new Set(Object.keys(hubApi))

export class Security implements SecurityInterface {
  keys = new Keys()
  host = new Host()
  call = new Call()
  group = new Group()
  owners = new Set<string>()

  async load() {
    await Promise.all([
      this.host.storage.load(),
      this.call.storage.load(),
      this.group.storage.load(),
      this.group.names.storage.load(),
      this.group.users.storage.load(),
    ])
    return this
  }
  requireOwner(user: string | undefined, path: string): void {
    if (!this.allowsCall(user, path)) throw 'Permissions required'
  }
  addOwner(user: string): void {
    this.owners.add(user)
  }
  allowsCall(user: string | undefined, path: string): boolean {
    if (!this.group.allowsUser(user, path)) {
      if (!user) return false
      return this.call.allows(user, path) || this.owners.has(user)
    }
    return true
  }
  allowsHost(user: string | undefined, path: string): boolean {
    if (!user) return false
    if (path.startsWith('hub/')) return false
    if (this.owners.has(user)) return true
    if (this.host.allows(user, path)) return true
    return false
  }
  allowedApi(user: string | undefined, api: Set<string>): string[] {
    if (user && this.owners.has(user)) return Array.from(api)
    return Array.from(api.difference(this.group.restricted(user)))
  }
}

class Keys {
  verify(signedKey: string | undefined): string | undefined {
    if (!signedKey?.length) return
    const parts = signedKey.split('.')
    if (parts.length !== 4 && parts[0] !== 'key' && parts.length === 4) throw 'invalid key'
    const [_, key, hash, time] = parts
    if (!this.verifyPub(key, hash, time)) throw 'invalid signature'
    return key
  }
  // Can handle around 38k verifications per second
  private verifyPub(key: string, signature: string, time: string): boolean {
    const pubKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    const s = parseInt(time, 36)
    const now = Math.round(new Date().getTime() / 1000)
    if (s <= now) throw 'authorization expired'
    const verified = verify(null, Buffer.from(time), pubKey, Buffer.from(signature, 'base64'))
    return verified
  }
}

class Host {
  allowedList = new MapSet<string>()
  pendingList = new MapSet<string>()
  pendingSubscription = new LazyState(() => this.pendingList.encode())
  storage = new Storage(
    'data/services.json',
    () => ({
      allowed: this.allowedList.encode(),
    }),
    data => {
      this.allowedList.decode(data?.allowed)
    },
  )
  allows(user: string, path: string): boolean {
    return this.allowedList.has(user, path)
  }
  ask(user: string, path: string): void {
    this.pendingList.set(user, path)
  }
  allow(user: string, paths: string[] | undefined): void {
    if (!paths?.length) return
    for (const path of paths) {
      this.pendingList.delete(user, path)
      this.allowedList.set(user, path)
    }
    this.storage.save()
  }
  revoke(user: string, paths: string[] | undefined): void {
    if (!paths?.length) return
    for (const path of paths) {
      this.pendingList.set(user, path)
      this.allowedList.delete(user, path)
    }
    this.storage.save()
  }
  allowed(user: string): Set<string> {
    return this.allowedList.get(user) ?? new Set()
  }
  pending(user: string): Set<string> {
    return this.pendingList.get(user) ?? new Set()
  }
  pendingUsers(): string[] {
    return this.pendingList.keys()
  }
}

class Call {
  allowedList = new MapSet<string>()
  pendingList = new MapSet<string>()
  pendingSubscription = new LazyState(() => this.pendingList.encode())
  storage = new Storage(
    'data/clients.json',
    () => ({
      allowed: this.allowedList.encode(),
    }),
    data => this.allowedList.decode(data?.allowed),
  )
  allows(user: string, path: string): boolean {
    return this.allowedList.has(user, path)
  }
  ask(user: string, path: string): void {
    this.pendingList.set(user, path)
  }
  allow(user: string, paths: string[] | undefined): void {
    if (!paths?.length) return
    for (const path of paths) {
      this.pendingList.delete(user, path)
      this.allowedList.set(user, path)
    }
    this.storage.save()
  }
  revoke(user: string, paths: string[] | undefined): void {
    if (!paths?.length) return
    for (const path of paths) {
      this.pendingList.set(user, path)
      this.allowedList.delete(user, path)
    }
    this.storage.save()
  }
  allowed(user: string): Set<string> {
    return this.allowedList.get(user) ?? new Set()
  }
  pending(user: string): Set<string> {
    return this.pendingList.get(user) ?? new Set()
  }
}

class Group {
  private groups = new MapSet<string>()
  users = new GroupUsers()
  names = new GroupNames()
  storage = new Storage(
    'data/groups.json',
    () => this.groups.encode(),
    data => this.groups.decode(data),
  )
  subscription = new LazyState<any>(() => this.groups.encode())
  allowsUser(user: string | undefined, path: string): boolean {
    if (!this.names.contains(path)) return true
    if (!user) return false
    const group = this.users.group(user)
    if (!group) return false
    return this.allows(group, path)
  }
  restricted(user: string | undefined): Set<string> {
    let restricted = this.names.restricted
    if (!user) return restricted
    const group = this.users.group(user)
    if (!group) return restricted
    return restricted.difference(this.allowed(group))
  }
  allows(group: string, path: string): boolean {
    if (!this.names.contains(path)) return true
    return this.groups.has(group, path)
  }
  create(group: string): void {
    const paths = this.groups.get(group)
    if (!paths) this.groups.replace(group, new Set())
  }
  remove(group: string): void {
    if (this.groups.deleteAll(group)) this.storage.save()
  }
  rename(group: string, name: string): void {
    this.users.rename(group, name)
    const paths = this.groups.move(group, name)
    if (!paths) return
    this.storage.save()
  }
  update(group: string, add: string[], remove: string[]): void {
    const paths = this.groups.get(group)
    if (!paths) return
    add.forEach(path => paths.add(path))
    remove.forEach(path => paths.delete(path))
    this.storage.save()
  }
  replace(group: string, paths: string[]): void {
    this.groups.replace(group, new Set(paths))
    this.storage.save()
  }
  allowed(group: string): Set<string> {
    return this.groups.get(group) ?? new Set<string>()
  }
}

class GroupUsers {
  private groupUsers = new MapSet<string>()
  private userGroups = new ObjectMap<string, string>()
  storage = new Storage(
    'data/group_users.json',
    () => this.groupUsers.encode(),
    data => {
      this.groupUsers.decode(data)
      this.groupUsers.forEach((group, users) => {
        users.forEach((user: string) => this.userGroups.set(user, group))
      })
    },
  )
  subscription = new LazyState<any>(() => this.groupUsers.encode())
  group(user: string): string | undefined {
    return this.userGroups.get(user)
  }
  users(group: string): Set<string> {
    return this.groupUsers.get(group)
  }
  edit(group: string, add: string[] | undefined, remove: string[] | undefined) {
    add?.forEach(user => this.add(user, group))
    remove?.forEach(user => this.add(user, group))
  }
  add(user: string, group: string): void {
    const oldValue = this.userGroups.get(user)
    if (oldValue === group) return
    if (oldValue) this.groupUsers.delete(oldValue, user)
    this.groupUsers.set(group, user)
    this.userGroups.set(user, group)
    this.storage.save()
  }
  remove(user: string): void {
    const group = this.userGroups.get(user)
    if (!group) return
    this.userGroups.delete(user)
    this.groupUsers.delete(group, user)
    this.storage.save()
  }
  removeGroup(group: string) {
    const set = this.groupUsers.get(group)
    if (!set.size) return
    set.forEach(user => this.userGroups.delete(user))
    this.groupUsers.deleteAll(group)
    this.storage.save()
  }
  rename(oldValue: string, group: string): void {
    const users = this.groupUsers.move(oldValue, group)
    if (!users) return
    users.forEach(user => this.userGroups.set(user, group))
    this.storage.save()
  }
}

class GroupNames {
  names = new ObjectMap<string, string>()
  private paths = new MapSet<string>()
  restricted = new Set<string>()
  storage = new Storage(
    'data/paths.json',
    () => this.names.storage,
    data => {
      this.names.storage = data
      this.paths = new MapSet<string>()
      this.restricted = new Set()
      this.setHubApi()
      Object.entries(data).forEach(([path, name]) => {
        this.restricted.add(path)
        this.paths.set(name as string, path)
      })
    },
  )
  subscription = new LazyState<any>(() => this.names.storage)
  constructor() {
    this.setHubApi()
  }
  private setHubApi() {
    Object.entries(hubApi).forEach(([path, name]) => {
      this.names.storage[path] = name
      this.restricted.add(path)
      this.paths.set(name, path)
    })
  }
  add(path: string, name: string): void {
    const oldName = this.names.get(path)
    if (oldName) this.paths.delete(oldName, path)
    this.names.set(path, name)
    this.paths.set(name, path)
    this.restricted.add(path)
    this.storage.save()
  }
  remove(path: string): void {
    const name = this.names.get(path)
    if (!name) return
    this.paths.delete(name, path)
    this.names.delete(path)
    this.restricted.delete(path)
    this.storage.save()
  }
  contains(path: string): boolean {
    return this.paths.get(path) ? true : false
  }
  list(): { path: string; name: string }[] {
    return Object.entries(this.names.storage).map(([path, name]) => ({ path, name: name as string }))
  }
}

class MapSet<Value> {
  content = new ObjectMap<string, Set<Value>>()
  set(key: string, value: Value) {
    const set = this.content.get(key)
    if (set) {
      set.add(value)
    } else {
      this.content.set(key, new Set([value]))
    }
  }
  keys(): string[] {
    return Object.keys(this.content.storage)
  }
  replace(key: string, value: Set<Value>) {
    this.content.set(key, value)
  }
  move(from: string, to: string): Set<Value> | undefined {
    const set = this.content.get(from)
    if (!set) return
    this.content.delete(from)
    this.content.set(to, set)
    return set
  }
  has(key: string, value: Value): boolean {
    const set = this.content.get(key)
    if (!set) return false
    return set.has(value)
  }
  get(key: string): Set<Value> {
    return this.content.get(key) ?? new Set<Value>()
  }
  delete(key: string, value: Value): boolean {
    const set = this.content.get(key)
    if (!set?.delete(value)) return false
    if (set.size === 0) this.content.delete(key)
    return true
  }
  deleteAll(key: string): boolean {
    const set = this.content.get(key)
    if (!set) return false
    this.content.delete(key)
    return true
  }
  encode(): any {
    let result: any = {}
    this.forEach((key, value) => (result[key] = Array.from(value)))
    return result
  }
  decode(value: any | undefined) {
    this.content = new ObjectMap()
    if (!value) return
    Object.entries(value).forEach(([key, value]) => this.content.set(key, new Set(value as Value[])))
  }
  forEach(action: (key: string, value: Set<Value>) => void) {
    Object.entries(this.content).forEach(([key, value]) => action(key, value))
  }
}
