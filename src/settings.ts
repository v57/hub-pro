interface Settings {
  merge: string[]
}

class HubSettings {
  data: Settings = {
    merge: [],
  }
  private isSavePending = false
  async load() {
    try {
      this.data = await Bun.file('hub.json').json()
    } catch {}
  }
  private async save() {
    this.isSavePending = false
    await Bun.file('hub.json').write(JSON.stringify(this.data, null, 2))
  }
  async setNeedsSave() {
    if (this.isSavePending) return
    this.isSavePending = true
    setTimeout(() => this.save(), 1000)
  }
}

export let settings = await new HubSettings().load()
