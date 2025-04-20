export class Authorization {
  auth: string | undefined
  async load() {
    try {
      this.auth = await Bun.file('auth-service').text()
    } catch {}
  }
  async save() {
    if (this.auth) {
      await Bun.file('auth-service').write(this.auth)
    }
  }
}
