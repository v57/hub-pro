import { LazyState } from 'channel/more'

interface Group {
  name: string
  services: Set<string>
}

export class ApiPermissions {
  state = new LazyState(() => this.groups)
  groups: { [key: string]: Group | undefined } = {}
  services: { [key: string]: Set<string> | undefined } = {}
  async load() {
    try {
      let data: { [key: string]: string[] | undefined } = await Bun.file('permissions.json').json()
      Object.entries(data).forEach(([name, services]) => {
        this.groups[name] = { name, services: new Set(services) }
        for (const service of services!) {
          dsAdd(this.services, service, name)
        }
      })
    } catch {}
    return this
  }
  async save() {
    let data: { [key: string]: string[] | undefined } = {}
    Object.values(this.groups).forEach(group => {
      data[group!.name] = Array.from(group!.services)
    })
    await Bun.file('permissions.json').write(JSON.stringify(data, null, 2))
  }
  allowsService(service: string, groups: Set<string>): boolean {
    if (groups.size === 0) return false
    if (groups.has('owner')) return true
    const s = this.services[service]
    if (!s) return false
    return !s.isDisjointFrom(groups)
  }
  addServices(services: string[], group: string) {
    let g = this.groups[group]
    if (g) {
      for (const service of services) {
        g.services.add(service)
      }
    } else {
      g = { name: group, services: new Set(services) }
      this.groups[group] = g
    }
    for (const service of services) {
      dsAdd(this.services, service, group)
    }
    this.state.setNeedsUpdate()
    this.save()
  }
  removeServices(services: string[], group: string) {
    let g = this.groups[group]
    if (!g) return
    for (const service of services) {
      g.services.delete(service)
      this.services[service]?.delete(group)
    }
    if (g.services.size === 0) {
      delete this.groups[group]
    }
    this.state.setNeedsUpdate()
    this.save()
  }
}

function dsAdd<Element>(dictionary: { [key: string]: Set<Element> | undefined }, key: string, value: Element) {
  const s = dictionary[key]
  if (s) {
    s.add(value)
  } else {
    dictionary[key] = new Set([value])
  }
}
