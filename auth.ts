export class Authorization {
  auth: string | undefined
  services: any = {} // Dictionary<string: Set<string>>
  pending: any = {} // Set<string>
  async load() {
    try {
      const data = await Bun.file('keys.json').json()
      this.auth = data.auth
      if (data.services) {
        for (const [key, value] of Object.entries(data.services)) {
          if (Array.isArray(value)) {
            this.services[key] = new Set(value)
          }
        }
      }
    } catch {}
  }
  async save() {
    const { services } = this
    await Bun.file('keys.json').write(JSON.stringify({ services }, null, 2))
  }
}
