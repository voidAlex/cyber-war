export interface RuntimeLLMConfig {
  provider: 'openai' | 'anthropic' | 'deepseek' | 'custom'
  endpoint: string
  apiKey: string
  model: string
}

let runtimeConfigInSession: RuntimeLLMConfig | null = null

export function setRuntimeLLMConfigSession(config: RuntimeLLMConfig | null): void {
  runtimeConfigInSession = config
}

export function getRuntimeLLMConfigSession(): RuntimeLLMConfig | null {
  return runtimeConfigInSession
}
