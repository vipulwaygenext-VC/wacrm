import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
/** Google's OpenAI-compatible endpoint, so a Gemini key works through the
 *  OpenAI adapter (pick provider "OpenAI", paste the Gemini key, set the
 *  model to a `gemini-…` id such as `gemini-flash-latest`). */
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export function isGeminiTarget(model: string, apiKey: string): boolean {
  return /^gemini/i.test(model.trim()) || apiKey.startsWith('AIza');
}

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(
  args: ProviderArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args;

  const gemini = isGeminiTarget(model, apiKey);
  const label = gemini ? 'Gemini' : 'OpenAI';
  let res: Response;
  // Gemini's free tier sometimes answers 503/429/500 when busy; one quick
  // retry turns most of those into a normal reply instead of a silent bot.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(gemini ? GEMINI_URL : OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...mergeConsecutive(messages),
          ],
          // Gemini's compatibility layer takes the classic name; its Flash
          // models "think" first and that counts against the cap, so give
          // it headroom (the visible reply stays short via the prompt).
          ...(gemini
            ? { max_tokens: MAX_OUTPUT_TOKENS * 4 }
            : { max_completion_tokens: MAX_OUTPUT_TOKENS }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }
    if (gemini && attempt < 2 && [429, 500, 503].includes(res.status)) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    break;
  }

  if (!res.ok) {
    throw await providerHttpError(label, res);
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError(`${label} returned an empty response.`, {
      code: 'empty_response',
    });
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  });
  return { text, usage };
}
