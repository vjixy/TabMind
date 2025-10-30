import { AI } from './ai.js';
import { updateItem } from './db.js';

export async function captureActiveTabContent() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('No active tab.');
  }

  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      function getMeta(name) {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el?.content || '';
      }
      const title = document.title || '';
      const description = getMeta('description') || getMeta('og:description') || '';
      const keywords = getMeta('keywords') || '';
      const selection = window.getSelection()?.toString() || '';
      const raw = document.body?.innerText || '';
      const text = (title + '\n\n' + description + '\n\n' + raw).slice(0, 120_000);
      return { title, description, keywords, selection, url: location.href, text };
    }
  });

  const page = res?.result;
  if (!page) {
    throw new Error('Could not extract page content.');
  }

  return page;
}

export function buildAIContext(page) {
  const parts = [];
  if (page.title) parts.push(sanitizeWhitespace(page.title));
  if (page.description) parts.push(`Description:\n${sanitizeWhitespace(page.description)}`);
  if (page.keywords) parts.push(`Keywords: ${sanitizeWhitespace(page.keywords)}`);
  if (page.selection) parts.push(`User selection:\n${sanitizeWhitespace(page.selection)}`);
  if (page.text) parts.push(sanitizeWhitespace(page.text));
  return parts.join('\n\n').trim();
}

export async function enrichSavedItem(savedItem, aiContext, { onTrim } = {}) {
  let summary = { tldr: '', keyPoints: '' };
  try {
    summary = await summarizeWithRetries(aiContext, onTrim);
  } catch (err) {
    console.warn('Summarize failed, continuing with trimmed context.', err);
  }

  let meta = { tags: [], intent: '', entities: [] };
  try {
    meta = await AI.extractTags(trimContext(aiContext, 8000));
  } catch (err) {
    console.warn('Tag extraction failed.', err);
  }

  const updated = {
    ...savedItem,
    summary,
    tags: meta.tags || [],
    intent: meta.intent || '',
    entities: meta.entities || [],
    enhancedAt: Date.now()
  };

  await updateItem(updated);
  return updated;
}

async function summarizeWithRetries(text, onTrim) {
  const sequence = [60000, 45000, 32000, 22000, 16000, 11000, 8000, 6000];
  const unique = [];
  for (const limit of sequence) {
    const len = Math.min(limit, text.length);
    if (!unique.includes(len)) unique.push(len);
  }
  let lastError;
  let workingText = text;
  for (const limit of unique) {
    const snippet = trimContext(workingText, limit);
    if (snippet.length < workingText.length && onTrim) {
      onTrim(limit);
    }
    try {
      return await AI.summarize(snippet);
    } catch (err) {
      if (!isTooLargeError(err)) throw err;
      lastError = err;
      workingText = snippet;
    }
  }
  if (lastError) throw lastError;
  return await AI.summarize(trimContext(workingText, 6000));
}

function trimContext(text, limit) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastBreak = slice.lastIndexOf('\n');
  if (lastBreak > limit * 0.6) {
    return slice.slice(0, lastBreak);
  }
  return slice;
}

function sanitizeWhitespace(value = '') {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isTooLargeError(err) {
  const msg = (err && (err.message || err.toString())) || '';
  return /too\s+large|exceeds|length|token/i.test(msg);
}
