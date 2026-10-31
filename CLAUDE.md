# CLAUDE.md — ClearChatDesktop (app)

> ⚠️ **AVISO — PROTOCOLO DE SYNC COMPARTILHADO**
> Este repositório faz parte da pasta `ClearChat/` (repositório pai com o que é compartilhado) junto com
> `../ClearChatDesktop` (app), `../ClearChatWebsite` (servidor/site) e `../ClearChatMobile` (mobile).
> O protocolo de sync tem fonte única em `../docs/SYNC_PROTOCOL.md` (e `../docs/test-vectors/`); o
> `docs/` daqui é uma cópia byte a byte. Qualquer mudança no protocolo, na criptografia, nos esquemas dos
> registros, nos endpoints ou nas mensagens de WebSocket: edite no pai, suba a versão + changelog, rode
> `node ../scripts/protocol.mjs sync` e implemente no app **e** no servidor (o mobile revendora). Mudar
> um lado só quebra o sync. Regras gerais: `../CLAUDE.md`.

- Contrato do app: `SPEC.md` (lido antes de mudar qualquer coisa). Contrato do sync: `docs/SYNC_PROTOCOL.md`.
- Os esquemas de registro do sync (§4 do protocolo) espelham `src/shared/types.ts`, `memory.ts`, `skills.ts`,
  `presets.ts`, `webSearchSettings.ts` e as tabelas de `src/main/dbSchema.ts` / `src/main/memory/schema.ts`:
  mudou um desses dados → avaliar o impacto no protocolo (e nos dois repositórios).
- Vetores de cripto: `cd docs/test-vectors && npm install && node generate.ts --check` (o cliente de sync deve
  passar em todos). `docs/SYNC_PROTOCOL.md` e `docs/test-vectors/*.json` ficam fora do prettier (bytes idênticos).
- Commits sem trailer de co-autoria de IA.
