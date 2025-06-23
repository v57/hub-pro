import { Hub } from './src/hub'
let port: number | undefined
let merges: string[] = []
let proxies: string[] = []
const argv = process.argv.slice(2)
while (true) {
  const command = argv.shift()
  if (!command) break
  switch (command) {
    case '-p':
    case '--port':
      port = Number(argv.shift())
      break
    case '--merge':
      const merge = argv.shift()
      if (merge) merges.push(merge)
      break
    case '--proxy':
      const proxy = argv.shift()
      if (proxy) proxies.push(proxy)
      break
    default:
      break
  }
}
const hub = new Hub(port)
merges.forEach(address => {
  hub.merger.connect(address, hub, false)
})
proxies.forEach(address => {
  hub.merger.connectProxy(address, hub, false)
})
