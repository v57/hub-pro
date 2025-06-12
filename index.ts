import { Hub } from './hub'
let port: number | undefined
const argv = process.argv.slice(2)
while (true) {
  const command = argv.shift()
  if (!command) break
  switch (command) {
    case '-p':
    case '--port':
      port = Number(argv.shift())
      break
    default:
      break
  }
}
new Hub(port)
