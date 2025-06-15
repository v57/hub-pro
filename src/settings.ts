interface Settings {
  merge: string[]
}

class HubSettings {
  settings: Settings = {
    merge: [],
  }
  async load() {
    try {
      this.settings = await Bun.file('hub.json').json()
    } catch {}
  }
  async save() {
    await Bun.file('hub.json').write(JSON.stringify(this.settings, null, 2))
  }
}

export let settings = await new HubSettings().load()
