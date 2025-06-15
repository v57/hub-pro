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
  addMerge(address: string) {
    if (this.data.merge.includes(address)) return
    this.data.merge.push(address)
    this.setNeedsSave()
  }
  removeMerge(address: string) {
    const i = this.data.merge.findIndex(a => a === address)
    if (i == -1) return
    this.data.merge.splice(i, 1)
    this.setNeedsSave()
  }
}

export let settings = await new HubSettings().load()
