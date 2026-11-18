/* Loose wire types for the two protocols Thinkflow speaks. Only the fields we touch are typed. */

/* ----------------------------- OpenAI ------------------------------ */

export interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /**
   * Provider-specific opaque data that clients may send in history; stripped before forwarding.
   */
  extra_content?: Record<string, unknown>;
}

export type OAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface OAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | OAIContentPart[] | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OAITool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export type OAIToolChoice =
  'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface OAIRequest {
  model: string;
  messages: OAIMessage[];
  tools?: OAITool[];
  tool_choice?: OAIToolChoice;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

export interface OAIDeltaToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface OAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: OAIDeltaToolCall[];
    };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

export interface OAICompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: string | null;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/* ---------------------------- Anthropic ---------------------------- */

export type AImageSource =
  { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };

export type AContentBlock =
  | { type: 'text'; text: string; [k: string]: unknown }
  | { type: 'image'; source: AImageSource; [k: string]: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown; [k: string]: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content?: string | AContentBlock[];
      is_error?: boolean;
      [k: string]: unknown;
    }
  | { type: 'thinking'; thinking: string; signature?: string; [k: string]: unknown }
  | { type: 'redacted_thinking'; data: string; [k: string]: unknown }
  | {
      type: 'document';
      source: { type: string; data?: string; media_type?: string };
      [k: string]: unknown;
    }
  | { type: string; [k: string]: unknown };

export interface AMessage {
  role: 'user' | 'assistant';
  content: string | AContentBlock[];
}

export interface ATool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  type?: string;
  [k: string]: unknown;
}

export type AToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string }
  | { type: 'none' };

export interface ARequest {
  model: string;
  messages: AMessage[];
  system?: string | { type: 'text'; text: string; [k: string]: unknown }[];
  max_tokens?: number;
  tools?: ATool[];
  tool_choice?: AToolChoice;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface AUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export type AStreamEvent =
  | {
      type: 'message_start';
      message: Omit<Partial<AMessageResponse>, 'usage'> & { usage?: AUsage };
    }
  | { type: 'content_block_start'; index: number; content_block: AContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'signature_delta'; signature: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason?: string | null; stop_sequence?: string | null };
      usage?: AUsage;
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };
