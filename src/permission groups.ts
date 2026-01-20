export class PermissionGroups {
  groups: Partial<Record<string, Set<string>>> = {}
  paths = new Map<string, string>()
  names = new Map<string, Set<string>>()
  restricted = new Set<string>()
  add(name: string, path: string): boolean {
    if (this.paths.has(path)) return false
    this.restricted.add(path)
    this.paths.set(path, name)
    let nameSet = this.names.get(name)
    if (nameSet) {
      nameSet.add(path)
    } else {
      this.names.set(name, new Set([path]))
    }
    return true
  }
  addGroup(group: string) {
    if (this.groups[group]) return
    this.groups[group] = new Set()
  }
  allow(group: string, name: string) {
    this.groups[group]?.add(name)
  }
  restrictedList(groups: Set<string>): Set<string> {
    if (groups.has('owner')) return new Set()
    let result = this.restricted
    for (const group of groups) {
      const g = this.groups[group]?.forEach(group => {
        const paths = this.names.get(group)
        if (paths) result = result.difference(paths)
      })
    }
    return result
  }
  checkMany(groups: Set<string>, path: string): boolean {
    if (groups.has('owner')) return true
    const name = this.paths.get(path)
    if (!name) return true
    for (const group of groups) {
      if (this.groups[group]?.has(name)) return true
    }
    return false
  }
  check(group: string, path: string): boolean {
    const name = this.paths.get(path)
    if (!name) return true
    return this.groups[group]?.has(name) ?? false
  }
  async save() {
    let groups: GroupList = {}
    let data: SavedPermissions = {
      permissions: this.list(),
      groups,
    }
    for (const [key, value] of Object.entries(this.groups)) {
      groups[key] = Array.from(value!)
    }
    await Bun.file('groups.json').write(JSON.stringify(data, null, 2))
  }
  async load() {
    try {
      const data: SavedPermissions = await Bun.file('groups.json').json()
      if (data.permissions) {
        for (const [group, list] of Object.entries(data.permissions)) {
          for (const [name, paths] of Object.entries(list!)) {
            for (const path of paths!) {
              this.add(`${group}/${name}`, path)
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
  groupList(): Record<string, string[]> {
    let object: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(this.groups)) {
      object[key] = Array.from(value!)
    }
    return object
  }
}

interface SavedPermissions {
  permissions?: PermissionList
  groups?: GroupList
}
type PermissionList = Record<string, Record<string, string[] | undefined> | undefined>
type GroupList = Record<string, string[] | undefined>
