export class PermissionGroups {
  groups = new Map<string, Set<string>>()
  paths = new Map<string, string>()
  restricted = new Set<string>()
  add(permission: { name: string; path: string }) {
    this.restricted.add(permission.path)
    this.paths.set(permission.path, permission.name)
    return this
  }
  addGroup(group: string) {
    if (this.groups.has(group)) return
    this.groups.set(group, new Set())
  }
  allow(group: string, name: string) {
    this.groups.get(group)?.add(name)
  }
  restrictedList(group: string): Set<string> {
    const g = this.groups.get(group)
    if (!g) return this.restricted
    return g.difference(this.restricted)
  }
  check(group: string, path: string): boolean {
    const name = this.paths.get(path)
    if (!name) return true
    return this.groups.get(group)?.has(name) ?? false
  }
  async save() {
    let groups: GroupList = {}
    let data: SavedPermissions = {
      permissions: this.list(),
      groups,
    }
    this.groups.forEach((value, key) => {
      groups[key] = Array.from(value)
    })
    await Bun.file('groups.json').write(JSON.stringify(data, null, 2))
  }
  async load() {
    try {
      const data: SavedPermissions = await Bun.file('groups.json').json()
      if (data.permissions) {
        for (const [group, list] of Object.entries(data.permissions)) {
          for (const [name, paths] of Object.entries(list!)) {
            for (const path of paths!) {
              this.add({ name: `${group}/${name}`, path })
            }
          }
        }
      }
      if (data.groups) {
        for (const [group, list] of Object.entries(data.groups)) {
          this.addGroup(group)
          for (const name of list!) {
            this.allow(group, name)
          }
        }
      }
    } catch {}
    return this
  }
  list(): PermissionList {
    let result: PermissionList = {}
    this.paths.forEach((groupAndName, path) => {
      const split = groupAndName.split('/')
      if (split.length > 1) {
        const group = split[0]
        const name = split.slice(1).join('/')
        const data = result[group]
        if (data) {
          if (data[name]) {
            data[name].push(path)
          } else {
            data[name] = [path]
          }
        } else {
          result[group] = { [name]: [path] }
        }
      }
    })
    return result
  }
}

interface SavedPermissions {
  permissions?: PermissionList
  groups?: GroupList
}
type PermissionList = Record<string, Record<string, string[] | undefined> | undefined>
type GroupList = Record<string, string[] | undefined>
