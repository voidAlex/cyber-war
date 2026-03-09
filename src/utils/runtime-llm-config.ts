import { decryptApiKey, encryptApiKey, type EncryptedApiKeyPayload } from './key-encryption'
import { getRuntimeLLMConfigSession, setRuntimeLLMConfigSession, type RuntimeLLMConfig } from './runtime-llm-session'

const ENCRYPTED_RUNTIME_KEY = 'cyberwar.llm.runtime-config.encrypted'

interface EncryptedRuntimeConfigRecord {
  provider: RuntimeLLMConfig['provider']
  endpoint: string
  encryptedApiKey: EncryptedApiKeyPayload
}

export interface ConfigureRuntimeConfigInput {
  provider: RuntimeLLMConfig['provider']
  endpoint: string
  apiKey: string
  passphrase: string
}

export async function configureRuntimeConfig(input: ConfigureRuntimeConfigInput): Promise<RuntimeLLMConfig> {
  const encryptedApiKey = await encryptApiKey(input.apiKey, input.passphrase)
  const record: EncryptedRuntimeConfigRecord = {
    provider: input.provider,
    endpoint: input.endpoint,
    encryptedApiKey,
  }

  window.localStorage.setItem(ENCRYPTED_RUNTIME_KEY, JSON.stringify(record))

  const runtimeConfig: RuntimeLLMConfig = {
    provider: input.provider,
    endpoint: input.endpoint,
    apiKey: input.apiKey,
  }
  setRuntimeLLMConfigSession(runtimeConfig)
  return runtimeConfig
}

export async function unlockRuntimeConfig(passphrase: string): Promise<RuntimeLLMConfig | null> {
  const encrypted = readEncryptedRuntimeConfig()
  if (!encrypted) {
    return null
  }

  const apiKey = await decryptApiKey(encrypted.encryptedApiKey, passphrase)
  const runtimeConfig: RuntimeLLMConfig = {
    provider: encrypted.provider,
    endpoint: encrypted.endpoint,
    apiKey,
  }
  setRuntimeLLMConfigSession(runtimeConfig)
  return runtimeConfig
}

export function readRuntimeConfigFromSession(): RuntimeLLMConfig | null {
  return getRuntimeLLMConfigSession()
}

export function clearRuntimeConfigSession(): void {
  setRuntimeLLMConfigSession(null)
}

export function hasEncryptedRuntimeConfig(): boolean {
  return readEncryptedRuntimeConfig() !== null
}

function readEncryptedRuntimeConfig(): EncryptedRuntimeConfigRecord | null {
  const raw = window.localStorage.getItem(ENCRYPTED_RUNTIME_KEY)
  if (!raw) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const record = parsed as Record<string, unknown>
    if (
      typeof record.provider !== 'string' ||
      typeof record.endpoint !== 'string' ||
      !record.encryptedApiKey ||
      typeof record.encryptedApiKey !== 'object'
    ) {
      return null
    }

    return {
      provider: record.provider as RuntimeLLMConfig['provider'],
      endpoint: record.endpoint,
      encryptedApiKey: record.encryptedApiKey as EncryptedApiKeyPayload,
    }
  } catch {
    return null
  }
}
