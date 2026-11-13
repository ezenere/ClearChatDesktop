# ClearChat Sync — Protocolo v1 (contrato)

> **Versão do protocolo: 1.10.0** · status: contrato inicial (ainda sem implementação) · data: 2026-11-12
>
> ⚠️ **AVISO — CONTRATO COMPARTILHADO ENTRE OS REPOSITÓRIOS**
> Fonte única: `docs/SYNC_PROTOCOL.md` e `docs/test-vectors/` do repositório pai `ezenere/ClearChat`.
> `ClearChatDesktop` (app Electron) e `ClearChatWebsite` (servidor FastAPI + site React) guardam cópias
> **idênticas** (`node scripts/protocol.mjs sync|check` no pai); `ClearChatMobile` (Expo) as vendora.
> Qualquer mudança no protocolo, na criptografia, nos esquemas dos registros, nos endpoints ou nas
> mensagens de WebSocket precisa ser implementada **em todos os clientes e no servidor** (vetores
> regenerados, versão do protocolo incrementada, changelog). Mudar um lado só **quebra o sync**.

**Servidor = qualquer instância.** O servidor oficial é `https://clear.ezenere.com`, mas qualquer pessoa
pode hospedar o seu (§20). Neste documento, **`<base>`** é a URL pública da instância escolhida
(`esquema://host[:porta][/caminho]`, sem `/` final — ex.: `https://clear.ezenere.com`,
`http://192.168.0.10:8080/clearchat`). Nada no protocolo depende do domínio oficial.

Convenções: "DEVE/NÃO DEVE" = obrigatório; "DEVERIA" = recomendado; "PODE" = opcional. Identificadores
em inglês; texto em pt-BR. Tempos do servidor em ISO 8601 UTC (`2026-10-19T12:00:00.000Z`); tempos do
app (`createdAt` etc. dentro dos registros cifrados) em ms Unix, como no app hoje.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [O que o servidor vê](#2-o-que-o-servidor-vê)
3. [Criptografia](#3-criptografia)
4. [Modelo de dados sincronizado](#4-modelo-de-dados-sincronizado)
5. [Contas, autenticação e dispositivos](#5-contas-autenticação-e-dispositivos)
6. [API REST](#6-api-rest)
7. [Sincronização de registros](#7-sincronização-de-registros)
8. [Host de execução (quem roda o chat)](#8-host-de-execução-quem-roda-o-chat)
9. [Divergência](#9-divergência)
10. [WebSocket](#10-websocket)
11. [Streaming ao vivo](#11-streaming-ao-vivo)
12. [Primeiro login num app com dados (merge)](#12-primeiro-login-num-app-com-dados-merge)
13. [Skills (sync opcional)](#13-skills-sync-opcional)
14. [Anexos (blobs)](#14-anexos-blobs)
15. [Captcha no app (Turnstile)](#15-captcha-no-app-turnstile)
16. [Diagramas de sequência](#16-diagramas-de-sequência)
17. [Limites, constantes e códigos de erro](#17-limites-constantes-e-códigos-de-erro)
18. [Versionamento](#18-versionamento)
19. [Notas de implementação do cliente (não normativo)](#19-notas-de-implementação-do-cliente-não-normativo)
20. [Instância, configurações da instância e self-host](#20-instância-configurações-da-instância-e-self-host)
21. [Fase futura (opcional): servidor como gateway de execução](#21-fase-futura-opcional-servidor-como-gateway-de-execução)
22. [Notificações push](#22-notificações-push-desde-170)
23. [Chats só ao vivo](#23-chats-só-ao-vivo-desde-180)

---

## 1. Visão geral

- **Zero-knowledge**: tudo que é dado do usuário é cifrado no cliente (AES-256-GCM) com chaves derivadas
  de uma **DEK** (data encryption key) aleatória de 256 bits. A DEK só existe no cliente; o servidor
  guarda a DEK **embrulhada** (wrap) pela senha de criptografia (Argon2id) e pela chave de recuperação.
- **Acesso ≠ decifragem**: entrar na conta é por e-mail + código de 6 dígitos (sessão por dispositivo,
  revogável). A **senha de criptografia** nunca sai do cliente e serve só para desembrulhar a DEK.
- **Servidor = armazém de registros cifrados + autenticação + relay em tempo real** (WebSocket).
- **Um registro por entidade** (provedor, persona, chat, sessão, mensagem, memória…), com `type`, `id`,
  `scope`, `rev` e `seq` em claro e o conteúdo num envelope cifrado.
- **Ordem = `seq` do servidor** (contador monotônico por usuário), nunca relógio de parede.
- **Host de execução por chat**: os turnos de um chat rodam num único dispositivo (o *host* — onde as
  tools de shell/arquivos agem). Os outros dispositivos online são *controles remotos*: enviam mensagens,
  respondem aprovações/questionários, param/forçam — tudo retransmitido (cifrado) ao host — e todos
  assistem ao vivo.
- **Divergência**: se duas histórias do mesmo chat forem produzidas sem uma ver a outra (ex.: execução
  offline), o chat fica *divergente* e o usuário escolhe qual versão vira a online; a outra é **descartada**
  (com aviso claro antes).

### Glossário

| Termo | Significado |
|---|---|
| **registro** (record) | Unidade de sync: `(type, id)` + metadados em claro + envelope cifrado. |
| **`seq`** | Número atribuído pelo servidor a cada mudança de registro; monotônico **por usuário**, sem buracos entre commits. |
| **`rev`** | Revisão do registro (1, 2, 3…). Proposta pelo cliente (`base_rev + 1`), conferida pelo servidor; entra na AAD. |
| **cursor** | Maior `seq` que o cliente já aplicou. |
| **tombstone** | Registro marcado `deleted: true` (sem envelope). |
| **escopo** (`scope`) | Id do "contêiner" do registro, em claro: o chat (para `chat`, `session`, `message`) ou a coleção (para `memory`). |
| **conteúdo do chat** | Registros `session` e `message` de um chat. Só escritos sob as regras de host/replay (§8). |
| **`head`** de um chat | `seq` da última mudança aceita de conteúdo daquele chat (servidor). |
| **host** | Dispositivo que executa os turnos do chat. |
| **controle remoto** | Qualquer outro dispositivo online do usuário com o chat aberto. |
| **janela de escrita** | Intervalo `host.begin` … `host.end` em que o host está rodando um turno/edição e pode gravar conteúdo. |
| **`epoch`** | Contador por chat incrementado a cada troca de host. |
| **comando remoto** | Mensagem cifrada controle remoto → host (enviar mensagem, aprovar, parar…). |
| **outbox** | Fila local do cliente de mudanças ainda não aceitas pelo servidor. |

---

## 2. O que o servidor vê

| Visível em claro | Por quê |
|---|---|
| e-mail, nome da conta | login por código; exibição |
| dispositivos: nome, plataforma, tipo de cliente, versão do app, IP/último acesso | lista/revogação de dispositivos; "Executando em <dispositivo>" |
| `type`, `id`, `scope`, `rev`, `seq`, `deleted`, tamanho do ciphertext, timestamps do servidor, dispositivo que escreveu | sync, cascatas, cotas |
| ids dos blobs referenciados por cada registro (`blobs`) e tamanho dos blobs | GC de blobs e cotas |
| estado de host por chat (dispositivo host, epoch, rodando/ocioso, fixado, troca pendente, divergente) | coordenação de execução |
| tipo de cada comando remoto (`send`, `stop`, `fs.read`…), quem enviou e o tamanho do envelope | roteamento ao host e logs de uso |
| parâmetros do KDF, salts, DEK embrulhada, `verifier` (SHA-256 de uma subchave) | desbloqueio; prova de posse |
| notificações push (desde 1.7.0): token de push de cada celular, tipo do aviso, tag aleatória, destinos, horário e tamanho; no aviso "host caiu", o chat e o nome do dispositivo; desde 1.8.0, também o id do dispositivo que enviou cada aviso e o do host no "host caiu" | entrega pelo FCM (§22) — o conteúdo vai cifrado |
| chats só ao vivo (desde 1.8.0), **só em memória** enquanto o host está conectado: ids dos chats ao vivo de cada host, `epoch` ao vivo, revisão e horário de cada anúncio, rodando/ocioso, tamanho dos anúncios, `kind`/tamanho dos comandos `history.*` e `attach.*` (dá para estimar o tamanho do histórico lido e dos anexos enviados/baixados) e dos eventos do stream; numa conversão online → ao vivo, o tombstone do `chat` (como qualquer exclusão) e que o mesmo id passou a ser anunciado | roteamento ao host e lista nos outros dispositivos (§23) — título, mensagens e todo o resto vão cifrados; nada disso é gravado |

Tudo o mais — conteúdo de mensagens, títulos, configs, chaves de API, nomes de skills, nomes de arquivos,
memórias — é cifrado. Ids de registros são UUIDs aleatórios gerados pelo app (não revelam nada), exceto
os ids fixos de `setting` (nomes públicos das configurações) e os ids de `skill`/blob, que são HMACs
(o servidor não consegue correlacioná-los com nomes/arquivos conhecidos). O agrupamento por `scope`
(quais mensagens pertencem ao mesmo chat) é um vazamento aceito: é necessário para o host e para
cascatas. Chats só ao vivo (§23) não têm registro nenhum: o servidor só os conhece pelo que passa em
memória (linha acima).

---

## 3. Criptografia

Implementação de referência: **`docs/test-vectors/generate.ts`** (TypeScript, Node ≥ 22.18). Vetores:
`docs/test-vectors/*.json`. Todo cliente DEVE passar em todos os vetores byte a byte; o servidor (Python)
nunca decifra, mas PODE usar os vetores para validar o formato dos envelopes.

### 3.1 Primitivas e bibliotecas

| Uso | Algoritmo | Biblioteca |
|---|---|---|
| Senha → KEK | Argon2id v1.3 (0x13) | **hash-wasm 4.12.0** em TODOS os clientes TS (Electron main ou renderer, navegador, mobile/RN) — mesma saída em toda plataforma |
| Cifra simétrica | AES-256-GCM, nonce 12 bytes, tag 16 bytes (anexada ao fim) | WebCrypto (`crypto.subtle`) ou `node:crypto` |
| Derivação de subchaves | HKDF-SHA256 (RFC 5869) | WebCrypto / `node:crypto.hkdfSync` |
| IDs derivados, checksum | HMAC-SHA256, SHA-256 | WebCrypto / `node:crypto` |
| Compressão opcional | DEFLATE cru (RFC 1951, "deflate-raw") | `CompressionStream('deflate-raw')`, `node:zlib`, pako |
| Aleatoriedade | CSPRNG | `crypto.getRandomValues` / `crypto.randomBytes` |

A página web que roda hash-wasm precisa de `'wasm-unsafe-eval'` em `script-src` na CSP.

### 3.2 Codificações

- Binário em JSON: **base64url sem padding** (RFC 4648 §5) — salvo campos com sufixo `_hex` e os ids de
  blob (64 hex minúsculos).
- Texto: UTF-8 sem BOM. JSON: RFC 8259; a ordem das chaves não importa (os vetores fixam bytes exatos
  via `frame_hex`).
- `user_id`: UUID minúsculo com hífens, atribuído pelo servidor.
- Ids de registro: `^[A-Za-z0-9._-]{1,128}$` (nunca contêm `|`). `type`: `^[a-z_]{1,32}$`.

### 3.3 Hierarquia de chaves

```
senha (NFC, UTF-8) ──Argon2id(salt_pw, m=64 MiB, t=3, p=1)──► KEK_pw ─┐
                                                                      ├─ AES-256-GCM wrap ─► DEK (32 bytes aleatórios)
chave de recuperação (160 bits) ──HKDF-SHA256(salt_rk)──► KEK_rk ─────┘
                                                                      │ HKDF-SHA256(DEK, salt vazio, info)
          ┌──────────────┬──────────────┬─────────────┬───────────────┼──────────────────┐
     K_record        K_blob         K_blob_id     K_stream        K_record_id       K_verify
  (registros)  (anexos/bundles)  (ids de blob)  (ao vivo,       (ids de skill)   (prova de posse:
                                                comandos)                         verifier = SHA-256)
```

### 3.4 Senha → KEK (Argon2id)

- Entrada: `UTF-8(NFC(senha))` — sem trim. Salt: 16 bytes aleatórios por usuário (trocado a cada troca
  de senha). Saída: 32 bytes.
- **Parâmetros padrão** (`kdf`): `{"alg":"argon2id","v":19,"m":65536,"t":3,"p":1,"len":32}`
  (m em KiB = 64 MiB).
- **Justificativa**: é a 2ª recomendação da RFC 9106 (64 MiB, t=3) com `p=1`, porque hash-wasm roda numa
  thread só — paralelismo > 1 só aumentaria o custo para o usuário, não para o atacante. Fica bem acima do
  mínimo da OWASP (19 MiB, t=2). 64 MiB cabe em celulares modernos e no navegador; custo medido ≈ 0,2–0,5 s
  no desktop (wasm), ≈ 1–2 s em celular médio. Os parâmetros ficam guardados junto da wrap, então podem
  subir no futuro sem quebrar contas antigas (o cliente regrava a wrap ao desbloquear).
- **Limites ao LER do servidor** (anti-DoS e anti-downgrade por servidor malicioso): `19456 ≤ m ≤ 1048576`,
  `2 ≤ t ≤ 10`, `1 ≤ p ≤ 4`, `alg = argon2id`, `v = 19`, `len = 32`. Fora disso → recusar e mostrar erro.
- Política de senha (cliente): ≥ 10 caracteres, diferente do e-mail; medidor de força recomendado.
- Senha errada ⇒ falha de autenticação GCM ao desembrulhar (não existe outro verificador).

### 3.5 Chave de recuperação

- 20 bytes aleatórios (160 bits). Formato exibido: **9 grupos de 4** caracteres base32 Crockford
  (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, bits MSB primeiro) separados por hífen: 32 caracteres da entropia
  + 4 de checksum (os 20 primeiros bits de `SHA-256(entropia)`). Ex. (vetor): `008J-4CT4-ANK7-F24S-NAXW-SQFE-ZW0J-6HB7-5CDY`.
- Leitura tolerante: maiúsculas/minúsculas, espaços e hífens em qualquer lugar, `O→0`, `I→1`, `L→1`;
  checksum errado → "chave de recuperação incorreta" (detecta erro de digitação antes de qualquer rede).
- `KEK_rk = HKDF-SHA256(ikm = entropia, salt = salt_rk (16 bytes aleatórios, guardado no servidor), info = "clearchat/v1/recovery-kek", L = 32)`.
  Sem Argon2: 160 bits aleatórios não são atacáveis por força bruta.
- Gerada **uma vez** no cadastro (no navegador), mostrada uma vez com "Copiar" / "Baixar .txt" e
  confirmação ("digite os 4 últimos caracteres"). PODE ser regenerada depois (nova entropia + nova wrap).

### 3.6 Wrap da DEK

```
wrap = AES-256-GCM(key = KEK, nonce = 12 bytes aleatórios, aad = AAD_wrap, plaintext = DEK)  → {"n": b64u(nonce), "c": b64u(ct‖tag)}  (c = 48 bytes)
AAD_wrap = UTF-8("clearchat|v1|dek-wrap|" + user_id + "|" + slot + "|" + key_version)     slot ∈ {password, recovery}; key_version = 1
```

### 3.7 Subchaves

`K_x = HKDF-SHA256(ikm = DEK, salt = (vazio, 0 bytes), info = UTF-8(info_x), L = 32)`:

| Subchave | `info` | Uso |
|---|---|---|
| `K_record` | `clearchat/v1/record` | envelopes de registros |
| `K_blob` | `clearchat/v1/blob` | chave-mãe dos blobs (ver §3.11) |
| `K_blob_id` | `clearchat/v1/blob-id` | ids de blob |
| `K_stream` | `clearchat/v1/stream` | eventos ao vivo, comandos remotos e resultados |
| `K_record_id` | `clearchat/v1/record-id` | ids derivados (skills) |
| `K_verify` | `clearchat/v1/key-verify` | prova de posse da DEK |
| `K_push` | `clearchat/v1/push` | notificações push (§22, desde 1.7.0) |

### 3.8 Prova de posse da DEK

- `verifier = SHA-256(K_verify)` (32 bytes, base64url) — enviado no setup das chaves e guardado no servidor.
- `key_proof = b64u(K_verify)` — enviado (sob TLS) em toda operação que troca wraps (troca de senha,
  nova chave de recuperação). O servidor confere `SHA-256(key_proof) == verifier` (comparação em tempo
  constante). Isso impede que alguém com uma sessão roubada (mas sem a DEK) substitua as wraps por lixo.
  `K_verify` não serve para decifrar nada.

### 3.9 Envelope e moldura do plaintext

```json
{ "v": 1, "k": 1, "n": "<b64u nonce 12 bytes>", "c": "<b64u ciphertext‖tag>" }
```

- `v` = versão do formato de envelope (1). `k` = versão da DEK (1 — reservado para rotação futura).
- `plaintext` cifrado = **moldura** = 1 byte de formato + payload:
  - `0x00` → payload = JSON UTF-8 cru;
  - `0x01` → payload = deflate-raw(JSON UTF-8).
  Escritores DEVERIAM comprimir quando o JSON passar de 1 KiB; leitores DEVEM aceitar os dois. O byte de
  formato está dentro do ciphertext (autenticado). O JSON DEVE ser um objeto.
- Nonce: 12 bytes aleatórios por cifragem (nunca reutilizar). Cada mudança de registro gera envelope novo.
- Validação pelo servidor (sem decifrar): `v == 1`, `k ≥ 1`, `n` decodifica para 12 bytes, `c` para ≥ 17
  bytes (1 de moldura + 16 de tag), base64url válido.

### 3.10 AADs (bytes exatos)

UTF-8 das strings abaixo, campos separados por `|`. `scope` nulo = string vazia. Números em decimal sem
zeros à esquerda.

| Contexto | Chave | AAD |
|---|---|---|
| wrap da DEK | KEK | `clearchat\|v1\|dek-wrap\|<user_id>\|<slot>\|<key_version>` |
| registro | `K_record` | `clearchat\|v1\|record\|<user_id>\|<type>\|<id>\|<scope>\|<rev>` |
| evento ao vivo | `K_stream` | `clearchat\|v1\|stream\|<user_id>\|<chat_id>\|<epoch>\|<n>` |
| comando remoto | `K_stream` | `clearchat\|v1\|command\|<user_id>\|<chat_id>\|<cmd_id>` |
| resultado de comando | `K_stream` | `clearchat\|v1\|command-result\|<user_id>\|<chat_id>\|<cmd_id>` |
| notificação push | `K_push` | `clearchat\|v1\|push\|<user_id>\|<kind>\|<tag>` |
| anúncio de chat só ao vivo (desde 1.8.0) | `K_stream` | `clearchat\|v1\|live-announce\|<user_id>\|<host_device_id>\|<chat_id>\|<epoch>\|<arev>` |
| blob (cada chunk) | chave do arquivo | `UTF-8("clearchat\|v1\|blob\|<user_id>\|<blob_id>\|") ‖ header (21 bytes)` |

A AAD do registro amarra usuário + tipo + id + escopo + revisão: o servidor não consegue trocar
envelopes entre registros/usuários, mover uma mensagem de chat, nem servir uma revisão antiga como se
fosse a atual (o cliente rejeita `rev` menor que a que já tem). Exemplo (vetor `records.json`):
`clearchat|v1|record|6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b|provider|0b9f6a1e-2c3d-4e5f-9a8b-7c6d5e4f3a2b||1`.

**Chats só ao vivo (desde 1.8.0, §23) usam `K_stream`**, sem subchave nova: anúncio, histórico e
atualizações têm a mesma natureza dos eventos ao vivo e dos comandos (efêmeros, só retransmitidos, nunca
gravados, trocados só entre dispositivos da conta) e a separação de domínio vem do contexto da AAD
(`live-announce` ≠ `stream` ≠ `command` ≠ `command-result`: o primeiro campo depois de `v1` nunca é
prefixo de outro). O histórico (`history.*`) e as atualizações (`rec`) reusam as AADs de comando,
resultado e evento ao vivo; só o anúncio tem contexto novo, que amarra o **host** (o servidor não
consegue apresentar o chat de um host como sendo de outro), o `epoch` ao vivo e a revisão `arev` (não
consegue trocar um anúncio velho pelo atual dentro do mesmo `epoch`). `K_push` é separada porque o aviso
sai para um terceiro (FCM), fica guardado lá até o TTL e é decifrado numa tarefa em segundo plano.

### 3.11 Blobs (formato `CCB1`, em chunks)

Usado para anexos (bytes crus do arquivo) e bundles de skill (moldura §3.9 + JSON, §13).

```
blob   = header ‖ chunk_0 ‖ chunk_1 ‖ … ‖ chunk_{N-1}
header = "CCB1" (4 bytes ASCII) ‖ chunk_log2 (1 byte) ‖ salt (16 bytes aleatórios)        = 21 bytes
CS     = 2^chunk_log2 bytes de plaintext por chunk   (escritores: 20 → 1 MiB; leitores aceitam 10..24)
N      = max(1, ceil(len / CS)); chunk i (i < N-1) tem CS bytes; o último tem len − (N−1)·CS (0 só se len = 0)
K_file = HKDF-SHA256(ikm = K_blob, salt = salt do header, info = "clearchat/v1/blob-file", 32)
nonce_i = i em big-endian (11 bytes) ‖ final (1 byte: 0x01 no último chunk, 0x00 nos demais)
chunk_i = AES-256-GCM(K_file, nonce_i, AAD_blob, plaintext_i)   (CS + 16 bytes; o último ≥ 16)
```

Leitura em streaming: enquanto restarem mais que `CS + 16` bytes, o chunk não é final; o resto é o
chunk final. O flag no nonce impede truncamento e a ordem no nonce impede reordenação. Uma chave por
blob (salt aleatório) torna os nonces por contador seguros.

**Id do blob** (content-addressed com chave): `blob_id = hex(HMAC-SHA256(K_blob_id, SHA-256(plaintext)))`.
O app já nomeia os anexos como `<sha256>.<ext>`: o id sai do nome do arquivo sem relê-lo; o servidor
não consegue correlacionar com arquivos conhecidos (precisa da chave) e o mesmo arquivo do mesmo usuário
deduplica. Ao baixar, o cliente DEVE conferir `SHA-256(plaintext)` contra o sha256 esperado.

### 3.12 IDs derivados

- Registro `skill`: `id = "sk_" + primeiros 32 hex de HMAC-SHA256(K_record_id, UTF-8("skill|" + name))`
  (`name` = nome efetivo da skill). Mesmo nome ⇒ mesmo id em todos os dispositivos (deduplicação natural).
  Comportamento conhecido: **renomear uma skill gera outro registro** (id novo); o antigo continua até ser
  removido da nuvem.

### 3.13 Guarda da DEK nos clientes

- **Desktop (Electron)**: DEK guardada com `safeStorage` (chaveiro do SO) se "Lembrar neste dispositivo"
  (padrão ligado); senão só em memória. Argon2id DEVERIA rodar no processo main (hash-wasm funciona no
  Node) para não travar a UI.
- **Site**: DEK e subchaves só em memória (recarregar a página = desbloquear de novo). PODE guardar
  subchaves como `CryptoKey` não extraíveis em IndexedDB para a sessão da aba — nunca a DEK crua.
- **Mobile**: Keychain/Keystore.
- Logout, revogação do dispositivo (`device_revoked`) ou `keys.reset` ⇒ apagar a DEK guardada.
- Revogar um dispositivo **não** revoga criptograficamente o que ele já sabia (a DEK). Rotação de DEK fica
  para uma versão futura (campo `k` e `key_version` já reservados).

### 3.14 Rotação de chave (reservado)

Não existe em v1. Espaço deixado: `k` no envelope, `key_version` na AAD da wrap e nas respostas de
`/keys`. Uma v2 PODE introduzir um *keyring* (DEKs antigas embrulhadas pela nova) e re-cifragem gradual.

### 3.15 Vetores de teste

| Arquivo | Cobre |
|---|---|
| `kdf.json` | Argon2id com parâmetros de produção (e NFD → mesmo resultado) e parâmetros rápidos de teste |
| `recovery.json` | formatação/parse/checksum da chave de recuperação, `KEK_rk` |
| `keys.json` | subchaves HKDF, `key_proof`/`verifier`, wraps (senha e recuperação) com AAD |
| `records.json` | envelopes de registro (cru e deflate), casos que DEVEM falhar (AAD/bit trocado) |
| `blobs.json` | blobs CCB1 (3 chunks, chunks exatos, vazio), `blob_id` |
| `realtime.json` | envelopes de evento ao vivo, comando remoto e resultado |
| `push.json` | `K_push` e envelopes de notificação push com AAD (§22) |
| `live.json` | chats só ao vivo (§23): anúncio com AAD `live-announce` e casos que DEVEM falhar (outro host, `arev` trocada, aberto como stream); exemplos de `history.list` (comando e resultado), de `rec` (stream) e de `attach.put` (pedaço e resultado com o `AttachmentInfo`) |
| `ids.json` | ids derivados de skill e de blob |
| `branches.json` | árvore de versões das mensagens (§4.3.8): mãe efetiva, caminho ativo e irmãos — **escrito à mão** (dados de teste compartilhados, não é cripto nem saída do `generate.ts`) |

Rodar: `cd docs/test-vectors && npm install && node generate.ts --check` (falha se algum JSON divergir).
Os vetores foram conferidos contra implementações independentes (libargon2 e `cryptography` do Python).
O `generate.ts` não gera nem confere o `branches.json`: ele é editado à mão (idêntico nos dois
repositórios) e todo cliente que mostra conversas (app, site, mobile) DEVE passar em todos os casos.

---

## 4. Modelo de dados sincronizado

### 4.1 Campos do registro (em claro, vistos pelo servidor)

| Campo | Tipo | Descrição |
|---|---|---|
| `type` | string | um dos tipos da §4.2 |
| `id` | string | id da entidade no app (`^[A-Za-z0-9._-]{1,128}$`) |
| `scope` | string \| null | ver §4.2 (obrigatório e fixo por tipo) |
| `rev` | int ≥ 1 | revisão; `base_rev + 1` a cada escrita |
| `seq` | int | atribuído pelo servidor |
| `deleted` | bool | tombstone (sem `env`, sem `blobs`) |
| `env` | envelope \| ausente | conteúdo cifrado (§3.9) |
| `size` | int | bytes do ciphertext (`c` decodificado) |
| `blobs` | string[] | ids de blob referenciados pelo conteúdo |
| `device_id` | uuid | dispositivo que escreveu esta revisão |
| `updated_at` | ISO 8601 | relógio do servidor (informativo) |

### 4.2 Tipos de registro

| `type` | `id` | `scope` | Classe de conflito | Origem no app |
|---|---|---|---|---|
| `provider` | `providers.id` | null | LWW por campo | tabela `providers` |
| `setting` | chave de sync (§4.3.2) | null | LWW (valor inteiro) | tabela `settings` (subconjunto) |
| `preset` | `presets.id` | null | LWW por campo (`config` por chave) | tabela `presets` |
| `memory_collection` | `memory_collections.id` | null | LWW por campo | tabela `memory_collections` |
| `memory` | `memories.id` | `collectionId` | LWW por campo | tabela `memories` |
| `chat` | `chats.id` | o próprio `id` | LWW por campo (`config` por chave) | tabela `chats` |
| `session` | `sessions.id` | `chatId` | **conteúdo do chat** (§8) | tabela `sessions` |
| `message` | `messages.id` | `chatId` (do chat da sessão) | **conteúdo do chat** (§8) | tabela `messages` |
| `skill` | `sk_…` (§3.12) | null | LWW (inteiro) | pasta da skill (opt-in, §13) |

Tipo **reservado** (não usar em v1): `key_grant` (concessão de chaves a um gateway, §21).

Tipos desconhecidos recebidos do servidor DEVEM ser ignorados (guardados como opacos) — permite adicionar
tipos numa versão menor. O servidor recusa push de tipos que não conhece (`invalid_request`).

Contêineres com cascata no servidor: apagar `chat` remove todos os registros com `scope = chat_id`;
apagar `memory_collection` remove os `memory` com `scope = collection_id` (§7.7).

### 4.3 Esquemas do plaintext

Todo plaintext é um objeto JSON com `sv` (versão do esquema do tipo, hoje `1`). Os tipos referenciados
(`ChatConfig`, `ApiMessage`, `MessageMeta`, `MemoryConfig`, `SkillsConfig`, `EngineConfig`,
`SmartApproveDefaults`, `AutoTitleSettings`…) são **exatamente** os de `src/shared/*.ts` do app na versão
0.8.x (desde 1.4.0; antes, 0.7.x — os campos que entraram depois são todos opcionais/aditivos, ex.:
`ChatConfig.acceptEditsInRoot`, `ChatConfig.capturedContext`, `SmartApproveConfig.canDeny`/`judgeWhitelisted`/
`environment`/`capture`/`capturePrompts`/`thinkingTokens`/`cache` (os dois últimos desde 1.4.1), `ContextCaptureConfig.thinkingTokens`/`cache` (desde 1.4.1),
`MessageMeta.autoTitle`/`presentFiles`/`reasoningMs`; desde 1.5.0, tipos do app com o áudio (depois do 0.9.0):
`ChatConfig.voice` (§4.3.6), `MessageMeta.voice`/`voiceCall` e `MessageMeta.kind: 'voice-call'` (§4.3.8),
`VoiceCallConfig.endCall`/`promptMode`; desde 1.10.0, `ChatConfig.overrides` — herança ao vivo da persona, §4.3.6). Leitores DEVEM ignorar campos
desconhecidos e DEVEM preservá-los ao regravar (merge por campo); escritores NÃO DEVEM enviar `undefined`.

#### 4.3.1 `provider`

```ts
{ sv: 1, name: string, kind?: 'openai' | 'openrouter' | 'anthropic' | 'elevenlabs' /* ProviderKind */,
  baseUrl: string, apiKey: string, headers: Record<string, string>, createdAt: number }
```
Mapeia `providers(id, name, kind, base_url, api_key, headers_json, created_at)`. `kind` ausente ou
desconhecido → inferido pela `baseUrl` (`openrouter.ai` → `openrouter`, `api.anthropic.com` →
`anthropic`, `elevenlabs.io` → `elevenlabs` (desde 1.5.0), resto → `openai`).

**Capacidades por tipo (desde 1.5.0).** O tipo define o que o provedor serve: `openai` e `openrouter` →
chat + fala (TTS) + transcrição (STT); `anthropic` → só chat; **`elevenlabs` → só voz** (ElevenLabs direta:
TTS por REST `/v1/text-to-speech/…` e WebSocket; cabeçalho `xi-api-key`; URL padrão
`https://api.elevenlabs.io`). Um provedor sem `chat` NÃO DEVE aparecer nos seletores de modelo de chat,
nem ser usado como provedor de chat, juiz, título, resumo ou extração de memória; ele só é referenciado
pelas settings de áudio (§4.3.2). A chave fica no próprio registro `provider` (cifrado, como as outras):
as settings de áudio guardam só o id do provedor.
- **Clientes < 1.5.0** não conhecem `elevenlabs`: inferem `openai` pela URL, mostram o provedor como
  "OpenAI-compatible" (a lista de modelos e o chat com ele falham — ele não serve para chat) e, se o
  usuário **editar** esse provedor num app antigo, regravam `kind: 'openai'`.
- **Reparo (leitores ≥ 1.5.0)**: `kind: 'openai'` com host da `baseUrl` contendo `elevenlabs.io` vale
  `elevenlabs` (a ElevenLabs não tem API de chat OpenAI-compatível). Escritores ≥ 1.5.0 gravam
  `elevenlabs` explícito.

#### 4.3.2 `setting`

```ts
{ sv: 1, value: <JSON> | null }      // null = configuração removida (o app apaga a chave)
```
Registros `setting` **nunca** são tombstones (ids fixos): remover = `value: null`.

| id do registro | chave(s) no app (`settings.key`) | `value` |
|---|---|---|
| `defaultModel` | `defaultProviderId` + `defaultModel` (o par "Modelo padrão", gravados juntos) | `{ providerId: string \| null, model: string \| null }` |
| `defaultSystemPrompt` | `defaultSystemPrompt` | `string \| null` |
| `defaultPresetId` | `defaultPresetId` | `string \| null` |
| `approvalModes` | `approvalModes` | `Record<ApprovalItem, ApprovalMode>` |
| `approvalLists` | `approvalLists` | `Record<ApprovalListItem, ApprovalList>` |
| `webSearchEngines` | `webSearchEngines` | `EngineConfig[]` |
| `webSearchApiKeys` | `webSearchApiKeys` | `{ 'brave-api'?: string, exa?: string, tavily?: string }` |
| `webSearchMinIntervalSec` | `webSearchMinIntervalSec` | `number` |
| `smartApproveDefaults` (desde 1.4.0) | `smartApproveDefaults` | `SmartApproveDefaults` = `{ environment: string, acceptEditsInRoot: boolean, capture: ContextCaptureConfig, capturePrompts?: { prompt: string \| null, template: string \| null, derivePrompt: string \| null } }` (`ContextCaptureConfig` = `{ enabled, providerId: string \| null, model: string \| null, maxTokens: number \| null, lookback, thinkingTokens?: number \| null, cache?: boolean }` — `thinkingTokens` e `cache` desde 1.4.1, opcionais; `cache` ausente = ligado) |
| `autoTitle` (desde 1.4.0) | `autoTitle` | `AutoTitleSettings` = `{ providerId: string \| null, model: string \| null, useMemory: boolean, maxTokens: number, prompt: string \| null, thinkingTokens?: number \| null }` (`thinkingTokens` desde 1.4.1, opcional) |
| `toolOutputSpillChars` (desde 1.4.0) | `toolOutputSpillChars` | `number` (caracteres; o app limita à faixa dele) |
| `audioInput` (1.5.0 a 1.8.x — **local do dispositivo desde 1.9.0**, ver abaixo) | `audioInput` | `AudioInputSettings` **sem `deviceId` nem `activationDb`** = `{ pttEnabled: boolean, pttKey: string \| null, silenceStopEnabled: boolean, silenceStopMs: number /* 0 = sem limite */, language: string }` (ditado: push-to-talk, parada por silêncio, idioma) |
| `sttSettings` (1.5.0 a 1.8.x — **local do dispositivo desde 1.9.0**, ver abaixo) | `sttSettings` | `SttSettings` **sem as partes do dispositivo** = `{ mode: 'api' \| 'local' \| 'hybrid', api: { providerId: string \| null, model: string, params?: VoiceApiParams }, local: { engine: 'whisper.cpp' \| 'vosk' \| 'nemotron', model: string } \| null, livePartials: boolean, reusePartialFinal?: boolean }` (`api.params` = parâmetros do modelo de transcrição escolhidos pelo usuário, por família de API — `{ openrouter?: { temperature?: number }, openai?: { temperature?: number, prompt?: string } }`; ver "Parâmetros dos modelos remotos" abaixo) |
| `ttsSettings` (1.5.0 a 1.8.x — **local do dispositivo desde 1.9.0**, ver abaixo) | `ttsSettings` | `TtsSettings` **sem as partes do dispositivo** = `{ backend: 'api' \| 'local', api: { providerId: string \| null, model: string, voice: string \| null, elevenLabsWs?: false, params?: VoiceApiParams }, local: { engine: 'kokoro' \| 'chatterbox', voice: string } \| null }` (`local: null` = limpo pelo usuário; `elevenLabsWs` só gravado como `false` = HTTP por frase em vez do WebSocket da ElevenLabs; `api.params` = parâmetros do modelo de fala escolhidos pelo usuário, por família de API — `{ elevenlabs?: { output_format?: string, stability?: number, similarity_boost?: number, style?: number, use_speaker_boost?: boolean, speed?: number, apply_text_normalization?: 'on' \| 'off', auto_mode?: true }, openrouter?: { speed?: number, instructions?: string }, openai?: { speed?: number, instructions?: string } }`; ver "Parâmetros dos modelos remotos" abaixo) |
| `voiceCallDefaults` (1.5.0 a 1.8.x — **local do dispositivo desde 1.9.0**, ver abaixo) | `voiceCallDefaults` | `VoiceCallDefaults` = `{ enabled: boolean, interjections?: InterjectionPolicy, audioTags?: boolean, audioTagsPrompt?: string \| null, toolPhrases?: { enabled: boolean, pool: { text: string, categories: ToolPhraseCategory[] }[] \| null }, fillers: { enabled, prompt: string \| null, delayMs: number, pool: { text: string, contexts: FillerContext[] }[] \| null }, turn: VoiceCallTurnConfig, model: { providerId: string, model: string, params: ChatParams } \| null, basePromptEnabled: boolean, basePrompt: string \| null /* removidos nos apps de 2026-11-12: não há prompt-base de voz — leitores ignoram */, endCall: boolean, delayPhrases?: { enabled: boolean, keepAliveAfterMs: number, apologyAfterMs: number, keepAlivePool: string[] \| null, apologyPool: string[] \| null } }` (padrões globais da chamada de voz, herdados pelos campos `null` de `ChatConfig.voice`; `delayPhrases` = frases de demora sintetizadas na chamada — opcional, ausente = padrões `{ enabled: true, keepAliveAfterMs: 8000, apologyAfterMs: 15000, pools null }` (até 2026-11-12 eram 3000/5000; leitores DEVERIAM migrar valores exatamente iguais aos antigos para os novos), tempos em ms presos em 1000–60000, pools `null` = os do app; `audioTags` (padrão `false`) e `audioTagsPrompt` (`null` = texto padrão do app) = tags de voz da chamada, ver §4.3.6; `toolPhrases` (opcional, 2026-11-12; ausente = `{ enabled: true, pool: null }`, `pool` `null` = frases do app) = frase curta falada quando a **primeira** ferramenta do turno começa, por categoria `ToolPhraseCategory` = `'web' \| 'files' \| 'shell' \| 'memory' \| 'agents' \| 'info' \| 'location' \| 'generic'` (texto ≤ 80 chars, sem duplicatas, só categorias conhecidas — frase sem nenhuma é descartada —, máx. 40, vazio → `null`); `turn` ganhou (opcionais, 2026-11-12) `duckGain` (0–1, padrão 0.3), `bargeInVoicedMs` (200–5000, padrão 700), `bargeInWords` (1–10, padrão 3) e `duckRestoreMs` (150–3000, padrão 450) — falar por cima da resposta abaixa a voz e só interrompe se o usuário insistir; `interjections` é **legado** desde 2026-11-12 — a chamada não tem mais interjeições nem modo sombra: escritores não enviam, leitores ignoram) |

**Settings de voz locais (desde 1.9.0).** `audioInput`, `sttSettings`, `ttsSettings` e
`voiceCallDefaults` dependem do que está instalado e configurado em cada máquina (motores locais, GPU,
microfone, o "Modelo da chamada" padrão, preâmbulos, frases de demora/ferramenta, tags…) e deixam de
sincronizar: escritores ≥ 1.9.0 NÃO DEVEM enviar revisões desses ids; leitores ≥ 1.9.0 DEVEM ignorar os
registros recebidos (de apps ≤ 1.8.x) e manter os valores locais. Cada dispositivo fica com o que já
tem (nada se perde); os registros já gravados no servidor ficam como estão (apps antigos continuam a
lê-los). O que sincroniza da voz é só o que pertence à **persona/chat** (`config.voice`, §4.3.6 —
inclusive a escolha de fala e transcrição, `voice.tts`/`voice.stt`). As regras abaixo sobre esses ids
(partes do dispositivo, `providerId`, `api.params`) valem para apps 1.5.0–1.8.x e para os campos de
mesma forma dentro de `voice.tts`/`voice.stt`.

O par do modelo padrão vira **um** registro para nunca misturar provedor de um dispositivo com modelo
de outro. Os `providerId` dentro de `smartApproveDefaults.capture`, `autoTitle`, `sttSettings.api`,
`ttsSettings.api` e `voiceCallDefaults.model` são ids de registros `provider` (como
`defaultModel.providerId`): o leitor resolve pelo id, e um provedor que não existe localmente vale como
"sem modelo" (nunca cai noutro provedor) — em stt/tts, "nenhum provedor escolhido" (a pré-checagem da
chamada pede para escolher outro); no modelo da chamada, "sem modelo próprio" (o turno usa o modelo do
chat).

**Parâmetros dos modelos remotos (`api.params`, campo opcional de `sttSettings`/`ttsSettings` desde
1.5.0).** Preferências do usuário, NÃO partes do dispositivo: sincronizam com o resto do registro (ao
contrário dos parâmetros dos motores da GPU, que ficam no bloco `gpu` e nunca saem do dispositivo).
Formato `VoiceApiParams` = `{ [família]: { [parâmetro]: number | boolean | string } }`, família ∈
`elevenlabs` (ElevenLabs direta), `openrouter`, `openai` (OpenAI-compatível — Groq, OpenAI, servidor
local); só os valores ESCOLHIDOS são gravados (o padrão — "da voz na conta"/"do provedor" — é a chave
ausente; família sem valores sai; `params` vazio sai). Trocar de modelo não apaga os de outra família.
Na hora de usar, o app envia só os parâmetros que o modelo atual aceita (na faixa dele). Faixas
(o escritor limita; o leitor DEVE ignorar valor fora do tipo/opções e PODE limitar números à faixa):
`output_format` ∈ `pcm_16000`/`pcm_22050`/`pcm_24000`/`pcm_44100`/`pcm_48000` (ausente = `pcm_24000`;
o plano da conta pode recusar — o app avisa, nunca troca sozinho), `stability`/`similarity_boost`/
`style` 0–1, `use_speaker_boost` boolean, `speed` 0,7–1,2 (ElevenLabs; OpenRouter/OpenAI 0,25–4, com a
faixa do modelo aplicada no envio), `apply_text_normalization` `on`/`off` (ausente = automático),
`auto_mode` só `true` (frases completas no WebSocket da ElevenLabs), `instructions` texto ≤ 400,
`temperature` 0–1, `prompt` texto ≤ 600. O app normaliza ao gravar: parâmetros ou famílias que ele
não reconhece somem na próxima escrita local (o registro é LWW inteiro). Leitores que não conhecem
`params` (app ≤ 0.10.1) ignoram o campo; o site pode mostrá-lo, não precisa editá-lo.

**Settings de áudio: partes do dispositivo (desde 1.5.0).** O registro leva as preferências; o que só
vale na máquina onde foi escolhido NUNCA é enviado e, ao aplicar um registro, o leitor DEVE manter o
valor local dessas partes (e descartá-las se vierem no registro):
- `audioInput.deviceId` (microfone desta máquina) e `audioInput.activationDb` (nível de ativação da fala
  em dBFS, padrão −45, faixa −70…−20 — depende do microfone e do ambiente; desde 2026-11-12).
- `sttSettings.local.installed` / `ttsSettings.local.installed` (o modelo local foi baixado AQUI). Ao
  aplicar: mantém o valor local se o `engine` recebido é o mesmo do local (a semântica de "instalado" é
  por motor), senão `false` (a UI deste dispositivo oferece o download).
- **Modo avançado (GPU local)**: o bloco `gpu` de `sttSettings`/`ttsSettings` (motor, voz — que pode ser
  um arquivo de voz do usuário só desta máquina —, passos e parâmetros por motor) e o valor `'gpu'` de
  `sttSettings.mode`/`ttsSettings.backend`. Escritores NÃO DEVEM enviar `'gpu'`: um dispositivo em modo
  GPU envia o `mode`/`backend` que já está online (sem registro: o padrão, `'api'` para stt e `'local'`
  para tts). Ao aplicar: um dispositivo em `'gpu'` continua em `'gpu'` (o resto do registro é aplicado);
  `'gpu'` recebido nunca é aplicado (vale o local). Ou seja: a escolha sem GPU (API/local/híbrido) e
  tudo o mais sincronizam; ligar a GPU é por computador — um notebook sem GPU nunca passa a falar pela
  GPU do desktop.
- Endereço/chave resolvidos do provedor (`api.baseUrl`, `api.apiKey`, `api.providerKind`,
  `api.extraBody`) nunca são gravados nem enviados; se vierem, o leitor os descarta. **Nenhuma setting
  de áudio carrega segredo** — as chaves ficam nos registros `provider`.
- `value: null` (setting removida) num leitor com partes do dispositivo: o leitor fica só com elas
  (ex.: `audioInput` = `{ deviceId }`), que valem como "padrões + o microfone desta máquina".
Trocar só uma parte do dispositivo (ex.: o microfone) não gera revisão nova.

**Ids novos num dispositivo que já sincronizava (desde 1.4.0).** Ao ganhar um id de `setting` novo, o
cliente DEVERIA, uma única vez e **depois** de um pull completo, enviar o valor local dos ids novos que
ainda não têm registro online (se já existe registro — outro dispositivo enviou antes — vale o online,
aplicado pelo pull). Leitores que não conhecem um id de `setting` (clientes < 1.4.0; os de áudio,
clientes < 1.5.0) o ignoram e guardam o registro (§4.2). Em 1.5.0 a mesma passada envia a `voice` local
de chats e personas (§4.3.6) cujo registro online ainda não tem `voice` (merge por chave da `config`; um
`voice` que já está online vence).

#### 4.3.3 `preset` (persona)

```ts
{ sv: 1, name: string, description: string, icon: string, config: PresetConfig /* sem cwd */,
  createdAt: number, updatedAt: number }
```
`config` = `sanitizePresetConfig` (`PRESET_FIELDS`) **sem `cwd`** — o diretório raiz opcional da
persona é local do dispositivo (§4.4). Ao aplicar um registro remoto, o cliente mantém o `cwd` local.
Desde 1.5.0 `config.voice` (`VoiceCallConfig`, a chamada de voz da persona — §4.3.6) sincroniza; até
1.4.1 era local e não era enviado. Desde 1.10.0 os chats **herdam a persona ao vivo** (os campos que o
chat não sobrescreveu seguem a persona — `ChatConfig.overrides`, §4.3.6); apagar uma persona **congela**
os chats dela antes (§4.3.6, §7.7). Campos que a persona não define seguem os padrões de "Novos chats"
(`defaultModel`, `defaultSystemPrompt`, padrões do app) — também ao vivo.

#### 4.3.4 `memory_collection`

```ts
{ sv: 1, category: MemoryCategory, name: string, description: string, icon: string | null,
  createdAt: number, updatedAt: number }
```
Colunas legadas `scope`/`chat_id` não são sincronizadas (sempre `'shared'`/NULL). `category` é imutável.

#### 4.3.5 `memory`

```ts
{ sv: 1, collectionId: string, category: MemoryCategory, title: string, slug: string, summary: string,
  facts: string[], pinned: boolean, createdAt: number, updatedAt: number,
  updatedByChatId: string | null, updatedBy: 'model' | 'extraction' | 'user', supersedesId: string | null }
```
`scope` = `collectionId` (mover de coleção = nova revisão com outro `scope`). **Colisão de slug** (o app
tem `UNIQUE(slug)`): se aplicar um registro cujo `slug` já pertence a outra memória local, a memória com
`createdAt` maior (empate: `id` maior) recebe `slug + "-" + últimos 4 caracteres alfanuméricos do id`;
o dispositivo que fez a troca envia a nova revisão (regra determinística: todos chegam ao mesmo resultado).

#### 4.3.6 `chat`

```ts
{ sv: 1, title: string, config: ChatConfig /* sem cwd */, mainSessionId: string,
  createdAt: number, updatedAt: number,
  hostCwd?: { deviceId: string, path: string } | null }   // informativo: raiz do chat NO HOST (§8.9)
```
`updatedAt` muda a cada mensagem (ordem da sidebar), então o host reenvia o registro `chat` durante o
turno (aceito: LWW por campo, coalescido). `config.cwd` é local do dispositivo (§4.4). `hostCwd` é escrito pelo host (quando vira host ou muda a
raiz) só para exibir avisos ("diretório raiz /home/x/proj no PC") — nunca é aplicado como raiz local.

**`config.voice` (desde 1.5.0; antes local do dispositivo)** — a chamada de voz do chat (na persona, o
mesmo campo em `PresetConfig`), LWW por chave da `config` como o resto:
```ts
VoiceCallConfig = { enabled: boolean | null,                      // null = herda (persona → voiceCallDefaults)
  model: { providerId: string, model: string, params: ChatParams } | null,   // modelo da chamada; null = herda
  tools: { enabledTools: ToolName[] | null, maxToolOutputChars: number | null } | null,
  voicePrompt: string | null, promptMode?: 'append' | 'replace' | 'none' | null,
  fillers: { enabled: boolean, prompt: string | null } | null,
  interjections?: InterjectionPolicy | null, endCall?: boolean | null,   // interjections: legado (abaixo)
  audioTags?: boolean | null, audioTagsPrompt?: string | null,         // desde 2026-11-12 (abaixo)
  toolPhrases?: boolean | null,    // desde 2026-11-12: frases de ferramenta (null = herda → voiceCallDefaults.toolPhrases.enabled)
  tts?: VoiceTtsChoice | null, stt?: VoiceSttChoice | null }   // desde 1.9.0: voz e transcrição da persona/chat
VoiceTtsChoice =
  | { backend: 'api', api: { providerId: string, model: string, voice: string | null,
                              elevenLabsWs?: false, params?: VoiceApiParams } }
  | { backend: 'local', local: { engine: 'kokoro' | 'chatterbox', voice: string } }
  | { backend: 'gpu', gpu: { engine: string, voice: string | null } }
VoiceSttChoice = { mode: 'api' | 'local' | 'hybrid' | 'gpu',
  api?: { providerId: string, model: string, params?: VoiceApiParams },    // obrigatório em api/hybrid
  local?: { engine: 'whisper.cpp' | 'vosk' | 'nemotron', model: string },  // obrigatório em local/hybrid
  gpu?: { engine: string, model: string | null },                          // obrigatório em gpu
  language?: string | null }                                               // null = o idioma do dispositivo
```
**Voz da persona/chat (`voice.tts`/`voice.stt`, desde 1.9.0).** Qual motor/provedor, modelo, voz e
parâmetros a persona usa para **falar** (chamada de voz, prévias) e para **ouvir** (chamada e ditado no
composer dos chats dela). `null`/ausente herda (chat → persona de origem → as settings de voz **deste
dispositivo**, que são locais desde 1.9.0, §4.3.2). Os campos têm a mesma forma e as mesmas regras dos
registros `ttsSettings`/`sttSettings` (`providerId` = id de `provider`; `api.params`; nada de endereço/
chave; parâmetros da GPU — passos etc. — ficam no dispositivo, só `engine`/`voice`/`model` sincronizam).
**Disponibilidade, por dispositivo (DEVE):** `api` = o `provider` existe aqui e serve a capacidade;
`local` = motor e modelo/voz instalados AQUI; `gpu` = runtime da GPU e motor instalados AQUI e a voz
existe nesta máquina (voz clonada de outro PC não existe aqui). Escolha indisponível → usa as settings
globais deste dispositivo (o app DEVERIA avisar "a voz da persona não está disponível aqui — usando a
padrão deste dispositivo"); escolha e global indisponíveis → microfone/chamada desabilitados com o motivo
(DEVERIA: ícones esmaecidos com dica "não configurado"/"não funciona neste dispositivo"). O celular só
tem `api` (local/gpu caem no global dele). Apps < 1.9.0 ignoram `tts`/`stt`, mas o normalizador da
`voice` deles descarta chaves desconhecidas: editar a persona/chat num app < 1.9.0 apaga a escolha.
**`interjections` é legado (desde 2026-11-12, sem mudança de versão):** a chamada de voz é só meia-duplex
(o usuário fala, o assistente responde), sem interjeições/backchannel durante a fala do usuário e sem o modo
sombra que vivia em `interjections.shadow`. Escritores NÃO DEVEM enviar o campo; leitores DEVEM ignorá-lo
(inclusive nos registros antigos que ainda o tragam). Os preâmbulos (`fillers`) e as frases de demora
(`delayPhrases`) continuam.

**Tags de voz (`audioTags`/`audioTagsPrompt`, desde 2026-11-12, aditivos):** opt-in por chat/persona
(`null` herda; global `voiceCallDefaults.audioTags`, padrão `false`). Ligado e com uma voz que interpreta
tags (ElevenLabs v3/v4; Fish Audio Drama 3/S2), o texto `audioTagsPrompt` (≤ 2000 chars; `null` = herda →
texto padrão do app) é acrescentado ao prompt da chamada e o modelo pode escrever direções entre
colchetes (`[sussurra]`, `[risos]`…). Com uma voz que não interpreta tags, os clientes DEVEM removê-las
antes da síntese. Leitores DEVERIAM exibir as tags das mensagens da chamada com destaque discreto.
Campos `null`/ausentes herdam (chat → persona de origem `presetId` → `voiceCallDefaults`, §4.3.2).
`voice.model.providerId` é um id de `provider` (remapeado no merge, §12; provedor que não existe
localmente = "sem modelo próprio"). `voice.tools.enabledTools` conta em `usesLocalTools` (§8.9). Clientes
< 1.5.0 guardam `voice` como chave desconhecida e a preservam ao regravar o chat; mas editar uma
**persona** num app < 1.5.0 (que reescreve a `config` pelos campos que conhece) apaga a `voice` dela.

**Herança ao vivo da persona (`config.overrides`, desde 1.10.0).** Até 1.9.0 a `config` de um chat era
uma **cópia** da persona feita na criação. Desde 1.10.0 o chat **herda ao vivo**: cada campo que o chat
não mudou segue a persona de origem (`presetId`) — mudar a persona muda os chats dela —, e um campo
mudado no chat vira **próprio** só daquele chat, até o usuário "voltar a herdar".
```ts
ChatConfig.overrides?: { [unidade: string]: true }   // unidades próprias do chat; as outras herdam
```
- **Unidades** (o que se herda ou sobrescreve de uma vez; nomes estáveis, leitores ignoram nomes
  desconhecidos e valores ≠ `true`):

  | Unidade | Campos de `config` |
  |---|---|
  | `model` | `providerId` + `model` (o par anda junto) |
  | `params.<nome>` | `params[<nome>]` — cada parâmetro é uma unidade (`params.temperature`, `params.extraBody`…) |
  | `enabledTools.<tool>` | se a tool `<tool>` está em `enabledTools` (cada tool é uma unidade; renomes de tool do app valem também para o nome da unidade) |
  | `approvalModes.<item>` | `approvalModes[<item>]` (cada item de aprovação) |
  | `appSignature` | `appSignature` + `appSignatureCustom` |
  | `smartApprove`, `memory`, `skills` | a seção inteira |
  | qualquer outra chave de `PresetConfig` (`systemPrompt`, `nativeTools`, `toolsInPrompt`, `toolsPromptText`, `envInPrompt`, `cacheEnabled`, `subagentSystemPrompt`, `acceptEditsInRoot`, `contextWindow`, `compactThreshold`, `autoCompact`, `compactPrompt`, `maxToolOutputChars`, `confineToRoot`, `sandboxBash` e as que vierem) | a própria chave |

  Ficam **fora** de `overrides`: `voice` (cada campo `null` da `voice` do chat já herda a persona ao vivo
  desde 1.5.0 — "voltar a herdar" = `null`), `cwd` (local, §4.4), `presetId` e `capturedContext`
  (estado do chat), sempre próprios.
- **Valor efetivo da persona** de uma unidade: o da persona, se a `config` dela define a unidade (a
  chave; em `params`/`approvalModes`, a subchave; em `enabledTools`, a persona ter a lista); senão o
  padrão de **"Novos chats"**, também ao vivo — `model` = setting `defaultModel` (provedor da persona
  apagado → o par padrão, como hoje), `systemPrompt` = `defaultSystemPrompt` (`null` → o texto padrão do
  app), `params.*`/`approvalModes.*` = ausente (o padrão do provedor/o global), `enabledTools.*` = as
  tools padrão do app (todas, inclusive as de um tipo de aparelho — abaixo), `cacheEnabled` = segue o provedor **efetivo do chat** (OpenRouter/Anthropic
  ligam; provedor efetivo inexistente neste dispositivo → o valor efetivo da persona), o resto = o padrão do app. Ou seja, a cadeia é **Novos chats → persona → chat**: mudar um
  padrão de "Novos chats" muda as personas que não definem aquele campo e os chats delas que não o
  sobrescrevem (a UI DEVERIA avisar isso na tela de "Novos chats").
- **Config efetiva do chat** (a que o host usa para rodar e todos usam para exibir; tudo que o protocolo
  calcula sobre a config — ex.: `usesLocalTools`, §8.9 — usa a efetiva): se o chat tem `presetId` de uma
  persona que existe neste dispositivo **e** tem `overrides` → cada unidade em `overrides` usa o valor do
  próprio chat (ausente inclusive: vale a semântica de "ausente" do campo — ex.: `memory` ausente =
  desligada; escritores DEVERIAM gravar a forma explícita quando ela existe) e cada unidade fora usa o
  valor efetivo da persona; `voice` pela regra própria. Sem `presetId`, ou com a persona inexistente
  aqui → a `config` como está (valores próprios; `overrides` não tem efeito).
- **Cópia informativa.** A `config` continua **completa** no registro: nas unidades herdadas, o
  escritor grava o valor efetivo da persona **no momento** em que cria o chat, migra, "volta a herdar",
  troca de persona ou congela. Esses valores servem a apps < 1.10.0 e ao congelamento — leitores ≥ 1.10.0
  NÃO DEVEM usá-los enquanto a persona existe. Escritores NÃO DEVERIAM regravar os chats só porque a
  persona ou um padrão mudou (seria uma escrita por chat a cada edição) nem atualizar a cópia nas outras
  escritas do chat (ex.: o `updatedAt` do turno, §8.5).
- **Criar um chat** (≥ 1.10.0) com persona: `presetId` = a persona; `overrides` = as unidades que o
  usuário mudou no formulário do Novo chat em relação ao valor efetivo da persona (`{}` se nenhuma);
  `config` completa. Sem persona: sem `presetId` (e `overrides` ausente ou vazio) — valores próprios.
  `presetId` de uma persona que ainda não existe neste dispositivo: `overrides` ausente (o chat é
  migrado quando a persona chegar).
- **Editar um campo no chat** → a(s) unidade(s) entram em `overrides` com o valor novo. Unidade
  **tocada** por uma edição: numa chave simples, enviá-la (mesmo com o valor igual); nas chaves
  compartilhadas (`params`, `approvalModes`, `enabledTools`), só as subunidades cujo valor muda (as UIs
  mandam o objeto `params` inteiro). **Voltar a herdar**
  → a unidade sai de `overrides` e a cópia recebe o valor efetivo atual da persona.
- **Trocar a persona do chat** → `presetId` novo, `overrides` mantido (as unidades próprias continuam
  próprias), as herdadas passam a seguir a persona nova (cópia atualizada); na `voice`, os campos `null`
  passam a herdar da nova. Escolher **nenhuma persona** = congelar (abaixo). Um chat sem persona que
  ganha uma: as unidades em `overrides` (se houver) ficam próprias, todas as outras herdam.
- **Persona apagada → os chats dela congelam.** Antes de apagar uma persona (localmente ou ao aplicar o
  tombstone dela, §7.7), o cliente DEVE congelar cada chat local com aquele `presetId`: grava em `config`
  o valor efetivo atual de todas as unidades herdadas, preenche os campos `null` da `voice` com os
  valores não nulos da `voice` da persona, **remove `presetId`** e **mantém `overrides`** (só sem efeito,
  para uma persona escolhida depois). Quem apaga DEVE enviar os chats congelados antes do tombstone da
  persona, ou no mesmo push e antes dele; quem recebe o tombstone e ainda tem chats apontando para ela os
  congela com a cópia local (valores iguais → nenhum conflito real); sem cópia local da persona (ex.:
  apagada antes deste dispositivo a conhecer) não há o que congelar — o chat fica com a cópia que já tem. Chats só ao vivo (§23): o host
  congela a cópia local dele.
- **Migração de chats antigos** (com `presetId` e **sem** `overrides` — gravados por apps < 1.10.0 ou
  antes da migração): uma vez por chat, **depois de um pull completo** (para persona e padrões estarem
  atualizados — ou de qualquer momento em que o cliente sabe estar em dia com o feed, ex.: um lote ao
  vivo contíguo), um cliente ≥ 1.10.0 DEVE gravar `overrides` = as unidades cujo valor no chat **difere**
  (JSON canônico — chaves ordenadas; `memory`/`skills` normalizadas, ausente = o padrão; `enabledTools.<t>`
  comparada como booleano) do valor efetivo da persona — as iguais passam a herdar — e, na `voice`, pôr `null` nos campos
  iguais ao campo **não nulo** correspondente da `voice` da persona (os padrões de voz do dispositivo são
  locais e não entram na comparação). O resultado é determinístico (depende só do que sincroniza): dois
  dispositivos que migram juntos gravam o mesmo. Até migrar, o chat vale como cópia (valores próprios).
  `presetId` de uma persona que não existe depois do pull completo → nada a migrar (valores próprios).
  Chats locais (sem login) e só ao vivo migram no próprio dispositivo/host.
- **Conflito:** `overrides` é mesclado **por unidade** (subchave) no merge por chave da `config`
  (§7.5): dois dispositivos que sobrescrevem campos diferentes ao mesmo tempo não perdem nenhuma marca.
  Ao reaplicar campos sujos num `rev_mismatch`, o cliente NÃO DEVE reaplicar o valor de uma unidade que
  ele tem como herdada **e cuja marca não mudou localmente**, se no servidor ela está em `overrides` (a
  cópia informativa não sobrescreve um valor próprio; um "voltar a herdar" local tira a marca e vence
  normalmente). As chaves compartilhadas por várias unidades (`params`, `approvalModes`,
  `enabledTools`) continuam LWW pela chave inteira, como antes, exceto as subunidades protegidas por
  essa regra, que ficam com o valor do servidor.
- **Apps < 1.10.0** leem a `config` como cópia (os valores herdados da última atualização da cópia) e
  preservam `overrides` como chave desconhecida ao regravar. Uma edição feita num app < 1.10.0 num campo
  que o chat herda não vale nos apps ≥ 1.10.0 (o campo continua herdando; a migração não roda de novo
  porque `overrides` já existe) — atualize os apps. Chats criados por apps < 1.10.0 são migrados como acima.

**Tools de um tipo de aparelho (desde 1.10.0).** Algumas tools só rodam num tipo de aparelho: **só no
computador** — `list_dir`, `read_file`, `search_files`, `find_files`, `present_file`, `write_file`,
`edit_file`, `shell`, `process_start`, `process_logs`, `process_list`, `process_stop` (e as skills,
`config.skills`); **só no celular** — `get_location`, `nearby_places`. A lista de tools do chat (a
efetiva, herdada ou própria) é a mesma em todos os aparelhos; quem **roda** o turno manda ao modelo só as
que ele executa (as outras não vão na request nem no texto de tools) e a UI as mostra esmaecidas ("só no
computador"/"só no celular"), ainda alternáveis — valem quando o chat rodar no outro tipo de aparelho.
Vale também para `voice.tools.enabledTools`. Regras:
- Escritores NÃO DEVEM marcar `enabledTools.<t>` como própria por causa do aparelho (ex.: o celular,
  ao criar um chat, não desliga as do computador nem liga as dele) — só por escolha do usuário.
- Leitores que não conhecem uma tool (ex.: o desktop e `get_location`) DEVEM preservá-la nas listas
  (`enabledTools` de chats e personas, `overrides`) ao regravar e PODEM mostrá-la como "só no celular".
- **Migração** (acima): uma diferença numa tool de um tipo de aparelho só vira própria se o chat já
  rodou naquele tipo — computador: o registro tem `hostCwd`, ou o chat é local deste computador;
  celular: o registro não tem `hostCwd`. Senão a unidade herda (ex.: um chat criado no celular, sem as
  tools do computador, passa a herdá-las — e continua rodando no celular sem elas).

#### 4.3.7 `session`

```ts
{ sv: 1, chatId: string, parentSessionId: string | null, parentToolCallId: string | null,
  depth: 0 | 1 | 2, model: string, providerId: string | null, title: string, task: string | null,
  status: SessionStatus, createdAt: number,
  memory: { snapshot?: { at: number, key: string, index: string }, lastExtractedSeq?: number } | null,
  branchSel?: { [parentKey: string]: string | null } }   // desde 1.2.0; parentKey = id da mãe ou "root"
```
Mapeia `sessions` (+ `memory_json` → `memory`, `branch_sel_json` → `branchSel`). O snapshot do índice de memória é sincronizado de
propósito: o próximo host continua com o mesmo prefixo (cache do provedor) e não re-extrai mensagens.
Status transitórios (`running`, `waiting`, `awaiting_approval`, `awaiting_input`, `awaiting_retry`)
PODEM ser gravados; leitores DEVEM exibi-los como `interrupted` quando o chat não tiver janela de escrita
aberta (§8). Ao abrir uma janela, o host DEVERIA normalizar status transitórios velhos (como o
`markStaleInterrupted` do app) e enviar.

`branchSel` (desde 1.2.0) = a versão escolhida em cada bifurcação da árvore de mensagens desta sessão
(algoritmo na §4.3.8). Chave = id da mensagem mãe, ou `"root"` para as mensagens sem mãe (escritores NÃO
DEVEM usar `root` como id de mensagem); valor = id do filho escolhido, ou `null` = "o caminho termina
nesta mãe" (estado transitório: um regenerar cuja nova resposta ainda não existe). Chave ausente ou
filho que não existe (ainda não chegou, apagado, não é filho dessa mãe) → o filho mais novo. O mapa só
guarda desvios do padrão: um chat linear tem `{}`, anexar mensagens não muda nada, criar uma versão
nova apaga a chave da mãe (a nova já é a mais nova) e voltar para a versão mais nova também.
- Escritores ≥ 1.2.0 DEVEM **sempre** enviar `branchSel` (`{}` quando vazio): a regravação mescla com o
  plaintext anterior (campos desconhecidos são preservados, §4.3), então omitir traria de volta uma
  seleção velha. Ausente (escritor < 1.2.0) = `{}`.
- É conteúdo do chat: só o host grava, dentro de uma janela (§8.4). Trocar de versão = nova revisão do
  `session` só com `branchSel` alterado (nenhuma mensagem muda); criar uma versão manda a mensagem nova
  e o `session` no **mesmo** lote. Num controle remoto, trocar vira o comando `branch.select` (§8.6).
- Quem não pode gravar o conteúdo (o site; dispositivos com o chat divergente ou sem janela) PODE trocar
  de versão **só na tela** (sem gravar nada), partindo do `branchSel` sincronizado.

#### 4.3.8 `message`

```ts
{ sv: 1, sessionId: string, seq: number, message: ApiMessage, meta: MessageMeta, createdAt: number,
  parentId?: string | null }   // desde 1.2.0: mensagem anterior no mesmo ramo; null = raiz
```
Mapeia `messages(id, session_id, seq, message_json, meta_json, created_at, parent_id)`. Mensagens **não**
são append-only no app (editar, apagar, `insertAt` da compactação desloca `seq`): toda mutação é
uma nova revisão do registro, e todas acontecem no host (§8). O `seq` dentro do plaintext é a posição
na sessão (não confundir com o `seq` do servidor). Referências a anexos (`clearchat-attachment://…`)
ficam como estão (§14).

**Voz no histórico (desde 1.5.0)** — campos opcionais de `MessageMeta`, só exibição/custos (nunca
mudam o que vai ao modelo; numa resposta interrompida o `content` já é só o trecho ouvido e o resto fica
em `voice.unheard`, que NUNCA vai ao modelo):
```ts
MessageMeta.voice?: { source: 'call' | 'dictation',   // 'call' = fala da chamada de voz; 'dictation' = texto ditado no composer
  callId?: string, durationMs?: number /* usuário: áudio transcrito */, sttModel?: string,
  spoken?: true | 'partial' /* assistente: falada inteira ou em parte */, ttsModel?: string,
  unheard?: string /* desde 2026-11-12: resto não ouvido de uma resposta interrompida — só exibição */ }
MessageMeta.voiceCall?: { callId: string, phase: 'start' | 'end', startedAt: number, endedAt?: number,
  durationMs?: number, endedBy?: 'user' | 'agent' | 'error', reason?: string,
  usage?: { turns, userSpeechMs, stt: { mode, model?, apiRequests, apiAudioMs, localRequests, cost?, costedRequests },
            tts: { backend: 'api' | 'elevenlabs' | 'local' | 'gpu', model?, chars, audioMs, cost?, estimated? },
            llm: { calls, cost, costed } } }
```
Os **marcadores de início/fim da chamada** são mensagens `role: 'assistant'`, `synthetic: true`, com
`meta.voiceCall` (o `content` traz um texto legível, ex. "Chamada encerrada · 4 min 12 s · por você"). São
**só de exibição**: NUNCA vão ao modelo (nem à compactação, busca, `read_history` ou extração de
memórias); leitores DEVERIAM mostrá-los como divisórias (duração, quem encerrou, custos — o custo da fala
com `estimated` é estimativa). Mensagens com `voice.source = 'call'` DEVERIAM aparecer em itálico com um
ícone (microfone/alto-falante). São mensagens comuns do conteúdo do chat (gravadas pelo host, §8).

**Codificação no registro (obrigatória).** Nos apps o marcador é `meta.kind: 'voice-call'`, mas no
plaintext do registro ele vai com **`meta.kind: 'memory-extraction'`, `meta.voiceCall` presente e
`meta.memoryExtraction` ausente**. Motivo: apps ≤ 0.9.0 (protocolo ≤ 1.4.1) só tratam como só de
exibição os `kind` `error` e `memory-extraction` (`DISPLAY_ONLY_KINDS`) — um `kind` desconhecido, mesmo
com `synthetic: true`, entraria na request ao modelo como mensagem do assistente se um app antigo
hospedasse ou continuasse o chat. Com `memory-extraction` o app antigo já o descarta da request, da
compactação, da busca, do `read_history` e da extração, e não desenha nada (o card da extração exige
`memoryExtraction`) — o marcador só some da tela dele. Regras:
- Escritores ≥ 1.5.0 DEVEM gravar o marcador assim (a troca é só no registro; localmente continua
  `voice-call`).
- Leitores ≥ 1.5.0: `kind: 'memory-extraction'` com `voiceCall` objeto e sem `memoryExtraction` ⇒
  marcador (`voice-call`); DEVEM aceitar também `kind: 'voice-call'` explícito. Um card de extração de
  verdade nunca tem `voiceCall`.
- Leitores < 1.5.0 ignoram `voice`/`voiceCall`; o marcador fica invisível neles e nunca vai ao modelo.

A tool `end_call` (a chamada encerrada pelo agente) é histórico normal: um `tool_calls` com
`function.name = 'end_call'` (`{ reason? }`) e o resultado `"Chamada encerrada pelo agente."` — vai ao
modelo como qualquer tool.

**Árvore de versões (desde 1.2.0).** As mensagens de uma sessão formam uma árvore: `parentId` = id da
mensagem anterior no mesmo ramo, na mesma sessão; `null` = raiz. Editar uma mensagem digitada pelo
usuário cria uma **irmã** (mesma mãe) e regenerar cria um novo filho da mensagem que abre o turno — a
versão antiga continua salva. Clientes a partir do app 0.7 DEVEM sempre escrever `parentId` (`null`
explícito na raiz). **Invariante:** `seq(mãe) < seq(filho)`, então `seq` continua uma ordem topológica
(todo caminho cresce em `seq`) e `#seq` continua identificando a mensagem na sessão (`read_history`,
`summaryOf` da compactação); num caminho os `seq` podem ter lacunas. Uma versão nova recebe
`seq = máximo da sessão + 1`; o `insertAt` da compactação desloca `seq` sem quebrar a invariante (o
marco fica com a mãe da primeira mensagem pendente e passa a ser a mãe dela); apagar uma mensagem
passa os filhos dela para a mãe dela (novas revisões dos filhos e, se a seleção mudar, do `session`).
Subsessões (subagentes) continuam lineares.

Algoritmo normativo (o mesmo em app, site e mobile; casos em `docs/test-vectors/branches.json`):
- **Ordem da sessão**: por `seq` crescente; empate (só em estados transitórios) por `id` (comparação
  de strings ASCII).
- **Mãe efetiva** de m: `parentId` se for `null` (raiz) ou o id de uma mensagem existente da **mesma
  sessão** com `seq < m.seq`. Senão — `parentId` ausente (registro de cliente < 0.7), mãe que ainda não
  chegou, apagada, de outra sessão ou que quebra a invariante — a mãe é **derivada**: a mensagem da
  mesma sessão com o maior `seq` menor que `m.seq` (empate: maior `id`); nenhuma → raiz. A derivação é
  só na leitura: o leitor NÃO DEVE regravar o registro por causa dela.
- **Filhos** de `k` (`k` = id de mensagem, ou `"root"`) = mensagens cuja mãe efetiva é `k`, na ordem
  da sessão; o **mais novo** é o último.
- **Caminho ativo** (`activePath(mensagens, branchSel)`):
  ```
  caminho = []; k = "root"
  enquanto filhos(k) não for vazio:
    se k ∈ branchSel e branchSel[k] === null: pare        // o caminho termina em k
    se k ∈ branchSel e branchSel[k] ∈ filhos(k): m = branchSel[k]
    senão: m = o mais novo de filhos(k)                   // padrão (inclui seleção velha/desconhecida)
    caminho.push(m); k = m.id
  ```
  O histórico mandado ao modelo, a tela e o "último turno" usam só o caminho ativo; as outras versões
  ficam guardadas.
- **Irmãos** de m = filhos da mãe efetiva de m: `{ index, count }` (`index` a partir de 0, na ordem da
  sessão). O seletor de versão (‹ i/n ›) aparece nas mensagens do caminho com `count > 1`.

Leitores < 1.2.0 ignoram `parentId`/`branchSel` e mostram todas as versões intercaladas por `seq` (nada
se perde); ao regravar, o merge com a base (§4.3) preserva os dois campos. Uma mensagem escrita por um
cliente antigo (sem `parentId`) vira filha da anterior por `seq`. O app preenche localmente o
`parent_id` das mensagens que já tinha (`migration.messageTree`, §4.4) **sem reenviá-las**: os outros
leitores derivam a mesma mãe.

#### 4.3.9 `skill`

```ts
{ sv: 1, name: string, description: string, meta?: SkillMeta,
  bundle: { blobId: string, sha256: string /* hex do plaintext do bundle */, size: number, files: number },
  updatedAt: number }
```
Ver §13 (formato do bundle).

### 4.4 Local do dispositivo (NUNCA sincronizado)

| Item | Onde fica no app | Motivo |
|---|---|---|
| `ChatConfig.cwd` (diretório raiz de cada chat) | `chats.config_json.cwd` | caminho da máquina; cada dispositivo guarda o seu |
| `cwd` opcional das personas | `presets.config_json.cwd` | idem |
| `defaultCwd` | `settings` | pasta padrão desta máquina |
| settings de voz `audioInput`, `sttSettings`, `ttsSettings`, `voiceCallDefaults` (desde 1.9.0; antes sincronizavam, §4.3.2) | `settings` | dependem do que está instalado/configurado em cada máquina; a voz que sincroniza é a da persona/chat (`config.voice.tts`/`stt`) |
| `skillsSettings` (locais de skills, `projectSkills`) | `settings` | pastas desta máquina |
| `presetsSeeded`, `migration.*` (`toolShellRename`, `approvalModes`, `smartApproveItems`, `searchIndex`, `messageTree`) | `settings` | estado de migração local |
| `updateDismissedVersion` (aviso de versão nova dispensado) | `settings` | cada instalação tem a sua versão do app |
| índices FTS (`message_search`, `messages_fts`, `memories_fts`) | SQLite | derivados; reconstruídos localmente |
| fila da sessão (`QueuedMessage`), aprovações/questionários/retries pendentes, processos em segundo plano | memória do main | estado de execução do host (vai ao vivo pelo stream, §11) |
| arquivos do store de anexos | `userData/attachments` | sincronizados como blobs (§14), mas o store é local |
| cache de modelos, `localStorage` da UI (aba do painel, seções recolhidas, grupos recolhidos, largura do painel de arquivo…) | renderer | estado de UI / tamanho de tela |
| estado do próprio sync (cursor, outbox, revs, credenciais, DEK) | tabelas `sync_*` / chaveiro | por dispositivo |
| skills não marcadas para sync | pastas | opt-in (§13) |
| partes do dispositivo das settings de áudio: `audioInput.deviceId`, `audioInput.activationDb`, `local.installed`, bloco `gpu` e modo `'gpu'` de `sttSettings`/`ttsSettings` (desde 1.5.0, §4.3.2) | `settings` | microfone e hardware desta máquina |
| `gpuVoiceMeasured` (medições do autoteste da GPU) | `settings` | desempenho desta máquina |
| modelos locais de voz baixados (whisper.cpp, Vosk, Kokoro…) e o `manifest.json` deles | `userData/models` | arquivos grandes, baixados sob demanda em cada dispositivo |
| runtime da GPU (Python, PyTorch, motores, pesos) e o estado de instalação/servidor local | `userData/gpu-runtime` | por máquina (hardware, sistema) |
| vozes do usuário para clonagem (áudios de referência) | `userData/gpu-voices` | arquivos de áudio locais (a voz escolhida é só um id, local junto com o bloco `gpu`) |
| cache de clipes de preâmbulo por voz | `userData/voice-clips` | derivado; regerado em cada dispositivo |
| logs de diagnóstico da chamada (`voice-eval/*.jsonl`) e o estado da chamada em andamento | `userData` / memória do main | diagnóstico e execução locais |
| token de push, preferências de notificação (tipos, "mostrar trecho") e tags dos avisos mostrados (desde 1.7.0, §22; desde 1.8.0 com o host de cada aviso, §22.7) | celular | por aparelho |
| modo de cada chat — `storage`: `online` \| `live` \| `live_pending` — e o último `epoch` ao vivo usado por chat (desde 1.8.0, §23.2) | coluna local de `chats` (fora de `config_json`) | a escolha "Salvar online"/"Só ao vivo" é do dispositivo que guarda o chat |
| `newChatStorage` — a última escolha "Salvar online"/"Só ao vivo" feita neste dispositivo (desde 1.8.0, §23.1) | `settings` | cada dispositivo lembra a sua |
| **conteúdo inteiro dos chats só ao vivo** (o `chat`, sessões, mensagens e anexos) enquanto `storage` ≠ `online` (desde 1.8.0, §23) | tabelas normais, só no host | nunca vira registro nem blob; outros dispositivos o veem ao vivo, pelo host |
| espelho de chats só ao vivo de outro host (lista, histórico lido, estado do stream) (desde 1.8.0, §23.5) | memória do visualizador | NUNCA gravado (banco, arquivo, cache, índice de busca, logs) |

Tudo que não está nesta tabela e corresponde às tabelas `providers`, `presets`, `chats`, `sessions`,
`messages`, `memory_collections`, `memories` e às chaves de `settings` da §4.3.2 é sincronizado — os
chats só ao vivo (e as sessões/mensagens deles) são a exceção da linha acima.

---

## 5. Contas, autenticação e dispositivos

### 5.1 Cadastro (só no site)

O cadastro depende da configuração da instância (§20.2):
- **Cadastro aberto**: qualquer pessoa se cadastra em `<base>/signup`.
- **Cadastro fechado**: não existe cadastro público (site e app escondem "Criar conta";
  `signup/start` sem convite → `403 signup_closed`). O admin (painel local) cria o usuário ou emite um
  **link de convite** de uso único: `<base>/signup?invite=<token>`. O convidado completa o cadastro no
  navegador exatamente como abaixo (DEK e chave de recuperação geradas no cliente). Usuário criado pelo
  admin (só e-mail + nome, `keys_ready: false`) entra por código e cai no fluxo "Definir senha de
  criptografia" (`<base>/setup`).

Passos:

1. Site `/signup`: e-mail + nome (+ Turnstile, se a instância tiver captcha; + `invite_token`, se veio de
   convite) → `POST /api/v1/auth/signup/start`.
2. Código de 6 dígitos por e-mail → `POST /api/v1/auth/signup/verify` → cria a conta
   (`keys_ready: false`) e a sessão do navegador.
3. No navegador: gera DEK (32 bytes), salt_pw, salt_rk, entropia da chave de recuperação; pede a senha
   de criptografia (2×); calcula wraps e `verifier` → `POST /api/v1/keys/setup`.
4. Mostra a chave de recuperação uma vez (copiar/baixar + confirmação). Pronto: "Volte ao app e entre".

Se o passo 3 não terminar (aba fechada), a conta fica com `keys_ready: false`; qualquer login depois
leva ao fluxo "Definir senha de criptografia" (site; o app PODE implementar o mesmo fluxo, ou abrir o
site em `<base>/setup`). O botão "Criar conta" do app (visível só com `features.signupOpen`) abre o
navegador em `<base>/signup?from=app`.

### 5.2 Login (app e site)

1. E-mail (+ Turnstile, se `features.captcha` — §15 no app) → `POST /api/v1/auth/code/request`.
2. Código → `POST /api/v1/auth/code/verify` com dados do dispositivo → tokens + `device_id` + `keys`.
3. **Desbloqueio**: senha → Argon2id → desembrulha a DEK (`keys.password`). Ou "Usei minha chave de
   recuperação" → `keys.recovery` → DEK → obrigatório definir senha nova (§5.5).

### 5.3 Códigos por e-mail

- 6 dígitos (`000000`–`999999`, CSPRNG), validade 10 min, **máx. 5 tentativas** por código; pedir um novo
  invalida os anteriores do mesmo propósito. Guardado como `HMAC-SHA256(SERVER_SECRET, purpose|email|code)`;
  comparação em tempo constante; uso único.
- Propósitos: `signup`, `login`, `delete_account`, `reset_keys`.
- **Convites**: token opaco (32 bytes, base64url) de uso único, validade padrão 7 dias, opcionalmente
  amarrado a um e-mail; guardado como `SHA-256(token)`. Consumido no `signup/verify`. Com cadastro
  fechado, `signup/start` só aceita `invite_token` válido (e, se amarrado, o mesmo e-mail).
- **Sem enumeração de contas**: `signup/start` e `code/request` respondem sempre `202 {"ok": true}` (mesmo
  corpo, mesmo tempo — o envio do e-mail é assíncrono). E-mail inexistente no login: nada é enviado.
  Cadastro com e-mail já existente: envia "você já tem uma conta — entre". Conta banida: nada é enviado.
  `verify` com código errado/expirado/esgotado/e-mail inexistente → sempre `400 code_invalid`.
- Limites e bloqueios: §17.3.

### 5.4 Sessões por dispositivo

- `access_token`: opaco, 32 bytes aleatórios, prefixo `cca_`, TTL 1 h. `refresh_token`: prefixo `ccr_`,
  TTL 60 dias deslizante, **rotacionado a cada uso**; reutilizar um refresh antigo — qualquer geração já
  rotacionada, enquanto ainda estaria válido — revoga o dispositivo (detecção de roubo). Servidor guarda só `SHA-256(token)`.
- Apps: tokens no corpo JSON; `Authorization: Bearer cca_…`. Desktop guarda o refresh com `safeStorage`.
- Site (`client: "web"`): o refresh vai num cookie `cc_refresh` `HttpOnly; SameSite=Strict;
  Path=<caminho de base>/api/v1/auth` (+ `Secure` quando `<base>` é `https`); o access fica em memória.
  `POST /auth/refresh` do site manda corpo `{}` e o servidor lê o cookie. Sem CORS (mesma origem; apps nativos não precisam).
- Cada login cria um **dispositivo** (`devices`): `name` (ex.: "PC de casa" — editável), `platform`
  (`linux|windows|macos|android|ios|web`), `client` (`desktop|mobile|web`), `app_version`,
  `can_host` (desktop: true; web: false; mobile: true só para chats sem ferramentas locais, §8.9).
  `client` aceita ainda o valor **reservado** `gateway` (§21) — servidores v1 recusam login com ele.
- Revogar (`DELETE /devices/{id}`) apaga os tokens (access e refresh), fecha o WebSocket
  (`4403`, motivo `device_revoked`) e retira o dispositivo de host dos chats dele (§8). Como os tokens são
  apagados, as chamadas REST seguintes desse dispositivo recebem **`401 unauthorized`** (não
  `403 device_revoked`) e o refresh também falha com `401 unauthorized` → o cliente trata como sessão
  encerrada (apaga credenciais e DEK, volta ao login). `403 device_revoked` só aparece se o token ainda
  existir com o dispositivo revogado (corrida). Login novo no mesmo aparelho = dispositivo novo.

### 5.5 Troca de senha e recuperação

- **Trocar senha** (app → Configurações → Conta, ou site): exige DEK em memória. Novo salt, Argon2id da
  senha nova, nova wrap → `PUT /api/v1/keys/password` com `key_proof`. A DEK não muda: os outros
  dispositivos continuam funcionando (recebem `keys.changed` e atualizam a wrap em cache).
- **Recuperação**: logado (código por e-mail) e sem a senha → digita a chave de recuperação →
  `KEK_rk` → DEK → define senha nova (troca acima). DEVERIA oferecer "Gerar nova chave de recuperação"
  (`PUT /api/v1/keys/recovery`).
- **Perdi senha e chave**: `POST /api/v1/keys/reset` com código fresco (`reset_keys`) → o servidor apaga
  **todos** os registros e blobs e volta a `keys_ready: false`. Os dispositivos recebem `keys.reset`,
  apagam o estado de sync e, depois do novo setup, fazem o merge do primeiro login (§12) — os dados locais
  de qualquer dispositivo voltam para a nuvem com a DEK nova.
- **Apagar conta**: `DELETE /api/v1/account` com código fresco (`delete_account`). Apaga tudo na hora.

---

## 6. API REST

Base: `<base>/api/v1` (exceto `GET <base>/api/info`, sem versão). Caminhos como `/api/v1/…` ao longo do
documento são relativos a `<base>`. JSON UTF-8. Cabeçalhos do cliente: `Authorization: Bearer …`
(exceto auth), `X-ClearChat-Client: desktop/0.6.0` (logs), `X-ClearChat-Protocol: 1`.

### 6.1 Erros

```json
{ "error": { "code": "conflict", "message": "texto pt-BR legível", "details": { } } }
```
Status HTTP indicativos; o cliente decide pelo `code` (lista completa em §17.4). `429` traz cabeçalho
`Retry-After` e `details.retry_after` (segundos).

### 6.2 Informações da instância — `GET <base>/api/info`

Sem autenticação e **sem versão no caminho** (qualquer cliente, de qualquer versão, consegue sondar).
Clientes chamam antes de login (validação do servidor escolhido) e a cada conexão; o site adapta a UI
(landing, "Criar conta", captcha).
```json
{ "name": "ClearChat", "server_version": "0.1.0", "base_url": "https://clear.ezenere.com",
  "protocol": { "min": 1, "max": 1, "version": "1.2.0" },
  "features": {
    "signupOpen": true,
    "captcha": { "provider": "turnstile", "siteKey": "0x4AAAA…" },
    "landing": true,
    "gateway": false,
    "push": { "providers": ["fcm"] },
    "liveChats": true
  },
  "links": { "download": "https://github.com/ezenere/ClearChat/releases", "signup": "https://clear.ezenere.com/signup" } }
```
- `captcha: null` = a instância não usa captcha (sem chaves configuradas ou desligado no painel): os
  clientes não abrem a janela de captcha e omitem `turnstile_token`; os limites de taxa continuam.
- `push` (desde 1.7.0): `null` quando a instância não tem push configurado (§22.1).
- `liveChats` (desde 1.8.0): `true` = o servidor entende chats só ao vivo (§23: `live.*`, `history.*`,
  `chat.update`). Ausente (servidor < 1.8.0) ou `false` = sem suporte: os clientes escondem a escolha e
  todo chat novo é online, como antes (§23.2).
- `links.signup` ausente quando `signupOpen` é falso. `gateway` é reservado (§21; sempre `false` em v1).
- Cliente com protocolo fora de `[protocol.min, protocol.max]` → "Este servidor usa uma versão
  incompatível do protocolo (servidor X–Y, app Z) — atualize o app/servidor" e não sincroniza.

### 6.3 Autenticação

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `GET /auth/invite/{token}` | — | `200 { valid: boolean, email?: string }` (pré-preenche o cadastro) |
| `POST /auth/signup/start` | `{ email, name, turnstile_token?, invite_token? }` | `202 { ok: true }` |
| `POST /auth/signup/verify` | `{ email, code, device }` | `201 AuthResult` |
| `POST /auth/code/request` | `{ email, turnstile_token? }` | `202 { ok: true }` |
| `POST /auth/code/verify` | `{ email, code, device }` | `200 AuthResult` |
| `POST /auth/refresh` | `{ refresh_token }` (apps); site: corpo `{}` + cookie `cc_refresh` | `200 Tokens` |
| `POST /auth/logout` | — | `204` (revoga o dispositivo atual) |
| `POST /auth/reauth/request` | `{ purpose: 'delete_account' \| 'reset_keys' }` (autenticado) | `202` (código no e-mail da conta) |

```ts
device = { name: string /* ≤ 64 */, platform: string, client: 'desktop'|'mobile'|'web' /* 'gateway' reservado, §21 */, app_version: string, can_host: boolean }
Tokens = { access_token: string, access_expires_in: number /* s */, refresh_token?: string /* ausente p/ web */, refresh_expires_in: number }
AuthResult = Tokens & { user: { id: string, email: string, name: string }, device_id: string,
                        keys_ready: boolean, keys: KeysResponse | null }
```
E-mail normalizado: trim + minúsculas (o servidor guarda `citext`). `turnstile_token` é obrigatório se
e somente se `features.captcha` não for nulo. Erros: `invalid_request`, `captcha_failed`,
`rate_limited`, `code_invalid`, `signup_closed`, `invite_invalid` (o `invite_invalid` só aparece no
`signup/start`/`verify` com convite — não revela nada sobre contas).

### 6.4 Conta

| | |
|---|---|
| `GET /account` | `{ id, email, name, created_at, keys_ready, usage: { record_bytes, records, blob_bytes, blobs, devices }, quotas: { record_bytes, records, blob_bytes, devices } }` (quota `null` = ilimitada) |
| `PATCH /account` | `{ name }` → conta |
| `DELETE /account` | `{ code }` → `204` |

### 6.5 Chaves

```ts
KeysResponse = {
  key_version: 1, keys_rev: number,                         // keys_rev sobe a cada troca de wrap
  password: { kdf: KdfParams, salt: string /* b64u 16 */, wrap: { n: string, c: string } },
  recovery: { kdf: { alg: 'hkdf-sha256' }, salt: string, wrap: { n: string, c: string } }
}
```
| Método e caminho | Corpo | Notas |
|---|---|---|
| `GET /keys` | — | `200 KeysResponse` ou `409 keys_not_ready` |
| `POST /keys/setup` | `{ password: {kdf, salt, wrap}, recovery: {kdf, salt, wrap}, verifier }` | `200 KeysResponse`; só com `keys_ready=false`, senão `409 keys_already_set` |
| `PUT /keys/password` | `{ key_proof, password: {kdf, salt, wrap} }` | `200 KeysResponse` (`keys_rev` novo); `403 key_proof_invalid`; broadcast `keys.changed` |
| `PUT /keys/recovery` | `{ key_proof, recovery: {kdf, salt, wrap} }` | idem |
| `POST /keys/reset` | `{ code }` | `204`; apaga dados; broadcast `keys.reset` (§10.2) |

O servidor valida formato (salt 16 bytes, `n` 12, `c` 48, `kdf` dentro dos limites §3.4).

### 6.6 Dispositivos

| | |
|---|---|
| `GET /devices` | `[{ id, name, platform, client, app_version, can_host, created_at, last_seen_at, last_ip, online, current, push }]` (`push` desde 1.7.0) |
| `PUT`/`DELETE /devices/current/push` | token de push deste dispositivo (§22.2) |
| `PATCH /devices/{id}` | `{ name }` |
| `DELETE /devices/{id}` | `204` (revoga; pode ser o atual = logout) |

### 6.7 Sync (registros)

| Método e caminho | Descrição |
|---|---|
| `GET /sync/changes?since=<seq>&limit=<n>&payload=1` | feed de mudanças (§7.3) |
| `POST /sync/push` | push atômico (§7.4) |
| `GET /records?type=<t>&scope=<id>&after=<seq>&limit=<n>&payload=1` | estado atual (sem tombstones), paginado por `seq` → `{ records: [Change], next, has_more, head }` (mesma paginação do feed: repetir com `after=next`) — usado pelo site, mobile, resync e resolução de divergência |
| `POST /records/fetch` | `{ items: [{ type, id }] }` (≤ 500) → `{ records: [Change] }` (payload de registros omitidos; ~8 MiB por resposta, o resto volta `omitted: true` — §7.2) |
| `GET /chat-states?since=<ssq>` | estados de host/divergência dos chats (§8.2), incremental por `ssq` → `{ chat_states: [ChatState], state_cursor }` |
| `POST /chats/{chat_id}/divergence/resolve` | resolução de divergência (§9) → `{ state: ChatState }` (+ `results`, `head`, `chat_heads` como no push, em `keep: 'local'` com itens) |

### 6.8 Blobs

| Método e caminho | Descrição |
|---|---|
| `POST /blobs/check` | `{ ids: [blob_id] }` (≤ 1000) → `{ present: [...], missing: [...] }` |
| `PUT /blobs/{blob_id}` | corpo `application/octet-stream` (o blob CCB1), cabeçalho `X-Content-SHA256: <hex do ciphertext>` → `201 { blob_id, created: true }` (novo) ou `200 { blob_id, created: false }` (já existia) |
| `GET /blobs/{blob_id}` | `200 application/octet-stream` + `X-Content-SHA256`; `404 not_found` |

---

## 7. Sincronização de registros

### 7.1 `seq` e cursor

- O servidor mantém `users.seq` (último `seq` atribuído). Cada push aceito, numa transação, faz
  `UPDATE users SET seq = seq + k RETURNING seq` e atribui `seq` consecutivos aos `k` registros do commit
  na ordem dos itens. Commits sucessivos têm `seq` contíguos (rollback devolve o contador).
- Cada registro guarda só a **última** revisão: o `seq` do registro é o do último commit que o tocou.
- O cliente guarda `cursor` = maior `seq` aplicado. Relógios dos clientes nunca entram na ordem.

### 7.2 Formato `Change`

```ts
Change = { seq: number, type: string, id: string, scope: string | null, rev: number, deleted: boolean,
           env?: Envelope, omitted?: true, size: number, blobs: string[], device_id: string, updated_at: string }
```
`omitted: true` = o payload não veio (página grande, `payload=0` ou evento ao vivo grande): buscar com
`POST /records/fetch` (ou `sync.fetch` no WS). O `fetch` obedece ao mesmo orçamento de ~8 MiB por resposta
(o primeiro registro, em ordem de `seq`, sempre vem com payload): os que não couberem voltam de novo com
`omitted: true`, e o cliente DEVE pedi-los outra vez até não restar nenhum.

### 7.3 Pull

`GET /sync/changes?since=S&limit=500` → registros com `seq > S` em ordem de `seq` (cada registro aparece
uma vez, na revisão atual), parando em `limit` itens ou ~8 MiB:
```json
{ "changes": [Change], "next": 1234, "has_more": true, "head": 1300 }
```
`next` = maior `seq` devolvido (ou `head` se vazio). Repetir com `since=next` até `has_more=false`.
`since` abaixo do piso de tombstones (§7.8) → `410 cursor_expired` → **resync completo** (§7.9).

Aplicação no cliente: cada página numa transação SQLite. Ao aplicar um registro: decifrar com AAD do
próprio change; conferir que `rev` ≥ a revisão local (menor → ignorar e logar); se houver mudança local
pendente para o mesmo registro (outbox), aplicar a regra de conflito do tipo (§7.5) em vez de
sobrescrever. Mensagens: a unicidade `(session_id, seq)` do app pode colidir no meio de um lote (o
`insertAt` desloca vários `seq`): mover temporariamente a mensagem local conflitante para `seq` negativo
e normalizar ao fim do lote; o que ainda estiver negativo espera a próxima revisão (a UI ordena por `seq`).

### 7.4 Push

`POST /sync/push` (ou `sync.push` no WS, mesmo corpo/resultado):
```ts
{ push_id: string /* uuid do cliente, estável entre tentativas */,
  items: [{ type, id, scope: string | null, base_rev: number /* 0 = novo */, rev: number /* = base_rev+1 */,
            deleted: boolean, env?: Envelope, blobs: string[] }],
  chat_bases?: { [chat_id]: number },      // obrigatório para todo chat com conteúdo (session/message) no lote
  host_epochs?: { [chat_id]: number } }    // opcional; enviado pelo host dentro da janela (§8.4)
```
Regras (servidor, numa transação; **lote atômico**: tudo ou nada), **nesta ordem**:
1. Validação: tipos conhecidos, `scope` coerente com o tipo, `rev == base_rev + 1`, tombstone sem `env`
   e sem `blobs`, envelope bem formado, ≤ 500 itens.
2. **Idempotência**: se `(user, push_id)` já existe em `push_receipts`, devolve a resposta guardada (7 dias).
3. **Blobs**: todo id em `blobs` precisa existir em `blobs` do usuário → senão `409 blob_missing`
   (`details.missing`). O cliente sobe os blobs **antes** do registro.
4. **Escopo**: `session`/`message` exigem o `chat` do escopo existente e não apagado (ou criado no mesmo
   lote); `memory` exige a coleção. Apagado → `scope_deleted`; inexistente → `scope_missing`.
5. **Conteúdo do chat**: regras de host/replay da §8.4 (`chat_diverged`, `divergence_discarded`,
   `stale_base`, `not_host`, `chat_busy`). Vêm **antes** das de revisão para que um replay com base velha
   marque a divergência em vez de devolver `rev_mismatch`; a divergência é gravada numa transação
   própria (o lote em si é recusado). Exclusão de `chat` com janela aberta → `chat_busy`; escrita no
   `chat` divergente → `chat_diverged`.
6. **Revisão**: `current.rev == base_rev` (registro inexistente = 0; tombstone conta com a rev dele).
   Senão conflito `rev_mismatch` com o `Change` atual.
7. **Tombstone atual**: escrever num registro apagado só é permitido com `base_rev == rev do tombstone`
   (o cliente viu a exclusão e quer recriar de propósito); senão conflito `gone`.
8. **Cotas** (§7.10) → `413 quota_exceeded`.
9. Aplica: novo `seq` por item, atualiza `head` dos chats afetados, `record_blobs`, uso; grava o recibo;
   transmite `sync.changes` a todas as conexões do usuário (inclusive a que enviou).

Resposta `200`:
```json
{ "results": [{ "type": "message", "id": "…", "rev": 4, "seq": 1301 }], "head": 1301,
  "chat_heads": { "<chat_id>": 1301 } }
```
Conflitos → `409 conflict` com `details.conflicts: [{ type, id, reason: 'rev_mismatch'|'gone'|'scope_deleted'|'scope_missing', current?: Change }]`
(nada aplicado). Erros de chat → `409` com o código específico e `details.chat_id`.
Recomendação: um chat por lote de conteúdo; registros LWW em lotes separados — um conflito não segura
o resto. Pelo WebSocket: no máximo **um push em voo por conexão** (aguardar o ack).

### 7.5 Regras de conflito por tipo

**LWW por campo** (`provider`, `preset`, `memory_collection`, `memory`, `chat`): o cliente guarda, para
cada registro pendente, o conjunto de campos que mudou localmente (`dirty_fields`; para `chat.config` e
`preset.config`, as chaves de `config`). Em `rev_mismatch`: pega o plaintext atual do servidor, aplica
por cima **só** os campos sujos locais, e reenvia com `base_rev = current.rev` (novo `push_id`).
Resultado: vence quem chega por último ao servidor, campo a campo; edições em campos diferentes não se
perdem. `updatedAt` = máximo dos dois. Campos desconhecidos do servidor são preservados. Exceção (desde
1.10.0): `chat.config.overrides` é mesclado **por subchave** (cada unidade da herança é suja sozinha), e a
cópia informativa de uma unidade herdada não sobrescreve um valor que no servidor está em `overrides`
(§4.3.6).

**LWW inteiro** (`setting`, `skill`): o valor local substitui o atual (`base_rev = current.rev`) — a
escrita que chega depois vence.

**Exclusão × edição**: conflito `gone` (alguém apagou) → a exclusão vence: descartar a edição local e
apagar localmente. Exceção: chat com conteúdo local não enviado (§7.7). Recriar algo apagado só por ação
explícita (merge "priorizar local", §12) com `base_rev = rev do tombstone`.

**Conteúdo do chat** (`session`, `message`): nunca mesclado — ou a escrita é aceita pelas regras de host
(§8.4), ou o chat diverge (§9). `rev_mismatch` dentro de uma janela de host válida indica bug: o cliente
DEVE puxar e tratar como divergência.

### 7.6 Idempotência e retentativas

- Toda tentativa de um mesmo lote reutiliza o `push_id`; um lote **alterado** (após conflito) usa
  `push_id` novo.
- Upload de blob é idempotente (`PUT` do mesmo id → `200`).
- Comandos remotos têm `cmd_id` (o host deduplica, §8.6). Eventos ao vivo são idempotentes por `n`.

### 7.7 Exclusões e cascatas

- Apagar = push com `deleted: true`. O tombstone fica no feed (§7.8).
- **Chat**: exige que o chat não esteja com janela de escrita aberta (`409 chat_busy`). O servidor apaga
  (fisicamente) todos os registros com `scope = chat_id` e o estado do chat; só o
  tombstone do `chat` vai ao feed. Clientes apagam localmente o chat com sessões e mensagens (cascata como
  no app). Push de conteúdo para chat apagado → `scope_deleted`: o cliente pergunta "Este chat foi apagado
  em outro dispositivo e você tem mensagens não sincronizadas: **Manter como novo chat** / **Descartar**"
  (manter = cópia local com ids novos, enviada como chat novo).
- **Chat que vira só ao vivo (desde 1.8.0)**: a conversão online → ao vivo é exatamente esta exclusão,
  feita pelo host, que mantém a cópia local e ignora o tombstone (§23.8). Para o servidor e para os outros
  dispositivos é uma exclusão comum.
- **Persona (desde 1.10.0)**: antes de apagar uma persona — por ação local ou ao aplicar o tombstone
  dela —, o cliente congela os chats locais com aquele `presetId` (valores efetivos gravados, `presetId`
  removido, §4.3.6); quem apaga envia os chats congelados antes do tombstone (ou no mesmo push, antes
  dele). O servidor não faz nada além do comum (sem cascata).
- **Coleção de memória**: o servidor apaga fisicamente as `memory` com `scope = collection_id`; clientes
  fazem a cascata local (a FK do app já faz). `supersedes_id` que apontava para elas: zerado pelo trigger
  do app (não é enviado nada).
- Registros `setting` não são apagados (`value: null`).

### 7.8 GC de tombstones

Tombstones com mais de `TOMBSTONE_RETENTION_DAYS` (180) são removidos; `users.tombstone_floor` = maior
`seq` removido. `since < tombstone_floor` → `410 cursor_expired`.

### 7.9 Resync completo

Quando `cursor_expired`, troca de conta ou estado local corrompido. Note que, após um `keys/reset`, até um
cliente novo recebe `410` em `since=0` (o piso subiu): começar sempre tratando `410` como resync. Então: o cliente baixa o estado atual
inteiro (`GET /records` paginado por tipo, depois `GET /chat-states`), e reconcilia: registro local já
sincronizado antes (tem `rev` > 0) e ausente online → apagar localmente; local nunca enviado → outbox;
presente nos dois → regra de conflito do tipo. Define `cursor = head` da primeira página.

### 7.10 Cotas

Por usuário, no servidor (nulo = ilimitado, que é o padrão hoje): `quota_record_bytes`, `quota_records`,
`quota_blob_bytes`, `quota_devices`. Checadas em push, upload de blob e login (dispositivos). Excedeu →
`413 quota_exceeded` com `details: { kind, used, limit }`. O cliente mostra o aviso e para de enviar
(continua puxando).

`kind`: `record_bytes` · `records` · `blob_bytes` · `devices` · `chat_states` · `live_chats` (desde 1.8.0:
chats só ao vivo anunciados por host/usuário, §23.4 — teto em memória, não é cota guardada). `chat_states` é o teto de
estados de chat (§8.2) por usuário, definido pelo servidor (não é editável por usuário): só é checado quando
`host.begin`, `host.takeover` ou `host.pin` criaria a linha de um chat que ainda não tem estado — chats que
já têm estado seguem normalmente. O servidor PODE apagar estados ociosos de chats sem registro (sem host,
janela, troca nem divergência). Clientes que não conhecem um `kind` DEVEM tratá-lo como cota genérica.

---

## 8. Host de execução (quem roda o chat)

### 8.1 Princípios

- Cada chat tem no máximo **um host**: o dispositivo onde os turnos rodam — as tools de shell, arquivos,
  processos e skills agem na máquina dele, com a raiz local dele. Host = **identidade de dispositivo**
  (`device_id` + nome), visível em toda UI: selo **"Executando em <dispositivo>"**.
- Os outros dispositivos são **controles remotos**: enviam mensagens e comandos (cifrados) que o servidor
  retransmite ao host, que os coloca na fila normal do runner (mesma semântica da fila local, ⚡,
  aprovações, questionários, parar). Todos assistem ao vivo (§11). Comandos remotos **só funcionam com o
  host online**: não existe fila guardada no servidor (§8.7).
- **Host padrão** = o dispositivo que rodou o chat por último. Ele continua host enquanto não houver
  troca explícita. Se estiver offline, ninguém assume automaticamente: assumir exige ação do usuário em
  outro dispositivo. Exceção: **chat sem host** — o primeiro dispositivo (com `can_host`) que enviar vira host.
- **Lease do host** = a conexão WebSocket do host (heartbeats). Queda → 10 s de tolerância → "host
  offline" + aviso "o dispositivo remoto caiu". O host continua sendo o host (offline) até alguém assumir.
- Só o host grava **conteúdo** do chat online, e só dentro de uma **janela de escrita** (`host.begin` …
  `host.end`). Execução offline (sem servidor) é permitida em qualquer dispositivo e reconciliada depois
  por replay (§8.4) ou vira divergência (§9).
- **Chats só ao vivo (desde 1.8.0, §23)** ficam fora desta seção quase toda: não têm registros nem
  `chat_states`, não têm janela de escrita nem troca de host. O host é fixo (o dispositivo que guarda o
  chat) e o servidor o conhece só por um **vínculo em memória** criado pelo anúncio do host (§23.3); os
  comandos remotos (§8.6) e o stream (§11) funcionam com ele.

### 8.2 Estado do chat no servidor (`chat_states`)

| Campo | Descrição |
|---|---|
| `host_device_id` | host atual ou null (sem host) |
| `epoch` | incrementa a cada troca de host |
| `pinned` | "fixar host": bloqueia assumir sem confirmação extra |
| `window` | janela de escrita aberta: `{ purpose: 'run'\|'edit'\|'replay', since }` ou null |
| `head` | `seq` da última mudança de conteúdo aceita |
| `handover` | troca pendente: `{ to_device_id, mode: 'next_turn'\|'force', requested_at }` ou null |
| `diverged` | `{ divergence_id, device_id, base, head, since }` ou null (§9) |
| `ssq` | versão do estado (contador por usuário, para sync incremental dos estados) |

Status do host derivado da conexão: `none` (sem host) · `online` (conectado) · `grace` (caiu há < 10 s)
· `offline`.

`ChatState` (como vai ao cliente em `chat.state`, `welcome` e `GET /chat-states`):
```ts
ChatState = {
  chat_id: string, ssq: number, epoch: number, head: number, pinned: boolean,
  host: { device_id: string, name: string, platform: string, status: 'online'|'grace'|'offline' } | null,
  window: { purpose: 'run'|'edit'|'replay', since: string } | null,      // "rodando" = window != null
  handover: { to_device_id: string, to_name: string, mode: 'next_turn'|'force', requested_at: string } | null,
  diverged: { divergence_id: string, device_id: string, device_name: string, base: number, head: number, since: string } | null,
  event?: ChatStateEvent      // só no broadcast: o que acabou de acontecer
}
ChatStateEvent = { kind: 'host_dropped' | 'host_back' | 'host_changed' | 'handover_requested' | 'handover_cancelled'
                         | 'turn_started' | 'turn_ended' | 'diverged' | 'resolved' | 'pinned' | 'unpinned',
                   device_id?: string, cmd_id?: string, reason?: string }
```
O cliente DEVE mostrar `host_dropped` como **"O dispositivo remoto (<nome>) caiu"**.

Chats só ao vivo (§23) **nunca** têm linha em `chat_states` (nem `ChatState` no `welcome`, em `chat.state`
ou em `GET /chat-states`): o estado do host deles vem do vínculo em memória (`LiveChat.host`, §23.4).

### 8.3 Máquina de estados do host (por chat)

```mermaid
stateDiagram-v2
    [*] --> SemHost
    SemHost --> HostOnline: host.begin / push de replay por dispositivo can_host (vira host)
    HostOnline --> Rodando: host.begin (pelo host)
    Rodando --> HostOnline: host.end
    HostOnline --> Tolerancia: WS do host caiu
    Rodando --> Tolerancia: WS do host caiu (janela segue aberta)
    Tolerancia --> HostOnline: host reconecta < 10 s (hello.active_windows reabre a janela)
    Tolerancia --> HostOffline: 10 s sem reconectar → fecha janela, broadcast host_dropped
    HostOffline --> HostOnline: host reconecta (host_back)
    HostOnline --> TrocaPendente: host.takeover de outro dispositivo (host online)
    Rodando --> TrocaPendente: host.takeover (next_turn espera o turno; force para o turno)
    TrocaPendente --> HostOnline: host.release do host antigo / timeout do force / queda do host antigo → novo host (epoch+1)
    TrocaPendente --> Rodando: host.handover_cancel (volta ao estado anterior)
    HostOffline --> HostOnline: host.takeover (imediato, epoch+1)
    SemHost --> Divergente: push com base < head e conteúdo de outro dispositivo depois da base
    HostOnline --> Divergente: push de replay com base < head e conteúdo de outro dispositivo depois da base
    HostOffline --> Divergente: push de replay com base < head e conteúdo de outro dispositivo depois da base
    Divergente --> HostOnline: divergence/resolve
    Divergente --> HostOffline: divergence/resolve (host offline)
```

Transições (normativas):

1. **`host.begin`** `{chat_id, epoch, purpose}` pelo dispositivo D:
   - `diverged` → `chat_diverged`.
   - Sem host: se `D.can_host` → `host = D`, `epoch+1`, janela aberta (`became_host: true`); senão `cannot_host`.
   - Host = D e `epoch` confere → abre a janela (idempotente se já aberta por D). Resposta traz `head`:
     o cliente DEVE ter `cursor ≥ head` antes de rodar (senão puxa primeiro).
   - Host ≠ D → `not_host` (com o estado). Troca pendente para outro dispositivo → `handover_pending`.
   - Chat ainda sem estado e o usuário no teto de estados → `413 quota_exceeded` (`kind: 'chat_states'`, §7.10).
2. **`host.end`** `{chat_id, epoch}`: fecha a janela. O host DEVE ter recebido ack de todo o conteúdo
   do turno antes (outbox do chat vazia). Se houver troca pendente, a resposta traz `handover_pending: true`
   e o host DEVE fazer `host.release` em seguida.
3. **Queda do host** (fechamento ou 30 s sem tráfego): `grace` por `HOST_DROP_GRACE_S` (10 s); se
   reconectar e mandar `hello.active_windows` com o mesmo `epoch`, a janela continua. Expirou: janela
   fechada, `host.status = offline`, broadcast `event: host_dropped`. O host **não** muda.
   **Eventos** (o que o servidor transmite em `chat.state`):
   - entrada em tolerância: `chat.state` com `host.status = 'grace'` **sem** `event` (a UI PODE mostrar
     "reconectando…", mas não avisa queda);
   - fim da tolerância sem volta: `event: host_dropped` (→ "O dispositivo remoto (<nome>) caiu");
   - host reconecta (vindo de `grace` **ou** de `offline`): `event: host_back`. Se o host tinha janela
     aberta e não a reivindicou em `hello.active_windows` (ou o epoch não confere), a janela é fechada no
     mesmo estado (o `event` continua `host_back`; sem janela anterior em tolerância, `turn_ended`).
     Clientes DEVERIAM mostrar "<nome> voltou" só se tinham mostrado a queda (estado anterior `offline`).
4. **Reinício do servidor**: todas as conexões caem; a tolerância conta a partir do boot e vale
   `SERVER_RESTART_GRACE_S` (60 s).
5. **Revogação do dispositivo host** → `host = null` em todos os chats dele.

### 8.4 Regras de escrita do conteúdo do chat (push)

Um lote com `session`/`message` do chat X e `chat_bases[X] = b` é aceito se **todas**:
- X não está divergente;
- o `chat` X existe e não está apagado (ou é criado no mesmo lote);
- `b == head(X)` — ou `b < head(X)` e **todo** conteúdo (`session`/`message`, inclusive tombstones) de X
  com `seq > b` foi escrito pelo próprio D (ex.: chat novo grande enviado em vários lotes, todos com a
  `chat_bases` calculada antes do primeiro): não há outra história, então vale como `b == head`;
- e um dos modos:
  - **(A) janela do host**: há janela aberta em X, D é o host de X e o WebSocket de D está **conectado**
    (não em tolerância). `host_epochs[X]` é opcional; se vier, tem de ser o `epoch` atual.
  - **(B) replay**: não há janela aberta em X (por ninguém) — qualquer dispositivo. Um host que mande
    `host_epochs` certo com a janela fechada também cai aqui. Se X está sem host e `D.can_host`, D vira
    host (é quem rodou por último; `epoch+1`, `event: host_changed`). Execução offline **não** troca o host.

Falhas (verificadas nesta ordem):
- X divergente → `chat_diverged`.
- `b > head` → `stale_base` (bug do cliente: puxar e recalcular; `details.head`).
- `b < head` → se `(chat, D, b)` estiver em `divergence_discards`: `divergence_discarded`
  (`details: { chat_id, divergence_id }`). Senão, se algum conteúdo de X com `seq > b` foi escrito por
  **outro** dispositivo, o servidor marca a **divergência** (§9) e responde `chat_diverged`; se todo ele é
  do próprio D, segue para as checagens abaixo como se `b == head`.
- `host_epochs[X]` presente mas D não é o host / epoch velho → `not_host` (o cliente passa a tratar o
  conteúdo como replay).
- Janela aberta e D não é o host, **ou** D é o host mas o WebSocket dele está em tolerância (ex.: push
  por REST com o WS caído) → `chat_busy` (tentar de novo quando a janela fechar / o WS voltar; se nesse
  meio-tempo o `head` avançar, vira divergência, que é o correto).

Toda mutação de conteúdo **online** (rodar turno, editar/apagar mensagem, regenerar, trocar de versão —
`branchSel`, §4.3.7 —, compactar, extrair memórias — que grava a mensagem de extração) acontece **no host, dentro de uma janela**. Num controle
remoto, essas ações viram comandos (§8.6).

### 8.5 Turno normal no host

1. Usuário envia no host (ou chega um comando `send`). Chat ocioso → `host.begin {purpose: 'run'}`.
2. Runner roda como hoje; cada mensagem persistida entra na outbox e é enviada (lotes a cada ~250 ms,
   `chat_bases[X] = head` corrente, `host_epochs[X] = epoch`). Ack → `head` novo. O app atualiza
   `chat.updatedAt` a cada mensagem, então o registro `chat` (LWW) também é reenviado durante o turno —
   comportamento aceito (um lote LWW separado, coalescido pela outbox).
3. Eventos efêmeros vão pelo stream (§11).
4. Chat ocioso (nenhuma sessão rodando/esperando, inclusive subagentes em segundo plano; nenhuma
   aprovação/questionário/retry pendente) e outbox vazia → `host.end`.

Sem conexão no meio do turno: o host continua rodando localmente. Se reconectar em < 10 s, a janela
continua. Senão, o conteúdo pendente vira replay: ao reconectar, `host.begin` de novo (ainda é host) e
envia; se alguém assumiu e rodou nesse meio-tempo, diverge.

### 8.6 Comandos remotos

Controle remoto → `remote.send` → servidor → host (`remote.command`) → host executa → `remote.result`
→ servidor → quem enviou. Payload cifrado com `K_stream` e AAD de comando (§3.10); `kind` em claro.
O servidor só repassa os `kind` desta tabela (outro → `invalid_request`), então um `kind` novo exige o
servidor atualizado antes dos clientes.

| `kind` | Plaintext (`sv: 1` + …) | Equivalente no app |
|---|---|---|
| `send` | `{ sessionId, text, attachments: AttachmentInfo[], skills: string[], createdAt, meta?: InterChatSendMeta }` | `agent.send` (rodando → fila; ocioso → turno); com `meta` (desde 1.6.0) = `send_to_chat` de um agente em outro dispositivo |
| `force` | `{ sessionId, text, attachments, skills, createdAt }` | enviar já com ⚡ (`send` + `forceSend`) |
| `queue.force` | `{ sessionId, queuedId }` | `agent.forceSend` |
| `queue.remove` | `{ sessionId, queuedId }` | `agent.removeQueued` |
| `stop` | `{ sessionId }` | `agent.stop` |
| `stop_subagents` | `{}` | `agent.stopSubagents(chatId)` |
| `approval` | `{ requestId, decision: 'allow'\|'deny', items?: ApprovalItemDecision[] }` | `agent.approve` |
| `smart_override` | `{ messageId }` | `agent.smartOverride` |
| `question` | `{ requestId, answers?: QuestionAnswer[], cancel?: true }` | `questions.answer` / `cancel` |
| `retry` | `{ requestId, action: 'retry'\|'cancel' }` | `retries.retry` / `cancel` |
| `regenerate` | `{ sessionId }` | `agent.regenerate` (desde 1.2.0: nova versão da resposta do último turno, como `branch.regenerate` sem `messageId`) |
| `message.edit` | `{ messageId, message: ApiMessage }` | `messages.update` (edição no lugar; ver regras) |
| `message.delete` | `{ messageId }` | `messages.delete` |
| `compact` | `{ sessionId, opts?: CompactOptions }` | `agent.compact` |
| `memory.extract` | `{ sessionId }` | `memory.extractNow` |
| `branch.edit` | `{ messageId, message: ApiMessage }` | `agent.editBranch` (desde 1.2.0: nova versão de uma mensagem do usuário — irmã com a mesma mãe — e roda o turno) |
| `branch.regenerate` | `{ sessionId, messageId? }` | `agent.regenerate(sessionId, messageId?)` (desde 1.2.0: nova versão da resposta do turno que contém `messageId`; sem ele, o último turno) |
| `branch.select` | `{ messageId }` | `agent.selectBranch` (desde 1.2.0: torna `messageId` a versão ativa — grava `branchSel`, §4.3.7) |
| `fs.list` | `{ chatId, path }` | aba Arquivos (`fs.listDir`) do chat no host (desde 1.3.0; só leitura, sem janela — ver "Arquivos do host") |
| `fs.read` | `{ chatId, path, offset, length }` | visualizador de arquivos do host, um pedaço por comando (desde 1.3.0; só leitura, sem janela) |
| `history.list` | `{ chatId, type: 'chat'\|'session'\|'message', sessionId?, after: string \| null, limit? }` | histórico de um chat só ao vivo, paginado (desde 1.8.0; só leitura, sem janela — §23.5) |
| `history.changes` | `{ chatId, since: number }` | o que mudou num chat só ao vivo depois de `lseq = since` (desde 1.8.0, §23.5) |
| `history.item` | `{ chatId, items?: [{ type, id }], piece?: { type, id, offset } }` | itens por id, ou um pedaço de um item grande (desde 1.8.0, §23.5) |
| `chat.update` | `{ chatId, title?: string, config?: Partial<ChatConfig> /* sem cwd */ }` | renomear / editar a config de um chat só ao vivo (desde 1.8.0, §23.7; nos chats online isso é o registro `chat`, §4.3.6) |
| `attach.put` | `{ chatId, uploadId, name, mime?, size, sha256, offset, data }` ou `{ chatId, uploadId, cancel: true }` | anexo de um chat só ao vivo enviado **ao host** em pedaços, sem blob no servidor; o último pedaço devolve o `AttachmentInfo` salvo no host (desde 1.8.0, §23.7) |
| `attach.get` | `{ chatId, file, offset, length }` | bytes de um anexo do host mostrado no histórico de um chat só ao vivo, um pedaço por comando, como `fs.read` (desde 1.8.0, §23.7) |

Regras:
- **Origem entre chats (desde 1.6.0)**: o `send_to_chat` de um agente cujo chat de destino é
  executado em **outro** dispositivo vira um `send` remoto com
  `meta: { kind: 'inter-chat', fromChatId, fromSessionId?, fromChatTitle, interChatHops }` (os mesmos
  campos de `MessageMeta` da entrega local). `text` continua com o cabeçalho
  `[Mensagem do chat "<título>" (id <id>)…]` na primeira linha, então um host < 1.6.0 (que ignora
  `meta`) recebe a mensagem como digitada mas o modelo ainda sabe a origem.
  - Remetente: só envia `meta` quando o host do destino está `online`; host `grace`/`offline`, chat
    divergente ou sem conexão com o destino rodando em outro lugar → a tool recusa (NUNCA entrega
    localmente: criaria conteúdo só deste dispositivo e levaria à divergência, §9). Sem fila no
    servidor (como todo comando). `skills: []` e `attachments: []`.
  - Host ≥ 1.6.0: `meta` com `kind: 'inter-chat'`, `fromChatId` string não vazia (≤ 100 caracteres) e
    `interChatHops` inteiro ≥ 1 ⇒ grava a mensagem do usuário com esse meta (título normalizado e cortado
    em 200 caracteres; `fromSessionId` só se for string válida) — a bolha "De: <chat>" e a contagem de
    saltos funcionam como na entrega local. `interChatHops` acima de `LIMITS.interChatMaxHops` (3) ⇒
    `rejected` com `error` em texto. `meta` ausente, de outro `kind` ou malformado ⇒ ignorado (a
    mensagem segue como digitada, nunca recusada por isso). `skills` é ignorado quando há `meta`.
  - Espera da resposta (`wait_for_reply`): não faz parte do comando. Um remetente PODE ler a resposta
    dos registros sincronizados depois que a janela do host fechar (o app mobile faz isso); o desktop
    responde que aguardar um chat de outro dispositivo não é suportado e a resposta fica lá.
  - Segurança: nada de capacidade nova — qualquer dispositivo da conta já pode mandar um `send` com esse
    texto; o `meta` só muda a exibição e a contagem de saltos (que só pode **limitar** a cadeia). O
    celular continua recusando comandos remotos nos chats que ele executa (decisão de produto do app
    mobile): o motivo volta ao agente remetente como erro da tool.
- `skills`: nomes; o **host** resolve e lê o `SKILL.md` (as skills que valem são as do host — o host
  publica a lista no snapshot do stream, §11, para a lâmpada do controle remoto).
- `attachments`: o controle remoto sobe os blobs **antes** de enviar; o host baixa pelo sha256 (§14)
  antes de aceitar. Falta blob → `rejected` com `error: 'attachment_missing'`.
- **Versões (desde 1.2.0)**: `branch.edit`, `branch.regenerate` e `branch.select` são comandos de
  conteúdo como `message.edit`/`regenerate`: o host os executa dentro de uma janela (`purpose: 'run'`
  para `branch.edit`/`branch.regenerate`, que rodam um turno; `'edit'` para `branch.select`) e grava as
  revisões nela (§8.4). O host recusa (`rejected`) trocar de versão com a sessão ocupada (rodando,
  esperando aprovação/resposta/retry) ou com um subagente em segundo plano iniciado abaixo da bifurcação
  ainda rodando. `regenerate` (sem prefixo) passa a significar o regenerar **em ramo** do último turno —
  nada é apagado. Um host ≥ 1.2.0 (app 0.7) **recusa `message.edit`** numa mensagem digitada pelo
  usuário da sessão principal (role `user`, não sintética, sem `kind` ou `queued`/`forced`), com `error`
  em texto pedindo para atualizar o app, para um controle remoto antigo não sobrescrever o histórico;
  as outras mensagens (assistente, sintéticas, entre chats, marco de compactação) continuam com
  `message.edit`. Controles remotos ≥ 1.2.0 DEVEM mandar `branch.edit` para mensagens do usuário e
  `branch.regenerate` (nunca `regenerate`): um host antigo recusa o kind desconhecido em vez de apagar
  as outras versões. O site não manda comandos: nele, trocar de versão é só na tela (§4.3.7).
- **Arquivos do host (desde 1.3.0)**: `fs.list` e `fs.read` deixam um controle remoto navegar pela aba
  Arquivos do chat e abrir arquivos no visualizador com os bytes vindos do host, cifrados de ponta a
  ponta como qualquer comando. **Não** são comandos de conteúdo: não abrem janela, não gravam nada, são
  aceitos com o agente rodando e o host NÃO os deduplica (repetir uma leitura é inofensivo).
  - Regras de caminho: o host aplica **exatamente** as regras da aba Arquivos e das tools de leitura
    daquele chat **nele**: raiz = diretório raiz do chat no host (`config.cwd` local do host, §4.4);
    `path` relativo resolve contra a raiz, `~` = home do host, vazio (`fs.list`) = a raiz; com
    `confineToRoot` (padrão) nada fora da raiz depois de `realpath` (`..`, caminho absoluto de fora ou
    symlink apontando para fora → recusado); sem confinamento, o mesmo que a aba Arquivos do host já
    mostra localmente. `fs.read` só lê **arquivo comum** (diretório, FIFO, dispositivo, socket →
    recusado) e confere tudo de novo a cada pedaço. `payload.chatId` DEVE ser igual ao `chat_id` do
    frame (a AAD já amarra o chat; diferente → recusado).
  - `fs.list` → resultado `{ sv: 1, status: 'accepted', dir, root, confine, truncated, entries: [{ name,
    kind: 'file'|'dir', size?, mtime? }] }`: `dir` = pasta listada (absoluta, no formato do host), `root`
    e `confine` = raiz e confinamento do chat no host (o controle remoto mostra a raiz do host, não a
    sua), pastas primeiro; no máximo `FS_LIST_MAX_ENTRIES` entradas e ~600 KiB de JSON (acima:
    `truncated: true`). `size` só em arquivos; `mtime` em ms Unix.
  - `fs.read` → resultado `{ sv: 1, status: 'accepted', size, mtime, mime?, offset, data }`: `data` =
    base64 (padrão, com `=`) de até `FS_READ_CHUNK_BYTES` bytes a partir de `offset` (o host corta
    pedidos maiores; além do fim → `data: ""`; `length: 0` = só `size`/`mtime`); `size`/`mtime` atuais
    do arquivo (o controle remoto confere em cada pedaço — mudou no meio → recomeça ou avisa); `mime`
    (tipo detectado pelo host) só no pedaço com `offset: 0`. O host recusa ler a partir de
    `FS_READ_MAX_FILE_BYTES` (um pedido que cruza o teto é cortado nele). Com `FS_READ_CHUNK_BYTES` =
    512 KiB, o envelope do `remote.result` fica em ~0,7 MiB — abaixo de `COMMAND_MAX_BYTES` e do frame
    de 4 MiB. O controle remoto DEVERIA manter poucos pedaços em voo (o app usa 3) para não encher a
    fila de envio da sua conexão no servidor (que fecha com `4429` quando ela estoura).
  - Recusa: `{ sv: 1, status: 'rejected', error: '<texto pt-BR>', code?: 'denied'|'missing'|'invalid'|'too_large' }`
    (`denied` = fora da raiz confinada / sem permissão; `missing` = não existe / não é arquivo comum /
    não é pasta; `too_large` = além do teto). Host < 1.3.0 recusa com `error: 'comando desconhecido:
    fs.…'` e o controle remoto mostra "atualize o app no host"; servidor < 1.3.0 recusa o `kind` com
    `invalid_request`.
  - Segurança: só dispositivos da **mesma conta** mandam comandos (autenticação do WebSocket, §10) e
    só ao host atual do chat; revogar o dispositivo corta o acesso na hora (4403, §5.4). Não há
    capacidade nova: um controle remoto já pode pedir ao agente do host que leia/liste esses mesmos
    arquivos (`read_file`/`list_dir` com as mesmas regras); `fs.*` só dispensam o modelo. O servidor vê
    o `kind`, quem pediu e o tamanho dos envelopes (dá para estimar o tamanho do arquivo pela soma dos
    pedaços), nunca nomes, caminhos nem conteúdo. O site não usa estes comandos (ainda).
- **Só com o host online** (`host.status = online`): com host `grace`/`offline` → erro `host_offline` na
  hora; sem host → `no_host` (quem pode hospedar roda localmente, §8.7). Nada é guardado no servidor.
- Entrega **no máximo uma vez**: o servidor mantém o comando só em memória, enquanto espera o resultado.
  Se o host cair antes do `remote.result`, ou não responder em `COMMAND_RESULT_TIMEOUT_S` (30 s), quem
  enviou recebe `remote.failed {code: 'host_offline' | 'command_timeout'}` e mostra um erro claro
  ("O host (<nome>) caiu antes de confirmar — a mensagem pode não ter sido entregue"), mantendo o texto
  no composer. O host DEVERIA deduplicar por `cmd_id` (reenvio manual reaproveita o id).
- Resultado (`remote.result`, cifrado com AAD de resultado): `{ sv: 1, status: 'accepted'|'rejected'|'duplicate', queued?: boolean, error?: string }`
  (`fs.list`/`fs.read` acrescentam os campos acima). O envelope do resultado tem o mesmo teto
  `COMMAND_MAX_BYTES` do comando.
- Com o chat divergente → `chat_diverged`.
- O controle remoto mostra a mensagem como "enviando…" até `accepted`.
- **Chats só ao vivo (desde 1.8.0)**: todos os kinds acima valem, roteados pelo vínculo em memória em vez
  de `chat_states` (host `online` → entrega; `grace` → `host_offline`; sem vínculo nem estado → `no_host`;
  nunca `chat_diverged`). `history.*`, `chat.update` e `attach.*` só valem para chats com vínculo ao vivo
  (senão `invalid_request`). Neles, `send.attachments`/`force.attachments` referenciam anexos que **já
  estão no host** (recebidos por `attach.put` ou já citados no chat) — nada de blob (§23.7). Detalhes em
  §23.5–§23.7.

### 8.7 Host offline: só "Executar neste dispositivo"

Com o host `offline` (ou em `grace`), controles remotos **não podem enviar mensagens nem qualquer
comando**. O composer fica desabilitado com a faixa **"O host (<nome>) está offline"** e uma única ação:
**"Executar neste dispositivo"** → `host.takeover` (imediato, §8.8), com o aviso de ferramentas locais
(§8.9) e, se o host estiver fixado, a confirmação extra. Não existe "aguardar", fila guardada no servidor,
expiração nem entrega na reconexão.
- Chat sem host: o primeiro `send` vira execução local (o dispositivo vira host) — sem pergunta. Site
  (`can_host=false`) sem host online: composer desabilitado com "O host está offline — abra este chat num
  dispositivo que possa executá-lo".
- Chat só ao vivo (§23): não há "Executar neste dispositivo" (a única cópia está no host). Host em `grace`
  → composer desabilitado com "Reconectando a <host>…"; tolerância expirada → o chat some dos outros
  dispositivos (§23.4).

### 8.8 Trocar de host ("Executar neste dispositivo")

`host.takeover { chat_id, mode: 'next_turn' | 'force', confirm_pinned: boolean }` pelo dispositivo N
(não existe para chats só ao vivo: `host.takeover`/`host.pin`/`host.begin` num chat com vínculo ao vivo →
`409 live_conflict`, §23.3):

- N sem `can_host` → `cannot_host`; divergente → `chat_diverged`; `pinned && !confirm_pinned` → `host_pinned`;
  chat ainda sem estado com o usuário no teto de estados → `quota_exceeded` (`kind: 'chat_states'`, §7.10).
- **Host offline / sem host** → concedido na hora: `host = N`, `epoch+1`, janela fechada; N recebe
  `host.granted {epoch, head}`.
- **Host em `grace`** → troca pendente; se o host voltar, recebe o pedido; se expirar, concede a N.
- **Host online** → `handover` pendente; o host recebe `host.handover_request {to_device_id, mode}`:
  - `next_turn` (padrão): o host termina o turno atual **sem** puxar mais nada da fila — repassa os itens
    ainda não injetados da fila local para o novo host — espera ficar ocioso (inclusive subagentes) e faz
    `host.release`. Sem timeout enquanto o host estiver online; N vê "aguardando o fim do turno em <host>
    — **Forçar agora** · Cancelar" (forçar = novo `host.takeover` com `force`).
  - `force`: o host para tudo (`agent.stop` em todas as sessões, subagentes inclusive — parciais
    persistidos como hoje), envia o que falta e faz `host.release`. Se não liberar em
    `HANDOVER_FORCE_TIMEOUT_S` (20 s), o servidor concede mesmo assim (escritas atrasadas do antigo host →
    `not_host` → replay → divergência, se houver).
  - Host antigo cai durante a troca pendente → ao fim da tolerância, concede a N.
- `host.release { chat_id, epoch, forwarded: [{ cmd_id, env }] }`: o host antigo repassa a fila local
  como comandos `send` (cifrados por ele, `cmd_id` novos) — o servidor os retransmite ao novo host logo
  após o `host.granted` (em trânsito, como qualquer comando: se N não estiver conectado, o antigo host
  recebe `remote.failed` e mostra os textos como não entregues).
  O servidor concede a N (`host.granted`), avisa o antigo (`host.revoked {reason: 'handover'}`) e
  transmite `event: host_changed`.
- `host.release` **sem** troca pendente: o chat fica **sem host** (`host = null`, `epoch+1`, janela
  fechada; broadcast `event: host_changed` com `reason: 'released'` e `device_id` = quem liberou). Itens
  em `forwarded` nesse caso não têm destino: o remetente recebe `remote.failed {host_offline}` para cada um.
- `host.handover_cancel { chat_id }` (por N ou pelo host) desfaz a troca pendente.
- Ao virar host, N DEVE: puxar até `head`; resolver a raiz local do chat (se não tiver `cwd` local para
  esse chat → pedir a pasta, padrão `defaultCwd`); atualizar `chat.hostCwd`; então processar os itens repassados.

### 8.9 Avisos de ferramentas locais e "fixar host"

- `usesLocalTools(chat)` = `config.enabledTools` contém alguma de `list_dir, read_file, search_files,
  find_files, write_file, edit_file, shell, process_start, process_logs, process_list, process_stop`
  (também em `config.voice.tools.enabledTools`, as tools liberadas na chamada de voz — desde 1.5.0), **ou**
  `config.skills.enabled`.
- Ao assumir/trocar o host de um chat com ferramentas locais, o cliente DEVE mostrar um aviso forte:
  *"Este chat usa ferramentas locais (diretório raiz `<hostCwd.path>` no `<host>`). Executar no
  `<este dispositivo>` pode rodar comandos no lugar errado."* — confirmação explícita. Chats sem
  ferramentas locais trocam livremente (sem aviso).
- Mobile (`can_host`): até 1.9.0 DEVERIA recusar ser host de chats com ferramentas locais. Desde 1.10.0
  hospeda o chat **sem elas** (§4.3.6, "Tools de um tipo de aparelho"); ao assumir um chat com
  ferramentas locais o aviso forte diz que elas ficam desligadas enquanto o celular for o host
  ("Este chat usa ferramentas locais (diretório raiz `<hostCwd.path>` no `<host>`); no celular ele roda
  sem elas."), com confirmação explícita.
- **Fixar host** (`host.pin {chat_id, pinned}`), por chat, qualquer dispositivo: com o host fixado,
  "Rodar aqui" fica escondido atrás de "Executar neste dispositivo mesmo assim…" e o servidor exige
  `confirm_pinned: true` no `host.takeover`. Visível em `ChatState.pinned` (selo de cadeado). Como
  `host.begin`/`host.takeover`, pode criar o estado do chat e cair no teto (`quota_exceeded`, `kind: 'chat_states'`).

---

## 9. Divergência

### 9.1 Quando acontece

Duas histórias do mesmo chat produzidas sem uma ver a outra:
- execução offline num dispositivo enquanto outro (host ou quem assumiu) rodou online;
- host que caiu com mensagens não enviadas, alguém assumiu e rodou, e o antigo volta;
- dois dispositivos offline no mesmo chat.

Não acontece em chats só ao vivo (§23): só existe a cópia do host e nada é reenviado por replay.

Detecção **só no servidor**: push de conteúdo com `chat_bases[X] < head(X)` (§8.4) quando há conteúdo de X
com `seq > chat_bases[X]` escrito por **outro** dispositivo (se tudo depois da base é do próprio
remetente, não há duas histórias e não diverge). O servidor grava
`diverged = { divergence_id (uuid), device_id = quem enviou, base = b, head = head atual, since }` e
transmite `event: diverged`.

### 9.2 Enquanto divergente

- **Nada é salvo online para esse chat**: o servidor recusa push de `session`/`message` **e** do
  registro `chat` (exceto a exclusão do chat), `host.begin` e comandos (`chat_diverged`).
- Todos os dispositivos mostram o selo **"divergente"**. No dispositivo D (o que tem a versão local),
  o chat abre com o seletor "**Versão online** · **Versão deste dispositivo**" (as duas navegáveis) e a
  escolha "Manter esta como a versão online". Nos outros: "Divergente — resolva em <D>" + "Descartar a
  versão de <D>" (= manter a online).
- **Aviso obrigatório antes de descartar** (diálogo de confirmação em qualquer dispositivo):
  *"A outra versão será apagada. Mensagens que só existem nela (N mensagens desde <data>) serão perdidas
  e não poderão ser recuperadas."* — botões "Apagar a outra versão e manter esta" / "Cancelar".
- Em D, enquanto o chat tiver conteúdo local pendente, mudanças remotas de conteúdo desse chat **não**
  são aplicadas nas tabelas locais (só avançam o cursor e marcam o chat "precisa rebaixar"); a versão
  online é baixada inteira na resolução (`GET /records?scope=X`).

### 9.3 Resolução

`POST /chats/{X}/divergence/resolve`:
```ts
{ divergence_id: string, keep: 'online' | 'local', push_id?: string, items?: PushItem[] }
```
- **`keep: 'online'`** (qualquer dispositivo): sem itens. O servidor limpa `diverged` e grava em
  `divergence_discards (chat_id, device_id = D, base)`. D (agora, ou quando reconectar — o próximo push
  dele com a mesma `base` recebe `divergence_discarded`) **apaga a sua versão local** (sessões e mensagens
  que não estão online, outbox desse chat) e baixa a versão online (`GET /records?scope=X`).
- **`keep: 'local'`** (só D): D baixa a lista online (`GET /records?scope=X`) e envia em `items` o lote que
  transforma o online no local: puts das suas sessões/mensagens (`base_rev` = rev online, ou 0 se novo) e
  tombstones das que só existem online, + o registro `chat` se mudou. O servidor confere `divergence_id`
  e `device_id == D`, aplica atômico (regras de rev normais, sem a checagem de `head`), limpa `diverged`,
  atualiza `head` e transmite. A versão online anterior é **descartada** (os outros dispositivos aplicam
  os tombstones normalmente).
- Nenhuma cópia da versão perdedora é mantida, em nenhum dispositivo.
- `divergence_id` velho → `409 divergence_mismatch`. O host não muda na resolução (se não houver host,
  D vira host em `keep: 'local'`).
- Só uma divergência ativa por chat. Um terceiro dispositivo com versão própria recebe `chat_diverged`
  e espera; depois da resolução, o push dele (base velha) gera a próxima divergência.

---

## 10. WebSocket

### 10.1 Conexão

- URL: `<base>/ws` com o esquema trocado (`https` → `wss`, `http` → `ws`; ex.:
  `wss://clear.ezenere.com/ws`, `ws://192.168.0.10:8080/clearchat/ws`). Sem token na URL. Frames de texto JSON; máx. 4 MiB por frame
  (pushes maiores: REST).
- Primeiro frame do cliente em até 10 s: `hello`. Uma conexão por dispositivo: uma nova do mesmo
  `device_id` fecha a anterior com `4409 superseded`.
- Formato: `{ "t": "<tipo>", "id"?: "<id do cliente>", ...campos }`. Toda **requisição** do cliente tem
  `id` e recebe exatamente um `ack` ou `error`. Os campos do resultado ficam **no nível de cima do frame**,
  ao lado de `t` e `re` (não há objeto aninhado): ex. `{"t":"ack","re":"7","epoch":8,"head":905,"became_host":true}`,
  `{"t":"error","re":"7","code":"not_host","message":"…","details":{…}}`. O `welcome` é o `ack` do
  `hello` (`{"t":"welcome","re":"<id do hello>",…}`); `pong` traz `re` se o `ping` tinha `id`. Eventos do
  servidor não têm `re`. Nas tabelas abaixo, a coluna `ack` lista esses campos de nível superior.

### 10.2 Confiabilidade

- **Registros**: estado pelo cursor — eventos `sync.changes` perdidos são recuperados por pull.
- **Estados de chat**: `chat.state` traz o estado completo e `ssq`; na reconexão, `hello.state_cursor`
  faz o `welcome` trazer todos os estados com `ssq` maior.
- **Comandos**: só com o host online; perda de conexão do host antes do resultado → `remote.failed` para
  quem enviou (§8.6). Nunca reentregues.
- **Stream**: `n` contíguo por janela + snapshot sob pedido (§11).
- **Heartbeat**: o cliente manda `ping` a cada 15 s; o servidor responde `pong`. Sem `pong` em 10 s → o
  cliente reconecta. O servidor considera a conexão morta após 30 s sem nenhum frame.
- **Reconexão**: backoff exponencial com jitter total: `delay = random(0, min(30 s, 1 s · 2^tentativa))`;
  zera após 60 s conectado. `4401` → refresh do token e reconecta já; `4403` → parar (dispositivo
  revogado / conta desativada: apagar credenciais e DEK) — **exceto** logo após `keys.reset` (abaixo);
  `4001` → protocolo incompatível (avisar "atualize o app"); `4409` → não reconectar automaticamente
  (outra instância assumiu); `1000` → fechamento normal (inclusive ociosidade: o servidor fecha com
  `1000 idle_timeout` após 30 s sem frames) → reconectar com o backoff normal.
- **`keys.reset`**: o servidor envia `keys.reset` a todas as conexões e logo depois fecha cada uma com
  `4403`, mas **não** revoga dispositivos nem tokens. O cliente que recebeu `keys.reset` apaga DEK e
  estado de sync, e trata um `4403` recebido **até 30 s depois** do `keys.reset` como "refazer
  desbloqueio/setup" (não como revogação): reconecta com o mesmo token quando houver chaves novas
  (`keys_ready` volta a `true` após o setup) e faz o merge do primeiro login (§12). Os cursores antigos
  passam a receber `410 cursor_expired` (o reset apaga sem tombstones e sobe o piso até o `seq` atual).
- **`hello.cursor`** é informativo (o servidor não reenvia nada a partir dele; `welcome.head` diz até onde
  puxar). O site manda `cursor: 0` sem que isso seja um pedido de replay.

### 10.3 Handshake

Cliente → `hello`:
```json
{ "t": "hello", "id": "1", "protocol": 1, "access_token": "cca_…", "cursor": 1200, "state_cursor": 88,
  "active_windows": [{ "chat_id": "…", "epoch": 7 }], "subscriptions": ["<chat_id aberto>"],
  "caps": ["live_chats"] }
```
Servidor → `welcome` (como `ack` do hello):
```json
{ "t": "welcome", "re": "1", "protocol": 1, "user_id": "…", "device_id": "…", "head": 1300,
  "server_time": "2026-10-19T12:00:00.000Z", "chat_states": [ChatState], "state_cursor": 95,
  "resumed_windows": ["<chat_id>"], "lost_windows": ["<chat_id>"], "keys_rev": 3, "caps": ["live_chats"] }
```
Depois do `welcome`, o servidor já transmite eventos ao vivo; o cliente puxa de `cursor` até `head`
(guardando os `sync.changes` que chegarem nesse meio-tempo e aplicando depois os de `seq > cursor`).

`caps` (desde 1.8.0, opcional): capacidades opcionais que o cliente entende; o `welcome` devolve as que
o servidor aceitou para esta conexão. Hoje só `"live_chats"` (§23): o servidor só manda `live.*` a
conexões que a declararam, e o cliente só usa `live.*`/`history.*`/`chat.update` se ela voltou no
`welcome`. Servidores < 1.8.0 ignoram o campo e não o devolvem; clientes < 1.8.0 não o mandam (nunca
recebem nada de chats ao vivo). Valores desconhecidos são ignorados.

### 10.4 Catálogo — cliente → servidor (requisições com `id`)

| `t` | Campos | `ack` |
|---|---|---|
| `hello` | §10.3 | `welcome` |
| `ping` | `ts?` | `pong` (sem `re` obrigatório) |
| `sync.pull` | `since, limit?, payload?` | `{ changes, next, has_more, head }` |
| `sync.fetch` | `items: [{type, id}]` | `{ records: [Change] }` (~8 MiB; pedir de novo os `omitted`, §7.2) |
| `sync.push` | corpo do push (§7.4) | resposta do push |
| `host.begin` | `chat_id, epoch \| null, purpose: 'run'\|'edit'\|'replay'` | `{ epoch, head, became_host }` (`host.begin`, `host.takeover` e `host.pin` podem dar `quota_exceeded` `kind: 'chat_states'`, §7.10) |
| `host.end` | `chat_id, epoch` | `{ handover_pending: boolean }` |
| `host.takeover` | `chat_id, mode: 'next_turn'\|'force', confirm_pinned` | `{ status: 'granted'\|'pending', epoch?, head? }` |
| `host.handover_cancel` | `chat_id` | `{}` |
| `host.release` | `chat_id, epoch, forwarded: [{cmd_id, env}]` | `{}` |
| `host.pin` | `chat_id, pinned` | `{ ssq }` |
| `remote.send` | `chat_id, cmd_id, kind, env` | `{ status: 'delivered' }` (ou erro `host_offline`/`no_host`/`chat_diverged`) |
| `remote.result` | `chat_id, cmd_id, env` (host) | `{}` |
| `stream.subscribe` | `chat_ids: string[]` | `{}` (o servidor pede snapshot aos hosts) |
| `stream.unsubscribe` | `chat_ids: string[]` | `{}` |
| `stream.event` | `chat_id, epoch, n, env` (host; **sem `id`, sem ack**) | — |
| `stream.resync` | `chat_id` (controle remoto) | `{}` |
| `live.announce` | `full: boolean, chats: [{ chat_id, epoch, arev, running, env }]` (host; desde 1.8.0, §23.4) | `{ accepted: [chat_id], rejected: [{ chat_id, code }] }` |
| `live.withdraw` | `chat_ids: string[] \| null, reason: 'deleted'\|'quit'\|'withdrawn'` (host; §23.4) | `{}` |
| `live.list` | — (§23.4) | `{ chats: [LiveChat], settling_s }` |
| `live.refresh` | `host_device_id?` (§23.4) | `{}` (o servidor pede reanúncio aos hosts) |

### 10.5 Catálogo — servidor → cliente (eventos)

| `t` | Campos | Para quem |
|---|---|---|
| `welcome` | §10.3 | a conexão |
| `pong` | `ts?` | a conexão |
| `ack` / `error` | `re`, … | quem pediu |
| `sync.changes` | `changes: [Change], head` (payload inline até 256 KiB por mensagem; acima, `omitted`) | todas as conexões do usuário |
| `chat.state` | `ChatState` (com `event`) | todas as conexões do usuário |
| `host.granted` | `chat_id, epoch, head` | novo host |
| `host.revoked` | `chat_id, epoch, reason: 'handover'\|'takeover'\|'device_revoked'` | host antigo |
| `host.handover_request` | `chat_id, epoch, to_device_id, to_name, mode` | host atual |
| `remote.command` | `chat_id, cmd_id, kind, env, from_device_id, created_at` | host |
| `remote.result` | `chat_id, cmd_id, env` | quem enviou o comando |
| `remote.failed` | `chat_id, cmd_id, code: 'host_offline'\|'command_timeout'` | quem enviou o comando |
| `stream.event` | `chat_id, epoch, n, env, device_id` | conexões inscritas no chat |
| `stream.resync_request` | `chat_id, requester_device_id` | host |
| `live.update` | `chats: [LiveChat]` (desde 1.8.0, §23.4) | conexões do usuário com `caps` `live_chats`, menos o host |
| `live.removed` | `host_device_id, chat_ids, reason: 'deleted'\|'host_quit'\|'withdrawn'\|'host_dropped'\|'saved_online'\|'device_revoked'` (§23.4) | idem |
| `live.host` | `host_device_id, status: 'online'\|'grace'` (§23.4) | idem |
| `live.refresh_request` | `requester_device_id` (§23.4) | host(s) com chats ao vivo |
| `keys.changed` | `keys_rev` | todas |
| `keys.reset` | — | todas (depois fecha `4403`, sem revogar dispositivos — §10.2) |
| `account.deleted` | — | todas (depois fecha `4403`) |

Códigos de fechamento: `4000 protocol_error`, `4001 unsupported_protocol`, `4002 hello_timeout`,
`4401 unauthorized` (token expirado/ inválido), `4403 forbidden` (revogado, conta banida/apagada,
chaves resetadas — §10.2), `4409 superseded`, `4429 rate_limited`, `1000` normal/ociosidade, `1001` reinício
do servidor.

---

## 11. Streaming ao vivo

- Só o host envia `stream.event`. O servidor confere que quem envia é o host atual e que `epoch` é o atual
  — **com ou sem janela aberta** (ex.: o `snapshot` que responde a um `stream.resync` com o chat ocioso,
  como no início de §16.5) — e retransmite só para as conexões **inscritas** no chat (chat aberto na
  tela), exceto a do próprio host. Eventos inválidos ou acima de ~50/s por chat são descartados em
  silêncio (sem ack). Nada é persistido. Num chat só ao vivo (§23), "host atual" e "`epoch` atual" são os
  do vínculo em memória (`epoch` ao vivo, escolhido pelo host — §23.3).
- `n`: contador do host por `(chat, epoch)`, começa em 1, +1 por evento. Plaintext cifrado com
  `K_stream` e AAD `…|stream|<user>|<chat>|<epoch>|<n>`.
- Plaintext (`sv: 1`) — `kind`:

| `kind` | Campos | Origem (`AgentEvent` do app) |
|---|---|---|
| `snapshot` | `{ sessions: { [sessionId]: { status, draft: StreamDraft \| null, tools: { [toolCallId]: { running, output?, judging? } }, compaction: { state, text? } \| null } }, queues: { [sessionId]: QueuedMessage[] }, approvals: ApprovalRequest[], questions: QuestionRequest[], retries: RetryRequest[], processes: ProcessInfo[], skills: { name: string, description: string }[] }` | estado completo do host |
| `draft.delta` | `{ sessionId, streamId, off: { content, reasoning }, append: { content?, reasoning? }, toolCalls?: [{ index, id?, name?, argsAppend? }] }` | `draft` (diferença) |
| `draft.end` | `{ sessionId, streamId }` | `draft` com `null` |
| `session` | `{ session: Session }` | `session-created/updated` (status ao vivo) |
| `tool` | `{ sessionId, toolCallId, running, output?, judging? }` | `tool-running` |
| `queue` | `{ sessionId, queue: QueuedMessage[] }` | `queue-updated` (inclui mensagens vindas de comandos remotos) |
| `approval.requested` / `approval.resolved` | `{ request }` / `{ id }` | idem |
| `question.requested` / `question.resolved` | `{ request }` / `{ id }` | idem |
| `retry.requested` / `retry.resolved` | `{ request }` / `{ id }` | idem |
| `compaction` | `{ sessionId, state, text? }` | `compaction` |
| `processes` | `{ processes: ProcessInfo[] }` | `processes-updated` |
| `error` | `{ sessionId, error }` | `error` |
| `rec` (desde 1.8.0, **só chats só ao vivo**) | `{ lseq, items: LiveItem[] }` | o que nos chats online iria para a outbox: `chat`/`session`/`message` novos, alterados ou apagados (§23.6) |

Num chat só ao vivo o `snapshot` ganha `live: { lseq }` (o `lseq` atual do host, §23.6).

- **Deltas**: `off` = tamanho que o receptor deve ter antes de aplicar (`content`/`reasoning`). Diferente
  → pede `stream.resync`. `streamId` muda a cada resposta do assistente. O host envia deltas a no
  máximo ~10/s por sessão (junta o texto) e um `snapshot` a cada 50 eventos ou 10 s rodando.
- **Buracos**: receptor vê `n` pulando, ou acabou de se inscrever/reconectar → `stream.resync` → o
  servidor manda `stream.resync_request` ao host → o host envia um `snapshot` (com `n` seguinte).
- Mensagens persistidas **não** vão pelo stream: chegam como registros (`sync.changes`) quase ao mesmo
  tempo. Ao receber a mensagem `assistant` persistida, o receptor descarta o draft daquela sessão.
  Exceção: nos chats só ao vivo (sem registros) elas vêm pelo próprio stream, em eventos `rec` (§23.6).
- `processes` e `snapshot.processes`: só leitura no remoto (logs completos ficam no host).
- Fim do turno: o host manda `session` com status final; `chat.state` (`turn_ended`) fecha o indicador
  (num chat só ao vivo: o anúncio com `running: false`, §23.4).

---

## 12. Primeiro login num app com dados (merge)

"Primeiro login" = o app tem dados locais e nenhum estado de sync para esta conta.

1. Após desbloquear: `GET /account` (`usage.records`). **Online vazio** → envia tudo (abaixo), sem
   perguntar. **Local vazio** → só baixa.
2. Os dois têm dados → pergunta: **"Priorizar online"** · **"Priorizar local"** (explicação: os dois lados
   são unidos; a prioridade decide quem vence quando a mesma coisa existe dos dois lados — e a versão
   perdedora dessas coisas é descartada).
3. Baixa todo o estado online (registros; sem blobs; skills não), decifra.
4. **Deduplicação** (local → online; o **id canônico é sempre o online**, assim os outros dispositivos
   não precisam remapear nada; a prioridade decide o **conteúdo**):

| Tipo | Mesma entidade se… |
|---|---|
| mesmo `type`+`id` (qualquer tipo) | sempre (dispositivo que já sincronizou antes) |
| `setting` | mesmo id (chave) |
| `provider` | `baseUrl` normalizada igual (minúsculas no esquema/host, sem `/` final) **e** (nome igual sem caixa **ou** `apiKey` igual) |
| `preset` | nome igual (sem caixa/acento) e `config` igual (JSON canônico, sem `cwd`) — persona "Padrão" semeada em cada instalação cai aqui |
| `memory_collection` | mesma `category` e nome igual (sem caixa/acento) |
| `memory` | (depois de remapear a coleção) mesma coleção e título igual (sem caixa/acento) |
| `chat` / `session` / `message` | só por id |
| `skill` | não entra no merge (opt-in, §13) |

5. **Remapeamento** de referências locais (ids locais deduplicados → ids online): `ChatConfig.providerId`,
   `ChatConfig.smartApprove.providerId`, `ChatConfig.smartApprove.capture.providerId`,
   `ChatConfig.memory.extraction.providerId`, `Session.providerId`, os mesmos campos em `PresetConfig`,
   settings `defaultModel.providerId`, `smartApproveDefaults.capture.providerId` e `autoTitle.providerId`
   (desde 1.4.0); `ChatConfig.voice.model.providerId` (chats e personas), settings
   `sttSettings.api.providerId`, `ttsSettings.api.providerId` e `voiceCallDefaults.model.providerId`
   (desde 1.5.0); `ChatConfig.presetId`, setting
   `defaultPresetId`; `ChatConfig.memory.collections[]` e `writeTo` (chats e personas), `Memory.collectionId`;
   `Memory.supersedesId`. Metadados informativos em `MessageMeta` (inclusive `voice`/`voiceCall`) não
   são remapeados. `ChatConfig.overrides` (desde 1.10.0) não tem ids; depois do merge, as unidades
   herdadas dos chats seguem a persona e os padrões de "Novos chats" que venceram (herança ao vivo,
   §4.3.6) — a persona online vencedora pode mudar os campos herdados dos chats locais.
6. **Conteúdo vencedor**: priorizar online → o conteúdo online fica e o local é descartado para essas
   entidades; priorizar local → o conteúdo local é enviado por cima (`base_rev = rev online`). **Chats
   com o mesmo id e histórias diferentes**: a versão perdedora é descartada (o diálogo do merge avisa
   antes: "N chats existem nos dois lados com histórias diferentes; a versão não priorizada será apagada").
   Registro apagado online e presente local: priorizar online → apaga local; priorizar local → recria
   (`base_rev = rev do tombstone`).
7. Envia: blobs primeiro (`/blobs/check` + `PUT`), depois os registros em lotes (LWW juntos; conteúdo
   um chat por lote, modo replay com `chat_bases = 0` — o dispositivo vira host dos chats que subiu).
   Chats com `storage` ≠ `online` (só ao vivo, §23.2) — inclusive os criados **antes do login**, que
   guardam o modo gravado na criação (padrão de instalação nova: só ao vivo, §23.1) — **nunca** entram
   no merge nem no envio: continuam locais depois do primeiro login (salvar online é sempre opt-in; quem
   entra só para usar o controle remoto não sobe nada sem querer). O diálogo do merge DEVERIA dizer
   quantos são ("N chats só ao vivo continuam só neste dispositivo") e oferecer "Salvar online" (§23.8)
   — para todos ou um a um. O mesmo vale depois de `keys/reset` (§5.5).
8. Grava `cursor = head` e liga o sync normal. Colisões de slug de memória: §4.3.5.

Logout não apaga os dados locais (só credenciais, DEK e estado de sync); entrar de novo (mesma conta ou
outra) passa por este merge (registros idênticos não geram envio).

---

## 13. Skills (sync opcional)

- Nada de skills é enviado por padrão. (Renomear = registro novo, §3.12.) Em Configurações → Skills, cada skill tem **"Sincronizar"**: ligar
  envia o bundle cifrado e cria o registro `skill` (id derivado do nome, §3.12). Esse dispositivo passa a
  *acompanhar* a pasta de origem: ao reescanear (mtime/sha do bundle mudou) envia nova revisão.
- Outros dispositivos veem a seção **"Skills na nuvem"** (registros `skill`, sem baixar bundles) e só
  baixam quando o usuário pede ("Baixar" / "Baixar todas"). Baixada, a skill vai para
  `<userData>/synced-skills/<name>/` — um local de skills **do app**, depois dos locais do usuário na
  precedência — e passa a ser acompanhada: novas revisões são aplicadas sozinhas (troca atômica da pasta).
- Edição numa cópia acompanhada → envia revisão (LWW). Conflito (mudou local e remoto) → vence o remoto;
  a versão local vai para `<userData>/synced-skills/.conflicts/<name>-<timestamp>/`.
- "Parar de sincronizar" = só local (para de acompanhar). "Remover da nuvem" = tombstone: cópias em
  `synced-skills` são apagadas; pastas de origem nunca são tocadas.
- **Bundle** (plaintext do blob = moldura §3.9 + JSON):
  ```ts
  { format: 'clearchat-skill-bundle', v: 1, name: string,
    files: [{ path: string /* POSIX relativo, sem '..', sem absoluto */, size: number, executable: boolean,
              sha256: string /* hex */, data: string /* base64 padrão */ }] }
  ```
  `SKILL.md` primeiro; mesmos limites do app (≤ 500 arquivos, profundidade ≤ 6, ignora `.git`,
  `node_modules`, `__pycache__`, `.venv`, ocultos; links não são seguidos). Ao extrair: recusar caminhos
  que escapem da pasta, conferir sha256 de cada arquivo, aplicar bit de execução.
  `skill.bundle.sha256` = SHA-256 do plaintext do bundle; `blobId` = §3.11.

---

## 14. Anexos (blobs)

- Referências no app: `clearchat-attachment://<sha256>.<ext>` em `message_json` (parts `image_url`, `file`,
  `input_audio`; resultados de `read_file`) e em `meta_json` (imagens do questionário em `meta.askUser`).
  Os registros continuam com essas referências; `blobs` do registro = ids de todos os sha256 citados.
- **Upload** (antes do push do registro): para cada sha256 → `blob_id` (§3.11) → `POST /blobs/check` →
  para os ausentes: cifra (CCB1) e `PUT /blobs/{id}` com `X-Content-SHA256`. O servidor grava em arquivo
  temporário, confere tamanho/`X-Content-SHA256`/magic, `fsync`, renomeia; upload interrompido não deixa
  nada (o cliente repete).
- **Download** (ao exibir ou antes de mandar ao modelo, no host): `GET /blobs/{id}` → decifra → confere
  `SHA-256 == <sha256>` → grava `<sha256>.<ext>` no store (escrita atômica). Arquivo ausente localmente =
  baixar sob demanda; sem rede → "arquivo ausente" (como hoje).
- O GC local de anexos do app (órfãos) continua valendo; o GC do servidor usa `record_blobs` (blob sem
  referência viva por 24 h → apagado).
- Arquivos de texto anexados ficam inline no `message_json` (não são blobs), como hoje.
- Anexos de chats só ao vivo (§23) **nunca** são enviados como blobs: ficam no store do host. Outros
  dispositivos os mandam ao host e os leem dele em pedaços dentro dos comandos cifrados (`attach.put` /
  `attach.get`, §23.7), só retransmitidos pelo servidor. Na conversão ao vivo → online eles sobem como
  em qualquer chat novo (§23.8).

---

## 15. Captcha no app (Turnstile)

Só quando a instância escolhida tem captcha (`GET <base>/api/info` → `features.captcha` não nulo); sem
captcha o app pula esta etapa. O app abre uma `BrowserWindow` pequena (sem preload,
`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, sessão de memória isolada
`partition: 'clearchat-captcha'`) na página da **própria instância**:

```
<base>/captcha?client=app&nonce=<16+ chars base64url aleatórios>&action=login
```

1. A página renderiza o widget Turnstile (`action` = `login` ou `signup` — os únicos valores; o servidor
   exige `login` em `code/request` e `signup` em `signup/start`; `cData` = `nonce`).
2. Sucesso → a página navega para `<base>/captcha/done#token=<turnstile_token>&nonce=<nonce>`
   (fragmento: nunca vai ao servidor nem a logs).
3. O app intercepta em `webContents.on('will-navigate')` (e `did-navigate` como redundância) a URL cuja
   origem e caminho sejam exatamente os de `<base>/captcha/done`, chama `event.preventDefault()`, lê o
   fragmento, confere o `nonce` e fecha a janela.
4. Erro/expirou → a página mostra "Tentar de novo"; fechar a janela = cancelado.
5. Navegação de nível superior para fora da origem de `<base>` é bloqueada (`will-navigate` +
   `setWindowOpenHandler → deny`); o iframe do Turnstile (`challenges.cloudflare.com`) é permitido.

Mesmo contrato no mobile (WebView: `onShouldStartLoadWithRequest`). Validação no servidor
(`siteverify`): `success`, `hostname` == host de `PUBLIC_BASE_URL`, `action` igual ao esperado pelo
endpoint, token não reutilizado (validade 300 s). O site usa o mesmo widget diretamente nas páginas de
login/cadastro.

## 16. Diagramas de sequência

### 16.1 Cadastro (site)

```mermaid
sequenceDiagram
    participant B as Navegador
    participant S as Servidor
    participant M as SMTP
    B->>S: POST /auth/signup/start {email, name, turnstile}
    S->>S: siteverify + limites
    S-->>B: 202 {ok}
    S->>M: código de 6 dígitos (assíncrono)
    B->>S: POST /auth/signup/verify {email, code, device}
    S-->>B: 201 {tokens, user, keys_ready:false}
    B->>B: DEK, salts, chave de recuperação, Argon2id(senha), wraps, verifier
    B->>S: POST /keys/setup {password, recovery, verifier}
    S-->>B: 200
    B->>B: mostra a chave de recuperação (uma vez)
```

### 16.2 Login + desbloqueio (app)

```mermaid
sequenceDiagram
    participant A as App (main)
    participant W as Janela captcha
    participant S as Servidor
    A->>S: GET <base>/api/info (protocolo, captcha?)
    A->>W: abre <base>/captcha?client=app&nonce=N (só se features.captcha)
    W->>W: Turnstile
    W-->>A: navega /captcha/done#token=T&nonce=N (interceptado)
    A->>S: POST /auth/code/request {email, turnstile_token:T}
    S-->>A: 202
    A->>S: POST /auth/code/verify {email, code, device}
    S-->>A: {tokens, device_id, keys}
    A->>A: Argon2id(senha, salt) → KEK → unwrap DEK (GCM ok?)
    alt senha errada
        A->>A: "Senha incorreta" (nada vai ao servidor)
    else ok
        A->>A: subchaves; safeStorage(DEK) se "lembrar"
        A->>S: WS hello {cursor, state_cursor}
        S-->>A: welcome
    end
```

### 16.3 Merge do primeiro login

```mermaid
sequenceDiagram
    participant A as App
    participant U as Usuário
    participant S as Servidor
    A->>S: GET /account (usage.records)
    alt online vazio
        A->>S: blobs (check + PUT) e push de tudo (replay, chat_bases=0)
    else os dois têm dados
        A->>U: Priorizar online / Priorizar local?
        U-->>A: escolha
        A->>S: GET /records (tudo) e GET /chat-states
        A->>A: dedupe + remapear + decidir conteúdo (+ cópias locais de chats perdedores)
        A->>S: PUT blobs ausentes
        A->>S: POST /sync/push (lotes)
    end
    A->>A: cursor = head; sync normal
```

### 16.4 Sync normal (registro LWW com conflito)

```mermaid
sequenceDiagram
    participant P as PC
    participant S as Servidor
    participant C as Celular
    P->>S: sync.push {push_id, provider rev 3→4}
    S-->>P: ack {seq 501}
    S-->>C: sync.changes [provider rev 4, seq 501]
    C->>S: sync.push {provider base_rev 3} (editado offline)
    S-->>C: error conflict rev_mismatch (current rev 4)
    C->>C: merge por campo (campos sujos por cima do rev 4)
    C->>S: sync.push {push_id novo, base_rev 4 → 5}
    S-->>C: ack {seq 502}
    S-->>P: sync.changes [provider rev 5]
```

### 16.5 Turno normal no host + streaming ao vivo

```mermaid
sequenceDiagram
    participant H as Host (PC)
    participant S as Servidor
    participant R as Controle remoto (celular)
    R->>S: stream.subscribe [chat]
    S->>H: stream.resync_request
    H->>S: stream.event snapshot (n=k)
    S-->>R: stream.event
    H->>S: host.begin {chat, epoch 7, run}
    S-->>H: ack {head 900}
    S-->>R: chat.state (window run, turn_started)
    loop resposta do modelo
        H->>S: stream.event draft.delta (n+1, n+2…)
        S-->>R: stream.event
    end
    H->>S: sync.push {message, chat_bases 900, host_epochs 7}
    S-->>H: ack {head 905}
    S-->>R: sync.changes [message]
    H->>S: host.end {chat, 7}
    S-->>R: chat.state (turn_ended)
```

### 16.6 Envio remoto → fila do host

```mermaid
sequenceDiagram
    participant R as Controle remoto
    participant S as Servidor
    participant H as Host
    R->>S: PUT /blobs (anexos, se houver)
    R->>S: remote.send {cmd_id, kind send, env}
    S->>H: remote.command {cmd_id, env}
    S-->>R: ack {delivered}
    H->>H: dedupe cmd_id, baixa anexos, agent.send (rodando → fila)
    H->>S: remote.result {accepted, queued:true}
    S-->>R: remote.result
    H->>S: stream.event queue (todos veem a fila)
    R->>S: remote.send {kind approval, allow}
    S->>H: remote.command
    H->>H: agent.approve
    H->>S: remote.result {accepted}
    S-->>R: remote.result
```

### 16.7 Queda do host (tolerância de 10 s)

```mermaid
sequenceDiagram
    participant H as Host
    participant S as Servidor
    participant R as Controle remoto
    Note over H,S: janela aberta (rodando)
    H--xS: conexão cai
    S->>S: status grace (10 s)
    alt volta em < 10 s
        H->>S: hello {active_windows:[chat, epoch]}
        S-->>H: welcome {resumed_windows:[chat]}
    else não volta
        S->>S: fecha janela, status offline
        S-->>R: chat.state {event: host_dropped} → "O dispositivo remoto (PC) caiu"
        Note over H: continua rodando offline; conteúdo vira replay
    end
```

### 16.8 Host offline e queda no meio de um comando

```mermaid
sequenceDiagram
    participant R as Controle remoto
    participant S as Servidor
    participant H as Host
    R->>S: remote.send {kind send}
    S->>H: remote.command
    S-->>R: ack {delivered}
    H--xS: conexão cai antes do remote.result
    S-->>R: remote.failed {host_offline} → "O host (PC) caiu antes de confirmar"
    S-->>R: chat.state {event: host_dropped} (após 10 s)
    R->>R: composer desabilitado: "O host (PC) está offline" · [Executar neste dispositivo]
    R->>S: remote.send (nova tentativa)
    S-->>R: error host_offline
```

### 16.9 Assumir um host offline ("Rodar aqui")

```mermaid
sequenceDiagram
    participant N as Novo host (notebook)
    participant S as Servidor
    participant H as Host antigo (offline)
    N->>N: aviso de ferramentas locais / confirmação (se fixado)
    N->>S: host.takeover {force, confirm_pinned}
    S-->>N: ack {granted, epoch 8, head 905}
    N->>N: puxa até 905, escolhe a raiz local, atualiza chat.hostCwd
    N->>S: host.begin {epoch 8} … turno … host.end
    H->>S: hello (volta depois)
    S-->>H: welcome (chat_states: host = notebook) + host.revoked
    alt H tinha conteúdo não enviado (base 900 < head)
        H->>S: sync.push (replay)
        S-->>H: error chat_diverged → §9
    end
```

### 16.10 Trocar o host com o antigo online

```mermaid
sequenceDiagram
    participant N as Novo host
    participant S as Servidor
    participant H as Host atual
    N->>S: host.takeover {next_turn}
    S->>H: host.handover_request {to N, next_turn}
    S-->>N: ack {pending}
    S-->>N: chat.state (handover_requested)
    H->>H: termina o turno sem puxar a fila; repassa itens da fila
    H->>S: host.end {handover_pending:true}
    H->>S: host.release {epoch 7, forwarded:[send…]}
    S-->>H: host.revoked {handover}
    S-->>N: host.granted {epoch 8, head}
    S-->>N: remote.command (itens repassados)
    Note over N,S: com mode force: H faz agent.stop em tudo e libera; sem resposta em 20 s o servidor concede
```

### 16.11 Divergência e resolução

```mermaid
sequenceDiagram
    participant D as Dispositivo com versão offline
    participant S as Servidor
    participant O as Outro dispositivo
    D->>S: sync.push {chat_bases: 900} (head já é 950)
    S->>S: diverged {id X, device D, base 900, head 950}
    S-->>D: error chat_diverged
    S-->>O: chat.state {event: diverged}
    D->>S: GET /records?scope=chat (versão online)
    D->>D: usuário escolhe + confirma "a outra versão será apagada"
    alt manter local
        D->>S: POST divergence/resolve {X, keep local, items (puts + tombstones)}
    else manter online
        D->>S: POST divergence/resolve {X, keep online}
        D->>D: apaga a versão local; aplica a online
    end
    S-->>D: 200
    S-->>O: sync.changes + chat.state {event: resolved}
```

### 16.12 Troca de senha

```mermaid
sequenceDiagram
    participant C as Cliente (desbloqueado)
    participant S as Servidor
    participant O as Outros dispositivos
    C->>C: salt novo, Argon2id(senha nova) → KEK', wrap' da mesma DEK
    C->>S: PUT /keys/password {key_proof, password:{kdf, salt, wrap'}}
    S->>S: SHA-256(key_proof) == verifier?
    S-->>C: 200 {keys_rev+1}
    S-->>O: keys.changed (continuam com a DEK guardada)
```

### 16.13 Recuperação

```mermaid
sequenceDiagram
    participant C as Cliente
    participant S as Servidor
    C->>S: login por código (sessão)
    C->>S: GET /keys
    C->>C: parse da chave (checksum) → HKDF(salt_rk) → KEK_rk → unwrap DEK
    C->>C: define senha nova → wrap'
    C->>S: PUT /keys/password {key_proof, …}
    opt nova chave de recuperação
        C->>S: PUT /keys/recovery {key_proof, …}
    end
```

### 16.14 Skills (opt-in)

```mermaid
sequenceDiagram
    participant P as PC (origem)
    participant S as Servidor
    participant N as Notebook
    P->>P: "Sincronizar" na skill X → bundle, sha256, blob_id
    P->>S: PUT /blobs/{id}
    P->>S: sync.push {skill sk_…, blobs:[id]}
    S-->>N: sync.changes [skill] (só aparece em "Skills na nuvem")
    N->>N: usuário clica "Baixar"
    N->>S: GET /blobs/{id}
    N->>N: decifra, confere, extrai em synced-skills/X (acompanhada)
    P->>P: pasta mudou (reescanear) → nova revisão
    P->>S: PUT blob + push skill rev+1
    S-->>N: sync.changes → baixa e troca a pasta sozinho
```

### 16.15 Anexo: upload e download

```mermaid
sequenceDiagram
    participant H as Host
    participant S as Servidor
    participant R as Outro dispositivo
    H->>H: sha256 do arquivo → blob_id = HMAC(K_blob_id, sha256)
    H->>S: POST /blobs/check {ids}
    S-->>H: {missing:[id]}
    H->>S: PUT /blobs/{id} (CCB1, X-Content-SHA256)
    S-->>H: 201
    H->>S: sync.push {message, blobs:[id]}
    S-->>R: sync.changes [message]
    R->>S: GET /blobs/{id} (ao exibir)
    R->>R: decifra, confere sha256, grava <sha256>.<ext>
```

---

## 17. Limites, constantes e códigos de erro

### 17.1 Constantes

| Nome | Valor |
|---|---|
| `EMAIL_CODE_TTL_S` / `EMAIL_CODE_MAX_ATTEMPTS` | 600 / 5 |
| `ACCESS_TOKEN_TTL_S` / `REFRESH_TOKEN_TTL_DAYS` | 3600 / 60 (deslizante, rotação a cada uso) |
| `WS_HELLO_TIMEOUT_S` | 10 |
| `WS_PING_INTERVAL_S` (cliente) / `WS_PONG_TIMEOUT_S` (cliente) / `WS_IDLE_TIMEOUT_S` (servidor) | 15 / 10 / 30 |
| Backoff de reconexão | jitter total, 1 s · 2ⁿ, teto 30 s, zera após 60 s conectado |
| `HOST_DROP_GRACE_S` | 10 |
| `SERVER_RESTART_GRACE_S` | 60 |
| `HANDOVER_FORCE_TIMEOUT_S` | 20 |
| `COMMAND_RESULT_TIMEOUT_S` | 30 |
| `COMMAND_MAX_BYTES` | 1 MiB (envelope de `remote.send`, `remote.result` e `host.release.forwarded[]`) |
| `FS_READ_CHUNK_BYTES` / `FS_READ_MAX_FILE_BYTES` / `FS_LIST_MAX_ENTRIES` (host, §8.6) | 512 KiB por `fs.read` / 200 MiB por arquivo / 5000 entradas |
| `TOMBSTONE_RETENTION_DAYS` | 180 |
| `PUSH_RECEIPT_TTL_DAYS` | 7 |
| `BLOB_ORPHAN_GRACE_H` | 24 |
| Pull: `limit` padrão / máx. / bytes por página | 500 / 1000 / 8 MiB |
| Push: itens / bytes (REST) / bytes (WS) | 500 / 32 MiB / 4 MiB |
| `sync.changes` payload inline por mensagem | 256 KiB |
| `stream.event` máx. / taxa do host | 256 KiB / ~20 eventos/s por chat (o servidor PODE descartar acima de 50/s) |
| Blob máx. por `PUT` | 300 MiB (Nginx `client_max_body_size`) — sem limite de cota por padrão |
| `PUSH_MAX_ENV_BYTES` / `PUSH_TEXT_MAX_CHARS` | 2048 (JSON do envelope) / 200 |
| `PUSH_PENDING_GRACE_S` / `AWAY_IDLE_S` / `PUSH_MAX_AGE_S` | 60 / 300 / 86400 |
| `HOST_OFFLINE_PUSH_DELAY_S` / `HOST_OFFLINE_PUSH_COOLDOWN_S` | 120 / 1800 |
| `LIVE_ANNOUNCE_MAX_ENV_BYTES` / `LIVE_TITLE_MAX_CHARS` / `LIVE_CWD_MAX_CHARS` (§23.4) | 2048 (JSON do envelope de cada chat) / 120 / 300 |
| `LIVE_MAX_CHATS_PER_HOST` / `LIVE_MAX_CHATS_PER_USER` (§23.4) | 500 / 1000 (vínculos em memória; acima → `quota_exceeded` `kind: 'live_chats'`) |
| `LIVE_ANNOUNCE_MIN_INTERVAL_S` (host, §23.4) | 2 por chat (coalescido; mudança de `running`/`status` vai na hora) |
| `HISTORY_PAGE_MAX_ITEMS` / `HISTORY_PAGE_MAX_BYTES` / `HISTORY_CHUNK_BYTES` (host, §23.5) | 200 itens / 512 KiB de JSON dos itens por resultado / 512 KiB crus por pedaço (`history.item` com `piece`) |
| `LIVE_ITEM_INLINE_MAX_BYTES` / `LIVE_REC_INLINE_MAX_BYTES` / `HISTORY_ITEM_MAX_BYTES` (host, §23.5–§23.6) | 256 KiB (item inteiro num resultado; acima → `large`) / 128 KiB (item inteiro num `rec`; acima → `omitted`) / 32 MiB (teto de um item; acima → `too_large`) |
| `HISTORY_CHANGES_MAX` (host, §23.5) | 5000 referências (acima → `reset`) |
| `LIVE_CONVERT_WAIT_S` (visualizador, §23.8) | 5 |
| `ATTACH_CHUNK_BYTES` (`attach.put`/`attach.get`, §23.7) | 512 KiB crus por pedaço |
| `ATTACH_MAX_FILE_BYTES` / `ATTACH_MAX_FILES` / `ATTACH_MAX_MESSAGE_BYTES` (§23.7) | 20 MiB / 10 / 50 MiB (os limites de anexo do composer do app) |
| `ATTACH_MAX_UPLOADS` / `ATTACH_MAX_PENDING_BYTES` (host, por chat, §23.7) | 10 uploads abertos / 50 MiB somados |
| `ATTACH_UPLOAD_IDLE_S` / `ATTACH_UNUSED_GRACE_H` (host, §23.7) | 60 / 24 |

### 17.2 Cotas

`users.quota_record_bytes`, `quota_records`, `quota_blob_bytes`, `quota_devices`: `NULL` = ilimitado
(padrão). Editáveis no painel admin. Erro: `413 quota_exceeded`. Além delas, um teto de estados de chat por
usuário vale para a instância toda (`kind: 'chat_states'`, §7.10).

### 17.3 Limites anti-abuso (aplicação, contadores no Postgres; Nginx na frente — ver ARCHITECTURE.md)

| Ação | Limite |
|---|---|
| `code/request` + `signup/start` por e-mail | 5/h e 10/24 h |
| idem por IP | 20/h e 100/24 h |
| `code/verify` por código | 5 tentativas |
| `code/verify` por e-mail + rede do cliente (IPv4 /24, IPv6 /64) | 10/h |
| `code/verify` por e-mail (teto, somando todas as redes) / por IP | 200/h / 30/h |
| bloqueio por e-mail + rede do cliente | 15 erros contra um código vivo (≈ 3 códigos queimados) em 24 h → 1 h; reincidência dobra até 24 h. Tentativa sem código vivo (inexistente, usado, expirado ou esgotado) não conta |
| `auth/refresh` por dispositivo | 60/h |
| conexões WS por usuário | 30/min |
| `reauth/request` por conta | 5/h |
| troca de wrap (`PUT /keys/password` + `PUT /keys/recovery`) por conta | 10/h |
| `POST /push` por dispositivo / por conta | 120/h / 300/h |
| `PUT /devices/current/push` por dispositivo | 30/h |
| `live.announce` + `live.withdraw` por conexão (contador em memória, §23.4) | 10 frames/s (acima → `rate_limited`; abuso contínuo → fecha com `4429`) |
| `live.list` / `live.refresh` por conexão (em memória) | 10/min / 6/min |

Contadores por e-mail usam `HMAC(SERVER_SECRET, email)` e valem também para e-mails inexistentes —
responder `429` não revela se a conta existe. Por isso, quando nenhum código é enviado (login sem conta ou
com conta banida, cadastro de conta existente), o servidor DEVERIA gravar mesmo assim um código que nunca é
enviado, para o bloqueio se comportar igual. Limites e bloqueio por rede do cliente impedem que terceiros
gastem o limite do dono do e-mail ou o bloqueiem.

### 17.4 Códigos de erro

| `code` | HTTP | Quando |
|---|---|---|
| `invalid_request` | 400 | corpo/parâmetros inválidos |
| `captcha_failed` | 400 | Turnstile inválido/expirado/ação errada (ou ausente com captcha ligado) |
| `signup_closed` | 403 | cadastro fechado na instância e sem convite |
| `invite_invalid` | 400 | convite inexistente, usado, expirado ou de outro e-mail |
| `code_invalid` | 400 | código errado, expirado, esgotado ou e-mail inexistente |
| `unauthorized` | 401 | sem token / expirado (`details.reason: 'expired'` → refresh) |
| `refresh_reused` | 401 | refresh antigo reutilizado (dispositivo revogado) |
| `forbidden` | 403 | sem permissão |
| `account_disabled` | 403 | conta banida (só após autenticar) |
| `device_revoked` | 403 | dispositivo revogado (raro: a revogação apaga os tokens, então o normal é `401 unauthorized`, §5.4) |
| `key_proof_invalid` | 403 | `key_proof` não confere |
| `not_found` | 404 | recurso inexistente |
| `keys_not_ready` / `keys_already_set` | 409 | setup de chaves |
| `conflict` | 409 | push com conflitos (`details.conflicts`) |
| `blob_missing` | 409 | push referencia blob não enviado (`details.missing`) |
| `chat_busy` | 409 | janela aberta por outro dispositivo / apagar chat rodando |
| `chat_diverged` | 409 | chat divergente (`details.diverged`) |
| `divergence_discarded` | 409 | sua versão já foi descartada (`details: { chat_id, divergence_id }`, vindo de `divergence_discards`) → apagar a versão local e baixar a online |
| `divergence_mismatch` | 409 | `divergence_id` velho / dispositivo errado |
| `stale_base` | 409 | `chat_bases` maior que `head` |
| `not_host` | 409 | não é o host / epoch velho (`details.state`) |
| `no_host` | 409 | chat sem host e quem pede não pode hospedar |
| `cannot_host` | 409 | dispositivo sem `can_host` |
| `host_offline` | 409 | comando remoto com o host fora (offline/tolerância) |
| `host_pinned` | 409 | host fixado sem `confirm_pinned` |
| `handover_pending` | 409 | troca de host em andamento |
| `live_conflict` | 409 | chat só ao vivo (desde 1.8.0, §23.3): anunciar um id que existe online (registro `chat` não apagado ou `chat_states`) ou que outro dispositivo anuncia; `host.begin`/`host.takeover`/`host.pin`/resolver divergência num chat com vínculo ao vivo; push de `chat`/`session`/`message` desse chat por outro dispositivo que não o host (`details: { chat_id, reason: 'exists_online'\|'other_host'\|'live' }`) |
| `cursor_expired` | 410 | `since` abaixo do piso de tombstones |
| `payload_too_large` | 413 | lote/frame grande demais |
| `quota_exceeded` | 413 | cota (`details.kind/used/limit`; `kind`: `record_bytes`\|`records`\|`blob_bytes`\|`devices`\|`chat_states`\|`live_chats` — §7.10) |
| `protocol_unsupported` | 426 | versão do protocolo fora da faixa |
| `rate_limited` | 429 | limites (`Retry-After`) |
| `internal` | 500 | erro inesperado |
| `push_unavailable` | 503 | `POST /push` numa instância sem push configurado (§22.1) |

---

## 18. Versionamento

- **Versão do protocolo** `MAJOR.MINOR.PATCH` no topo deste arquivo. MAJOR = incompatível (rotas
  `/api/v2`, `hello.protocol: 2`); MINOR = adições compatíveis (campos/tipos/mensagens novos que os
  clientes antigos ignoram); PATCH = só texto.
- `GET <base>/api/info` (`protocol.min`/`protocol.max`) e o `welcome` (`protocol`) informam as versões. O servidor DEVE manter o MAJOR anterior
  por um período de transição quando houver um novo.
- Versões independentes: `v` do envelope (formato cifrado), `k` da DEK, `sv` de cada esquema de registro.
  Leitor que encontrar `v`/`k` desconhecido NÃO DEVE decifrar nem sobrescrever o registro (pede
  atualização); `sv` maior que o conhecido: ler o que entende, preservar o resto.
- **Regra dos dois repositórios**: toda mudança aqui → mesma mudança em `ClearChat/docs/SYNC_PROTOCOL.md`
  e `ClearChatWebsite/docs/SYNC_PROTOCOL.md` (arquivos idênticos), `generate.ts` + vetores regenerados nos
  dois, versão incrementada, entrada no changelog abaixo.

### Changelog

| Versão | Data | Mudança |
|---|---|---|
| 1.0.0 | 2026-10-19 | Contrato inicial (cripto, registros, REST, WebSocket, host de execução, divergência, merge, skills, anexos, instância/self-host, gateway reservado). |
| 1.1.0 | 2026-10-19 | Adições compatíveis: `quota_exceeded` com `details.kind: 'chat_states'` — teto de estados de chat por usuário em `host.begin`/`host.takeover`/`host.pin` ao criar o estado de um chat (§7.10, §8.3, §8.8, §8.9, §10.4, §17.2, §17.4); `records/fetch`/`sync.fetch` com o orçamento de ~8 MiB por resposta, o cliente pede de novo os `omitted: true` até acabarem (§6.7, §7.2, §10.4). Texto: §17.3 — `code/verify` limitado por e-mail + rede do cliente (teto de 200/h por e-mail), bloqueio contando só erros contra um código vivo, código não enviado para o bloqueio não revelar contas, limite de 10/h para troca de wrap; §5.4 — reuso vale para qualquer refresh já rotacionado. |
| 1.1.1 | 2026-10-19 | Texto (sem mudança de formato): §8.3/§8.4/§9.1 — `chat_bases[X] < head(X)` só marca divergência se houver conteúdo de X com `seq > base` escrito por outro dispositivo; se tudo depois da base é do próprio remetente (ex.: chat novo enviado em vários lotes com a mesma base), o push segue como `b == head`. `divergence_discarded` continua checado antes. |
| 1.2.0 | 2026-10-19 | Adições compatíveis — versões de mensagens (ramos): `message.parentId?` (mãe no mesmo ramo; ausente = derivada como a anterior por `seq`) com o algoritmo normativo do caminho ativo e dos irmãos e a invariante `seq(mãe) < seq` (§4.3.8); `session.branchSel?` (versão escolhida por bifurcação, sempre enviado, `{}` quando vazio; `null` = caminho termina ali) (§4.3.7); comandos `branch.edit`, `branch.regenerate`, `branch.select` (§8.6), com `regenerate` virando regenerar em ramo e o host 0.7 recusando `message.edit` em mensagem digitada pelo usuário na sessão principal; trocar de versão entra nas mutações de conteúdo (§8.4); `migration.messageTree` local (§4.4); site troca de versão só na tela; fixture `docs/test-vectors/branches.json` escrito à mão (§3.15); tipos de referência do app 0.7.x (§4.3). |
| 1.3.0 | 2026-10-20 | Adições compatíveis — arquivos do host num controle remoto: comandos `fs.list` (pasta do chat no host, com raiz/confinamento do host) e `fs.read` (pedaços de até 512 KiB em base64 dentro do resultado cifrado, teto de 200 MiB por arquivo), só leitura, sem janela, sem dedupe, aceitos com o agente rodando, com as mesmas regras de caminho da aba Arquivos/tools de leitura do host e recusa com `code` (§8.6); `COMMAND_MAX_BYTES` explicitado também para o `remote.result` e constantes `FS_*` (§17.1); §2 cita o tamanho dos envelopes de comando. Servidor ≥ 1.3.0 precisa repassar os kinds novos antes de os apps os usarem. |
| 1.4.0 | 2026-10-21 | Adições compatíveis — preferências que eram locais passam a sincronizar como registros `setting`: `smartApproveDefaults` (padrões globais do Smart-Approve: descrição do ambiente, "aceitar edições dentro da raiz", coleta de contexto e os prompts do resumidor `capturePrompts`), `autoTitle` (título automático) e `toolOutputSpillChars` (limite para salvar saídas de tool em arquivo) (§4.3.2); envio único dos ids novos depois do primeiro pull num dispositivo que já sincronizava (§4.3.2); remapeamento no merge dos `providerId` dentro deles e de `ChatConfig.smartApprove.capture` (§12); `updateDismissedVersion` e a largura do painel de arquivo listados como locais (§4.4); tipos de referência do app 0.8.x, com os campos opcionais novos da config do chat/persona citados (§4.3). Servidor: nenhuma mudança de comportamento (ids de `setting` não são filtrados) — só a versão informada em `/api/info`/`welcome`. |
| 1.4.1 | 2026-10-21 | Adições compatíveis (só campos opcionais em objetos que já sincronizam): "Tokens de pensamento" das chamadas laterais com raciocínio obrigatório — `SmartApproveConfig.thinkingTokens` (juiz; na config do chat/persona), `ContextCaptureConfig.thinkingTokens` (resumidor; em `smartApprove.capture` e `smartApproveDefaults.capture`) e `AutoTitleSettings.thinkingTokens` (título), cada um `number \| null`, ausente/`null` = o padrão do app; e o liga/desliga do "Cache do prompt" — `SmartApproveConfig.cache` (juiz) e `ContextCaptureConfig.cache` (resumidor; em `smartApprove.capture` e `smartApproveDefaults.capture`), `boolean`, ausente = ligado (o app só grava `false`) (§4.3, §4.3.2). Nenhum id de `setting` novo (sem envio único). Servidor: nenhuma mudança de comportamento — só a versão informada em `/api/info`/`welcome`. |
| 1.5.0 | 2026-10-23 | Adições compatíveis — áudio (ditado e chamada de voz): ids de `setting` novos `audioInput`, `sttSettings`, `ttsSettings` e `voiceCallDefaults` com as **partes do dispositivo** fora do registro e preservadas ao aplicar (`audioInput.deviceId`, `local.installed`, bloco `gpu` e modo/backend `'gpu'` — escritores nunca enviam `'gpu'`, um dispositivo em GPU continua em GPU), sem segredos (chaves só nos provedores), `providerId` resolvido pelo id e "sem provedor" quando não existe localmente (§4.3.2); envio único dos ids novos e da `voice` local de chats/personas depois do primeiro pull (§4.3.2); `ChatConfig.voice`/`PresetConfig.voice` (`VoiceCallConfig`, inclusive `promptMode`/`endCall`) passam a sincronizar — antes eram locais (§4.3.3, §4.3.6); `MessageMeta.voice` (fala/ditado), `MessageMeta.voiceCall` e os marcadores de início/fim da chamada (só de exibição; no registro com `kind: 'memory-extraction'` + `voiceCall` para que apps ≤ 0.9.0 — que mandariam um `kind` desconhecido ao modelo — os descartem; leitores ≥ 1.5.0 voltam a `voice-call`) e a tool `end_call` no histórico (§4.3.8); `provider.kind: 'elevenlabs'` (só voz, fora de tudo que é chat), capacidades por tipo, inferência pela URL e reparo do `openai` gravado por apps antigos (§4.3.1); remapeamento no merge do `providerId` de stt/tts, do modelo padrão da chamada e de `voice.model` (§12); tools da chamada em `usesLocalTools` (§8.9); itens locais do áudio (microfone, modelos baixados, runtime da GPU, vozes do usuário, clipes, medições, logs do modo sombra) (§4.4); tipos de referência do app com o áudio, depois do 0.9.0 (§4.3); campo opcional `voiceCallDefaults.delayPhrases` (frases de demora da chamada — aditivo dentro do mesmo setting, sem mudança de versão; leitores que não o conhecem o ignoram e os que o conhecem completam a ausência com os padrões) (§4.3.2); campo opcional `api.params` em `sttSettings`/`ttsSettings` (parâmetros dos modelos remotos por família de API — ElevenLabs: formato de saída, `voice_settings`, normalização, `auto_mode`; OpenRouter/OpenAI-compatível: `speed`, `instructions`, `temperature`, `prompt` — preferências que sincronizam, ao contrário dos parâmetros da GPU; aditivo dentro do mesmo setting, sem mudança de versão) (§4.3.2). Clientes < 1.5.0 (app ≤ 0.9.0): ignoram os ids novos; não mostram os marcadores (e nunca os mandam ao modelo); guardam `voice`/meta de voz como desconhecidos (editar uma persona num app antigo apaga a `voice` dela); mostram o provedor ElevenLabs como OpenAI-compatível. Servidor: nenhuma mudança de comportamento (ids de `setting` não são filtrados, meta e config vão cifrados) — só a versão informada em `/api/info`/`welcome`; o site passa a mostrar falas, marcadores de chamada e o provedor de voz. |
| 1.6.0 | 2026-11-02 | Adição compatível — origem entre chats no comando remoto: `send` ganha `meta?: InterChatSendMeta` (`kind: 'inter-chat'`, `fromChatId`, `fromSessionId?`, `fromChatTitle`, `interChatHops`) para o `send_to_chat` de um agente cujo chat de destino roda em outro dispositivo; o host ≥ 1.6.0 grava a mensagem com esse meta, conta os saltos e recusa acima de `interChatMaxHops`; meta inválido é ignorado; o remetente nunca entrega localmente um chat executado em outro dispositivo (host offline/divergente/sem conexão → a tool recusa) (§8.6). Hosts < 1.6.0 ignoram o meta (a mensagem chega como digitada, com o cabeçalho de origem no texto). Servidor: nenhuma mudança de comportamento (o payload é cifrado) — só a versão informada em `/api/info`/`welcome`. Texto: o aviso do topo aponta para o repositório pai como fonte única. |
| 1.7.0 | 2026-11-06 | Adições compatíveis — notificações push (§22): token FCM por dispositivo (`PUT`/`DELETE /devices/current/push`, `push` em `GET /devices`), `POST /push` com conteúdo cifrado por `K_push` (subchave nova, AAD `clearchat\|v1\|push\|…`, vetores em `push.json`), kinds `approval`/`question`/`retry`/`reply`/`error`/`dismiss`, regras de quando o host avisa (turno iniciado por um celular ou host ausente; pendências também depois de 60 s), aviso `host_offline` gerado pelo servidor com histerese (2 min offline seguidos, no máximo 1 a cada 30 min por host, tag fixa por host, `dismiss` na volta), recebimento no celular com texto genérico sem a DEK; `features.push` em `/api/info` (§6.2), linha nova em §2, itens locais (§4.4), constantes e limites (§17.1, §17.3), erro `push_unavailable` (§17.4). Clientes < 1.7.0 não registram token nem enviam: nada muda para eles. Servidor ≥ 1.7.0 precisa da conta de serviço do Firebase para ligar o push. |
| 1.8.0 | 2026-11-06 | Adições compatíveis — chats só ao vivo (§23): escolha "Salvar online"/"Só ao vivo" ao criar um chat (padrão de instalação nova: só ao vivo; depois, a última escolha do dispositivo, `newChatStorage` local), modo `storage` local do host (`online`/`live`/`live_pending`) e conteúdo inteiro do chat ao vivo fora do sync (§4.4); nada no servidor além de um **vínculo em memória** por chat (host, `epoch` ao vivo escolhido pelo host, `arev`, rodando/ocioso, envelope), com tolerância de queda, reanúncio a cada `welcome`, `settling_s` após reinício do servidor e exclusividade com os chats online (`live_conflict` em anúncio, push de outro dispositivo e `host.begin`/`takeover`/`pin`/resolver divergência) (§23.3); WebSocket: `hello.caps`/`welcome.caps` com `"live_chats"` (§10.3), `live.announce`/`live.withdraw`/`live.list`/`live.refresh` e `live.update`/`live.removed`/`live.host`/`live.refresh_request` (§10.4, §10.5); anúncio cifrado com `K_stream` e AAD nova `clearchat\|v1\|live-announce\|…` amarrando host, chat, epoch e `arev` (§3.10, vetores em `live.json`, §3.15); comandos `history.list`/`history.changes`/`history.item` (histórico paginado sob demanda, itens com o plaintext dos registros e `lseq` por epoch, pedaços para itens grandes) e `chat.update` (renomear/editar config de um chat ao vivo) (§8.6, §23.5, §23.7); anexos sem blob: `attach.put` (arquivo enviado ao host em pedaços de 512 KiB dentro dos comandos cifrados, validado no primeiro pedaço, conferido por tamanho + SHA-256 no último e salvo como anexo local do chat; devolve o `AttachmentInfo` que o `send` usa como referência ao store do host; idempotente por `offset`, cancelamento e expiração por ociosidade) e `attach.get` (anexo do histórico baixado do host em pedaços, como `fs.read`, conferido pelo SHA-256 e mantido só em memória), limites de anexo do app (20 MiB por arquivo, 10 por mensagem, 50 MiB por mensagem) (§8.6, §14, §17.1, §23.7); kind `rec` no stream e `snapshot.live.lseq` (§11, §23.6); conversões ao vivo → online (push comum por replay, vínculo apagado no commit do `chat`) e online → ao vivo (tombstone comum, ignorado pelo host; tombstone aceito como vazamento) (§7.7, §23.8); merge do primeiro login ignora chats ao vivo, inclusive os criados antes do login, que continuam locais (salvar online é opt-in) (§12, §23.1); `features.liveChats` em `/api/info` (§6.2); linha nova em §2; `quota_exceeded` com `kind: 'live_chats'` (§7.10), constantes, limites e erro `live_conflict` (§17); notas em §8.1, §8.2, §8.7, §8.8, §9.1, §14. Push: `from_device_id` posto pelo servidor em toda mensagem FCM, `PushPayload.hostDeviceId?`/`live?`, `device_id` do host no `host_offline` (que conta chats ao vivo rodando) e o celular apaga as pendências daquele host ao receber `host_offline` (§22.3, §22.4, §22.6, §22.7). Clientes < 1.8.0 não veem chats ao vivo (sem registros; o servidor só manda `live.*` a quem declarou `caps`); clientes ≥ 1.8.0 contra servidor < 1.8.0 escondem a escolha e criam tudo online. Servidor ≥ 1.8.0 precisa repassar os kinds novos antes de os apps os usarem. |
| 1.8.0 (emenda) | 2026-11-12 | Remoção sem mudança de fio: `interjections` (em `voiceCallDefaults` e em `config.voice` de chat/persona) vira legado — escritores não enviam, leitores ignoram; a chamada de voz não tem mais interjeições nem modo sombra (§4.3.6).. Também aditivos (sem mudança de fio): tags de voz `audioTags`/`audioTagsPrompt` (chat/persona e `voiceCallDefaults`), campos de "falar por cima" em `voiceCallDefaults.turn`, novos padrões das frases de demora (8000/15000), `audioInput.activationDb` como parte do dispositivo `MessageMeta.voice.unheard` e as frases de ferramenta (`voiceCallDefaults.toolPhrases`, `config.voice.toolPhrases`). |
| 1.9.0 | 2026-11-12 | Voz por persona: `config.voice.tts`/`config.voice.stt` (chat/persona; motor/provedor, modelo, voz, parâmetros e idioma; herança chat → persona → settings do dispositivo; indisponível no dispositivo → as globais dele; ditado usa a transcrição da persona). As settings `audioInput`, `sttSettings`, `ttsSettings` e `voiceCallDefaults` viram **locais do dispositivo** (escritores não enviam, leitores ignoram; os registros antigos ficam no servidor). Sem mudança no servidor além da versão. |
| 1.10.0 | 2026-11-12 | Adições compatíveis — **chats herdam a persona ao vivo** (§4.3.6): `ChatConfig.overrides` (`{ [unidade]: true }`) marca o que é próprio do chat; o resto segue o valor efetivo da persona (o dela ou, se ela não define, o padrão de "Novos chats" — cadeia Novos chats → persona → chat, ao vivo); unidades (`model` = par provedor+modelo, `params.<nome>`, `enabledTools.<tool>`, `approvalModes.<item>`, `appSignature` com o custom, `smartApprove`/`memory`/`skills` inteiras, as demais chaves de `PresetConfig` uma a uma; `voice` continua com `null` = herda, `cwd`/`presetId`/`capturedContext` sempre próprios); `config` continua completa como cópia informativa (gravada ao criar, migrar, voltar a herdar, trocar de persona e congelar; não regravada a cada edição da persona); migração única dos chats antigos depois de um pull completo (iguais à persona → herdam; diferentes → próprios; na `voice`, iguais à persona → `null`); trocar de persona mantém `overrides`; persona apagada → os chats dela congelam antes (valores efetivos gravados, `presetId` removido, enviados antes do tombstone) (§4.3.3, §7.7); `overrides` mesclado por subchave e cópia informativa que não sobrescreve valor próprio no conflito (§7.5); `chat.update` com/sem `overrides` (§23.7); nota no merge do primeiro login (§12). Tools de um tipo de aparelho (só no computador / só no celular): mesma lista em todos os aparelhos, o host manda ao modelo só as que roda, nunca viram próprias por causa do aparelho, padrão do app inclui as do celular, preservadas por quem não as conhece, migração só as marca próprias se o chat rodou naquele tipo; o celular hospeda chats com ferramentas locais sem elas (antes recusava) (§4.3.6, §8.9). Apps < 1.10.0 leem a cópia e preservam `overrides`; edições deles em campos herdados não valem nos apps novos. Sem mudança no servidor além da versão. |

---

## 19. Notas de implementação do cliente (não normativo)

Tabelas locais sugeridas no SQLite do app (não fazem parte do contrato):

```sql
sync_state(key TEXT PK, value TEXT)          -- user_id, device_id, cursor, state_cursor, server_url, keys_rev
sync_records(type TEXT, id TEXT, rev INTEGER, seq INTEGER, deleted INTEGER, PRIMARY KEY(type, id))
sync_outbox(oid INTEGER PK, type, id, scope, base_rev, dirty_fields TEXT, deleted INTEGER, chat_base INTEGER NULL, created_at)
sync_chat(chat_id TEXT PK, head INTEGER, local_cwd TEXT, needs_refetch INTEGER, offline_dirty INTEGER)
sync_blobs(sha256 TEXT PK, blob_id TEXT, uploaded INTEGER)
sync_commands_seen(cmd_id TEXT PK, at INTEGER)   -- dedupe de comandos remotos (host), 7 dias
sync_remote_pending(cmd_id TEXT PK, chat_id, payload_json, status, created_at)   -- enviados como controle remoto, aguardando resultado (só em memória basta)
sync_skills(name TEXT PK, record_id, mode TEXT /* source|copy */, local_dir, bundle_sha256, rev)
```

- O sync roda no **processo main** do Electron (rede, SQLite, DEK); o renderer recebe eventos
  (`AgentEvent` + novos: estado de host, divergência, progresso de sync).
- Hooks no app: cada escrita dos repos (`providersRepo`, `chatsRepo`, `messagesRepo`, `MemoryStore`…)
  registra no outbox (com `dirty_fields`); o runner abre/fecha a janela (`host.begin`/`host.end`) e
  publica os eventos do stream; `agent.send` num chat cujo host é outro dispositivo vira `remote.send`.
- O `cwd` local de cada chat sai do `config_json` antes de cifrar e volta ao aplicar (guardar em
  `sync_chat.local_cwd` ou manter no próprio `config_json` local e ignorar o campo remoto).
- Ao aplicar `chat` remoto novo sem `cwd` local: usar `defaultCwd` (ou home) e pedir ao usuário só ao
  virar host.
- Mobile: pull com `payload=0` + `records/fetch` sob demanda; não segurar host em segundo plano (o SO
  derruba o WS → host offline em 10 s).

---

## 20. Instância, configurações da instância e self-host

### 20.1 Escolha do servidor no app (estilo Jellyfin)

- Configurações → Conta → **Servidor**: "**ClearChat** (clear.ezenere.com)" (padrão) ou "**Self-host**"
  com um campo de endereço `esquema://host[:porta][/caminho]` (sem esquema → `https://`; `/` final
  removido). Variável de ambiente `CLEARCHAT_SYNC_URL` sobrepõe (desenvolvimento/testes).
- Antes do login o app valida com `GET <base>/api/info`: resposta válida, `protocol` compatível, e mostra
  o `name` da instância ("Entrar em <nome>"). Erro de rede/TLS/protocolo → mensagem clara e não continua.
  `http://` só é aceito com aviso ("sem criptografia de transporte — use só em rede local"; os dados
  continuam cifrados ponta a ponta, mas tokens e metadados não).
- A UI se adapta às `features`: "Criar conta" só com `signupOpen`; janela de captcha só com `captcha`.
- Trocar de servidor = logout da instância atual (dados locais ficam) + login na nova → merge do primeiro
  login (§12). Um app fala com **uma** instância por vez.
- Tudo que o app abre no navegador usa `<base>` (cadastro, setup, painel).

### 20.2 Configurações da instância (painel admin, persistidas no banco)

| Configuração | Padrão | Efeito |
|---|---|---|
| `instance_name` | `ClearChat` | nome exibido no site, nos e-mails e no app ("Entrar em <nome>") |
| `signup_open` | `true` (oficial) / `false` recomendado em self-host | cadastro público on/off (§5.1); fechado → só convites ou usuários criados pelo admin |
| `landing_enabled` | `true` | off → a raiz do site mostra só login/painel (sem landing) |
| `captcha_enabled` | `true` | só tem efeito se `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` estiverem no `.env`; sem chaves, captcha fica desligado de qualquer forma |
| `gateway_enabled` | `false` | reservado (§21); v1 ignora |

Lidas pelo backend a cada requisição relevante (cache curto) e expostas em `GET /api/info`. Segredos
(SMTP, Turnstile secret, `SERVER_SECRET`, `ADMIN_TOKEN`) ficam no `.env`, nunca no banco.

### 20.3 Self-host (resumo — passo a passo em ARCHITECTURE.md / README do servidor)

- O servidor roda em qualquer host/porta/caminho: `PUBLIC_BASE_URL` no `.env` define `<base>` (links de
  e-mail, `base_url` do `/api/info`, verificação do hostname do Turnstile, cookie `Path`). A API fica em
  `<base>/api`, o WebSocket em `<base>/ws`, o site em `<base>/`.
- CORS: desligado por padrão (site na mesma origem; apps nativos não precisam). `ALLOWED_ORIGINS` (lista)
  libera origens extras quando o site é servido de outro lugar.
- Captcha opcional (sem chaves Turnstile → sem captcha; limites continuam). E-mail via SMTP próprio.
- Painel admin sempre só em `127.0.0.1` (túnel SSH), também em self-host.

---

## 21. Fase futura (opcional): servidor como gateway de execução

> **Não faz parte da v1. Interpretação ainda a confirmar com o usuário.** Esta seção só reserva espaço no
> protocolo; nada aqui deve ser implementado agora.

Ideia: uma opção da instância (`gateway_enabled`) para o **servidor** servir de host de execução de um
chat quando nenhum dispositivo host estiver online (ex.: conversar do celular com o PC desligado).

- **Quebra o zero-knowledge** para o que o gateway executa: ele precisa das chaves de API dos provedores
  e do histórico do chat em claro. Portanto: opt-in explícito **por usuário e por chat**, com avisos
  claros, e revogável.
- **Concessão de chaves**: o cliente cifraria para a chave pública do gateway só o necessário (ex.: as
  chaves do chat/provedor, ou uma subchave) num registro do tipo reservado `key_grant`; revogar = apagar
  o registro. O mecanismo exato (subchaves por chat vs. DEK) fica para o design da fase.
- **Sem acesso ao sistema de arquivos dos dispositivos**: tools locais indisponíveis (no máximo um
  workspace isolado no servidor).
- **Arquitetura provável**: um runner headless (serviço Node reaproveitando o núcleo do agente do app)
  que se registra como dispositivo `client: 'gateway'` e participa do modelo de host (§8) como qualquer
  host — janela de escrita, comandos remotos, stream.
- **Espaço reservado em v1**: `device.client = 'gateway'`, `features.gateway` no `/api/info`, configuração
  `gateway_enabled`, tipo de registro `key_grant`. Servidores e clientes v1 tratam tudo isso como
  desligado/desconhecido.

---

## 22. Notificações push (desde 1.7.0)

Avisos no celular quando um chat precisa do usuário ou termina algo que ele pediu, mesmo com o app
fechado. O conteúdo vai **cifrado de ponta a ponta** (`K_push`); o servidor só repassa ao provedor de push
e vê o tipo do aviso, a tag aleatória, os destinos e o horário (§2).

### 22.1 Quem participa

- **Recebem**: só apps móveis, com provedor `fcm` (Firebase Cloud Messaging; Android em v1 — iOS via APNs
  pelo FCM fica para depois, e `provider: 'apns'` está reservado). Desktop e site não registram token.
- **Enviam**: o **host** do chat (§8) — é ele quem sabe que uma aprovação está pendente ou que o turno
  acabou. Chats hospedados no próprio celular não passam pelo servidor: o app mostra notificações locais
  quando está em segundo plano (não normativo).
- **Servidor**: guarda o token de cada dispositivo, valida e repassa ao FCM (HTTP v1, conta de serviço da
  instância). Sem push configurado na instância, `features.push` é `null` (§6.2): clientes não registram
  token nem enviam, e `POST /push` responde `503 push_unavailable`.

### 22.2 Token do dispositivo

| | |
|---|---|
| `PUT /devices/current/push` | `{ provider: 'fcm', token: string }` (token ≤ 4096 chars) → `204`. Um token por dispositivo (substitui o anterior). |
| `DELETE /devices/current/push` | `204` (idempotente) |

- O app registra depois do login/desbloqueio, a cada abertura (idempotente) e quando o FCM troca o token;
  remove quando o usuário desliga as notificações neste aparelho.
- O servidor apaga o token ao revogar o dispositivo/logout e quando o FCM responde que ele não vale mais
  (`UNREGISTERED`, `404`, ou `INVALID_ARGUMENT` apontando o token).
- `GET /devices` ganha `push: boolean` (o dispositivo tem token válido) — é por ele que o host sabe se a
  origem de um turno é um celular (§22.5).

### 22.3 Envio — `POST /push`

```json
{ "kind": "approval", "tag": "5f0c1e2d3a4b5c6d7e8f901a2b3c4d5e",
  "to": "all", "env": { "v": 1, "k": 1, "n": "…", "c": "…" } }
```

- `kind`: `approval` (aprovação pendente), `question` (pergunta do agente), `retry` (esperando para tentar
  de novo), `reply` (resposta pronta), `error` (turno parou com erro) ou `dismiss` (apagar o aviso da
  mesma `tag`). Desconhecido → `400 invalid_request`.
- `tag`: 32 hex minúsculos, aleatória, escolhida pelo remetente. Identifica o aviso no aparelho: um aviso
  novo com a mesma tag substitui o anterior; `dismiss` apaga.
- `to`: `"all"` (todos os dispositivos do usuário com token, menos o remetente) ou lista de `device_id`
  (≤ 20; ids de outros usuários ou sem token são ignorados).
- `env`: envelope (§3.9) com `K_push` e AAD `clearchat|v1|push|<user_id>|<kind>|<tag>` (§3.10).
  Obrigatório exceto em `dismiss` (`null`). O JSON do envelope DEVE ter ≤ `PUSH_MAX_ENV_BYTES`.
- Resposta `200 { "sent": n }` (destinos com token; `0` não é erro). `429 rate_limited` (§17.3) — o host
  descarta o aviso, sem fila.
- Mensagem ao FCM: **só dados** (o app monta a notificação), `android.collapse_key = tag`,
  `android.priority = high` exceto `dismiss` (`normal`), `android.ttl`: `approval`/`question`/`retry`/
  `dismiss` 3600 s, `reply`/`error` 86400 s. Campos (strings): `v: "1"`, `kind`, `tag`, `env` (JSON do
  envelope ou `""`), `sent_at` (ISO do servidor) e, desde 1.8.0, `from_device_id` (o dispositivo
  autenticado que fez o `POST /push`, preenchido **pelo servidor** — é o host do chat; serve para o celular
  saber de que host é o aviso mesmo sem decifrar, §22.7).

### 22.4 Conteúdo cifrado

`K_push = HKDF(DEK, info "clearchat/v1/push")` (§3.7). Plaintext (moldura §3.9):

```ts
PushPayload = {
  sv: 1,
  kind: 'approval' | 'question' | 'retry' | 'reply' | 'error',  // DEVE ser igual ao kind de fora
  chatId: string, sessionId?: string,
  chatTitle: string,       // ≤ 120 chars
  text: string,            // trecho, ≤ PUSH_TEXT_MAX_CHARS, sem Markdown: início da resposta, a pergunta,
                           // o que a aprovação pede (ex.: "Executar: npm test") ou a mensagem de erro
  requestId?: string,      // approval/question/retry
  hostName: string,        // nome do dispositivo que roda o chat
  hostDeviceId?: string,   // desde 1.8.0: device_id do host (escritores ≥ 1.8.0 DEVEM enviar)
  live?: true,             // desde 1.8.0: chat só ao vivo (§23) — tocar abre o visualizador ao vivo
  ts: number               // ms Unix
}
```
Chats só ao vivo (§23) avisam exatamente como os outros: o aviso já vai cifrado e não fica no servidor.

### 22.5 Quando o host avisa (DEVERIA)

"**Turno do celular**": turno da sessão principal iniciado por um comando remoto (`send`, `force`,
`branch.edit`, `branch.regenerate`) cujo `from_device_id` (§10.5) é um dispositivo com `push: true`.
"**Ausente**": no momento do evento, o host está com a tela bloqueada, ou sem interação do usuário há
≥ `AWAY_IDLE_S` (como o "ausente" do Discord), ou com a tela desligada. Host sem como saber (ex.: Wayland
sem suporte) = presente.

| Evento | Avisa quando | Para quem |
|---|---|---|
| turno da sessão principal terminou com resposta (`reply`) ou com erro (`error`; parar pelo usuário não conta) | turno do celular, ou host ausente | o celular de origem; se ausente sem origem móvel, `"all"` |
| aprovação, pergunta ou espera de retry (`approval`/`question`/`retry`, também de subagentes) | imediatamente se turno do celular ou host ausente; senão depois de `PUSH_PENDING_GRACE_S` se ainda pendente | idem; depois da espera, `"all"` |
| pendência acima resolvida (em qualquer dispositivo) ou cancelada | se o aviso foi enviado | os mesmos destinos (`dismiss`, mesma tag) |

- `reply`/`error` DEVERIAM reutilizar uma tag por chat (o aviso novo substitui o anterior);
  `approval`/`question`/`retry` usam uma tag por pedido.
- O host NÃO avisa sobre chats que não hospeda e não manda nada se `features.push` for `null`.

### 22.6 Aviso gerado pelo servidor: host caiu

Quando o host de um chat **rodando** cai, o servidor DEVERIA avisar — com histerese, para uma conexão
instável não virar uma sequência de avisos:

- **Espera**: só avisa se o host ficar offline por `HOST_OFFLINE_PUSH_DELAY_S` **seguidos** e, nesse
  momento, algum chat dele ainda estiver como rodando. Voltar antes disso cancela o aviso. Chats só ao
  vivo (desde 1.8.0) contam: o servidor guarda **em memória**, da queda até a decisão, se algum vínculo
  ao vivo do host estava com `running: true` no último anúncio (§23.4) — o vínculo em si já some ao fim
  da tolerância.
- **Intervalo mínimo**: no máximo um aviso por dispositivo host a cada `HOST_OFFLINE_PUSH_COOLDOWN_S`
  (conta a partir do último enviado, mesmo que o host tenha voltado e caído de novo).
- **Mesma tag por host**: a tag é fixa por dispositivo host (gerada pelo servidor, aleatória, guardada),
  então um aviso novo substitui o anterior no aparelho em vez de empilhar.
- **Volta**: quando o host reconecta, o servidor manda `dismiss` dessa tag (se tinha avisado).
- Mensagem: `kind: "host_offline"`, `env: ""`, campos extras em claro `chat_id` (um dos chats que rodavam;
  desde 1.8.0, de preferência um chat online — um chat só ao vivo some junto com o host), `device_name`
  e, desde 1.8.0, `device_id` (o host que caiu); vai a todos os dispositivos do usuário com token.

### 22.7 No celular (recebimento)

- Mensagem de dados recebida mesmo com o app fechado (tarefa em segundo plano). App em primeiro plano
  **com o chat aberto** → não mostra (o `dismiss` vale sempre).
- Decifra com `K_push` se a DEK estiver disponível sem interação. DEK disponível e falha de
  autenticação/AAD, `kind` interno diferente do externo ou `ts` mais velho que `PUSH_MAX_AGE_S` →
  descarta. DEK indisponível (guardada com biometria, "não lembrar", ainda não desbloqueado) → texto
  genérico pelo `kind` ("Um chat precisa da sua aprovação", "Resposta pronta num chat"…).
- Título = `chatTitle`; corpo = `text` se o usuário quiser trecho (padrão: sim), senão o genérico. Na
  tela bloqueada só o genérico (visibilidade privada do Android). Tocar abre o chat (`chatId`).
- Canais Android: pendências (`approval`/`question`/`retry`, importância alta), respostas, erros, host
  offline. Preferências por tipo e "mostrar trecho" ficam no aparelho (§4.4) e filtram no próprio app.
- **Host de cada aviso (desde 1.8.0)**: o celular guarda, junto de cada aviso mostrado (nos dados da
  notificação), o host = `hostDeviceId` do payload decifrado, senão o `from_device_id` de fora (avisos
  genéricos, sem a DEK).
- **Host caiu → limpar pendências (desde 1.8.0)**: ao receber `host_offline` com `device_id` = D, o
  celular DEVE apagar da bandeja os avisos `approval`/`question`/`retry` cujo host é D (o host morto não
  vai mandar o `dismiss` deles; se ele voltar e a pendência ainda existir, ela continua no app, só não
  avisa de novo). Servidor < 1.8.0 (sem `device_id`): casar pelo nome — avisos decifrados com
  `hostName` igual ao `device_name`; os genéricos ficam. `reply`/`error` não são apagados.
- **Chat só ao vivo** (`live: true`): tocar abre o visualizador ao vivo (§23.5) se o chat estiver na
  lista ao vivo; senão "Este chat só ao vivo não está disponível agora — <host> não está conectado".
  Celulares < 1.8.0 mostram o aviso, mas não conhecem o chat (tocar não abre nada).

---

## 23. Chats só ao vivo (desde 1.8.0)

Um chat **só ao vivo** fica guardado **só no dispositivo que o executa** (o host): o servidor não guarda
nada dele — nenhum registro (`chat`, `session`, `message`), nenhum blob, nenhuma linha em `chat_states`,
nem o título. Os outros dispositivos da conta o veem **enquanto o app do host estiver aberto e
conectado**: o host anuncia a lista cifrada pelo WebSocket, o servidor só retransmite (e a guarda em
memória enquanto o host está conectado), o histórico vem do host sob demanda pelos comandos remotos
(§8.6) e as atualizações pelo stream (§11). Tudo cifrado com `K_stream` (§3.10).

### 23.1 Escolha do usuário e regras visíveis

- Ao criar um chat (desktop e celular), com o sync ligado e a instância com suporte (§23.2), o usuário
  escolhe **"Salvar online"** ou **"Só ao vivo"** (no celular: "Salvar online" · **"Só neste aparelho"**,
  §23.10), com uma linha de explicação ("Só ao vivo: fica só neste dispositivo; os outros o veem enquanto
  este app estiver aberto").
- **Padrão** = a última escolha feita **neste dispositivo** (`newChatStorage`, setting local — §4.4; não
  sincroniza). Sem escolha anterior: **"Só ao vivo"** numa instalação nova (salvar online é opt-in); numa
  instalação que já sincronizava antes de atualizar para 1.8.0, "Salvar online" (nada muda sem o usuário
  escolher — o app grava esse valor na primeira execução da versão nova).
- Chats criados sem a tela de escolha (por um agente, por importação) usam o padrão do dispositivo; o
  "Manter como novo chat" da §7.7 é sempre online (é o propósito dele). Chats anteriores ao 1.8.0 (sem
  modo) são online.
- **Sem login (sync não configurado)**: o seletor não aparece, mas todo chat novo grava o modo do mesmo
  jeito (o padrão do dispositivo — numa instalação nova, só ao vivo). Esse modo vale no primeiro login: os
  chats só ao vivo **continuam locais** e o merge os pula, oferecendo "Salvar online" (§12, passo 7).
  Salvar online é sempre opt-in — dá para entrar na conta só para usar o controle remoto sem subir nada.
- No host: selo "Só ao vivo" no cabeçalho e na sidebar; "Salvar online" / "Tirar do servidor" no menu do
  chat (§23.8).
- Nos outros dispositivos o chat aparece numa seção **"Ao vivo em <host>"** (§23.10) só enquanto o app do
  host estiver **aberto, conectado e com a DEK desbloqueada** — em qualquer tela, minimizado ou na bandeja;
  não depende de o chat estar aberto no host. O host fecha o app → some na hora; o host perde a conexão →
  "reconectando…" e some depois de `HOST_DROP_GRACE_S` (10 s).
- Quem visualiza guarda o chat **só em memória** (§23.5): nada é gravado no aparelho.

### 23.2 Modo do chat (local) e detecção de suporte

- O modo é a coluna local `storage` da tabela `chats` **do host** (fora de `config_json`, nunca enviada —
  §4.4):
  - `online` (padrão; ausente/`NULL` = online): chat comum, sincronizado (§7–§8);
  - `live`: só ao vivo;
  - `live_pending`: conversão online → ao vivo em andamento (esperando o ack da exclusão, §23.8) —
    tratado como `live` para tudo, menos o anúncio, que espera o ack.
- Com `storage` ≠ `online`, o host **NÃO DEVE** mandar nada desse chat ao servidor: nenhum push de
  `chat`/`session`/`message` (os hooks da outbox desse chat vão para o emissor ao vivo, §23.6), nenhum
  upload dos anexos dele, nenhum `host.begin`/`host.end`/`host.pin`/`host.takeover`/`divergence/resolve`.
- Fora do chat nada muda: personas, provedores, settings e **memórias** continuam sincronizando —
  coleções e memórias são da conta; as que um chat só ao vivo cria ou edita (tools de memória, extração)
  viram registros `memory` normais, com `updatedByChatId` = id do chat ao vivo (leitores tratam um chat
  desconhecido como hoje). A mensagem da extração (o card) é conteúdo do chat e fica local.
- **Detecção** — o cliente só oferece a escolha e só anuncia se **todas**: sync ligado e desbloqueado;
  `GET /api/info` com `features.liveChats: true` (§6.2); `"live_chats"` de volta em `welcome.caps`
  (§10.3).
- **Cliente novo × servidor antigo** (< 1.8.0, ou `liveChats` falso): escolha escondida, todo chat novo é
  online (como hoje). Chats que já são `live` (criados antes, ou contra outra instância) **continuam
  locais**: não são anunciados nem enviados sozinhos; aparecem como "Só neste dispositivo — o servidor
  não suporta chats ao vivo", com a ação "Salvar online" (que só usa push comum, §23.8).
- **Clientes antigos** (< 1.8.0) nunca veem chats só ao vivo: não há registros e o servidor só manda
  `live.*` a conexões que declararam `caps: ["live_chats"]`. Hosts antigos não têm chats ao vivo.

### 23.3 Servidor: vínculo ao vivo (só em memória)

Para cada usuário, o servidor mantém em memória um **vínculo** por chat ao vivo anunciado:

```ts
LiveBinding = { chat_id, host_device_id, epoch, arev, running: boolean, env: Envelope, announced_at }
```

- **Nunca persistido** (banco, disco, filas); logs PODEM contar frames e tamanhos, nunca guardar `env`.
  Reinício do servidor apaga tudo: os hosts reanunciam a cada `welcome` (§23.4). Uma instância com vários
  processos precisa de um lugar comum em memória para os vínculos (ex.: o processo que segura as
  conexões).
- **`epoch` ao vivo**: escolhido pelo host — inteiro ≥ 1 e ≤ 2⁵³ − 1, fixo enquanto o processo do app
  roda, que **nunca se repete** para aquele chat (nem com os epochs que ele teve online). Recomendado:
  `max(ms Unix no início do processo, último usado + 1)`, guardando o último por chat (§4.4). O `n` do
  stream (§11) e o `lseq` do histórico (§23.5) recomeçam a cada `epoch`; um visualizador que vê o `epoch`
  mudar descarta o espelho e recarrega. O servidor guarda o `epoch` do último anúncio aceito e o usa para
  validar `stream.event` (§11).
- **Status do host**: `online` com a conexão aberta. Queda → `grace` (`live.host`) por
  `HOST_DROP_GRACE_S`; expirou sem reconectar → o servidor apaga **todos** os vínculos desse host
  (`live.removed`, `reason: 'host_dropped'`). Reconectou → `online` (`live.host`) e o host DEVE reanunciar
  (`full: true`); vínculos dele ainda sem reanúncio `HOST_DROP_GRACE_S` depois do `welcome` são apagados
  (`withdrawn`). Dispositivo revogado (§5.4) → vínculos apagados (`device_revoked`); conta apagada ou
  `keys.reset` → apagados (as conexões fecham).
- **Roteamento**: `remote.send` (§8.6), `stream.subscribe`/`stream.resync` e `stream.event` (§11)
  procuram primeiro o vínculo ao vivo do `chat_id` e, se existir, usam o host e o `epoch` dele; senão
  `chat_states`, como antes.
- **Exclusividade** (`409 live_conflict`, §17.4):
  - anunciar um `chat_id` que tem registro `chat` não apagado ou linha em `chat_states`
    (`reason: 'exists_online'`), ou que está vinculado a outro dispositivo (`reason: 'other_host'`) → o
    item é recusado no ack do `live.announce`;
  - `host.begin`, `host.takeover`, `host.pin` e `POST /chats/{id}/divergence/resolve` num chat vinculado →
    `live_conflict` (`reason: 'live'`) — nunca nasce `chat_states` para um chat ao vivo;
  - push com `chat` de id vinculado, ou `session`/`message` com `scope` vinculado: vindo de **outro**
    dispositivo → o lote é recusado (`live_conflict`, `reason: 'live'`); vindo do **host do vínculo** → é a
    conversão ao vivo → online (§23.8): segue as regras normais e, no commit que cria o registro `chat`, o
    servidor apaga o vínculo e transmite `live.removed` (`reason: 'saved_online'`).
- **Limites**: até `LIVE_MAX_CHATS_PER_HOST` vínculos por host e `LIVE_MAX_CHATS_PER_USER` por usuário;
  acima, o item é recusado com `quota_exceeded` (`kind: 'live_chats'`, §7.10).

### 23.4 Anúncio e lista

**Host → servidor**:

| Frame | Uso |
|---|---|
| `live.announce { full, chats: [{ chat_id, epoch, arev, running, env }] }` | `full: true` = o conjunto inteiro deste host: o servidor apaga os vínculos dele que não estão na lista (`live.removed`, `withdrawn`). `full: false` = cria/atualiza só os itens listados. |
| `live.withdraw { chat_ids, reason }` | tira chats da lista (`chat_ids: null` = todos deste host). `reason`: `deleted` (apagado no host), `quit` (o app vai fechar, ou a conta bloqueou/saiu — some sem esperar a tolerância), `withdrawn` (outro motivo: saiu dos mais recentes, ficou sem a DEK…). |

- O host DEVE mandar `live.announce { full: true }` logo depois de **cada** `welcome` (lista vazia se não
  tiver chats ao vivo) e antes de qualquer `stream.event` de chat ao vivo. Com os limites da §17.1 o frame
  cabe nos 4 MiB.
- Ack: `{ accepted: [chat_id], rejected: [{ chat_id, code: 'live_conflict' | 'quota_exceeded' |
  'invalid_request' }] }`. Item com `arev` ≤ a do vínculo no mesmo `epoch` é ignorado (vai em
  `accepted`, sem efeito). `live_conflict` com `exists_online` num chat `live_pending` = a exclusão ainda
  não terminou: anunciar depois do ack dela (§23.8); em outro caso, o chat fica "Só neste dispositivo" e
  o app registra o erro.
- Quando anunciar (`full: false`): chat ao vivo criado ou vindo de conversão; mudança de título, persona,
  modelo, `status`/pendências ou `updatedAt`. Coalescer por chat a no máximo um anúncio a cada
  `LIVE_ANNOUNCE_MIN_INTERVAL_S`, menos mudança de `running`/`status`, que vai na hora.
  `live.refresh_request` → `full: true`.
- O host anuncia no máximo `LIVE_MAX_CHATS_PER_HOST` chats: com mais, os de `updatedAt` mais recente (os
  outros ficam visíveis só no host).
- `arev`: contador do host por `(chat, epoch)`, começa em 1, +1 a cada anúncio daquele chat.
- `running` (em claro, como a janela dos chats online — §2): o chat **não** está ocioso pelo critério da
  §8.5, passo 4 (sessão rodando ou esperando, subagente em segundo plano, aprovação/pergunta/retry
  pendente). Serve à lista do site e ao aviso "host caiu" (§22.6).
- `env`: envelope (§3.9) com `K_stream` e AAD
  `clearchat|v1|live-announce|<user_id>|<host_device_id>|<chat_id>|<epoch>|<arev>` (§3.10; vetores em
  `live.json`); JSON do envelope ≤ `LIVE_ANNOUNCE_MAX_ENV_BYTES`. Plaintext:

```ts
LiveChatInfo = {
  sv: 1,
  chatId: string,                    // DEVE ser igual ao chat_id de fora
  title: string,                     // ≤ LIVE_TITLE_MAX_CHARS
  persona: { id: string, name: string, icon: string } | null,   // ChatConfig.presetId + nome/ícone atuais
  model: { providerId: string | null, providerName: string | null, model: string | null },
  status: 'idle' | 'running' | 'waiting',   // waiting = aprovação, pergunta ou retry pendente
  pending: { approvals: number, questions: number, retries: number },
  usesLocalTools: boolean,           // §8.9 (só exibição)
  hostCwd: string | null,            // raiz do chat no host, ≤ LIVE_CWD_MAX_CHARS (só exibição)
  createdAt: number, updatedAt: number,     // ms Unix; updatedAt ordena a lista
  messageCount?: number              // mensagens do caminho ativo da sessão principal (informativo)
}
```
Leitores ignoram campos desconhecidos; o escritor corta os textos nos limites.

**Servidor → visualizadores** (todas as conexões do usuário com `caps` `live_chats`, menos a do host):

```ts
LiveChat = { chat_id: string, epoch: number, arev: number, running: boolean, env: Envelope,
             host: { device_id: string, name: string, platform: string, status: 'online' | 'grace' },
             announced_at: string }
```

| Frame | Quando |
|---|---|
| `live.update { chats: [LiveChat] }` | anúncio aceito que mudou algo |
| `live.removed { host_device_id, chat_ids, reason }` | `deleted` / `host_quit` / `withdrawn` (pelo host), `host_dropped` (tolerância expirou), `saved_online` (virou chat online, §23.8), `device_revoked` |
| `live.host { host_device_id, status }` | o host entrou em tolerância (`grace`) ou voltou (`online`) |

- **Lista**: o cliente manda `live.list` depois de **cada** `welcome` → ack
  `{ chats: [LiveChat], settling_s }`. Os frames de uma conexão chegam em ordem: o ack substitui a lista
  inteira, eventos `live.*` recebidos antes dele são descartados (já estão nele) e os de depois são
  aplicados por cima. Dentro de um `epoch`, `arev` menor ou igual à conhecida é ignorada (anti-replay).
- `settling_s` = segundos que ainda faltam de `SERVER_RESTART_GRACE_S` desde o boot do servidor (0
  normalmente). Chats que o cliente conhecia antes de reconectar e que não vieram na lista ficam como
  "reconectando…" (composer desabilitado) até `settling_s` passar, e então somem; com 0, somem na hora.
  Assim um reinício do servidor (hosts ainda reconectando) não esvazia a lista de uma vez.
- `live.refresh { host_device_id? }` (ack `{}`): o servidor manda `live.refresh_request
  { requester_device_id }` ao host indicado (ou a todos os hosts conectados com chats ao vivo), que
  respondem com `full: true`. Para um visualizador que não conseguiu decifrar um item ou desconfia da
  lista; limitado (§17.3).
- Decifrar: `K_stream`, AAD montada com `user_id`, `host.device_id`, `chat_id`, `epoch` e `arev` **de
  fora**; falha ou `chatId` de dentro diferente → o item é ignorado (não aparece).
- O visualizador mostra `host.name` (vem do servidor) e o `status`; `host.status: 'grace'` =
  "reconectando…".

### 23.5 Abrir o chat noutro dispositivo: histórico sob demanda

O histórico vem do host pelos comandos `history.*` (§8.6) — mesmo `remote.send`/`remote.result`, mesmas
AADs de comando e resultado (`K_stream`), teto `COMMAND_MAX_BYTES`. Como `fs.*`, **não** são comandos de
conteúdo (sem janela, não gravam nada, aceitos com o agente rodando) e o host NÃO os deduplica. O host só
responde para chats que guarda como `live` (senão `rejected`, `code: 'not_live'`); `payload.chatId` DEVE
ser igual ao `chat_id` do frame.

**Itens** — todo resultado de `history.*` e todo `rec` (§23.6) usam:
```ts
LiveItem = { type: 'chat' | 'session' | 'message', id: string,
             lseq: number,      // lseq da última mudança deste item no epoch atual (0 = não mudou desde o início do epoch)
             deleted?: true,    // apagado (sem data)
             data?: object,     // plaintext EXATAMENTE como o do registro (§4.3.6 sem cwd, §4.3.7, §4.3.8), com sv
             omitted?: true,    // não coube nesta resposta / neste rec: pedir com history.item { items }
             large?: number }   // bytes do JSON de data, acima de LIVE_ITEM_INLINE_MAX_BYTES: pedir em pedaços (history.item { piece })
```
Reusar o plaintext dos registros deixa o visualizador usar os mesmos leitores (árvore de versões e
caminho ativo, §4.3.8; marcadores de voz; status transitórios, §4.3.7). Resultado aceito:
`{ sv: 1, status: 'accepted', epoch, lseq, … }` (`epoch` ao vivo e `lseq` atual do host no momento da
resposta). Recusa: `{ sv: 1, status: 'rejected', error: '<texto pt-BR>', code?: 'not_live' | 'missing' |
'invalid' | 'too_large' }`.

| `kind` | Payload | Resultado (além de `epoch` e `lseq`) |
|---|---|---|
| `history.list` | `{ chatId, type, sessionId?, after: string \| null, limit? }` | `{ items: LiveItem[], next: string \| null }`. `type: 'chat'` → o item do chat; `'session'` → as sessões do chat (ordem `createdAt`, `id`); `'message'` → as mensagens de `sessionId` na ordem da sessão (`seq`, `id`, §4.3.8). Página até `limit` (≤ `HISTORY_PAGE_MAX_ITEMS`, padrão o máximo) e `HISTORY_PAGE_MAX_BYTES`; o primeiro item sempre vem (como `large`, se preciso). `next` = cursor opaco do host (≤ 200 caracteres) ou `null` no fim. |
| `history.changes` | `{ chatId, since: number }` | `{ changes: [{ type, id, lseq, deleted?: true }], reset?: true }` — referências (sem `data`) com `lseq > since`, em ordem de `lseq`. Mais que `HISTORY_CHANGES_MAX`, ou um `since` que o host não cobre mais → `reset: true` (sem `changes`): recarregar tudo. |
| `history.item` | `{ chatId, items: [{ type, id }] }` (≤ 200) **ou** `{ chatId, piece: { type, id, offset } }` | `items` → `{ items: LiveItem[] }` (inexistente → `deleted: true`; o que não couber volta `omitted: true` e o visualizador pede de novo, como na §7.2). `piece` → `{ piece: { type, id, lseq, total, offset, data } }`: `data` = base64 (padrão) de até `HISTORY_CHUNK_BYTES` do JSON UTF-8 de `data` a partir de `offset`, `total` = tamanho desse JSON; o visualizador junta os pedaços e faz o parse; `lseq` mudou entre pedaços → recomeça. Item acima de `HISTORY_ITEM_MAX_BYTES` → `too_large`. |

**`lseq` (no host)**: contador por `(chat, epoch)`, em memória, que começa em 0 no início do `epoch` e
sobe 1 a cada evento `rec` (§23.6) — mesmo que o envio falhe (sem conexão). Durante o `epoch` o host
guarda `(type, id) → lseq` da última mudança (inclusive exclusões) para responder `history.changes`; PODE
esquecer as mais antigas (e responder `reset`).

**Abrir (visualizador), nesta ordem:**
1. `stream.subscribe [chat]` e esperar o ack (o servidor pede o `snapshot` ao host, §11). A partir daqui,
   guardar os `rec` que chegarem.
2. `history.list` do `chat`, das sessões (todas as páginas) e das mensagens da sessão principal (todas as
   páginas — a mãe efetiva e o caminho ativo dependem das anteriores, §4.3.8; a tela mostra
   "carregando…" com progresso). Subsessões (subagentes) sob demanda. Itens `large`/`omitted` →
   `history.item`.
3. Juntar por item: **o maior `lseq` vence** (empate = a mesma versão); exclusões ficam guardadas (em
   memória) com o `lseq` delas. Os `rec` guardados entram com a mesma regra.
4. `conhecido` = maior `lseq` visto (resultados e `rec`). Um `rec` com `lseq > conhecido + 1`, ou um
   `snapshot` com `live.lseq > conhecido`, = mudanças perdidas → `history.changes { since: conhecido }` e
   `history.item` do que veio; `reset` → recarregar a partir do passo 2.
5. `epoch` diferente (no anúncio, num `stream.event` ou num resultado) → descartar tudo e recomeçar do
   passo 1.
6. Reconexão (do visualizador, do host ou do servidor): a inscrição volta por `hello.subscriptions`, mas o
   servidor só consegue pedir o `snapshot` quando o vínculo existe. Quando o chat aberto volta a aparecer
   (`live.list`/`live.update`) com o **mesmo** `epoch`, o visualizador manda `stream.resync` e segue pelo
   passo 4; com `epoch` novo, passo 5.
- No máximo 3 comandos `history.*`/`attach.*`/`fs.*` em voo por visualizador (como `fs.read`, §8.6).
- **Só em memória**: o visualizador NÃO DEVE gravar nada do chat (banco, arquivos, cache de imagens,
  índice de busca, logs). PODE manter o espelho enquanto o app está aberto (voltar ao chat sem
  recarregar); DEVE descartá-lo quando o chat sai da lista (§23.4), quando a conta bloqueia/sai e quando o
  `epoch` muda. O rascunho do composer também fica só em memória.

### 23.6 Atualizações ao vivo: stream

- O stream da §11 vale sem mudança, com o `epoch` ao vivo (o servidor confere host e `epoch` pelo
  vínculo). Não há janela: o indicador "rodando" vem do anúncio (`running`/`status`).
- **`rec`** (kind novo do stream, só em chats ao vivo): `{ lseq, items: LiveItem[] }`. O host emite, em
  vez do push, cada mudança de `chat`/`session`/`message` desse chat que num chat online iria para a
  outbox (mensagem nova, edição, exclusão, `insertAt` da compactação, `branchSel`, status de sessão
  gravado, `chat.updatedAt`…), coalescendo como os lotes do push (~250 ms). Um `rec` = um `lseq`. Item com
  JSON de `data` acima de `LIVE_REC_INLINE_MAX_BYTES` vai `omitted: true` (o visualizador o busca com
  `history.item`); o evento inteiro respeita o teto do `stream.event` (256 KiB) — se não couber, vários
  `rec`, cada um com o seu `lseq`.
- A troca do draft pela mensagem persistida (§11) acontece quando um `rec` traz a mensagem `assistant`.
- **`snapshot`** ganha `live: { lseq }`; o snapshot periódico da §11 (a cada 50 eventos ou 10 s rodando)
  deixa o visualizador perceber `rec` perdidos (§23.5, passo 4).
- Hosts NÃO DEVEM mandar `rec` em chats online (o conteúdo vem por `sync.changes`); receptores ignoram
  `rec` de chats que não são ao vivo.

### 23.7 Comandos remotos num chat ao vivo

- Todos os kinds da §8.6 (`send`, `force`, fila, `stop`, `stop_subagents`, `approval`, `smart_override`,
  `question`, `retry`, `regenerate`, `message.edit`/`delete`, `compact`, `memory.extract`, `branch.*`,
  `fs.*`) funcionam: mesmo envelope, mesmo `cmd_id`, mesma dedupe no host, mesmo
  `remote.result`/`remote.failed`, mesmas recusas. O servidor roteia pelo vínculo (§23.3): host `online` →
  `remote.command`; `grace` → `host_offline`; sem vínculo (nem `chat_states`) → `no_host`.
- No host, os comandos de conteúdo rodam pelos mesmos caminhos dos chats online, **sem**
  `host.begin`/`host.end` e sem outbox: o efeito aparece nos `rec` (§23.6) e no anúncio.
- **Anexos** (`attach.put` / `attach.get`): num chat ao vivo nada vira blob. Os bytes viajam em pedaços
  dentro dos envelopes dos comandos remotos (AADs de comando e resultado, `K_stream`, cada envelope ≤
  `COMMAND_MAX_BYTES`), só retransmitidos pelo servidor, nunca guardados nele. Como `fs.*`, não são
  comandos de conteúdo (sem janela, aceitos com o agente rodando) e o host NÃO os deduplica por
  `cmd_id`: a idempotência vem do `offset`. Contam no limite de 3 comandos de leitura/transferência em voo
  por visualizador (§23.5). Com `ATTACH_CHUNK_BYTES` = 512 KiB o envelope fica em ~0,7 MiB (comprimido;
  ~0,9 MiB sem compressão), abaixo de `COMMAND_MAX_BYTES`.
  - **Enviar ao host — `attach.put`**. O visualizador escolhe um `uploadId` (uuid), calcula `size` e
    `sha256` (hex minúsculo do arquivo inteiro) e manda pedaços **contíguos**, um por vez (espera o
    resultado antes do próximo): `{ chatId, uploadId, name, mime?, size, sha256, offset, data }`, `data` =
    base64 (padrão) de até `ATTACH_CHUNK_BYTES` a partir de `offset`; `name`/`mime`/`size`/`sha256` iguais
    em todos os pedaços.
    - Primeiro pedaço (`offset: 0`): o host valida **antes** de receber o resto — `size` ≤
      `ATTACH_MAX_FILE_BYTES`, nome/tipo aceitos pelas regras de anexo do composer do app (imagem, PDF,
      áudio, texto/código), uploads abertos no chat ≤ `ATTACH_MAX_UPLOADS` e soma deles ≤
      `ATTACH_MAX_PENDING_BYTES`. Se o store do host já tem esse `sha256` (é content-addressed), responde
      `done` na hora e o visualizador para de enviar.
    - Os bytes vão para um arquivo temporário no host (nunca direto no store). `offset` DEVE ser igual ao
      já recebido; pedaço repetido (mesmo `offset` já recebido — retentativa depois de timeout ou
      `remote.failed`) → `accepted` com o mesmo `received`; `offset` diferente → `rejected`,
      `code: 'offset'`, com `received` (o visualizador continua de lá).
    - Último pedaço (`offset` + bytes = `size`): o host confere o tamanho e o SHA-256; diferente → descarta
      o upload (`code: 'hash'`); certo → salva como **anexo local normal** do chat (a mesma rotina do
      composer: validação de tipo, texto UTF-8, `<sha256>.<ext>` no store) e responde
      `{ sv: 1, status: 'accepted', received: size, done: true, attachment: AttachmentInfo }`. Pedaços do
      meio: `{ sv: 1, status: 'accepted', received, done: false }`.
    - Cancelar: `{ chatId, uploadId, cancel: true }` → o host descarta → `{ sv: 1, status: 'accepted',
      cancelled: true }`. Sem pedaço por `ATTACH_UPLOAD_IDLE_S`, o host descarta sozinho; um pedaço
      depois disso (ou depois de o host reiniciar) → `code: 'expired'` (recomeçar do 0).
    - Recusa: `{ sv: 1, status: 'rejected', error: '<texto pt-BR>', code }` com `code` ∈ `invalid`
      (payload ou campos diferentes entre pedaços), `too_large`, `type` (tipo não suportado / texto que não
      é UTF-8 — o `error` é o mesmo texto do composer), `busy` (uploads demais ou soma acima do teto),
      `offset`, `expired`, `hash`, `not_live`.
  - **Usar no `send`**: num chat ao vivo, `send.attachments`/`force.attachments` levam os `AttachmentInfo`
    devolvidos pelo `attach.put` (ou de anexos já citados no chat) — referências ao **store do host**
    (`file`/`sha256`), não blobs. O host aceita só se `<file>` existe no store dele com aquele `sha256`
    (senão `rejected`, `error: 'attachment_missing'`) e dentro dos limites por mensagem do app
    (`ATTACH_MAX_FILES`, `ATTACH_MAX_MESSAGE_BYTES`). O GC local de órfãos do host NÃO DEVE apagar um
    anexo recebido por `attach.put` antes de `ATTACH_UNUSED_GRACE_H` sem uso (o usuário pode demorar a
    enviar). O composer do visualizador mostra o progresso do envio e só libera "Enviar" com todos `done`.
  - **Baixar do host — `attach.get`** `{ chatId, file, offset, length }`, para mostrar um anexo do
    histórico (partes de imagem/PDF/áudio, resultados de `read_file`, imagens do questionário em
    `meta.askUser`). `file` = `<sha256>.<ext>` como na referência `clearchat-attachment://…`
    (`^[0-9a-f]{64}\.[a-z0-9]{1,10}$`). O host só serve arquivos do store citados por mensagens **deste**
    chat ou recebidos por `attach.put` nele (senão `code: 'missing'`). Resultado como o do `fs.read`:
    `{ sv: 1, status: 'accepted', file, size, mime?, offset, data }` — `data` = base64 (padrão) de até
    `ATTACH_CHUNK_BYTES`; `length: 0` = só `size`; `mime` só com `offset: 0`; teto
    `FS_READ_MAX_FILE_BYTES`. Sem estado no host (cancelar = parar de pedir). O visualizador junta os
    pedaços e confere `SHA-256 == <sha256>` do nome; diferente → descarta e mostra erro. Os bytes ficam
    **só em memória**, como o resto do espelho (§23.5) — nada em disco, cache de imagens ou galeria
    (salvar/compartilhar explícito pelo usuário é outra ação, fora do protocolo); o visualizador DEVERIA
    pedir só ao exibir e soltar o que saiu da tela. Recusa: `code` ∈ `missing`, `invalid`, `too_large`,
    `not_live`.
- **`chat.update`** (novo, só chats ao vivo): `{ chatId, title?, config? }` — `config` = as chaves de
  `ChatConfig` a trocar (sem `cwd`; o valor substitui a chave inteira, como o merge por chave da §7.5 —
  exceto `params`, mesclado parâmetro a parâmetro, com `null` removendo o parâmetro, como na tela de
  configuração do chat; o remetente PODE mandar o objeto inteiro com `null` nos removidos). O
  host aplica como uma edição local (as mesmas validações da tela de configuração do chat), emite o `rec`
  do `chat` e um anúncio novo (desde 1.10.0, herança da persona, §4.3.6: um patch **sem** `overrides` é
  uma edição — cada unidade tocada pelas chaves enviadas vira própria; um patch **com** `overrides` (o
  mapa completo novo) vale como enviado — é assim que o remoto "volta a herdar", mandando só o mapa sem a
  unidade; o host recalcula a cópia das unidades herdadas; uma unidade que o mapa novo acrescenta sem o
  valor no patch fica com o valor efetivo atual como próprio; `presetId: null` = escolher nenhuma persona
  = congelar; `presetId: <id>` = trocar de persona, mantendo `overrides` — um chat ainda não migrado é
  migrado antes contra a persona atual) → `{ sv: 1, status: 'accepted' }`, ou `rejected` com `error` em texto. Nos
  chats online, renomear/editar continua sendo o registro `chat` (§4.3.6) — o servidor recusa
  `chat.update` sem vínculo ao vivo.
- **Entre chats** (§8.6): um agente noutro dispositivo PODE mandar `send` com `meta` a um chat ao vivo
  que o dispositivo dele conhece pelo anúncio; a resposta não pode ser lida dos registros (não há).
- **Push** (§22.5): o host avisa como em qualquer chat; o `from_device_id` do comando decide o "turno do
  celular".

### 23.8 Conversões

Só **no host** (o dispositivo que tem — ou vai ficar com — a cópia), pelo menu do chat.

**Ao vivo → online ("Salvar online")** — não depende de `features.liveChats` (é push comum):
1. Confirmação: "Salvar online? O histórico inteiro (N mensagens e os anexos) vai para o servidor,
   cifrado, e o chat passa a sincronizar com os seus dispositivos." O app DEVERIA conferir antes a cota
   (`GET /account`) contra o tamanho estimado e avisar.
2. `storage = 'online'`. A partir daqui o chat é um chat comum **criado offline**: tudo vai para a outbox.
3. Envio com as regras normais (§7.4, §8.4, §14), como no merge (§12, passo 7): blobs primeiro; o registro
   `chat` **no primeiro lote**, junto com o começo do conteúdo; o resto em lotes de conteúdo em modo replay
   (B) com `chat_bases = 0` em todos (todo conteúdo depois da base é do próprio host, §8.4) → o dispositivo
   vira host do chat (`epoch + 1`, `host_changed`) e nasce o `chat_states` (pode dar `quota_exceeded`
   `kind: 'chat_states'`). `base_rev` do `chat` = rev do tombstone se o chat já foi online antes (o host a
   guardou na conversão anterior; conflito `gone` → reenviar com `base_rev = current.rev`, recriação
   intencional como na §12); sessões e mensagens: `base_rev = 0`.
4. No commit do lote que cria o `chat`, o servidor apaga o vínculo e transmite `live.removed`
   (`saved_online`) — o host não precisa de `live.withdraw`. Dali em diante o host usa o `epoch` do
   `chat_states` no stream e não anuncia mais o chat.
5. Visualizadores: `saved_online` → descartam o espelho e abrem o chat comum (registros por
   `sync.changes`, estado por `chat.state`); o histórico vai aparecendo conforme o host termina de enviar.
6. Sem conexão: tudo espera na outbox (o chat some dos outros e só volta quando subir). Cota estourada no
   meio: o chat fica online com envio pendente (como qualquer `quota_exceeded`, §7.10) e o host oferece
   "Tirar do servidor" para voltar.

**Online → ao vivo ("Tirar do servidor")** — precisa de `features.liveChats` e de conexão:
1. Pré-condições: este dispositivo é o host do chat (ou o chat não tem host e ele tem `can_host`); chat
   ocioso (sem janela), não divergente, outbox dele vazia; **todo** o conteúdo e **todos** os anexos do
   chat estão locais — o que faltar (o celular puxa com `payload=0`; anexos nunca baixados) é baixado
   antes; se falhar, não converte.
2. Confirmação: "Tirar do servidor? O chat será apagado do servidor e dos seus outros dispositivos e
   ficará só neste. Os outros só o verão ao vivo, enquanto este app estiver aberto. Os anexos saem do
   servidor em até 24 h."
3. `storage = 'live_pending'` (sobrevive a fechar o app: a conversão continua na próxima conexão).
4. Push do tombstone do `chat` (§7.7): o servidor apaga fisicamente sessões, mensagens e o
   `chat_states`; o tombstone do `chat` fica no feed (`TOMBSTONE_RETENTION_DAYS`); os blobs que só esse
   chat referenciava saem pelo GC (`BLOB_ORPHAN_GRACE_H`). `chat_busy` → esperar e tentar de novo;
   `rev_mismatch` → reenviar com a rev atual; `gone` (alguém apagou o chat online ao mesmo tempo) →
   segue: o chat já não está no servidor, que era o pedido, e a cópia local fica.
5. Ack → `storage = 'live'`; o host esquece a contabilidade de sync das sessões/mensagens do chat (revs,
   outbox), guarda a rev do tombstone do `chat` (para uma volta futura) e **anuncia** o chat (`epoch`
   novo). Um host com o chat em `live_pending`/`live` **ignora** o tombstone dele no pull (não apaga a
   cópia local).
6. Os outros dispositivos aplicam o tombstone (apagam a cópia, §7.7). Quem estava com o chat aberto
   DEVERIA esperar até `LIVE_CONVERT_WAIT_S` por um anúncio do mesmo `chat_id` vindo do dispositivo que
   escreveu o tombstone: chegou → "Este chat agora é só ao vivo em <host>" e abre o visualizador; não
   chegou → "Este chat foi apagado". Um dispositivo com conteúdo não enviado desse chat cai no diálogo da
   §7.7 ("Manter como novo chat" cria **outro** chat, online).
- **Tombstone (decisão): aceito.** Ele só diz que um chat com aquele id existiu e foi apagado por aquele
  dispositivo naquela hora — igual a qualquer exclusão — e é o que faz os outros dispositivos apagarem as
  cópias. O servidor consegue ligar o id apagado ao mesmo id anunciado depois (fica sabendo que o chat
  continua ao vivo naquele host), nunca o conteúdo. Trocar o id na conversão esconderia só essa ligação
  (o servidor ainda vê o host e os horários) e obrigaria a reescrever referências locais (sessões,
  `fromChatId`, `updatedByChatId`…), então o id é mantido.

### 23.9 O que não existe em chats só ao vivo

- **"Executar neste dispositivo"**, troca de host, "fixar host" (§8.7–§8.9): a única cópia está no host
  (`live_conflict`). Host desligado = chat indisponível nos outros.
- **Divergência** (§9): não acontece.
- **Busca fora do host**: a busca do site/celular roda nos registros baixados e não encontra chats ao vivo;
  a busca local do host funciona normalmente.
- **Anexos como blobs**: nunca; outros dispositivos enviam e veem anexos só pelo host, com ele conectado
  (`attach.put`/`attach.get`, §23.7).
- **Ler a resposta pelos registros** (o `wait_for_reply` do celular, §8.6) e **qualquer acesso com o host
  desligado** (inclusive o gateway da §21).
- **Apagar ou converter pelo visualizador**: só no host (apagar = exclusão local + `live.withdraw
  { reason: 'deleted' }`).

### 23.10 Celular e site

- **Celular como host**: a escolha é "Salvar online" · **"Só neste aparelho"** (`storage = 'live'`). Como
  os chats executados no celular não aceitam controle remoto nem são transmitidos (decisão de produto do
  app mobile, §8.6), o celular NÃO DEVE anunciá-los em 1.8.0: ficam só locais. As conversões (§23.8)
  valem do mesmo jeito.
- **Celular como visualizador**: seção "Ao vivo" na lista de chats (agrupada por host, ordem `updatedAt`,
  com o `status`); abrir = §23.5; comandos = §23.7; notificações = §22.7.
- **Site**: declara `caps: ["live_chats"]`, faz `live.list` e acompanha os `live.*`; em 1.8.0 mostra só a
  **contagem** e uma **lista simples** (título, host, status: rodando / aguardando você / ocioso /
  reconectando) — sem abrir, sem `history.*`, sem comandos. Decifra os anúncios com `K_stream` (a DEK já
  está na memória da aba).
- **Desktop como visualizador** dos chats ao vivo de outro desktop: PODE, com as mesmas regras.

### 23.11 Diagramas

Anúncio, lista e queda do host:

```mermaid
sequenceDiagram
    participant H as Host (PC)
    participant S as Servidor (memória)
    participant C as Celular
    H->>S: hello {caps:[live_chats]}
    S-->>H: welcome {caps:[live_chats]}
    H->>S: live.announce {full:true, chats:[{chat, epoch E, arev 1, running:false, env}]}
    S-->>H: ack {accepted:[chat]}
    C->>S: hello {caps:[live_chats]} → welcome
    C->>S: live.list
    S-->>C: ack {chats:[LiveChat], settling_s:0}
    H->>S: live.announce {full:false, chats:[{chat, E, arev 2, running:true, env}]}
    S-->>C: live.update
    H--xS: conexão cai
    S-->>C: live.host {grace} → "reconectando…"
    S->>S: 10 s sem voltar
    S-->>C: live.removed {host_dropped} → o chat some
```

Abrir um chat ao vivo e acompanhar:

```mermaid
sequenceDiagram
    participant C as Celular (visualizador)
    participant S as Servidor
    participant H as Host
    C->>S: stream.subscribe [chat]
    S-->>C: ack
    S->>H: stream.resync_request
    H->>S: stream.event snapshot {live:{lseq 7}} (epoch E)
    S-->>C: stream.event
    C->>S: remote.send {history.list chat / session / message…}
    S->>H: remote.command
    H->>S: remote.result {epoch E, lseq 7, items, next}
    S-->>C: remote.result
    H->>S: stream.event rec {lseq 8, items:[message]}
    S-->>C: stream.event (maior lseq vence)
    C->>S: remote.send {send, attachments:[]}
    S->>H: remote.command
    H->>S: remote.result {accepted}
```

Conversões:

```mermaid
sequenceDiagram
    participant H as Host
    participant S as Servidor
    participant O as Outros dispositivos
    Note over H: online → ao vivo
    H->>H: baixa o que faltar (registros, anexos); storage = live_pending
    H->>S: sync.push {chat deleted:true}
    S->>S: apaga sessões, mensagens e chat_state; tombstone no feed
    S-->>O: sync.changes [tombstone] → apagam a cópia
    S-->>H: ack (H ignora o tombstone; storage = live)
    H->>S: live.announce {chat, epoch E'}
    S-->>O: live.update → "agora é só ao vivo em <host>"
    Note over H: ao vivo → online
    H->>S: PUT blobs; sync.push {chat + conteúdo, chat_bases 0} (replay)
    S->>S: cria registros + chat_state (host = H); apaga o vínculo
    S-->>O: sync.changes + chat.state + live.removed {saved_online}
    H->>S: demais lotes (replay, chat_bases 0)
```
