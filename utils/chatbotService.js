import { all, get, run } from "../db.js";
import { generateSnowflake } from "./snowflake.js";

const MAX_SNIPPET_LENGTH = 500;
const FALLBACK_RESPONSE =
  "Je n'ai pas encore été entraîné avec une réponse adaptée. Ajoutez du texte dans l'onglet d'administration pour enrichir mes connaissances.";

export async function listChatbotDocuments() {
  return all(
    `SELECT id, snowflake_id AS snowflakeId, title, content, created_at AS createdAt
       FROM chatbot_documents
      ORDER BY created_at DESC, id DESC`,
  );
}

export async function countChatbotDocuments() {
  const row = await get(
    "SELECT COUNT(*) AS total FROM chatbot_documents",
  );
  return Number(row?.total ?? 0);
}

export async function createChatbotDocument({ title, content }) {
  const normalizedContent = typeof content === "string" ? content.trim() : "";
  if (!normalizedContent) {
    throw new Error("Le contenu du document d'entraînement est requis.");
  }
  const normalizedTitle = typeof title === "string" ? title.trim() : "";
  const snowflakeId = generateSnowflake();
  await run(
    `INSERT INTO chatbot_documents(snowflake_id, title, content) VALUES(?,?,?)`,
    [snowflakeId, normalizedTitle || null, normalizedContent],
  );
  return snowflakeId;
}

export async function deleteChatbotDocument(snowflakeId) {
  if (!snowflakeId) {
    return false;
  }
  const result = await run(
    `DELETE FROM chatbot_documents WHERE snowflake_id = ?`,
    [snowflakeId],
  );
  return Boolean(result?.changes);
}

export async function generateChatbotReply(message, history = []) {
  const corpus = await listChatbotDocuments();
  if (!corpus.length) {
    return FALLBACK_RESPONSE;
  }

  const tokens = buildQueryTokens(message, history);
  if (!tokens.length) {
    return FALLBACK_RESPONSE;
  }

  let best = null;
  for (const document of corpus) {
    const evaluation = evaluateDocument(document, tokens);
    if (!best || evaluation.score > best.score) {
      best = { document, ...evaluation };
    }
  }

  if (!best || best.score <= 0) {
    return FALLBACK_RESPONSE;
  }

  const title = (best.document.title || "Document sans titre").trim();
  const snippet = truncateSnippet(best.snippet, MAX_SNIPPET_LENGTH);
  return `D'après le document « ${title} », ${snippet}`.trim();
}

export function summarizeDocument(content, { maxLength = 160 } = {}) {
  const clean = collapseWhitespace(content).slice(0, Math.max(20, maxLength));
  return clean.length < content.length ? `${clean}…` : clean;
}

export function countWords(content) {
  if (typeof content !== "string" || !content.trim()) {
    return 0;
  }
  return content
    .trim()
    .split(/\s+/u)
    .filter(Boolean).length;
}

function buildQueryTokens(message, history) {
  const seeds = [];
  if (typeof message === "string") {
    seeds.push(message);
  }
  if (Array.isArray(history) && history.length) {
    const recentUserMessages = history
      .filter((item) => item?.role === "user")
      .slice(-3)
      .map((item) => item.content || "");
    seeds.push(...recentUserMessages);
  }
  const joined = seeds
    .map((value) => (typeof value === "string" ? value : ""))
    .filter(Boolean)
    .join(" ");
  return tokenize(joined);
}

function evaluateDocument(document, tokens) {
  const paragraphs = extractParagraphs(document.content);
  if (!paragraphs.length) {
    return { score: 0, snippet: "" };
  }

  const normalizedTitle = normalizeText(document.title || "");
  let titleScore = 0;
  for (const token of tokens) {
    if (normalizedTitle.includes(token)) {
      titleScore += token.length > 6 ? 4 : 1;
    }
  }

  let bestParagraph = paragraphs[0];
  let bestParagraphScore = 0;
  let totalScore = titleScore;

  for (const paragraph of paragraphs) {
    const normalizedParagraph = normalizeText(paragraph);
    let paragraphScore = 0;
    for (const token of tokens) {
      const occurrences = countOccurrences(normalizedParagraph, token);
      if (occurrences > 0) {
        const weight = token.length > 6 ? 3 : 1;
        paragraphScore += occurrences * weight;
      }
    }
    if (paragraphScore > bestParagraphScore) {
      bestParagraphScore = paragraphScore;
      bestParagraph = paragraph;
    }
    totalScore += paragraphScore;
  }

  return {
    score: totalScore,
    snippet: bestParagraph,
  };
}

function tokenize(value) {
  if (typeof value !== "string") {
    return [];
  }
  const normalized = normalizeText(value);
  const tokens = normalized.split(/[^a-z0-9àâçéèêëîïôûùüÿñæœ]+/iu).filter(Boolean);
  const unique = new Set();
  for (const token of tokens) {
    if (token.length < 2) {
      continue;
    }
    unique.add(token);
  }
  return Array.from(unique);
}

function extractParagraphs(content) {
  if (typeof content !== "string") {
    return [];
  }
  const paragraphs = content
    .split(/\n{2,}/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length && content.trim()) {
    return [content.trim()];
  }
  return paragraphs;
}

function countOccurrences(haystack, needle) {
  if (!needle || !haystack.includes(needle)) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
}

function truncateSnippet(snippet, maxLength) {
  const collapsed = collapseWhitespace(snippet);
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

function collapseWhitespace(value) {
  return (value || "")
    .replace(/\s+/gu, " ")
    .trim();
}
