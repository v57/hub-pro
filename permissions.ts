import { LazyState } from 'channel/more'

interface Group {
  name: string
  services: Set<string>
}

export class ApiPermissions {
  state = new LazyState(() => this.groups)
  groups: { [key: string]: Group | undefined } = {}
  services: { [key: string]: Set<string> | undefined } = {}
  allowsService(service: string, groups: Set<string>): boolean {
    if (groups.size === 0) return false
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
      const s = this.services[service]
      if (s) {
        s.add(group)
      } else {
        this.services[service] = new Set([group])
      }
    }
    this.state.setNeedsUpdate()
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
  }
}
