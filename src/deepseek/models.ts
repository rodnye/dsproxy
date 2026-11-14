export type WebModelType = "default" | "expert";

export interface ModelSpec {
  id: string;
  modelType: WebModelType;
  thinking: boolean;
  search: boolean;
  description: string;
  capabilities: { reasoning: boolean; webSearch: boolean };
}

export const DEFAULT_MODEL_ID = "deepseek-chat";

function spec(
  id: string,
  modelType: WebModelType,
  thinking: boolean,
  search: boolean,
  description: string,
): ModelSpec {
  return {
    id,
    modelType,
    thinking,
    search,
    description,
    capabilities: { reasoning: thinking, webSearch: search },
  };
}

// Only aliases verified to work. Removed: `deepseek-expert-search` (Expert has no
// search) and `deepseek-vision` (the web API answers backend_err_by_model)
const MODELS: readonly ModelSpec[] = [
  spec(
    "deepseek-chat",
    "default",
    false,
    false,
    'Web "Fast" mode, non-thinking',
  ),
  spec(
    "deepseek-v3",
    "default",
    false,
    false,
    "Compatibility alias of deepseek-chat",
  ),
  spec(
    "deepseek-default",
    "default",
    false,
    false,
    "Compatibility alias of deepseek-chat",
  ),
  spec(
    "deepseek-reasoner",
    "default",
    true,
    false,
    'Web "Fast" mode with thinking enabled',
  ),
  spec(
    "deepseek-r1",
    "default",
    true,
    false,
    "R1-compatible alias of deepseek-reasoner",
  ),
  spec(
    "deepseek-chat-search",
    "default",
    false,
    true,
    "Fast mode with web search",
  ),
  spec(
    "deepseek-default-search",
    "default",
    false,
    true,
    "Alias of deepseek-chat-search",
  ),
  spec(
    "deepseek-reasoner-search",
    "default",
    true,
    true,
    "Thinking mode with web search",
  ),
  spec(
    "deepseek-r1-search",
    "default",
    true,
    true,
    "R1-compatible alias of deepseek-reasoner-search",
  ),
  spec("deepseek-expert", "expert", false, false, 'Web "Expert" mode'),
  spec(
    "deepseek-v4-pro",
    "expert",
    true,
    false,
    'Web "Expert" mode with thinking enabled',
  ),
];

export function listModels(): readonly ModelSpec[] {
  return MODELS;
}

export function findModel(id: string | undefined): ModelSpec | undefined {
  const wanted = (id ?? DEFAULT_MODEL_ID).toLowerCase();
  return MODELS.find((model) => model.id === wanted);
}
