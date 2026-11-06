// ClearChat — protocolo de sync v1 — IMPLEMENTAÇÃO DE REFERÊNCIA + gerador de vetores de teste.
//
// ⚠️  Este arquivo é IDÊNTICO nos dois repositórios (ClearChat app ↔ ClearChatWebsite). Qualquer
//     mudança aqui é mudança de protocolo: altere os DOIS repositórios, regenere os vetores nos dois
//     e suba a versão do protocolo em docs/SYNC_PROTOCOL.md.
//
// Uso (Node ≥ 22.18, que roda TypeScript direto removendo os tipos):
//   cd docs/test-vectors && npm install && node generate.ts          # (re)gera os *.json
//   cd docs/test-vectors && node generate.ts --check                 # confere os *.json (CI)
//
// Só usa: hash-wasm (Argon2id — a MESMA biblioteca em todos os clientes TS: Electron, navegador,
// mobile) + node:crypto (AES-256-GCM, HKDF-SHA256, HMAC-SHA256, SHA-256 — equivalentes ao WebCrypto)
// + node:zlib (deflate-raw). Sem enums/namespaces (type stripping).
//
// Tudo aqui está especificado em docs/SYNC_PROTOCOL.md → "Criptografia". Os nonces/salts/DEK fixos
// abaixo são SÓ para os vetores — em produção são SEMPRE aleatórios (CSPRNG).

import { argon2id } from 'hash-wasm'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  timingSafeEqual
} from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ============================================================================================
// Constantes do protocolo (SYNC_PROTOCOL.md → "Criptografia")
// ============================================================================================

export const PROTOCOL_VERSION = 1
export const ENVELOPE_VERSION = 1
export const KEY_VERSION = 1

/** Parâmetros Argon2id padrão para novas wraps (m em KiB). */
export const ARGON2_DEFAULT = { alg: 'argon2id', v: 19, m: 65536, t: 3, p: 1, len: 32 }
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
}

export const FRAME_RAW = 0x00
export const FRAME_DEFLATE = 0x01

export const BLOB_MAGIC = 'CCB1'
export const BLOB_HEADER_LEN = 21 // magic(4) + chunk_log2(1) + salt(16)
export const BLOB_CHUNK_LOG2_DEFAULT = 20 // 1 MiB
export const BLOB_CHUNK_LOG2_MIN = 10
export const BLOB_CHUNK_LOG2_MAX = 24

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

// ============================================================================================
// Codificações
// ============================================================================================

export const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
export const fromB64u = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url inválido (sem padding, sem + /)')
  return new Uint8Array(Buffer.from(s, 'base64url'))
}
export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex')
export const fromHex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'hex'))
export const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'))
const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts))

// ============================================================================================
// Primitivas
// ============================================================================================

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest())
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest())
}

/** HKDF-SHA256 (RFC 5869). `salt` vazio = HashLen zeros (como no WebCrypto com salt de 0 bytes). */
export function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, len = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(info), len))
}

/** AES-256-GCM, tag de 16 bytes anexada ao fim (= saída do WebCrypto `encrypt`). */
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

// ============================================================================================
// KDF da senha (Argon2id via hash-wasm) e chave de recuperação
// ============================================================================================

export interface KdfParams {
  alg: string
  v: number
  m: number
  t: number
  p: number
  len: number
}

/** Valida parâmetros vindos do servidor. `allowTest` só nos vetores de teste rápidos. */
export function checkKdfParams(k: KdfParams, allowTest = false): void {
  if (k.alg !== 'argon2id' || k.v !== 19 || k.len !== 32) throw new Error('kdf não suportado')
  if (allowTest) return
  const b = ARGON2_BOUNDS
  if (k.m < b.mMin || k.m > b.mMax || k.t < b.tMin || k.t > b.tMax || k.p < b.pMin || k.p > b.pMax)
    throw new Error('parâmetros Argon2id fora dos limites aceitos')
}

/** KEK da senha: Argon2id(NFC(senha) em UTF-8, salt de 16 bytes) → 32 bytes. */
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

/** Base32 Crockford (MSB primeiro) — usado só na chave de recuperação. */
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
    if (v < 0) throw new Error(`caractere inválido na chave de recuperação: ${ch}`)
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

/** 20 bits do SHA-256 da entropia → 4 caracteres base32. */
function recoveryChecksum(entropy: Uint8Array): string {
  const h = sha256(entropy)
  const v = (h[0] << 12) | (h[1] << 4) | (h[2] >>> 4) // 20 bits
  let out = ''
  for (let i = 3; i >= 0; i--) out += CROCKFORD[(v >>> (i * 5)) & 31]
  return out
}

/** 20 bytes de entropia → "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-CCCC" (36 chars + 8 hífens). */
export function formatRecoveryKey(entropy: Uint8Array): string {
  if (entropy.length !== 20) throw new Error('a chave de recuperação tem 20 bytes de entropia')
  const s = base32Encode(entropy) + recoveryChecksum(entropy)
  return s.match(/.{4}/g)!.join('-')
}

/** Aceita minúsculas, espaços/hífens em qualquer lugar e O→0, I→1, L→1. Lança se inválida. */
export function parseRecoveryKey(input: string): Uint8Array {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== 36) throw new Error('a chave de recuperação tem 36 caracteres (9 grupos de 4)')
  const entropy = base32Decode(s.slice(0, 32))
  if (entropy.length !== 20) throw new Error('chave de recuperação inválida')
  if (recoveryChecksum(entropy) !== s.slice(32))
    throw new Error('chave de recuperação incorreta (checksum)')
  return entropy
}

/** KEK da chave de recuperação: HKDF-SHA256(entropia, salt de 16 bytes guardado no servidor). */
export function recoveryKek(entropy: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(entropy, salt, HKDF_INFO.recoveryKek)
}

// ============================================================================================
// Hierarquia de chaves
// ============================================================================================

export interface Subkeys {
  record: Uint8Array
  blob: Uint8Array
  blobId: Uint8Array
  stream: Uint8Array
  recordId: Uint8Array
  keyVerify: Uint8Array
}

/** Subchaves derivadas da DEK (HKDF-SHA256, salt vazio). */
export function deriveSubkeys(dek: Uint8Array): Subkeys {
  if (dek.length !== 32) throw new Error('DEK precisa de 32 bytes')
  const empty = new Uint8Array(0)
  return {
    record: hkdf(dek, empty, HKDF_INFO.record),
    blob: hkdf(dek, empty, HKDF_INFO.blob),
    blobId: hkdf(dek, empty, HKDF_INFO.blobId),
    stream: hkdf(dek, empty, HKDF_INFO.stream),
    recordId: hkdf(dek, empty, HKDF_INFO.recordId),
    keyVerify: hkdf(dek, empty, HKDF_INFO.keyVerify)
  }
}

/** key_proof (enviado ao servidor em operações de chave) e verifier (guardado no servidor). */
export function keyProof(sk: Subkeys): { key_proof: string; verifier: string } {
  return { key_proof: b64u(sk.keyVerify), verifier: b64u(sha256(sk.keyVerify)) }
}

// ============================================================================================
// AADs (bytes EXATOS: UTF-8 da string, campos separados por "|")
// ============================================================================================

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

/** Comando remoto (dispositivo de controle → host). Sem epoch: comandos guardados offline podem ser
 *  entregues a um host diferente do que existia quando foram enviados. */
export const aadCommand = (userId: string, chatId: string, cmdId: string): Uint8Array =>
  utf8(`clearchat|v1|command|${userId}|${chatId}|${cmdId}`)

/** Resultado de um comando (host → dispositivo que enviou). */
export const aadCommandResult = (userId: string, chatId: string, cmdId: string): Uint8Array =>
  utf8(`clearchat|v1|command-result|${userId}|${chatId}|${cmdId}`)
export const aadPush = (userId: string, kind: string, tag: string): Uint8Array =>
  utf8(`clearchat|v1|push|${userId}|${kind}|${tag}`)
/** Anúncio de chat só ao vivo (§23.4, desde 1.8.0): host → servidor → outros dispositivos, com
 *  K_stream. Amarra o host, o chat, o epoch ao vivo e a revisão do anúncio. */
export const aadLiveAnnounce = (
  userId: string,
  hostDeviceId: string,
  chatId: string,
  epoch: number,
  arev: number
): Uint8Array =>
  utf8(`clearchat|v1|live-announce|${userId}|${hostDeviceId}|${chatId}|${epoch}|${arev}`)
/** K_push (§22.4): fora de deriveSubkeys para não mexer em keys.json. */
export const pushKey = (dek: Uint8Array): Uint8Array =>
  hkdf(dek, new Uint8Array(0), HKDF_INFO.push)

export const aadBlob = (userId: string, blobId: string, header: Uint8Array): Uint8Array =>
  concat(utf8(`clearchat|v1|blob|${userId}|${blobId}|`), header)

// ============================================================================================
// Wrap da DEK
// ============================================================================================

export interface Wrap {
  n: string
  c: string
}

export function wrapDek(
  kek: Uint8Array,
  dek: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array
): Wrap {
  return { n: b64u(nonce), c: b64u(gcmEncrypt(kek, nonce, aad, dek)) }
}

/** Falha de autenticação GCM = senha / chave de recuperação incorreta. */
export function unwrapDek(kek: Uint8Array, w: Wrap, aad: Uint8Array): Uint8Array {
  const dek = gcmDecrypt(kek, fromB64u(w.n), aad, fromB64u(w.c))
  if (dek.length !== 32) throw new Error('DEK inválida')
  return dek
}

// ============================================================================================
// Envelope (registros, eventos ao vivo, fila, controle)
// ============================================================================================

export interface Envelope {
  v: number
  k: number
  n: string
  c: string
}

/** Moldura do plaintext: 1 byte de formato + payload (JSON UTF-8 cru ou deflate-raw do JSON). */
export function frameJson(json: string, compress: boolean): Uint8Array {
  const body = utf8(json)
  return compress
    ? concat(new Uint8Array([FRAME_DEFLATE]), new Uint8Array(deflateRawSync(body, { level: 9 })))
    : concat(new Uint8Array([FRAME_RAW]), body)
}

export function unframeJson(frame: Uint8Array): unknown {
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
  return obj
}

export function seal(
  key: Uint8Array,
  aad: Uint8Array,
  frame: Uint8Array,
  nonce: Uint8Array
): Envelope {
  return {
    v: ENVELOPE_VERSION,
    k: KEY_VERSION,
    n: b64u(nonce),
    c: b64u(gcmEncrypt(key, nonce, aad, frame))
  }
}

export function open(key: Uint8Array, aad: Uint8Array, env: Envelope): Uint8Array {
  if (env.v !== ENVELOPE_VERSION) throw new Error('versão de envelope não suportada')
  if (env.k !== KEY_VERSION) throw new Error('versão de chave desconhecida')
  const n = fromB64u(env.n)
  if (n.length !== 12) throw new Error('nonce inválido')
  return gcmDecrypt(key, n, aad, fromB64u(env.c))
}

// ============================================================================================
// IDs derivados
// ============================================================================================

/** blob_id = hex(HMAC-SHA256(K_blob_id, SHA-256(plaintext))) — 64 hex minúsculos. */
export function blobIdFromSha256(sk: Subkeys, plaintextSha256: Uint8Array): string {
  return hex(hmacSha256(sk.blobId, plaintextSha256))
}

/** id do registro `skill`: "sk_" + 32 hex de HMAC-SHA256(K_record_id, "skill|" + nome). */
export function skillRecordId(sk: Subkeys, name: string): string {
  return 'sk_' + hex(hmacSha256(sk.recordId, utf8('skill|' + name))).slice(0, 32)
}

// ============================================================================================
// Blobs (anexos e bundles de skill) — formato CCB1 em chunks
// ============================================================================================

function chunkNonce(index: number, final: boolean): Uint8Array {
  const n = new Uint8Array(12)
  // índice big-endian nos bytes 0..10 (usamos os 6 de baixo — mais que suficiente)
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
  salt: Uint8Array,
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

// ============================================================================================
// Vetores
// ============================================================================================

const HERE = dirname(fileURLToPath(import.meta.url))

// Entradas fixas (SÓ para vetores)
const USER_ID = '6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b'
const PASSWORD_NFC = 'correct horse battery staple — ação ✓'
const PASSWORD_NFD = PASSWORD_NFC.normalize('NFD')
const PW_SALT = fromHex('000102030405060708090a0b0c0d0e0f')
const DEK = fromHex('a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00')
const RK_ENTROPY = fromHex('00112233445566778899aabbccddeeff01234567')
const RK_SALT = fromHex('f0e1d2c3b4a5968778695a4b3c2d1e0f')
const NONCE = (b: number): Uint8Array => new Uint8Array(12).fill(b)
const CHAT_ID = '3d6f0a52-7c1e-4b8a-9f2d-0e4c5b6a7d8e'

async function buildVectors(): Promise<Record<string, unknown>> {
  const header = {
    protocol_version: PROTOCOL_VERSION,
    note: 'Gerado por docs/test-vectors/generate.ts. Binários: hex (minúsculo) quando o campo termina em _hex; base64url sem padding nos demais. Nonces/salts/DEK fixos SÓ para teste.'
  }

  // ---------------- kdf ----------------
  const testParams = { alg: 'argon2id', v: 19, m: 1024, t: 1, p: 1, len: 32 }
  const kekProd = await passwordKek(PASSWORD_NFC, PW_SALT, ARGON2_DEFAULT)
  const kekProdNfd = await passwordKek(PASSWORD_NFD, PW_SALT, ARGON2_DEFAULT)
  if (hex(kekProd) !== hex(kekProdNfd)) throw new Error('NFC falhou')
  const kekTest = await passwordKek(PASSWORD_NFC, PW_SALT, testParams, true)
  const kdf = {
    ...header,
    description:
      'KEK da senha = Argon2id(UTF-8(NFC(senha)), salt) com hash-wasm. NFD na entrada deve dar o MESMO resultado.',
    cases: [
      {
        name: 'production-params',
        password: PASSWORD_NFC,
        password_nfd_utf8_hex: hex(utf8(PASSWORD_NFD)),
        password_nfc_utf8_hex: hex(utf8(PASSWORD_NFC)),
        salt: b64u(PW_SALT),
        kdf: ARGON2_DEFAULT,
        kek_hex: hex(kekProd)
      },
      {
        name: 'fast-test-params (NUNCA aceitar do servidor: fora de ARGON2_BOUNDS)',
        password: PASSWORD_NFC,
        salt: b64u(PW_SALT),
        kdf: testParams,
        kek_hex: hex(kekTest)
      }
    ],
    bounds: ARGON2_BOUNDS
  }

  // ---------------- recovery ----------------
  const rkFormatted = formatRecoveryKey(RK_ENTROPY)
  const rkKek = recoveryKek(RK_ENTROPY, RK_SALT)
  const messy = rkFormatted.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
  if (hex(parseRecoveryKey(messy)) !== hex(RK_ENTROPY)) throw new Error('parse da chave falhou')
  const badChecksum = rkFormatted.slice(0, -1) + (rkFormatted.endsWith('0') ? '2' : '0')
  let badRejected = false
  try {
    parseRecoveryKey(badChecksum)
  } catch {
    badRejected = true
  }
  if (!badRejected) throw new Error('checksum ruim aceito')
  const recovery = {
    ...header,
    description:
      'Chave de recuperação: 20 bytes aleatórios → base32 Crockford (32 chars) + checksum (4 chars = 20 primeiros bits de SHA-256(entropia)), 9 grupos de 4 com hífen. KEK = HKDF-SHA256(entropia, salt_recuperação, "clearchat/v1/recovery-kek").',
    entropy_hex: hex(RK_ENTROPY),
    formatted: rkFormatted,
    parse_accepts: [rkFormatted, messy],
    parse_rejects: [badChecksum, rkFormatted.slice(0, -5)],
    salt: b64u(RK_SALT),
    kek_hex: hex(rkKek)
  }

  // ---------------- keys ----------------
  const sk = deriveSubkeys(DEK)
  const proof = keyProof(sk)
  const wrapPw = wrapDek(kekProd, DEK, aadWrap(USER_ID, 'password'), NONCE(0x11))
  const wrapRk = wrapDek(rkKek, DEK, aadWrap(USER_ID, 'recovery'), NONCE(0x22))
  if (hex(unwrapDek(kekProd, wrapPw, aadWrap(USER_ID, 'password'))) !== hex(DEK))
    throw new Error('unwrap')
  const keys = {
    ...header,
    description:
      'Subchaves = HKDF-SHA256(DEK, salt vazio, info). Wraps = AES-256-GCM(KEK, nonce, AAD, DEK).',
    user_id: USER_ID,
    dek_hex: hex(DEK),
    subkeys: {
      [HKDF_INFO.record]: hex(sk.record),
      [HKDF_INFO.blob]: hex(sk.blob),
      [HKDF_INFO.blobId]: hex(sk.blobId),
      [HKDF_INFO.stream]: hex(sk.stream),
      [HKDF_INFO.recordId]: hex(sk.recordId),
      [HKDF_INFO.keyVerify]: hex(sk.keyVerify)
    },
    key_proof: proof.key_proof,
    verifier: proof.verifier,
    wraps: [
      {
        slot: 'password',
        kek_hex: hex(kekProd),
        aad_utf8: `clearchat|v1|dek-wrap|${USER_ID}|password|1`,
        nonce_hex: hex(NONCE(0x11)),
        wrap: wrapPw
      },
      {
        slot: 'recovery',
        kek_hex: hex(rkKek),
        aad_utf8: `clearchat|v1|dek-wrap|${USER_ID}|recovery|1`,
        nonce_hex: hex(NONCE(0x22)),
        wrap: wrapRk
      }
    ]
  }

  // ---------------- records ----------------
  const providerJson = JSON.stringify({
    sv: 1,
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-v1-0000000000000000',
    headers: {},
    createdAt: 1760000000000
  })
  const settingJson = JSON.stringify({ sv: 1, value: { commands: 'lists', search: 'always' } })
  const messageJson = JSON.stringify({
    sv: 1,
    sessionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    seq: 7,
    message: {
      role: 'assistant',
      content: 'Olá! '.repeat(40) + 'Posso ajudar com o parser de SSE.',
      reasoning: 'O usuário cumprimentou.'
    },
    meta: {
      model: 'anthropic/claude-sonnet-4.5',
      usage: { promptTokens: 1200, completionTokens: 210 }
    },
    createdAt: 1760000123456
  })
  const recCases = [
    {
      name: 'provider-raw',
      type: 'provider',
      id: '0b9f6a1e-2c3d-4e5f-9a8b-7c6d5e4f3a2b',
      scope: null,
      rev: 1,
      json: providerJson,
      compress: false,
      nonce: NONCE(0x33)
    },
    {
      name: 'setting-raw',
      type: 'setting',
      id: 'approvalModes',
      scope: null,
      rev: 12,
      json: settingJson,
      compress: false,
      nonce: NONCE(0x44)
    },
    {
      name: 'message-deflate',
      type: 'message',
      id: 'c4d5e6f7-0819-4a2b-8c3d-4e5f60718293',
      scope: CHAT_ID,
      rev: 3,
      json: messageJson,
      compress: true,
      nonce: NONCE(0x55)
    }
  ]
  const records = {
    ...header,
    description:
      'Envelope de registro. frame = byte de formato (0x00 JSON cru | 0x01 deflate-raw) + payload. Para testar CIFRAGEM use frame_hex (o deflate de outra biblioteca pode diferir); para DECIFRAGEM confira que open(envelope) == frame_hex e unframe == json.',
    user_id: USER_ID,
    record_key_hex: hex(sk.record),
    cases: recCases.map((c) => {
      const aad = aadRecord(USER_ID, c.type, c.id, c.scope, c.rev)
      const frame = frameJson(c.json, c.compress)
      const env = seal(sk.record, aad, frame, c.nonce)
      const back = open(sk.record, aad, env)
      if (JSON.stringify(unframeJson(back)) !== c.json) throw new Error('roundtrip ' + c.name)
      return {
        name: c.name,
        type: c.type,
        id: c.id,
        scope: c.scope,
        rev: c.rev,
        aad_utf8: new TextDecoder().decode(aad),
        json: c.json,
        frame_hex: hex(frame),
        nonce_hex: hex(c.nonce),
        envelope: env,
        ciphertext_size: fromB64u(env.c).length
      }
    }),
    must_fail: [] as unknown[]
  }
  // casos negativos: mesma envelope do provider com AAD trocada / bit trocado
  {
    const c = records.cases[0] as { envelope: Envelope; id: string; type: string }
    const tries: { name: string; aad: string; env: Envelope }[] = [
      {
        name: 'rev diferente (2)',
        aad: `clearchat|v1|record|${USER_ID}|provider|${c.id}||2`,
        env: c.envelope
      },
      {
        name: 'tipo diferente (preset)',
        aad: `clearchat|v1|record|${USER_ID}|preset|${c.id}||1`,
        env: c.envelope
      },
      {
        name: 'outro usuário',
        aad: `clearchat|v1|record|00000000-0000-4000-8000-000000000000|provider|${c.id}||1`,
        env: c.envelope
      },
      {
        name: 'ciphertext com 1 bit trocado',
        aad: `clearchat|v1|record|${USER_ID}|provider|${c.id}||1`,
        env: (() => {
          const ct = fromB64u(c.envelope.c)
          ct[0] ^= 1
          return { ...c.envelope, c: b64u(ct) }
        })()
      }
    ]
    for (const t of tries) {
      let failed = false
      try {
        open(sk.record, utf8(t.aad), t.env)
      } catch {
        failed = true
      }
      if (!failed) throw new Error('caso negativo decifrou: ' + t.name)
      records.must_fail.push({ name: t.name, aad_utf8: t.aad, envelope: t.env })
    }
  }

  // ---------------- blobs ----------------
  const pattern = (len: number): Uint8Array => {
    const b = new Uint8Array(len)
    for (let i = 0; i < len; i++) b[i] = (i * 7 + 3) % 256
    return b
  }
  const blobCases = [
    {
      name: '3-chunks (1 KiB, último parcial)',
      pt: pattern(2500),
      log2: 10,
      salt: fromHex('101112131415161718191a1b1c1d1e1f')
    },
    {
      name: '2-chunks exatos (último cheio = final)',
      pt: pattern(2048),
      log2: 10,
      salt: fromHex('202122232425262728292a2b2c2d2e2f')
    },
    {
      name: 'vazio (1 chunk final vazio)',
      pt: new Uint8Array(0),
      log2: 20,
      salt: fromHex('303132333435363738393a3b3c3d3e3f')
    }
  ]
  const blobs = {
    ...header,
    description:
      'Blob CCB1: header = "CCB1" + chunk_log2 (1 byte) + salt (16) ; chave do arquivo = HKDF-SHA256(K_blob, salt, "clearchat/v1/blob-file") ; AAD = UTF-8("clearchat|v1|blob|<user_id>|<blob_id>|") || header ; nonce do chunk i = i em big-endian (11 bytes) || flag_final (1 byte). blob_id = hex(HMAC-SHA256(K_blob_id, SHA-256(plaintext))).',
    user_id: USER_ID,
    blob_key_hex: hex(sk.blob),
    blob_id_key_hex: hex(sk.blobId),
    cases: blobCases.map((c) => {
      const ptSha = sha256(c.pt)
      const blobId = blobIdFromSha256(sk, ptSha)
      const ct = encryptBlob(sk, USER_ID, blobId, c.pt, c.salt, c.log2)
      if (hex(decryptBlob(sk, USER_ID, blobId, ct)) !== hex(c.pt))
        throw new Error('blob roundtrip ' + c.name)
      return {
        name: c.name,
        plaintext_rule: c.pt.length ? 'byte[i] = (i*7 + 3) % 256' : 'vazio',
        plaintext_len: c.pt.length,
        plaintext_sha256_hex: hex(ptSha),
        blob_id: blobId,
        chunk_log2: c.log2,
        salt_hex: hex(c.salt),
        file_key_hex: hex(hkdf(sk.blob, c.salt, HKDF_INFO.blobFile)),
        ciphertext_len: ct.length,
        ciphertext_sha256_hex: hex(sha256(ct)),
        ciphertext_hex: hex(ct)
      }
    })
  }

  // ---------------- realtime (stream / comandos remotos) ----------------
  const epoch = 42
  const streamJson = JSON.stringify({
    sv: 1,
    kind: 'draft.delta',
    sessionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    streamId: 'f00dbabe-0000-4000-8000-000000000001',
    off: { content: 120, reasoning: 0 },
    append: { content: ' mundo' }
  })
  const commandJson = JSON.stringify({
    sv: 1,
    kind: 'send',
    sessionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    text: 'E agora rode os testes, por favor.',
    attachments: [],
    skills: [],
    createdAt: 1760000200000
  })
  const resultJson = JSON.stringify({ sv: 1, status: 'accepted', queued: true })
  const rt = [
    {
      name: 'stream',
      aad: aadStream(USER_ID, CHAT_ID, epoch, 17),
      json: streamJson,
      nonce: NONCE(0x66)
    },
    {
      name: 'command',
      aad: aadCommand(USER_ID, CHAT_ID, 'cmd-7f3a'),
      json: commandJson,
      nonce: NONCE(0x77)
    },
    {
      name: 'command-result',
      aad: aadCommandResult(USER_ID, CHAT_ID, 'cmd-7f3a'),
      json: resultJson,
      nonce: NONCE(0x88)
    }
  ]
  const realtime = {
    ...header,
    description:
      'Eventos ao vivo (stream), comandos remotos e resultados de comandos: mesmo envelope dos registros, com K_stream.',
    user_id: USER_ID,
    stream_key_hex: hex(sk.stream),
    cases: rt.map((c) => {
      const frame = frameJson(c.json, false)
      const env = seal(sk.stream, c.aad, frame, c.nonce)
      return {
        name: c.name,
        aad_utf8: new TextDecoder().decode(c.aad),
        json: c.json,
        frame_hex: hex(frame),
        nonce_hex: hex(c.nonce),
        envelope: env
      }
    })
  }

  // ---------------- push (notificações, §22) ----------------
  const kPush = pushKey(DEK)
  const pushCases = [
    {
      name: 'approval',
      kind: 'approval',
      tag: '5f0c1e2d3a4b5c6d7e8f901a2b3c4d5e',
      json: JSON.stringify({
        sv: 1,
        kind: 'approval',
        chatId: CHAT_ID,
        sessionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        chatTitle: 'Refatorar login',
        text: 'Executar: npm test',
        requestId: 'req-31c2',
        hostName: 'Desktop de casa',
        ts: 1760000300000
      }),
      nonce: NONCE(0x99)
    },
    {
      name: 'reply',
      kind: 'reply',
      tag: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      json: JSON.stringify({
        sv: 1,
        kind: 'reply',
        chatId: CHAT_ID,
        sessionId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        chatTitle: 'Refatorar login',
        text: 'Pronto, alterei os 3 arquivos e os testes passaram.',
        hostName: 'Desktop de casa',
        ts: 1760000400000
      }),
      nonce: NONCE(0xaa)
    }
  ]
  const push = {
    ...header,
    description:
      'Notificações push (§22): envelope dos registros com K_push = HKDF(DEK, info "clearchat/v1/push"); AAD amarra usuário, kind e tag.',
    user_id: USER_ID,
    push_key_hex: hex(kPush),
    cases: pushCases.map((c) => {
      const aad = aadPush(USER_ID, c.kind, c.tag)
      const frame = frameJson(c.json, false)
      const env = seal(kPush, aad, frame, c.nonce)
      return {
        name: c.name,
        kind: c.kind,
        tag: c.tag,
        aad_utf8: new TextDecoder().decode(aad),
        json: c.json,
        frame_hex: hex(frame),
        nonce_hex: hex(c.nonce),
        envelope: env
      }
    })
  }

  // ---------------- chats só ao vivo (§23, desde 1.8.0) ----------------
  // Anúncio: contexto novo (live-announce). Histórico e atualizações: os contextos de comando,
  // resultado e stream que já existem, com os payloads novos (history.list, rec).
  const HOST_DEVICE_ID = '8c2e4f6a-1b3d-4e5f-9a7b-0c1d2e3f4a5b'
  const OTHER_DEVICE_ID = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5c'
  const LIVE_CHAT_ID = '5a1e9c3b-2d4f-4e6a-8b7c-9d0e1f2a3b4c'
  const LIVE_EPOCH = 1793923200000
  const LIVE_SESSION_ID = '7c6b5a49-3827-4615-a4b3-c2d1e0f9a8b7'
  const announceJson = JSON.stringify({
    sv: 1,
    chatId: LIVE_CHAT_ID,
    title: 'Plano da viagem',
    persona: { id: 'preset-default', name: 'Padrão', icon: 'sparkles' },
    model: {
      providerId: '0b9f6a1e-2c3d-4e5f-9a8b-7c6d5e4f3a2b',
      providerName: 'OpenRouter',
      model: 'anthropic/claude-sonnet-4.5'
    },
    status: 'waiting',
    pending: { approvals: 1, questions: 0, retries: 0 },
    usesLocalTools: true,
    hostCwd: '/home/ana/viagem',
    createdAt: 1793920000000,
    updatedAt: 1793923260000,
    messageCount: 14
  })
  const historyCmdJson = JSON.stringify({
    sv: 1,
    chatId: LIVE_CHAT_ID,
    type: 'message',
    sessionId: LIVE_SESSION_ID,
    after: null,
    limit: 200
  })
  const historyResultJson = JSON.stringify({
    sv: 1,
    status: 'accepted',
    epoch: LIVE_EPOCH,
    lseq: 3,
    items: [
      {
        type: 'message',
        id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        lseq: 0,
        data: {
          sv: 1,
          sessionId: LIVE_SESSION_ID,
          seq: 1,
          message: { role: 'user', content: 'Monte um roteiro de 3 dias em Lisboa.' },
          meta: {},
          createdAt: 1793920005000,
          parentId: null
        }
      },
      { type: 'message', id: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f', lseq: 2, large: 300000 }
    ],
    next: 'm:2:c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f'
  })
  const recJson = JSON.stringify({
    sv: 1,
    kind: 'rec',
    lseq: 4,
    items: [
      {
        type: 'message',
        id: 'd3e4f5a6-b7c8-4d9e-8f1a-2b3c4d5e6f70',
        lseq: 4,
        data: {
          sv: 1,
          sessionId: LIVE_SESSION_ID,
          seq: 3,
          message: { role: 'assistant', content: 'Dia 1: Alfama e Castelo de São Jorge…' },
          meta: {},
          createdAt: 1793923260000,
          parentId: 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f'
        }
      },
      { type: 'message', id: 'e4f5a6b7-c8d9-4e0f-9a2b-3c4d5e6f7081', lseq: 4, deleted: true }
    ]
  })
  const liveCases = [
    {
      name: 'live-announce',
      aad: aadLiveAnnounce(USER_ID, HOST_DEVICE_ID, LIVE_CHAT_ID, LIVE_EPOCH, 3),
      json: announceJson,
      nonce: NONCE(0xbb)
    },
    {
      name: 'history.list (comando)',
      aad: aadCommand(USER_ID, LIVE_CHAT_ID, 'cmd-h1'),
      json: historyCmdJson,
      nonce: NONCE(0xcc)
    },
    {
      name: 'history.list (resultado)',
      aad: aadCommandResult(USER_ID, LIVE_CHAT_ID, 'cmd-h1'),
      json: historyResultJson,
      nonce: NONCE(0xdd)
    },
    {
      name: 'rec (stream)',
      aad: aadStream(USER_ID, LIVE_CHAT_ID, LIVE_EPOCH, 9),
      json: recJson,
      nonce: NONCE(0xee)
    },
    {
      name: 'attach.put (comando, pedaço único)',
      aad: aadCommand(USER_ID, LIVE_CHAT_ID, 'cmd-a1'),
      json: JSON.stringify({
        sv: 1,
        chatId: LIVE_CHAT_ID,
        uploadId: '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901',
        name: 'hello.txt',
        mime: 'text/plain',
        size: 6,
        sha256: hex(sha256(utf8('hello\n'))),
        offset: 0,
        data: Buffer.from('hello\n').toString('base64')
      }),
      nonce: NONCE(0xf1)
    },
    {
      name: 'attach.put (resultado, done)',
      aad: aadCommandResult(USER_ID, LIVE_CHAT_ID, 'cmd-a1'),
      json: JSON.stringify({
        sv: 1,
        status: 'accepted',
        received: 6,
        done: true,
        attachment: {
          name: 'hello.txt',
          mime: 'text/plain',
          size: 6,
          kind: 'text',
          file: hex(sha256(utf8('hello\n'))) + '.txt',
          sha256: hex(sha256(utf8('hello\n')))
        }
      }),
      nonce: NONCE(0xf2)
    }
  ]
  const liveSealed = liveCases.map((c) => {
    const frame = frameJson(c.json, false)
    return { c, frame, env: seal(sk.stream, c.aad, frame, c.nonce) }
  })
  const announceEnv = liveSealed[0].env
  const liveMustFail = [
    {
      name: 'anúncio atribuído a outro host',
      aad: aadLiveAnnounce(USER_ID, OTHER_DEVICE_ID, LIVE_CHAT_ID, LIVE_EPOCH, 3)
    },
    {
      name: 'anúncio com revisão trocada',
      aad: aadLiveAnnounce(USER_ID, HOST_DEVICE_ID, LIVE_CHAT_ID, LIVE_EPOCH, 4)
    },
    {
      name: 'anúncio aberto como evento do stream',
      aad: aadStream(USER_ID, LIVE_CHAT_ID, LIVE_EPOCH, 3)
    }
  ]
  for (const f of liveMustFail) {
    let opened = false
    try {
      open(sk.stream, f.aad, announceEnv)
      opened = true
    } catch {
      /* esperado */
    }
    if (opened) throw new Error(`live must_fail abriu: ${f.name}`)
  }
  const live = {
    ...header,
    description:
      'Chats só ao vivo (§23, desde 1.8.0): anúncio cifrado do host com K_stream e AAD live-announce (amarra usuário, host, chat, epoch ao vivo e revisão do anúncio); histórico sob demanda e atualizações pelos contextos de comando/resultado/stream que já existem.',
    user_id: USER_ID,
    host_device_id: HOST_DEVICE_ID,
    stream_key_hex: hex(sk.stream),
    cases: liveSealed.map(({ c, frame, env }) => ({
      name: c.name,
      aad_utf8: new TextDecoder().decode(c.aad),
      json: c.json,
      frame_hex: hex(frame),
      nonce_hex: hex(c.nonce),
      envelope: env
    })),
    must_fail: liveMustFail.map((f) => ({
      name: f.name,
      aad_utf8: new TextDecoder().decode(f.aad),
      envelope: announceEnv
    }))
  }

  // ---------------- ids ----------------
  const ids = {
    ...header,
    description:
      'IDs derivados por HMAC (o servidor não consegue correlacioná-los com nomes/arquivos conhecidos).',
    user_id: USER_ID,
    record_id_key_hex: hex(sk.recordId),
    skills: ['pdf-tools', 'Revisão de código', 'my_skill'].map((name) => ({
      name,
      hmac_input_utf8: 'skill|' + name,
      record_id: skillRecordId(sk, name)
    })),
    blobs: [
      {
        description: 'SHA-256 do arquivo "hello\\n" (o nome no store do app é <sha256>.<ext>)',
        plaintext_utf8: 'hello\n',
        plaintext_sha256_hex: hex(sha256(utf8('hello\n'))),
        blob_id: blobIdFromSha256(sk, sha256(utf8('hello\n')))
      }
    ]
  }

  return {
    'kdf.json': kdf,
    'recovery.json': recovery,
    'keys.json': keys,
    'records.json': records,
    'blobs.json': blobs,
    'realtime.json': realtime,
    'push.json': push,
    'live.json': live,
    'ids.json': ids
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const files = await buildVectors()
  let bad = 0
  for (const [name, data] of Object.entries(files)) {
    const text = JSON.stringify(data, null, 2) + '\n'
    const path = join(HERE, name)
    if (check) {
      let cur = ''
      try {
        cur = readFileSync(path, 'utf8')
      } catch {
        /* ausente */
      }
      const same =
        cur.length === text.length && timingSafeEqual(Buffer.from(cur), Buffer.from(text))
      console.log(`${same ? 'ok  ' : 'DIFF'} ${name}`)
      if (!same) bad++
    } else {
      writeFileSync(path, text)
      console.log(`escrito ${name}`)
    }
  }
  if (bad) {
    console.error(`${bad} arquivo(s) divergem da implementação de referência`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
