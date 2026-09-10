import OpenAI from 'openai';
import { wrapOpenAI } from 'neatlogs';
import { MODEL_NAME, assertConfigured } from './config.js';

// Kimi K3 always reasons — omit thinking controls entirely.
const DEFAULT_PARAMS = {
  temperature: 0.3,
  max_tokens: 2048,
  top_p: 0.95,
} as const;

let client: any = null;

export function getClient(): any {
  if (client) return client;
  const { baseURL, apiKey } = assertConfigured();
  client = wrapOpenAI(new OpenAI({ baseURL, apiKey }));
  return client;
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export async function chat(
  messages: ChatMessage[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
) {
  const c = getClient();
  return c.chat.completions.create({
    model: MODEL_NAME,
    messages,
    stream: false,
    ...DEFAULT_PARAMS,
    ...(tools ? { tools } : {}),
  });
}
