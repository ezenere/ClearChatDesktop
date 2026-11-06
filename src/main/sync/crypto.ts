// Criptografia do sync (docs/SYNC_PROTOCOL.md §3). Porta fiel de docs/test-vectors/generate.ts
// (implementação de referência) — testada byte a byte contra os vetores em e2e/syncCrypto.test.ts.
// Sem Electron: roda no main e nos testes (Node). Argon2id via hash-wasm (mesma lib em todos os
// clientes); AES-256-GCM / HKDF / HMAC / SHA-256 via node:crypto; deflate-raw via node:zlib.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes
} from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { argon2id } from 'hash-wasm'

export const PROTOCOL_VERSION = 1
export const ENVELOPE_VERSION = 1
export const KEY_VERSION = 1

export interface KdfParams {
  alg: string
  v: number
  m: number
  t: number
  p: number
  len: number
}

/** Parâmetros Argon2id padrão para novas wraps (m em KiB). */
export const ARGON2_DEFAULT: KdfParams = { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 }
/** Limites aceitos ao LER parâmetros vindos do servidor (anti-DoS / anti-downgrade). */
export const ARGON2_BOUNDS = { mMin: 19456, mMax: 1048576, tMin: 2, tMax: 10, pMin: 1, pMax: 4 }

export const HKDF_INFO = {
  record: 'clearchat/v1/record',
  blob: 'clearchat/v1/blob',
  blobId: 'clearchat/v1/blob-id',
  stream: 'clearchat/v1/stream',
  recordId: 'clearchat/v1/record-id',
  keyVerify: 'clearchat/v1/key-verify',
  recoveryKek: 'clearchat/v1/recovery-kek',
  blobFile: 'clearchat/v1/blob-file',
  push: 'clearchat/v1/push'
} as const

export const FRAME_RAW = 0x00
export const FRAME_DEFLATE = 0x01
/** Escritores comprimem quando o JSON passa de 1 KiB (§3.9). */
export const COMPRESS_OVER = 1024

export const BLOB_MAGIC = 'CCB1'
export const BLOB_HEADER_LEN = 21
export const BLOB_CHUNK_LOG2_DEFAULT = 20
export const BLOB_CHUNK_LOG2_MIN = 10
export const BLOB_CHUNK_LOG2_MAX = 24

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// ---------------- codificações ----------------

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
export const fromB64u = (s: string): Uint8Array => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s))
    throw new Error('base64url inválido (sem padding, sem + /)')
  return new Uint8Array(Buffer.from(s, 'base64url'))
}
export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'))
export const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))
const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts))
export const randomBytesU8 = (n: number): Uint8Array => new Uint8Array(randomBytes(n))

// ---------------- primitivas ----------------

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest())
}

/** HKDF-SHA256 (RFC 5869). Salt vazio = HashLen zeros. */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, len = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(info), len))
}

export function gcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array
): Uint8Array {
  if (key.length !== 32) throw new Error('chave AES-256 precisa de 32 bytes')
  if (nonce.length !== 12) throw new Error('nonce GCM precisa de 12 bytes')
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  c.setAAD(aad)
  return concat(c.update(plaintext), c.final(), c.getAuthTag())
}

export function gcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  ctAndTag: Uint8Array
): Uint8Array {
  if (ctAndTag.length < 16) throw new Error('ciphertext curto demais')
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  d.setAAD(aad)
  d.setAuthTag(ctAndTag.subarray(ctAndTag.length - 16))
  return concat(d.update(ctAndTag.subarray(0, ctAndTag.length - 16)), d.final())
}

// ---------------- KDF da senha / chave de recuperação ----------------

/** Valida parâmetros vindos do servidor. `allowTest` só nos vetores rápidos. */
export function checkKdfParams(k: KdfParams, allowTest = false): void {
  if (!k || k.alg !== 'argon2id' || k.v !== 19 || k.len !== 32)
    throw new Error('Parâmetros de derivação da senha não suportados.')
  if (allowTest) return
  const b = ARGON2_BOUNDS
  if (k.m < b.mMin || k.m > b.mMax || k.t < b.tMin || k.t > b.tMax || k.p < b.pMin || k.p > b.pMax)
    throw new Error(
      'O servidor enviou parâmetros de derivação da senha fora dos limites aceitos — recusado por segurança.'
    )
}

/** KEK da senha: Argon2id(UTF-8(NFC(senha)), salt de 16 bytes) → 32 bytes. */
export async function passwordKek(
  password: string,
  salt: Uint8Array,
  k: KdfParams,
  allowTest = false
): Promise<Uint8Array> {
  checkKdfParams(k, allowTest)
  if (salt.length !== 16) throw new Error('salt precisa de 16 bytes')
  const out = await argon2id({
    password: utf8(password.normalize('NFC')),
    salt,
    parallelism: k.p,
    iterations: k.t,
    memorySize: k.m,
    hashLength: k.len,
    outputType: 'binary'
  })
  return new Uint8Array(out)
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(s: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of s) {
    const v = CROCKFORD.indexOf(ch)
    if (v < 0) throw new Error('Chave de recuperação incorreta (caractere inválido).')
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
    value &= (1 << bits) - 1
  }
  return new Uint8Array(out)
}

function recoveryChecksum(entropy: Uint8Array): string {
  const h = sha256(entropy)
  const v = (h[0] << 12) | (h[1] << 4) | (h[2] >>> 4)
  let out = ''
  for (let i = 3; i >= 0; i--) out += CROCKFORD[(v >>> (i * 5)) & 31]
  return out
}

/** 20 bytes de entropia → "XXXX-…-CCCC" (9 grupos de 4). */
export function formatRecoveryKey(entropy: Uint8Array): string {
  if (entropy.length !== 20) throw new Error('a chave de recuperação tem 20 bytes de entropia')
  const s = base32Encode(entropy) + recoveryChecksum(entropy)
  return s.match(/.{4}/g)!.join('-')
}

/** Leitura tolerante (minúsculas, espaços/hífens, O→0, I/L→1). Checksum errado → erro legível. */
export function parseRecoveryKey(input: string): Uint8Array {
  const s = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (s.length !== 36)
    throw new Error('Chave de recuperação incorreta: ela tem 36 caracteres (9 grupos de 4).')
  const entropy = base32Decode(s.slice(0, 32))
  if (entropy.length !== 20) throw new Error('Chave de recuperação incorreta.')
  if (recoveryChecksum(entropy) !== s.slice(32))
    throw new Error('Chave de recuperação incorreta (confira se não há erro de digitação).')
  return entropy
}

export function recoveryKek(entropy: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(entropy, salt, HKDF_INFO.recoveryKek)
}

// ---------------- hierarquia de chaves ----------------

export interface Subkeys {
  record: Uint8Array
  blob: Uint8Array
  blobId: Uint8Array
  stream: Uint8Array
  recordId: Uint8Array
  keyVerify: Uint8Array
  /** K_push: notificações push (§22.4, desde 1.7.0). */
  push: Uint8Array
}

export function deriveSubkeys(dek: Uint8Array): Subkeys {
  if (dek.length !== 32) throw new Error('DEK precisa de 32 bytes')
  const empty = new Uint8Array(0)
  return {
    record: hkdf(dek, empty, HKDF_INFO.record),
    blob: hkdf(dek, empty, HKDF_INFO.blob),
    blobId: hkdf(dek, empty, HKDF_INFO.blobId),
    stream: hkdf(dek, empty, HKDF_INFO.stream),
    recordId: hkdf(dek, empty, HKDF_INFO.recordId),
    keyVerify: hkdf(dek, empty, HKDF_INFO.keyVerify),
    push: hkdf(dek, empty, HKDF_INFO.push)
  }
}

export function keyProof(sk: Subkeys): { key_proof: string; verifier: string } {
  return { key_proof: b64u(sk.keyVerify), verifier: b64u(sha256(sk.keyVerify)) }
}

// ---------------- AADs ----------------

export type WrapSlot = 'password' | 'recovery'

export const aadWrap = (userId: string, slot: WrapSlot, keyVersion = KEY_VERSION): Uint8Array =>
  utf8(`clearchat|v1|dek-wrap|${userId}|${slot}|${keyVersion}`)

export const aadRecord = (
  userId: string,
  type: string,
  id: string,
  scope: string | null,
  rev: number
): Uint8Array => utf8(`clearchat|v1|record|${userId}|${type}|${id}|${scope ?? ''}|${rev}`)

export const aadStream = (userId: string, chatId: string, epoch: number, n: number): Uint8Array =>
  utf8(`clearchat|v1|stream|${userId}|${chatId}|${epoch}|${n}`)

export const aadCommand = (userId: string, chatId: string, cmdId: string): Uint8Array =>
  utf8(`clearchat|v1|command|${userId}|${chatId}|${cmdId}`)

export const aadCommandResult = (userId: string, chatId: string, cmdId: string): Uint8Array =>
  utf8(`clearchat|v1|command-result|${userId}|${chatId}|${cmdId}`)

/** Notificação push (§3.10, §22.4): amarra usuário, kind e tag. */
export const aadPush = (userId: string, kind: string, tag: string): Uint8Array =>
  utf8(`clearchat|v1|push|${userId}|${kind}|${tag}`)

export const aadBlob = (userId: string, blobId: string, header: Uint8Array): Uint8Array =>
  concat(utf8(`clearchat|v1|blob|${userId}|${blobId}|`), header)

// ---------------- wrap da DEK ----------------

export interface Wrap {
  n: string
  c: string
}

export function wrapDek(
  kek: Uint8Array,
  dek: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array = randomBytesU8(12)
): Wrap {
  return { n: b64u(nonce), c: b64u(gcmEncrypt(kek, nonce, aad, dek)) }
}

export function unwrapDek(kek: Uint8Array, w: Wrap, aad: Uint8Array): Uint8Array {
  const dek = gcmDecrypt(kek, fromB64u(w.n), aad, fromB64u(w.c))
  if (dek.length !== 32) throw new Error('DEK inválida')
  return dek
}

// ---------------- envelope ----------------

export interface Envelope {
  v: number
  k: number
  n: string
  c: string
}

export function frameJson(json: string, compress: boolean): Uint8Array {
  const body = utf8(json)
  return compress
    ? concat(new Uint8Array([FRAME_DEFLATE]), new Uint8Array(deflateRawSync(body, { level: 9 })))
    : concat(new Uint8Array([FRAME_RAW]), body)
}

export function unframeJson(frame: Uint8Array): Record<string, unknown> {
  if (frame.length < 1) throw new Error('moldura vazia')
  const body = frame.subarray(1)
  let raw: Uint8Array
  if (frame[0] === FRAME_RAW) raw = body
  else if (frame[0] === FRAME_DEFLATE) raw = new Uint8Array(inflateRawSync(body))
  else throw new Error(`formato de moldura desconhecido: ${frame[0]}`)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  const obj = JSON.parse(text)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    throw new Error('payload não é objeto JSON')
  return obj as Record<string, unknown>
}

export function seal(
  key: Uint8Array,
  aad: Uint8Array,
  frame: Uint8Array,
  nonce: Uint8Array = randomBytesU8(12)
): Envelope {
  return {
    v: ENVELOPE_VERSION,
    k: KEY_VERSION,
    n: b64u(nonce),
    c: b64u(gcmEncrypt(key, nonce, aad, frame))
  }
}

/** Envelope com versão desconhecida: NÃO decifrar nem sobrescrever (§18). */
export class UnsupportedEnvelopeError extends Error {}

export function open(key: Uint8Array, aad: Uint8Array, env: Envelope): Uint8Array {
  if (!env || env.v !== ENVELOPE_VERSION)
    throw new UnsupportedEnvelopeError('versão de envelope não suportada')
  if (env.k !== KEY_VERSION) throw new UnsupportedEnvelopeError('versão de chave desconhecida')
  const n = fromB64u(env.n)
  if (n.length !== 12) throw new Error('nonce inválido')
  return gcmDecrypt(key, n, aad, fromB64u(env.c))
}

/** Cifra um objeto JSON (comprime acima de 1 KiB). */
export function sealJson(key: Uint8Array, aad: Uint8Array, obj: unknown): Envelope {
  const json = JSON.stringify(obj)
  return seal(key, aad, frameJson(json, Buffer.byteLength(json) > COMPRESS_OVER))
}

export function openJson(key: Uint8Array, aad: Uint8Array, env: Envelope): Record<string, unknown> {
  return unframeJson(open(key, aad, env))
}

/** Validação de forma (o que o servidor confere sem decifrar). */
export function isEnvelope(e: unknown): e is Envelope {
  if (!e || typeof e !== 'object') return false
  const x = e as Envelope
  try {
    return (
      x.v === 1 &&
      Number.isInteger(x.k) &&
      x.k >= 1 &&
      fromB64u(x.n).length === 12 &&
      fromB64u(x.c).length >= 17
    )
  } catch {
    return false
  }
}

// ---------------- ids derivados ----------------

export function blobIdFromSha256(sk: Subkeys, plaintextSha256: Uint8Array): string {
  return hex(hmacSha256(sk.blobId, plaintextSha256))
}

export function skillRecordId(sk: Subkeys, name: string): string {
  return 'sk_' + hex(hmacSha256(sk.recordId, utf8('skill|' + name))).slice(0, 32)
}

// ---------------- blobs CCB1 ----------------

function chunkNonce(index: number, final: boolean): Uint8Array {
  const n = new Uint8Array(12)
  let v = index
  for (let i = 10; i >= 5; i--) {
    n[i] = v % 256
    v = Math.floor(v / 256)
  }
  n[11] = final ? 1 : 0
  return n
}

export function encryptBlob(
  sk: Subkeys,
  userId: string,
  blobId: string,
  plaintext: Uint8Array,
  salt: Uint8Array = randomBytesU8(16),
  chunkLog2 = BLOB_CHUNK_LOG2_DEFAULT
): Uint8Array {
  if (salt.length !== 16) throw new Error('salt do blob precisa de 16 bytes')
  if (chunkLog2 < BLOB_CHUNK_LOG2_MIN || chunkLog2 > BLOB_CHUNK_LOG2_MAX)
    throw new Error('chunk_log2 fora do intervalo')
  const header = concat(utf8(BLOB_MAGIC), new Uint8Array([chunkLog2]), salt)
  const fileKey = hkdf(sk.blob, salt, HKDF_INFO.blobFile)
  const aad = aadBlob(userId, blobId, header)
  const cs = 2 ** chunkLog2
  const count = Math.max(1, Math.ceil(plaintext.length / cs))
  const parts: Uint8Array[] = [header]
  for (let i = 0; i < count; i++) {
    const chunk = plaintext.subarray(i * cs, Math.min(plaintext.length, (i + 1) * cs))
    parts.push(gcmEncrypt(fileKey, chunkNonce(i, i === count - 1), aad, chunk))
  }
  return concat(...parts)
}

export function decryptBlob(
  sk: Subkeys,
  userId: string,
  blobId: string,
  data: Uint8Array
): Uint8Array {
  if (data.length < BLOB_HEADER_LEN + 16) throw new Error('blob curto demais')
  const header = data.subarray(0, BLOB_HEADER_LEN)
  if (Buffer.from(header.subarray(0, 4)).toString('latin1') !== BLOB_MAGIC)
    throw new Error('magic inválido')
  const chunkLog2 = header[4]
  if (chunkLog2 < BLOB_CHUNK_LOG2_MIN || chunkLog2 > BLOB_CHUNK_LOG2_MAX)
    throw new Error('chunk_log2 fora do intervalo')
  const salt = header.subarray(5, 21)
  const fileKey = hkdf(sk.blob, salt, HKDF_INFO.blobFile)
  const aad = aadBlob(userId, blobId, header)
  const full = 2 ** chunkLog2 + 16
  const out: Uint8Array[] = []
  let off = BLOB_HEADER_LEN
  let i = 0
  for (;;) {
    const remaining = data.length - off
    const final = remaining <= full
    const len = final ? remaining : full
    if (len < 16) throw new Error('chunk truncado')
    out.push(gcmDecrypt(fileKey, chunkNonce(i, final), aad, data.subarray(off, off + len)))
    off += len
    i++
    if (final) break
  }
  return concat(...out)
}

// ---------------- setup de chaves (usado pela troca de senha / nova chave) ----------------

/** Nova wrap da senha (salt novo + Argon2id com os parâmetros padrão). */
export async function newPasswordWrap(
  userId: string,
  dek: Uint8Array,
  password: string,
  kdf: KdfParams = ARGON2_DEFAULT
): Promise<{ kdf: KdfParams; salt: string; wrap: Wrap }> {
  const salt = randomBytesU8(16)
  const kek = await passwordKek(password, salt, kdf)
  return { kdf, salt: b64u(salt), wrap: wrapDek(kek, dek, aadWrap(userId, 'password')) }
}

/** Nova chave de recuperação (entropia nova + wrap). */
export function newRecoveryWrap(
  userId: string,
  dek: Uint8Array
): { formatted: string; recovery: { kdf: { alg: 'hkdf-sha256' }; salt: string; wrap: Wrap } } {
  const entropy = randomBytesU8(20)
  const salt = randomBytesU8(16)
  const kek = recoveryKek(entropy, salt)
  return {
    formatted: formatRecoveryKey(entropy),
    recovery: {
      kdf: { alg: 'hkdf-sha256' },
      salt: b64u(salt),
      wrap: wrapDek(kek, dek, aadWrap(userId, 'recovery'))
    }
  }
}
