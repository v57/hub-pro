import type { Service } from './hub'

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

export class CounterLoadBalancer extends RandomLoadBalancer {
  index = 0
  next(): Service {
    if (this.services.length === 0) throw 'api not available'
    this.index += 1
    if (this.index >= this.services.length) this.index = 0
    return this.services[this.index]
  }
  remove(service: Service) {
    const index = this.services.findIndex(s => s.sender === service.sender)
    if (index === -1) return
    if (index < this.index) this.index -= 1
    this.services.splice(index, -1)
  }
}
