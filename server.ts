import type { ServerWebSocket } from 'bun'

export function json(value: any): string {
  return JSON.stringify(value)
}

export class Server<SocketInfo> {
  private port: number
  private onRequest: (socket: ServerWebSocket<SocketInfo>, request: Request) => any = () => {}
  private onResponse: (socket: ServerWebSocket<SocketInfo>, request: Response) => any = () => {}
  private onConnect: (socket: ServerWebSocket<SocketInfo>) => any = () => {}
  private onDisconnect: (socket: ServerWebSocket<SocketInfo>) => any = () => {}
  private makeInfo: (request: globalThis.Request) => Promise<SocketInfo>
  constructor(port: number, makeInfo: (request: globalThis.Request) => Promise<SocketInfo>) {
    this.port = port
    this.makeInfo = makeInfo
  }

  request(action: (socket: ServerWebSocket<SocketInfo>, request: Request) => any) {
    this.onRequest = action
    return this
  }
  response(action: (socket: ServerWebSocket<SocketInfo>, request: Response) => any) {
    this.onResponse = action
    return this
  }
  connected(action: (socket: ServerWebSocket<SocketInfo>) => any) {
    this.onConnect = action
    return this
  }
  disconnected(action: (socket: ServerWebSocket<SocketInfo>) => any) {
    this.onDisconnect = action
    return this
  }
  start() {
    const { onRequest, onResponse, onConnect, onDisconnect, makeInfo } = this
    console.log('started', this.port)
    async function received(ws: ServerWebSocket<SocketInfo>, r: any) {
      if (r.path) {
        try {
          onRequest(ws, r)
        } catch (e) {
          ws.send(json({ id: r.id, error: 'failed' }))
        }
      } else {
        onResponse(ws, r)
      }
    }
    return Bun.serve({
      port: this.port,
      hostname: '127.0.0.1',
      async fetch(req, server) {
        if (server.upgrade(req, { data: await makeInfo(req) })) return
        return new Response()
      },
      websocket: {
        open(ws: ServerWebSocket<SocketInfo>) {
          onConnect(ws)
        },
        close(ws: ServerWebSocket<SocketInfo>) {
          onDisconnect(ws)
        },
        async message(ws: ServerWebSocket<SocketInfo>, message) {
          if (typeof message != 'string') return
          const req = JSON.parse(message)
          if (Array.isArray(req)) {
            for (const r of req) {
              await received(ws, r)
            }
          } else {
            await received(ws, req)
          }
        },
      },
    })
  }
}
export interface Request {
  socket: ServerWebSocket
  id: number
  path: string
  body?: any
}
export interface Response {
  socket: ServerWebSocket
  id: number
  body?: any
  error?: any
}
