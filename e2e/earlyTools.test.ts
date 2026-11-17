// Execução antecipada de ferramentas (@shared/earlyTools): a fila dispara, em ordem e uma de cada
// vez, as chamadas completas e elegíveis do começo da lista; a chamada ainda sendo gerada espera; a
// 1ª não elegível (efeito, aprovação, argumentos inválidos) fecha a fila — a ordem nunca muda;
// descartar ignora o que estava em voo. O runner está em e2e/toolSearch.test.ts ("execução
// antecipada").
// Rodar: node --import ./e2e/ts-hooks.mjs --test e2e/earlyTools.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EARLY_TOOLS,
  EarlyToolQueue,
  earlyArgsOk,
  type EarlyCall
} from '../src/shared/earlyTools.ts'

const call = (id: string, name: string, complete = true, args = '{}'): EarlyCall => ({
  id,
  name,
  arguments: args,
  complete
})

function queue(): { q: EarlyToolQueue<string>; ran: string[]; release: () => void } {
  const ran: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const q = new EarlyToolQueue<string>({
    eligible: (c) => EARLY_TOOLS.has(c.name),
    run: async (c) => {
      ran.push(c.id)
      await gate
      return `ok:${c.id}`
    }
  })
  return { q, ran, release }
}

test('lista: só leitura (sem efeito fora do app); nada que escreva, execute, envie ou pergunte', () => {
  for (const n of ['read_file', 'browse_url', 'web_search', 'datetime', 'weather', 'memory_search'])
    assert.ok(EARLY_TOOLS.has(n), n)
  for (const n of [
    'shell',
    'write_file',
    'edit_file',
    'process_start',
    'process_stop',
    'send_to_chat',
    'delegate_task',
    'memory_write',
    'schedule',
    'ask_user',
    'present_file',
    'end_call',
    'tool_search',
    'get_location'
  ])
    assert.ok(!EARLY_TOOLS.has(n), n)
  assert.ok(earlyArgsOk('{"a":1}') && earlyArgsOk(''))
  assert.ok(!earlyArgsOk('{"a":') && !earlyArgsOk('[1]') && !earlyArgsOk('3'))
})

test('fila: dispara as completas em ordem, uma de cada vez; a incompleta espera; take devolve a execução', async () => {
  const { q, ran, release } = queue()
  q.offer([call('a', 'read_file'), call('b', 'datetime', false)])
  await Promise.resolve()
  assert.deepEqual(ran, ['a'], 'a b ainda está sendo gerada')
  q.offer([call('a', 'read_file'), call('b', 'datetime')])
  await Promise.resolve()
  assert.deepEqual(ran, ['a'], 'uma de cada vez: b espera a terminar')
  release()
  assert.equal(await q.take('a'), 'ok:a')
  assert.equal(await q.take('b'), 'ok:b')
  assert.deepEqual(ran, ['a', 'b'])
  assert.deepEqual(q.startedIds, ['a', 'b'])
  assert.equal(q.take('c'), null, 'não começou: roda no fim')
})

test('fila: a 1ª não elegível fecha — nada depois dela começa antes (a ordem não muda)', async () => {
  const { q, ran, release } = queue()
  release()
  q.offer([call('a', 'read_file'), call('w', 'write_file'), call('r', 'read_file')])
  await q.settle()
  assert.deepEqual(ran, ['a'], 'o read_file depois do write_file roda no fim (lê o arquivo novo)')
  q.offer([call('a', 'read_file'), call('w', 'write_file'), call('r', 'read_file')])
  await q.settle()
  assert.deepEqual(ran, ['a'], 'fechada continua fechada')
  // argumentos inválidos e chamada sem id também fecham
  const b = queue()
  b.release()
  b.q.offer([call('x', 'read_file', true, '{"path":'), call('y', 'read_file')])
  const c = queue()
  c.release()
  c.q.offer([call('', 'read_file'), call('z', 'read_file')])
  await Promise.all([b.q.settle(), c.q.settle()])
  assert.deepEqual(b.ran, [])
  assert.deepEqual(c.ran, [])
  // buraco no começo (índice ainda vazio): espera
  const d = queue()
  d.release()
  d.q.offer([undefined, call('k', 'read_file')])
  await d.q.settle()
  assert.deepEqual(d.ran, [])
})

test('fila: descartar (stream refeito/recusado) — nada novo começa e take devolve null', async () => {
  const { q, ran, release } = queue()
  q.offer([call('a', 'read_file')])
  q.discard()
  q.offer([call('a', 'read_file'), call('b', 'read_file')])
  release()
  await q.settle()
  assert.deepEqual(ran, ['a'])
  assert.equal(q.take('a'), null)
  assert.equal(q.discarded, true)
})
