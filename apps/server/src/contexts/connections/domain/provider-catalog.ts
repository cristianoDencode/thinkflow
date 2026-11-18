/**
 * Static catalog of supported providers. Every provider speaks either the OpenAI
 * Chat Completions wire format or the Anthropic Messages format, which keeps the
 * gateway down to two translators (see contexts/gateway/domain/translators).
 *
 * Model lists change frequently; `suggestedModels` are only hints — the dashboard
 * lists live models from each connection (`GET {baseUrl}/models`).
 */
export type WireFormat = 'openai' | 'anthropic';
export type AuthStyle = 'bearer' | 'x-api-key' | 'none';

export interface ProviderModel {
  id: string;
  toolCalling?: boolean;
  free?: boolean;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  format: WireFormat;
  baseUrl: string;
  auth: AuthStyle;
  requiresApiKey: boolean;
  requiresBaseUrl: boolean;
  freeTier: boolean;
  description: string;
  keyUrl?: string;
  /** Path (relative to baseUrl) or absolute URL used to list models. null = not supported. */
  modelsUrl: string | null;
  /** Whether `stream_options.include_usage` is accepted (OpenAI format only). */
  streamUsage: boolean;
  extraHeaders?: Record<string, string>;
  suggestedModels: ProviderModel[];
}

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    format: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: true,
    description: 'Agregador com dezenas de modelos gratuitos (sufixo ":free").',
    keyUrl: 'https://openrouter.ai/settings/keys',
    modelsUrl: '/models',
    streamUsage: true,
    extraHeaders: { 'HTTP-Referer': 'https://github.com/thinkflow', 'X-Title': 'Thinkflow' },
    suggestedModels: [{ id: 'openrouter/auto', toolCalling: true }],
  },
  {
    id: 'groq',
    name: 'Groq',
    format: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: 'bearer',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: true,
    description: 'Inferência muito rápida com plano gratuito (limites por minuto/dia).',
    keyUrl: 'https://console.groq.com/keys',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [{ id: 'llama-3.3-70b-versatile', toolCalling: true, free: true }],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    format: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: 'bearer',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: true,
    description: 'Plano "Experiment" gratuito com limites de taxa.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    modelsUrl: '/models',
    streamUsage: false,
    suggestedModels: [{ id: 'mistral-small-latest', toolCalling: true, free: true }],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    format: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    auth: 'bearer',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: true,
    description: 'Catálogo build.nvidia.com com créditos gratuitos.',
    keyUrl: 'https://build.nvidia.com',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    format: 'openai',
    baseUrl: 'https://api.deepseek.com',
    auth: 'bearer',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: false,
    description:
      'API oficial da DeepSeek. Pago por uso (a documentação não lista plano gratuito; só há saldo de crédito concedido, que não renova). Com ferramentas, o Thinkflow desliga o modo de raciocínio, pois ele exige devolver o reasoning_content.',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [
      { id: 'deepseek-flash', toolCalling: true },
      { id: 'deepseek-v4-pro', toolCalling: true },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    format: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    auth: 'none',
    requiresApiKey: false,
    requiresBaseUrl: false,
    freeTier: true,
    description: 'Modelos rodando na sua máquina via Ollama.',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    format: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    requiresApiKey: false,
    requiresBaseUrl: false,
    freeTier: true,
    description: 'Servidor local do LM Studio.',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    format: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: 'x-api-key',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: false,
    description: 'API oficial da Anthropic (Claude). Pago por uso.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    modelsUrl: '/v1/models',
    streamUsage: false,
    suggestedModels: [
      { id: 'claude-opus-5-5', toolCalling: true },
      { id: 'claude-sonnet-5-5', toolCalling: true },
      { id: 'claude-haiku-5-5', toolCalling: true },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    format: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    requiresApiKey: true,
    requiresBaseUrl: false,
    freeTier: false,
    description: 'API oficial da OpenAI. Pago por uso.',
    keyUrl: 'https://platform.openai.com/api-keys',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [],
  },
  {
    id: 'custom-openai',
    name: 'Compatível com OpenAI (custom)',
    format: 'openai',
    baseUrl: '',
    auth: 'bearer',
    requiresApiKey: false,
    requiresBaseUrl: true,
    freeTier: false,
    description: 'Qualquer endpoint compatível com /v1/chat/completions (inclusive outro gateway).',
    modelsUrl: '/models',
    streamUsage: true,
    suggestedModels: [],
  },
  {
    id: 'custom-anthropic',
    name: 'Compatível com Anthropic (custom)',
    format: 'anthropic',
    baseUrl: '',
    auth: 'x-api-key',
    requiresApiKey: false,
    requiresBaseUrl: true,
    freeTier: false,
    description: 'Qualquer endpoint compatível com /v1/messages.',
    modelsUrl: '/v1/models',
    streamUsage: false,
    suggestedModels: [],
  },
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export const providerCatalog = {
  list(): readonly ProviderDefinition[] {
    return PROVIDERS;
  },
  get(id: string): ProviderDefinition | undefined {
    return BY_ID.get(id);
  },
  has(id: string): boolean {
    return BY_ID.has(id);
  },
};
