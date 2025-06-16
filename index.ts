import { Hub } from './src/hub'
let port: number | undefined
let merges: string[] = []
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
      const address = argv.shift()
      if (address) merges.push(address)
      break
    default:
      break
  }
}
const hub = new Hub(port)
merges.forEach(address => {
  hub.merger.connect(address, hub, false)
})
