import { REQUEST_SUMMARY_FILE } from './task-files.mjs';
import { getOpenAiApiKey } from './openai-config.mjs';
import { loadSettings } from './settings-store.mjs';

export { REQUEST_SUMMARY_FILE };

export function truncateToWords(text, maxWords) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  if (words.length <= maxWords) {
    return words.join(' ');
  }
  return `${words.slice(0, maxWords).join(' ')}…`;
}

async function summarizeWithOpenAI(text, maxWords) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    return null;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.REMOTECODE_SUMMARY_MODEL ?? 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Summarize the user request in at most ${maxWords} words. Return only the summary text.`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: Math.max(16, maxWords * 4),
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI summary failed (${response.status}): ${body}`);
  }

  const result = await response.json();
  const summary = result.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    return null;
  }

  return truncateToWords(summary, maxWords);
}

export async function buildRequestSummary(text, maxWords) {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  if (loadSettings().useLlmSummaries) {
    try {
      const llmSummary = await summarizeWithOpenAI(trimmed, maxWords);
      if (llmSummary) {
        return llmSummary;
      }
    } catch {
      // Fall back to truncation when summarization fails.
    }
  }

  return truncateToWords(trimmed, maxWords);
}
