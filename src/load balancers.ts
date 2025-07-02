import type { Service, Sender } from './hub'

export type Name = 'random' | 'counter' | 'first' | 'available'

export interface Type {
  name: Name
  next(services: Service[]): Service | undefined
  add(services: Service[], item: Service): void
  remove(services: Service[], item: Sender): Service | undefined
}

export class Random implements Type {
  get name(): Name {
    return 'random'
  }
  next(services: Service[]): Service | undefined {
    if (services.length === 0) return
    return services[Math.floor(Math.random() * services.length)]
  }
  add(services: Service[], service: Service) {
    services.push(service)
  }
  remove(services: Service[], sender: Sender) {
    const index = services.findIndex(s => s.sender === sender)
    if (index === -1) return
    const service = services[index]
    services.splice(index, 1)
    return service
  }
}

export class Counter extends Random {
  get name(): Name {
    return 'counter'
  }
  index = 0
  next(services: Service[]): Service | undefined {
    if (services.length === 0) return
    this.index += 1
    if (this.index >= services.length) this.index = 0
    return services[this.index]
  }
  remove(services: Service[], sender: Sender) {
    const index = services.findIndex(s => s.sender === sender)
    if (index === -1) return
    if (index < this.index) this.index -= 1
    const service = services[index]
    services.splice(index, 1)
    return service
  }
}

export class FirstAvailable extends Random {
  get name(): Name {
    return 'first'
  }
  next(services: Service[]): Service | undefined {
    return services.find(a => !a.sending.size)
  }
}

export class CounterAvailable extends Counter {
  get name(): Name {
    return 'available'
  }
  next(services: Service[]): Service | undefined {
    if (services.length === 0) return
    let index = this.index + 1
    if (index >= services.length) index = 0
    for (let i = index; i < services.length; i += 1) {
      if (!services[i].sending.size) {
        this.index = i
        return services[i]
      }
    }
    for (let i = 0; i < index; i += 1) {
      if (!services[i].sending.size) {
        this.index = i
        return services[i]
      }
    }
  }
  remove(services: Service[], sender: Sender) {
    const index = services.findIndex(s => s.sender === sender)
    if (index === -1) return
    if (index < this.index) this.index -= 1
    const service = services[index]
    services.splice(index, 1)
    return service
  }
}
