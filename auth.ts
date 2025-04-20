import type { Sender } from 'channel/channel'
import { createPublicKey, verify } from 'crypto'

export class Authorization {
  auth: string | undefined
  sender?: Sender
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
  async permissions(key: string | null): Promise<Set<string>> {
    if (!key || !this.sender) return new Set()
    const permissions: string[] = await this.sender.send('auth/verify', key)
    return new Set(permissions)
  }
  // Returns permissions list
  verify(data: string): string {
    const parts = data.split('.')
    if (parts.length !== 4 && parts[0] !== 'key' && parts.length === 4) throw 'invalid key'
    const [_, key, hash, time] = parts
    if (!this.verifyPub(key, hash, time)) throw 'invalid signature'
    return key
  }
  // Can handle around 38k verifications per second
  private verifyPub(key: string, signature: string, time: string): boolean {
    const pubKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    const s = parseInt(time, 36)
    const now = Math.round(new Date().getTime() / 1000)
    if (s <= now) throw 'authorization expired'
    const verified = verify(null, Buffer.from(time), pubKey, Buffer.from(signature, 'base64'))
    return verified
  }
}
