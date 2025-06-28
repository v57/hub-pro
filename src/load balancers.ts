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

export class FirstAvailableLoadBalancer extends RandomLoadBalancer {
  next(): Service {
    const service = this.services.find(a => !a.sending)
    if (!service) throw 'api not available'
    return service
  }
}

export class CounterAvailableLoadBalancer extends CounterLoadBalancer {
  next(): Service {
    if (this.services.length === 0) throw 'api not available'
    let index = this.index + 1
    if (index >= this.services.length) index = 0
    for (let i = index; i < this.services.length; i += 1) {
      if (!this.services[i].sending) {
        this.index = i
        return this.services[i]
      }
    }
    for (let i = 0; i < index; i += 1) {
      if (!this.services[i].sending) {
        this.index = i
        return this.services[i]
      }
    }
    throw 'api not available'
  }
  remove(service: Service) {
    const index = this.services.findIndex(s => s.sender === service.sender)
    if (index === -1) return
    if (index < this.index) this.index -= 1
    this.services.splice(index, -1)
  }
}
