import type { Service } from './hub'

export interface LoadBalancer {
  next(services: Service[]): Service
  add(services: Service[], item: Service): void
  remove(services: Service[], item: Service): void
}

export class RandomLoadBalancer implements LoadBalancer {
  next(services: Service[]): Service {
    if (services.length === 0) throw 'api not available'
    return services[Math.floor(Math.random() * services.length)]
  }
  add(services: Service[], service: Service) {
    services.push(service)
  }
  remove(services: Service[], service: Service) {
    const index = services.findIndex(s => s.sender === service.sender)
    if (index === -1) return
    services.splice(index, -1)
  }
}

export class CounterLoadBalancer extends RandomLoadBalancer {
  index = 0
  next(services: Service[]): Service {
    if (services.length === 0) throw 'api not available'
    this.index += 1
    if (this.index >= services.length) this.index = 0
    return services[this.index]
  }
  remove(services: Service[], service: Service) {
    const index = services.findIndex(s => s.sender === service.sender)
    if (index === -1) return
    if (index < this.index) this.index -= 1
    services.splice(index, -1)
  }
}

export class FirstAvailableLoadBalancer extends RandomLoadBalancer {
  next(services: Service[]): Service {
    const service = services.find(a => !a.sending)
    if (!service) throw 'api not available'
    return service
  }
}

export class CounterAvailableLoadBalancer extends CounterLoadBalancer {
  next(services: Service[]): Service {
    if (services.length === 0) throw 'api not available'
    let index = this.index + 1
    if (index >= services.length) index = 0
    for (let i = index; i < services.length; i += 1) {
      if (!services[i].sending) {
        this.index = i
        return services[i]
      }
    }
    for (let i = 0; i < index; i += 1) {
      if (!services[i].sending) {
        this.index = i
        return services[i]
      }
    }
    throw 'api not available'
  }
  remove(services: Service[], service: Service) {
    const index = services.findIndex(s => s.sender === service.sender)
    if (index === -1) return
    if (index < this.index) this.index -= 1
    services.splice(index, -1)
  }
}
