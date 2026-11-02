import { useState } from 'react'
import type { ProviderTestResult } from '@shared/ipc'
import { draftToInput, type ProviderDraft } from '@shared/providerDraft'
import { api, errorMessage } from './api'

// o formulário (rascunho, troca de tipo, headers, validação) é puro e fica em @shared/providerDraft
// (o app mobile vendora); aqui só o teste de conexão, que usa o IPC
export {
  draftToInput,
  draftWithBaseUrl,
  draftWithKind,
  parseHeaders,
  PROVIDER_KIND_NAME,
  type ProviderDraft
} from '@shared/providerDraft'

export function useProviderTest(): {
  testing: boolean
  result: ProviderTestResult | null
  test: (d: ProviderDraft) => Promise<void>
  reset: () => void
} {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const test = async (d: ProviderDraft): Promise<void> => {
    const input = draftToInput(d)
    if (typeof input === 'string') {
      setResult({ ok: false, error: input })
      return
    }
    setTesting(true)
    setResult(null)
    try {
      setResult(
        await api.providers.test({
          kind: input.kind,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          headers: input.headers
        })
      )
    } catch (err) {
      setResult({ ok: false, error: errorMessage(err) })
    } finally {
      setTesting(false)
    }
  }
  return { testing, result, test, reset: () => setResult(null) }
}
