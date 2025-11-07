#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import configModule from './config.js';
import promptModule from './prompt.js';
function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || key in process.env) continue;
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

const { promptYesNo } = promptModule;
const {
  DEFAULT_MODEL_NAME,
  DEFAULT_OUTPUT_SUFFIX,
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_ANNOTATION_TEMPERATURE,
  DEFAULT_VOCAB_MEMORY_PROMPT_LIMIT,
  DEFAULT_VOCAB_MEMORY_STORE_LIMIT,
  DEFAULT_FOOTNOTE_MARGIN_TOKENS,
  DEFAULT_MIN_EFFECTIVE_CHUNK_TOKENS,
  DEFAULT_TOKEN_COUNT_CACHE_SIZE,
  DEFAULT_KEEP_CHUNKS,
  DEFAULT_SHRINK_FACTORS,
  DEFAULT_OPENAI_BASE_URL,
} = configModule;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is missing in your environment (.env).');
  process.exit(1);
}

let CHUNK_TOKENS = Number.parseInt(process.env.CHUNK_TOKENS ?? `${DEFAULT_CHUNK_TOKENS}`, 10);
const MODEL_NAME = process.env.MODEL_NAME || DEFAULT_MODEL_NAME;
const OUTPUT_SUFFIX = DEFAULT_OUTPUT_SUFFIX;
const ANNOTATION_TEMPERATURE = Number.parseFloat(
  process.env.ANNOTATION_TEMPERATURE ?? `${DEFAULT_ANNOTATION_TEMPERATURE}`,
);
const VOCAB_MEMORY_PROMPT_LIMIT = DEFAULT_VOCAB_MEMORY_PROMPT_LIMIT;
const VOCAB_MEMORY_STORE_LIMIT = Number.parseInt(
  process.env.VOCAB_MEMORY_STORE_LIMIT ?? `${DEFAULT_VOCAB_MEMORY_STORE_LIMIT}`,
  10,
);
const VOCAB_MEMORY_SUFFIX = 'vocab_memory.json';
const FOOTNOTE_MARGIN_TOKENS = Math.max(
  0,
  Number.parseInt(process.env.FOOTNOTE_MARGIN_TOKENS ?? `${DEFAULT_FOOTNOTE_MARGIN_TOKENS}`, 10),
);
const MIN_EFFECTIVE_CHUNK_TOKENS = DEFAULT_MIN_EFFECTIVE_CHUNK_TOKENS;
const TOKEN_COUNT_CACHE_SIZE = Math.max(
  32,
  Number.parseInt(process.env.TOKEN_COUNT_CACHE_SIZE ?? `${DEFAULT_TOKEN_COUNT_CACHE_SIZE}`, 10),
);
const KEEP_CHUNKS = ['1', 'true', 'yes'].includes(
  (process.env.KEEP_CHUNKS ?? (DEFAULT_KEEP_CHUNKS ? '1' : '')).toLowerCase(),
);
const SHRINK_FACTORS = DEFAULT_SHRINK_FACTORS;
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, '');
const RESPONSES_URL = `${OPENAI_BASE_URL}/responses`;
const OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION ?? process.env.OPENAI_ORG ?? '';
const CACHE_ROOT = path.resolve(process.cwd(), '.cache');
fs.mkdirSync(CACHE_ROOT, { recursive: true });

function defaultApiTimeout() {
  const scaled = Math.floor(CHUNK_TOKENS * 0.03);
  return Math.max(60, Math.min(180, scaled));
}

const API_TIMEOUT_MS = Number.parseInt(
  process.env.OPENAI_TIMEOUT ?? String(defaultApiTimeout()),
  10,
) * 1000;

const ALLOWED_EMOJIS = [
  '📚',
  '💓',
  '🔧',
  '🧠',
  '🗝️',
  '🇯🇵',
  '🌍',
  '🧩',
  '⏳',
];
const ALLOWED_EMOJI_INLINE = ALLOWED_EMOJIS.join('');
const EMOJI_LEGEND_TEXT = '📚 vocab / 💓 emotion / 🔧 grammar / 🧠 nuance / 🗝️ symbolism / 🇯🇵 JP gloss / 🌍 culture / 🧩 interpretation / ⏳ tense';

const FOOTNOTE_REF_RE = /\[\^\d+\]/g;
const FOOTNOTE_DEF_BLOCK_RE = /\n\[\^\d+\]:(?:.*(?:\n(?!\[\^\d+\]:).*)*)?/g;
const FOOTNOTE_DEF_RE = /^\[\^\d+\]:(.*)$/gm;

const tokenCountCache = new Map();

function approximateTokenCount(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const punctuation = (text.match(/[\p{P}\p{S}]/gu) || []).length;
  const charEstimate = Math.round(text.length / 4);
  return Math.max(1, Math.round((words + punctuation * 0.2 + charEstimate) / 2));
}

function countTokens(text, model = MODEL_NAME) {
  const key = `${model}::${text}`;
  if (tokenCountCache.has(key)) {
    const value = tokenCountCache.get(key);
    tokenCountCache.delete(key);
    tokenCountCache.set(key, value);
    return value;
  }
  const tokens = approximateTokenCount(text);
  tokenCountCache.set(key, tokens);
  if (tokenCountCache.size > TOKEN_COUNT_CACHE_SIZE) {
    const oldestKey = tokenCountCache.keys().next().value;
    tokenCountCache.delete(oldestKey);
  }
  return tokens;
}

function splitIntoTokenChunks(text, maxTokens = CHUNK_TOKENS, model = MODEL_NAME) {
  const effectiveMax = Math.max(MIN_EFFECTIVE_CHUNK_TOKENS, maxTokens - FOOTNOTE_MARGIN_TOKENS);
  if (effectiveMax < maxTokens) {
    console.log(
      `Applying footnote margin: chunk tokens ${maxTokens} -> ${effectiveMax} (margin ${FOOTNOTE_MARGIN_TOKENS})`,
    );
  }
  const paragraphs = text.trim().split(/\n\s*\n/);
  const chunks = [];
  let current = [];
  let currentTokens = 0;
  for (const paragraph of paragraphs) {
    const tokens = countTokens(paragraph, model);
    if (current.length && currentTokens + tokens > effectiveMax) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(paragraph);
    currentTokens += tokens;
  }
  if (current.length) {
    chunks.push(current.join('\n\n'));
  }
  return chunks;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeDashSpacing(text) {
  return text.replace(/\s*([—–])\s*/g, ' $1 ');
}

function fillTemplate(template, replacements) {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

function recordFailedResponse(meta, content, reason) {
  if (!meta || !meta.cacheDir || !meta.chunkIdx || !content) {
    return;
  }
  const label = meta.attemptLabel || 'attempt';
  const failedDir = path.join(meta.cacheDir, 'failed');
  fs.mkdirSync(failedDir, { recursive: true });
  const file = path.join(
    failedDir,
    `${String(meta.chunkIdx).padStart(4, '0')}_${label}.md`,
  );
  const payload = `<!-- ${reason} -->\n\n${content}`;
  try {
    fs.writeFileSync(file, payload, 'utf8');
    console.warn(`Saved failed response for chunk ${meta.chunkIdx} (${label}) to ${file}`);
  } catch (error) {
    console.warn(`Could not write failed response ${file}: ${error.message}`);
  }
}

function defaultCacheBaseDir(inputPath) {
  const parsed = path.parse(inputPath);
  const rawName = parsed.name || 'input';
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(CACHE_ROOT, `${safeName}.cache`);
}

function firstWords(s, n = 8) {
  return s.split(/\s+/).slice(0, n).join(' ');
}

function lastWords(s, n = 8) {
  const parts = s.split(/\s+/);
  return parts.slice(-n).join(' ');
}

function validatePreserveSource(src, annotated) {
  const srcNorm = normalizeWhitespace(normalizeDashSpacing(src.trim()));
  let body = annotated.replace(FOOTNOTE_DEF_BLOCK_RE, '');
  body = body.replace(FOOTNOTE_REF_RE, '');
  const bodyNorm = normalizeWhitespace(normalizeDashSpacing(body));
  if (!srcNorm) return true;
  if (bodyNorm.includes(srcNorm)) return true;
  const fw = firstWords(srcNorm);
  const lw = lastWords(srcNorm);
  const start = bodyNorm.indexOf(fw);
  const end = bodyNorm.lastIndexOf(lw);
  if (start !== -1 && end !== -1 && end > start) {
    const window = bodyNorm.slice(start, end + lw.length);
    if (window.includes(srcNorm)) return true;
  }
  return false;
}

function validateFootnoteEmojis(text) {
  const matches = text.matchAll(FOOTNOTE_DEF_RE);
  let foundAny = false;
  for (const match of matches) {
    foundAny = true;
    const content = match[1]?.trimStart();
    if (!content) return false;
    if (!ALLOWED_EMOJIS.some((emoji) => content.startsWith(emoji))) {
      return false;
    }
  }
  return true;
}

function flattenMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item) {
          if (item.type === 'text' && 'text' in item) return String(item.text);
          if ('text' in item) return String(item.text);
        }
        return String(item);
      })
      .join('\n');
  }
  return String(content ?? '');
}

function prepareResponsesIO(messages) {
  const instructionsParts = [];
  const formattedMessages = [];
  for (const message of messages) {
    const role = message.role ?? 'user';
    const text = flattenMessageContent(message.content ?? '');
    if (role === 'system') {
      instructionsParts.push(text);
      continue;
    }
    const segment = role === 'assistant'
      ? [{ type: 'output_text', text }]
      : [{ type: 'input_text', text }];
    formattedMessages.push({ role, content: segment });
  }
  const instructions = instructionsParts.join('\n').trim();
  return { instructions, formattedMessages };
}

async function postResponsesStream(serializedPayload) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (OPENAI_ORGANIZATION) {
    headers['OpenAI-Organization'] = OPENAI_ORGANIZATION;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), API_TIMEOUT_MS);
  const response = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers,
    body: serializedPayload,
    signal: controller.signal,
  }).catch((error) => {
    clearTimeout(timeout);
    throw error;
  });
  clearTimeout(timeout);
  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`OpenAI API error ${response.status}: ${body}`);
    err.status = response.status;
    throw err;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let collected = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (dataStr === '[DONE]') {
        await reader.cancel();
        return collected;
      }
      let event;
      try {
        event = JSON.parse(dataStr);
      } catch (err) {
        continue;
      }
      const eventType = event.type || event.object;
      if (eventType === 'response.output_text.delta') {
        const delta = event.delta;
        if (typeof delta === 'string') {
          collected += delta;
        }
      } else if (eventType === 'response.output_text') {
        const content = event.content || event.output_text;
        if (Array.isArray(content)) {
          const parts = content
            .map((item) => {
              if (typeof item === 'string') return item;
              if (typeof item === 'object' && item.type === 'output_text' && 'text' in item) {
                return item.text;
              }
              if (typeof item === 'object' && 'text' in item) return item.text;
              return '';
            })
            .join('');
          collected += parts;
        } else if (typeof content === 'string') {
          collected += content;
        }
      } else if (eventType === 'response.error') {
        const detail = event.error ?? event;
        const err = new Error(`OpenAI response error: ${JSON.stringify(detail)}`);
        err.status = event.status;
        throw err;
      }
    }
  }
  return collected;
}

async function callChatWithBackoff(messages, temperature = 0.5, maxRetries = 6) {
  const { instructions, formattedMessages } = prepareResponsesIO(messages);
  const payload = {
    model: MODEL_NAME,
    input: formattedMessages,
    temperature,
    stream: true,
  };
  if (instructions) {
    payload.instructions = instructions;
  }
  const serializedPayload = JSON.stringify(payload);
  let delaySeconds = 1.5;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const text = await postResponsesStream(serializedPayload);
      return { choices: [{ message: { content: text } }] };
    } catch (error) {
      const status = error.status;
      const isAbort = error.name === 'AbortError' || /timeout/i.test(error.message ?? '');
      const shouldRetry = status
        ? [429, 502, 503, 504].includes(status)
        : isAbort;
      if (!shouldRetry || attempt === maxRetries - 1) {
        throw error;
      }
      const jitter = Math.random() * 0.4 + 0.2;
      const sleepFor = delaySeconds + jitter;
      console.warn(
        `API error (attempt ${attempt + 1}/${maxRetries}): ${error.message} -> retry in ${sleepFor.toFixed(1)}s`,
      );
      await delay(sleepFor * 1000);
      delaySeconds = Math.min(delaySeconds * 1.7, 20);
    }
  }
  throw new Error('Exceeded max retries for API call');
}

async function detectGenreIntro(text) {
  const intro = text.slice(0, 1000);
  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant that classifies the genre of English book excerpts.',
    },
    {
      role: 'user',
      content:
        'Here is the beginning of a book. Based on the style, tone, and content, what is the most appropriate genre?\n\n'
        + intro
        + '\n\nChoose one from: literary fiction, sci-fi, fantasy, philosophy, biography, thriller, romance, academic writing, self-help, children\'s book, other. '
        + 'Reply with only: genre: [your_choice]',
    },
  ];
  const resp = await callChatWithBackoff(messages, 0.3);
  const content = resp.choices[0].message.content ?? '';
  const match = /genre:\s*(.+)/i.exec(content);
  return match ? match[1].trim().toLowerCase() : 'other';
}

function getGenreGuidance(genre) {
  const map = {
    'literary fiction': 'Focus on subtle emotional tone, literary metaphors, and abstract expressions.',
    'sci-fi': 'Explain technical or futuristic terms and unfamiliar concepts clearly.',
    fantasy: 'Clarify mythical elements, symbolic terms, or invented vocabulary.',
    philosophy: 'Emphasise logical structure, abstract concepts, and difficult sentence constructions.',
    biography: 'Focus on historical references and less common vocabulary.',
    thriller: 'Clarify idiomatic suspense language or psychological tension.',
    romance: 'Highlight emotional tone and cultural idioms.',
    'academic writing': 'Explain formal constructions, logical connectors, and field-specific vocabulary.',
    'self-help': 'Clarify abstract motivational language and practical expressions.',
    "children's book": 'Add only minimal annotation — focus on occasionally unfamiliar terms.',
    other: 'Annotate as usual based on clarity and learner needs.',
  };
  return map[genre] ?? map.other;
}

const OUTPUT_FORMAT_GUARD = `
Output format (strict):
- Output ONLY the annotated text.
- Do NOT add any headings, labels, quotes, code fences, or explanations.
- The output must be: the original text with inline [^n] markers, then a blank line, then footnote definitions.
- You may only insert [^n] markers into the original text and append new footnote definition lines; every other character (including whitespace and punctuation) must remain identical to the input chunk.
- You must reproduce the entire input chunk from the first character to the very last character; do NOT truncate or stop early for any reason.
- Footnote definitions must appear only after the complete body text; never place \[^n] definition blocks inside the body.
- Start every footnote definition with exactly one emoji from {allowed_emojis}.
`.trim();

const ANNOTATION_PROMPT_TEMPLATE_BASE = `Your role is to help me quickly and deeply understand English texts while improving my English skills.
Follow the guidelines below to carefully examine the entire text sentence by sentence and add annotations when needed.
Never skip or remove any part of the original text — even short lines or chapter titles like "Chapter no 8" must be preserved.
Read each sentence in context and add annotations in **simple English**.

Rules (hard):
0) Preserve the input text exactly: you may only INSERT inline [^n] markers within the body and APPEND footnote definition lines at the end. Never delete, replace, reorder, or re-wrap any existing characters or whitespace.
1) Multiple annotations per sentence are allowed. There is no strict upper limit, but avoid excessive repetition.
2) Prioritise VOCABULARY and EXPRESSIONS that could confuse B2–C1 learners:
   - uncommon or literary words
   - figurative / metaphorical uses of common words
   - idioms, phrasal verbs, collocations, cultural expressions
3) Keep grammar notes SHORT; add only when structure itself blocks understanding.
4) Use Obsidian footnotes strictly: inline [^n], and definitions at the end as "[^n]: ...".
5) Provide brief Japanese gloss when it improves understanding (subtle nuance, culture-specific usage, false friends, tricky polysemy, or idiomatic sense). Keep it short. If plain English is sufficient, omit Japanese.
6) Begin EVERY footnote definition with exactly one emoji chosen from {allowed_emojis}. No emoji → invalid.
7) Do NOT invent or paraphrase content not present verbatim in the input; annotate only what actually appears in the text.
8) Before submitting, double-check that the body text matches the input exactly (apart from inserted [^n] markers) and that all footnotes start with an allowed emoji.

{output_format_guard}

{recent_vocab_block}

📘 Genre-specific focus: {genre_guidance}

---

🔍 When to annotate:
- Annotate any word, phrase, or sentence that may feel subtle, abstract, literary, or unfamiliar.
- Especially highlight:
  - words that carry emotion or imagery
  - metaphorical uses
  - idiomatic or cultural nuances
  - rare or precise vocabulary
  - ambiguous expressions that can have multiple interpretations

---

📝 Annotation style:
- Add footnote markers (e.g. [^1]) immediately after the word or phrase.
- Write footnotes at the end of the chunk in Obsidian style.
- Emoji legend: {emoji_legend}
- Keep each annotation concise but informative.

✍️ Text to annotate:

{chunk}`.trim();

function makePrompt(chunk, genreGuidance, recentVocab) {
  const recentBlock = recentVocab.length
    ? `🚫 Recently annotated vocabulary — skip unless the context clearly expresses a new sense: ${recentVocab.join(', ')}`
    : '';
  const formattedGuard = fillTemplate(OUTPUT_FORMAT_GUARD, { allowed_emojis: ALLOWED_EMOJI_INLINE });
  return fillTemplate(ANNOTATION_PROMPT_TEMPLATE_BASE, {
    genre_guidance: genreGuidance,
    output_format_guard: formattedGuard,
    recent_vocab_block: recentBlock,
    allowed_emojis: ALLOWED_EMOJI_INLINE,
    emoji_legend: EMOJI_LEGEND_TEXT,
    chunk,
  });
}

function planShrunkSubchunks(chunkText) {
  for (const factor of SHRINK_FACTORS) {
    const newLimit = Math.max(MIN_EFFECTIVE_CHUNK_TOKENS, Math.floor(CHUNK_TOKENS * factor));
    if (newLimit >= CHUNK_TOKENS) continue;
    const subs = splitIntoTokenChunks(chunkText, newLimit);
    if (subs.length > 1 && subs.some((part) => part.trim())) {
      return subs;
    }
  }
  return [];
}

function shouldFallbackToSubchunks(error, attempt) {
  if (attempt < 2) return false;
  const message = (error?.message ?? '').toLowerCase();
  const isTimeout = /timeout/.test(message);
  const isSourceMismatch = message.includes('source text') || message.includes('model modified');
  return isTimeout || isSourceMismatch;
}

function ensureFootnotesAtEnd(text) {
  const footnoteBlocks = [];
  const withoutDefs = text.replace(FOOTNOTE_DEF_BLOCK_RE, (match) => {
    const cleaned = match.replace(/^\n/, '').trimEnd();
    if (cleaned) {
      footnoteBlocks.push(cleaned);
    }
    return '\n';
  });
  const body = withoutDefs.trimEnd();
  if (!footnoteBlocks.length) {
    return body;
  }
  return `${body}\n\n${footnoteBlocks.join('\n')}`.trimEnd();
}

async function annotateShrunkSubchunks(subchunks, guidance, memory, chunkIdx, totalChunks, cacheDir) {
  const annotatedParts = [];
  for (let subIdx = 0; subIdx < subchunks.length; subIdx += 1) {
    console.log(
      `[${chunkIdx}/${totalChunks}] fallback subchunk ${subIdx + 1}/${subchunks.length} annotating...`,
    );
    const recent = memory.recent(VOCAB_MEMORY_PROMPT_LIMIT);
    const subPrompt = makePrompt(subchunks[subIdx], guidance, recent);
    const annotated = await annotateChunkWithPrompt(subchunks[subIdx], subPrompt, {
      cacheDir,
      chunkIdx,
      attemptLabel: `sub${subIdx}`,
    });
    const sanitized = ensureFootnotesAtEnd(annotated);
    const { text } = normalizeFootnotesSafe(sanitized, 1);
    annotatedParts.push(text);
    if (memory.updateFromText(text)) {
      memory.save();
    }
  }
  const combined = annotatedParts.join('\n\n');
  return normalizeFootnotesSafe(combined, 1).text;
}

async function annotateChunkWithPrompt(chunk, promptTemplate, failureMeta) {
  const messages = [
    {
      role: 'system',
      content:
        'You are GPT-4.1 operating in deterministic annotation mode for English-learning footnotes. '
        + 'Follow every instruction exactly. '
        + 'Use Obsidian-style footnotes and never annotate the same word or phrase more than once per chunk. '
        + 'Preserve the input text verbatim: you may only insert inline [^n] markers in-place and append footnote definition lines after the body. '
        + 'Never delete, reorder, or alter any existing characters, punctuation, whitespace, or line breaks. '
        + 'Before replying, compare the input and your draft output to ensure they match character-for-character apart from the allowed insertions. '
        + `Every footnote definition must begin with exactly one emoji from this allowed set: ${ALLOWED_EMOJI_INLINE}. `
        + 'If you cannot comply, reply with `ERROR: unable to annotate`.',
    },
    { role: 'user', content: promptTemplate },
  ];
  const resp = await callChatWithBackoff(messages, ANNOTATION_TEMPERATURE);
  const content = resp.choices[0].message.content ?? '';
  if (!content) {
    throw new Error('Empty response from OpenAI');
  }
  const sanitized = ensureFootnotesAtEnd(content);
  if (!validatePreserveSource(chunk, sanitized)) {
    recordFailedResponse(failureMeta, sanitized, 'source_mismatch');
    throw new Error('Model modified or dropped source text');
  }
  if (!validateFootnoteEmojis(sanitized)) {
    recordFailedResponse(failureMeta, sanitized, 'emoji_missing');
    throw new Error('Footnote definitions missing required emoji prefix');
  }
  return sanitized;
}

function cacheChunkPath(cacheDir, idx) {
  return path.join(cacheDir, `${String(idx).padStart(4, '0')}.md`);
}

async function nextAvailableOutputPath(outputPath) {
  let counter = 1;
  const { dir, name, ext } = path.parse(outputPath);
  while (true) {
    const candidate = path.join(dir, `${name}_${counter}${ext}`);
    try {
      await fs.promises.access(candidate);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function normalizeFootnotesSafe(text, start = 1) {
  const refRegex = /\[\^(\d+)\](?!:)/g;
  const defRegex = /\[\^(\d+)\]:/g;
  const refMatches = [];
  const defMatches = [];
  let match;
  while ((match = refRegex.exec(text)) !== null) {
    refMatches.push({ index: match.index, id: match[1], kind: 'ref' });
  }
  while ((match = defRegex.exec(text)) !== null) {
    defMatches.push({ index: match.index, id: match[1], kind: 'def' });
  }
  const order = [];
  const seen = new Set();
  [...refMatches, ...defMatches]
    .sort((a, b) => a.index - b.index)
    .forEach(({ id }) => {
      if (!seen.has(id)) {
        order.push(id);
        seen.add(id);
      }
    });
  const mapping = new Map();
  let nextId = start;
  for (const oldId of order) {
    mapping.set(oldId, String(nextId));
    nextId += 1;
  }
  const items = [...refMatches, ...defMatches].sort((a, b) => b.index - a.index);
  let result = text;
  for (const item of items) {
    let newId = mapping.get(item.id);
    if (!newId) {
      newId = String(nextId);
      nextId += 1;
      mapping.set(item.id, newId);
    }
    if (item.kind === 'def') {
      result = `${result.slice(0, item.index)}[^${newId}]:${result.slice(item.index + item.id.length + 4)}`;
    } else {
      result = `${result.slice(0, item.index)}[^${newId}]${result.slice(item.index + item.id.length + 3)}`;
    }
  }
  return { text: result, nextId };
}

class VocabMemory {
  constructor(filePath, storeLimit = VOCAB_MEMORY_STORE_LIMIT) {
    this.path = filePath;
    this.storeLimit = storeLimit;
    this.terms = [];
    this.lower = new Set();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.path)) return;
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      const filtered = [];
      const seen = new Set();
      for (const entry of data) {
        if (typeof entry !== 'string') continue;
        const clean = entry.trim();
        if (!clean) continue;
        const lower = clean.toLowerCase();
        if (seen.has(lower)) continue;
        filtered.push(clean);
        seen.add(lower);
      }
      const limited = filtered.slice(-this.storeLimit);
      this.terms = limited;
      this.lower = new Set(limited.map((t) => t.toLowerCase()));
    } catch (error) {
      console.warn(`Failed to load vocab memory ${this.path}: ${error.message}`);
    }
  }

  save() {
    try {
      const payload = this.terms.slice(-this.storeLimit);
      fs.writeFileSync(this.path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      console.warn(`Failed to save vocab memory ${this.path}: ${error.message}`);
    }
  }

  deleteFile() {
    try {
      fs.rmSync(this.path, { force: true });
    } catch (error) {
      console.warn(`Failed to delete vocab memory ${this.path}: ${error.message}`);
    }
  }

  recent(limit) {
    if (limit <= 0) return [];
    return this.terms.slice(-limit);
  }

  updateFromText(text) {
    const terms = VocabMemory.extractTerms(text);
    return this.addTerms(terms);
  }

  addTerms(terms) {
    let updated = false;
    for (const term of terms) {
      const clean = term.trim();
      if (!clean) continue;
      const lower = clean.toLowerCase();
      if (this.lower.has(lower)) continue;
      this.terms.push(clean);
      this.lower.add(lower);
      updated = true;
    }
    if (this.terms.length > this.storeLimit) {
      this.terms = this.terms.slice(-this.storeLimit);
      this.lower = new Set(this.terms.map((t) => t.toLowerCase()));
    }
    return updated;
  }

  static extractTerms(text) {
    const terms = [];
    const regex = /^\[\^\d+\]:(.*)$/gm;
    let match;
    while ((match = regex.exec(text)) !== null) {
      let content = match[1].trim();
      if (!content) continue;
      for (const emoji of ALLOWED_EMOJIS) {
        if (content.startsWith(emoji)) {
          content = content.slice(emoji.length).trimStart();
          break;
        }
      }
      if (!content) continue;
      let candidate = content;
      for (const sep of [':', '：', ' - ', ' — ', ' – ', '—', '–']) {
        const idx = candidate.indexOf(sep);
        if (idx !== -1) {
          candidate = candidate.slice(0, idx);
          break;
        }
      }
      const term = candidate.trim();
      if (term) terms.push(term);
    }
    return terms;
  }
}

function vocabMemoryPath(baseCacheDir) {
  return path.join(baseCacheDir, VOCAB_MEMORY_SUFFIX);
}

async function processFile(
  filePath,
  { resume = true, cacheBaseDir, outputPath, forceOverwrite = false, preserveChunks = false } = {},
) {
  const inputPath = path.resolve(filePath);
  const resolvedBaseCache = cacheBaseDir
    ? path.resolve(cacheBaseDir)
    : defaultCacheBaseDir(inputPath);
  await fs.promises.mkdir(resolvedBaseCache, { recursive: true });
  const cacheDir = path.join(resolvedBaseCache, 'chunks');
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const defaultOutputPath = path.join(
    path.dirname(inputPath),
    `${path.parse(inputPath).name}${OUTPUT_SUFFIX}`,
  );
  let finalOutputPath = outputPath ? path.resolve(outputPath) : defaultOutputPath;
  const memoryPath = vocabMemoryPath(resolvedBaseCache);
  const memory = new VocabMemory(memoryPath);

  if (fs.existsSync(finalOutputPath)) {
    if (forceOverwrite) {
      console.warn(`Overwriting existing file: ${path.basename(finalOutputPath)}`);
    } else {
      console.warn(`Output exists: ${path.basename(finalOutputPath)}`);
      if (await promptYesNo(`Overwrite existing file '${path.basename(finalOutputPath)}'?`)) {
        console.log(`Overwriting existing file: ${path.basename(finalOutputPath)}`);
      } else {
        finalOutputPath = await nextAvailableOutputPath(finalOutputPath);
        console.log(`Keeping both files. Writing to: ${path.basename(finalOutputPath)}`);
      }
    }
  }

  const inputText = await fs.promises.readFile(inputPath, 'utf8');
  console.log('Detecting genre from intro...');
  const genre = await detectGenreIntro(inputText);
  const guidance = getGenreGuidance(genre);
  console.log(`Detected genre: ${genre} | Guidance: ${guidance}`);

  const chunks = splitIntoTokenChunks(inputText, CHUNK_TOKENS);
  console.log(`Total chunks: ${chunks.length}`);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const idx = i + 1;
    const chunkPath = cacheChunkPath(cacheDir, idx);
    if (resume && fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 0) {
      console.log(`[${idx}/${chunks.length}] cache hit -> skip`);
      const cached = fs.readFileSync(chunkPath, 'utf8');
      if (memory.updateFromText(cached)) memory.save();
      continue;
    }
    console.log(`[${idx}/${chunks.length}] annotating...`);
    const recent = memory.recent(VOCAB_MEMORY_PROMPT_LIMIT);
    const prompt = makePrompt(chunk, guidance, recent);
    let tries = 0;
    let success = false;
    let lastErr;
    while (tries < 3 && !success) {
      tries += 1;
      try {
        const annotated = await annotateChunkWithPrompt(chunk, prompt, {
          cacheDir,
          chunkIdx: idx,
          attemptLabel: `try${tries}`,
        });
        const sanitized = ensureFootnotesAtEnd(annotated);
        const { text } = normalizeFootnotesSafe(sanitized, 1);
        fs.writeFileSync(chunkPath, text, 'utf8');
        if (memory.updateFromText(text)) memory.save();
        success = true;
      } catch (error) {
        lastErr = error;
        console.warn(`annotate retry ${tries}/3 due to: ${error.message}`);
        const fallback = shouldFallbackToSubchunks(error, tries);
        if (fallback) {
          const subchunks = planShrunkSubchunks(chunk);
          if (subchunks.length) {
            console.log(`[${idx}/${chunks.length}] shrinking chunk -> ${subchunks.length} subchunks`);
            try {
              const combined = await annotateShrunkSubchunks(
                subchunks,
                guidance,
                memory,
                idx,
                chunks.length,
                cacheDir,
              );
              fs.writeFileSync(chunkPath, combined, 'utf8');
              success = true;
            } catch (subErr) {
              lastErr = subErr;
              console.warn(`Fallback subchunk annotation failed: ${subErr.message}`);
            }
          }
        }
        if (!success) {
          await delay((1.2 * tries + Math.random() * 0.5) * 1000);
        }
      }
    }
    if (!success) {
      throw new Error(`Failed to annotate chunk ${idx}: ${lastErr?.message ?? 'unknown error'}`);
    }
  }

  console.log('Combining chunks & renumbering footnotes across the document...');
  const annotatedChunks = [];
  for (let i = 1; i <= chunks.length; i += 1) {
    const chunkPath = cacheChunkPath(cacheDir, i);
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Missing cached chunk: ${chunkPath}`);
    }
    annotatedChunks.push(fs.readFileSync(chunkPath, 'utf8'));
  }
  const combined = [];
  let nextId = 1;
  for (const annotated of annotatedChunks) {
    const sanitized = ensureFootnotesAtEnd(annotated);
    const normalized = normalizeFootnotesSafe(sanitized, nextId);
    combined.push(normalized.text);
    nextId = normalized.nextId;
  }
  const finalText = combined.join('\n\n');
  memory.save();
  memory.deleteFile();
  fs.writeFileSync(finalOutputPath, finalText, 'utf8');
  console.log(`✅ Annotated output saved to: ${finalOutputPath}`);

  const shouldRemoveChunks = !KEEP_CHUNKS && !preserveChunks;
  if (shouldRemoveChunks) {
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      console.log(`🧹 Removed cache directory: ${cacheDir}`);
    } catch (error) {
      console.warn(`Could not remove cache directory ${cacheDir}: ${error.message}`);
    }
  }

  return finalOutputPath;
}

export { processFile };

export function setChunkTokenLimit(limit) {
  const numeric = Number.parseInt(limit, 10);
  if (Number.isFinite(numeric) && numeric > 0) {
    CHUNK_TOKENS = numeric;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { noResume: false, chunkTokens: CHUNK_TOKENS, input: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-resume') {
      options.noResume = true;
      continue;
    }
    if (arg === '--chunk-tokens') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--chunk-tokens requires a value');
      }
      options.chunkTokens = Number.parseInt(value, 10);
      i += 1;
      continue;
    }
    if (!options.input) {
      options.input = arg;
    }
  }
  if (!options.input) {
    console.error('Usage: obsidian-annotator <input_file> [--no-resume] [--chunk-tokens N]');
    process.exit(1);
  }
  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    CHUNK_TOKENS = options.chunkTokens;
    await processFile(options.input, { resume: !options.noResume });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  await main();
}
