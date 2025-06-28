import type { Service } from '../hub'

export interface LoadBalancer {
  next(): Service
  add(item: Service): void
  remove(item: Service): void
}

export class RandomLoadBalancer implements LoadBalancer {
  services: Service[] = []
  next(): Service {
    if (this.services.length === 0) throw 'api not available'
    return this.services[Math.floor(Math.random() * this.services.length)]
  }
  add(service: Service) {
    this.services.push(service)
  }
  remove(service: Service) {
    const index = this.services.findIndex(s => s.sender === service.sender)
    if (index === -1) return
    this.services.splice(index, -1)
  }
}
