import crypto from 'node:crypto'
import { config, requireConfiguredMasterKey } from './config.mjs'

function key() {
  requireConfiguredMasterKey()
  return crypto.createHash('sha256').update(config.masterKey).digest()
}

export function encryptSecret(value) {
  if (!value) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  }
}

export function decryptSecret(secret) {
  if (!secret) return null
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(secret.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(secret.data, 'base64')),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}
