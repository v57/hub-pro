import type { Service, Sender } from './hub'

export interface Type {
  next(services: Service[]): Service | undefined
  add(services: Service[], item: Service): void
  remove(services: Service[], item: Sender): boolean
}

export class Random implements Type {
  next(services: Service[]): Service | undefined {
    if (services.length === 0) return
    return services[Math.floor(Math.random() * services.length)]
  }
  add(services: Service[], service: Service) {
    services.push(service)
  }
  remove(services: Service[], sender: Sender) {
    const index = services.findIndex(s => s.sender === sender)
    if (index === -1) return false
    services.splice(index, -1)
    return true
  }
}

export class Counter extends Random {
  index = 0
  next(services: Service[]): Service | undefined {
    if (services.length === 0) return
    this.index += 1
    if (this.index >= services.length) this.index = 0
    return services[this.index]
  }
  remove(services: Service[], sender: Sender) {
    const index = services.findIndex(s => s.sender === sender)
    if (index === -1) return false
    if (index < this.index) this.index -= 1
    services.splice(index, -1)
    return true
  }
}

export class FirstAvailable extends Random {
  next(services: Service[]): Service | undefined {
    return services.find(a => !a.sending)
  }
}

export class CounterAvailable extends Counter {
  next(services: Service[]): Service | undefined {
    if (services.length === 0) return
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
  }
  remove(services: Service[], sender: Sender) {
    const index = services.findIndex(s => s.sender === sender)
    if (index === -1) return false
    if (index < this.index) this.index -= 1
    services.splice(index, -1)
    return true
  }
}
