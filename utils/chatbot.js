import { all } from "../db.js";

const CACHE_TTL_MS = 60_000;
const caches = {
  public: { entries: null, lastFetchedAt: 0 },
  admin: { entries: null, lastFetchedAt: 0 },
};

export async function answerQuestion(question, scope = "public") {
  const trimmedQuestion = (question || "").trim();
  if (!trimmedQuestion) {
    return {
      answer: "Je n'ai reçu aucune question à analyser.",
      sources: [],
      variant: scope,
    };
  }

  const searchTerms = extractTerms(trimmedQuestion);
  if (!searchTerms.length) {
    return {
      answer:
        "Je n'ai pas reconnu de mots-clés exploitables. Reformulez la question avec des termes plus précis.",
      sources: [],
      variant: scope,
    };
  }

  const entries = await getKnowledgeBase(scope);
  const ranked = entries
    .map((entry) => ({
      ...entry,
      score: computeScore(entry.searchText, searchTerms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!ranked.length) {
    return {
      answer:
        "Je n'ai rien trouvé correspondant à votre question. Essayez avec d'autres mots-clés ou vérifiez l'orthographe.",
      sources: [],
      variant: scope,
    };
  }

  const lines = ranked.map((entry) => {
    const snippet = buildSnippet(entry.text, searchTerms);
    return `• ${entry.source} : ${snippet}`;
  });

  const header =
    scope === "admin"
      ? "Mode administrateur — l'assistant peut consulter l'intégralité de la base de données."
      : "Mode public — l'assistant utilise uniquement les articles publiés et commentaires approuvés.";

  return {
    answer: `${header}\n${lines.join("\n")}`,
    sources: ranked.map((entry) => ({
      source: entry.source,
      snippet: buildSnippet(entry.text, searchTerms),
    })),
    variant: scope,
  };
}

async function getKnowledgeBase(scope) {
  const now = Date.now();
  const cache = caches[scope];
  if (cache?.entries && now - cache.lastFetchedAt < CACHE_TTL_MS) {
    return cache.entries;
  }

  const entries =
    scope === "admin" ? await buildAdminKnowledgeBase() : await buildPublicKnowledgeBase();

  if (cache) {
    cache.entries = entries;
    cache.lastFetchedAt = now;
  }

  return entries;
}

async function buildPublicKnowledgeBase() {
  const entries = [];

  const pages = await all(`
    SELECT p.slug_id, p.title, p.content, p.created_at,
           COALESCE(GROUP_CONCAT(t.name, ', '), '') AS tags
    FROM pages p
    LEFT JOIN page_tags pt ON pt.page_id = p.id
    LEFT JOIN tags t ON t.id = pt.tag_id
    GROUP BY p.id
  `);

  for (const page of pages) {
    const tagsLine = page.tags ? `\nTags : ${page.tags}` : "";
    const body = `Titre : ${page.title}\nContenu : ${page.content}${tagsLine}`;
    entries.push(buildEntry(`Article · ${page.title}`, body));
  }

  const comments = await all(`
    SELECT p.title AS pageTitle, c.body, c.author, c.created_at
    FROM comments c
    JOIN pages p ON p.id = c.page_id
    WHERE c.status = 'approved'
    ORDER BY c.created_at DESC
  `);

  for (const comment of comments) {
    const author = comment.author ? comment.author : "Anonyme";
    const meta = comment.created_at ? ` (${comment.created_at})` : "";
    const body = `Commentaire sur « ${comment.pageTitle} » par ${author}${meta}\n${comment.body}`;
    entries.push(buildEntry(`Commentaire · ${comment.pageTitle}`, body));
  }

  return entries;
}

async function buildAdminKnowledgeBase() {
  const baseEntries = await buildPublicKnowledgeBase();
  const adminEntries = baseEntries.slice();

  const tables = await all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );

  for (const table of tables) {
    const name = table.name;
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      continue;
    }
    const rows = await all(`SELECT * FROM ${name}`);
    const serialized = rows.length
      ? JSON.stringify(rows, null, 2)
      : "Aucune donnée enregistrée pour le moment.";
    adminEntries.push(
      buildEntry(`Table ${name}`, `Contenu brut de la table ${name}\n${serialized}`),
    );
  }

  return adminEntries;
}

function buildEntry(source, text) {
  const safeText = stripHtml(text || "");
  return {
    source,
    text: safeText,
    searchText: normalizeForSearch(`${source}\n${safeText}`),
  };
}

function extractTerms(question) {
  return normalizeForSearch(question)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1);
}

function computeScore(searchText, terms) {
  let score = 0;
  for (const term of terms) {
    const occurrences = countOccurrences(searchText, term);
    if (occurrences > 0) {
      score += 1 + Math.log(1 + occurrences);
    }
  }
  return score;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let position = haystack.indexOf(needle);
  while (position !== -1) {
    count += 1;
    position = haystack.indexOf(needle, position + needle.length);
  }
  return count;
}

function buildSnippet(text, terms) {
  if (!text) {
    return "";
  }
  const sentences = text.split(/(?<=[.!?\n])\s+/);
  for (const sentence of sentences) {
    const normalizedSentence = normalizeForSearch(sentence);
    if (terms.some((term) => normalizedSentence.includes(term))) {
      return clampSnippet(sentence.trim());
    }
  }
  return clampSnippet(text.trim());
}

function clampSnippet(sentence) {
  if (sentence.length <= 240) {
    return sentence;
  }
  return `${sentence.slice(0, 237)}…`;
}

function normalizeForSearch(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r\n|\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}
