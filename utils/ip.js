import fetch from "node-fetch";

const USER_AGENT_MAX_LENGTH = 512;

export function getClientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    null
  );
}

export function normalizeUserAgent(userAgent) {
  if (typeof userAgent !== "string") {
    return null;
  }
  const trimmed = userAgent.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > USER_AGENT_MAX_LENGTH) {
    return trimmed.slice(0, USER_AGENT_MAX_LENGTH);
  }
  return trimmed;
}

export function getClientUserAgent(req) {
  if (!req || typeof req !== "object") {
    return null;
  }
  const header = req.headers?.["user-agent"];
  return normalizeUserAgent(header);
}

const BOT_SIGNATURES = [
  { pattern: /googlebot/, reason: "Agent Googlebot" },
  { pattern: /bingbot/, reason: "Agent Bingbot" },
  { pattern: /duckduckbot/, reason: "Agent DuckDuckBot" },
  { pattern: /baiduspider/, reason: "Agent Baidu" },
  { pattern: /yandex(bot|images|video)/, reason: "Agent Yandex" },
  { pattern: /ahrefsbot/, reason: "Agent Ahrefs" },
  { pattern: /semrushbot/, reason: "Agent Semrush" },
  { pattern: /mj12bot/, reason: "Agent MJ12" },
  { pattern: /dotbot/, reason: "Agent DotBot" },
  { pattern: /pinterestbot/, reason: "Agent Pinterest" },
  { pattern: /linkedinbot/, reason: "Agent LinkedIn" },
  { pattern: /slackbot/, reason: "Agent Slack" },
  { pattern: /discordbot/, reason: "Agent Discord" },
  { pattern: /telegrambot/, reason: "Agent Telegram" },
  { pattern: /twitterbot/, reason: "Agent Twitter" },
  { pattern: /petalbot/, reason: "Agent PetalBot" },
  { pattern: /bytespider/, reason: "Agent ByteSpider" },
  { pattern: /qwant(bot|ify)/, reason: "Agent Qwant" },
  { pattern: /seznambot/, reason: "Agent Seznam" },
  { pattern: /sogou/, reason: "Agent Sogou" },
  { pattern: /exabot/, reason: "Agent ExaBot" },
  { pattern: /megaindex/, reason: "Agent MegaIndex" },
  { pattern: /roger(bot|seo)/, reason: "Agent RogerBot" },
  { pattern: /gptbot/, reason: "Agent GPTBot" },
  { pattern: /claudebot/, reason: "Agent ClaudeBot" },
  { pattern: /anthropic-ai/, reason: "Agent Anthropic" },
  { pattern: /whatsapp/, reason: "Agent WhatsApp" },
  { pattern: /applebot/, reason: "Agent Applebot" },
  { pattern: /facebookexternalhit/, reason: "Agent Facebook" },
  { pattern: /facebot/, reason: "Agent Facebook" },
  { pattern: /ia_archiver/, reason: "Agent Alexa" },
  { pattern: /lighthouse/, reason: "Agent Lighthouse" },
  { pattern: /headlesschrome/, reason: "Navigateur Headless" },
  { pattern: /phantomjs/, reason: "Navigateur PhantomJS" },
  { pattern: /rendertron/, reason: "Agent Rendertron" },
  { pattern: /google page speed insights/, reason: "PageSpeed Insights" },
  { pattern: /bot\b/, reason: "Mot-clé bot" },
  { pattern: /crawler/, reason: "Mot-clé crawler" },
  { pattern: /spider/, reason: "Mot-clé spider" },
  { pattern: /scrap(er|ing)/, reason: "Mot-clé scrape" },
  { pattern: /scanner/, reason: "Mot-clé scanner" },
  { pattern: /validator/, reason: "Mot-clé validator" },
  { pattern: /preview/, reason: "Mot-clé preview" },
  { pattern: /monitor/, reason: "Mot-clé monitor" },
  { pattern: /uptimerobot/, reason: "Service UptimeRobot" },
  { pattern: /statuscake/, reason: "Service StatusCake" },
  { pattern: /pingdom/, reason: "Service Pingdom" },
  { pattern: /datadog/, reason: "Service Datadog" },
  { pattern: /newrelic/, reason: "Service NewRelic" },
  { pattern: /python-requests/, reason: "Bibliothèque python-requests" },
  { pattern: /httpx\//, reason: "Client httpx" },
  { pattern: /aiohttp/, reason: "Client aiohttp" },
  { pattern: /httpclient/, reason: "Client HTTP générique" },
  { pattern: /libwww-perl/, reason: "Client libwww-perl" },
  { pattern: /curl\//, reason: "Client curl" },
  { pattern: /wget\//, reason: "Client wget" },
  { pattern: /okhttp/, reason: "Client OkHttp" },
  { pattern: /java\//, reason: "Client Java" },
  { pattern: /go-http-client/, reason: "Client Go" },
  { pattern: /node-fetch/, reason: "Client node-fetch" },
  { pattern: /axios\//, reason: "Client axios" },
  { pattern: /guzzlehttp/, reason: "Client Guzzle" },
  { pattern: /postmanruntime/, reason: "Client Postman" },
];

const DEFAULT_BOT_DETECTION_ENDPOINT = "https://api.apicagent.com";
const BOT_DETECTION_ENDPOINT =
  process.env.BOT_DETECTION_ENDPOINT || DEFAULT_BOT_DETECTION_ENDPOINT;
const DEFAULT_BOT_DETECTION_TIMEOUT_MS = 2000;
const configuredBotTimeout =
  process.env.BOT_DETECTION_TIMEOUT_MS !== undefined
    ? Number(process.env.BOT_DETECTION_TIMEOUT_MS)
    : DEFAULT_BOT_DETECTION_TIMEOUT_MS;
const BOT_DETECTION_TIMEOUT_MS = Number.isFinite(configuredBotTimeout)
  ? Math.max(500, configuredBotTimeout)
  : DEFAULT_BOT_DETECTION_TIMEOUT_MS;

let botDetectionFetchImpl = fetch;
const botDetectionCache = new Map();
const BOT_CACHE_MAX_SIZE = 250;

function cacheBotDetectionResult(key, value) {
  if (!key) {
    return;
  }
  if (botDetectionCache.size >= BOT_CACHE_MAX_SIZE) {
    const oldestKey = botDetectionCache.keys().next().value;
    if (oldestKey) {
      botDetectionCache.delete(oldestKey);
    }
  }
  botDetectionCache.set(key, value);
}

function buildBotApiUrl(userAgent) {
  const base = BOT_DETECTION_ENDPOINT.replace(/\/$/, "");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}ua=${encodeURIComponent(userAgent)}`;
}

function parseRemoteBotResponse(data) {
  if (!data || typeof data !== "object") {
    return { isBot: false, reason: null };
  }
  const parts = [];
  const category = typeof data.category === "string" ? data.category.trim() : "";
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const producer =
    typeof data?.producer?.name === "string"
      ? data.producer.name.trim()
      : "";
  const clientType =
    typeof data?.client?.type === "string" ? data.client.type.trim() : "";

  const botHints = [category, name, clientType].filter(Boolean).join(" ");
  const isBot = /bot|crawler|spider|scraper/i.test(botHints);

  if (!isBot) {
    return { isBot: false, reason: null };
  }

  if (category) parts.push(category);
  if (name && name.toLowerCase() !== category.toLowerCase()) {
    parts.push(name);
  }
  if (producer) {
    parts.push(producer);
  }

  const reason = parts.length
    ? `API: ${parts.join(" · ")}`
    : "API: Bot détecté";

  return { isBot: true, reason };
}

async function queryRemoteBotDetection(userAgent, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOT_DETECTION_TIMEOUT_MS);
  try {
    const url = buildBotApiUrl(userAgent);
    let signal = controller.signal;
    if (options?.signal) {
      if (
        typeof AbortSignal !== "undefined" &&
        typeof AbortSignal.any === "function"
      ) {
        try {
          signal = AbortSignal.any([options.signal, controller.signal]);
        } catch {
          signal = options.signal;
        }
      } else {
        signal = options.signal;
      }
    }
    const response = await botDetectionFetchImpl(url, {
      signal,
      headers: { Accept: "application/json" },
    });
    if (!response?.ok) {
      throw new Error(
        `Bot API request failed${response ? ` (${response.status})` : ""}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function detectBotUserAgent(userAgent) {
  const normalized = normalizeUserAgent(userAgent);
  if (!normalized) {
    return { isBot: false, reason: null, userAgent: null };
  }
  const lower = normalized.toLowerCase();
  if (lower === "-") {
    return { isBot: true, reason: "Agent absent (-)", userAgent: normalized };
  }
  for (const signature of BOT_SIGNATURES) {
    if (signature.pattern.test(lower)) {
      return {
        isBot: true,
        reason: signature.reason,
        userAgent: normalized,
      };
    }
  }
  return { isBot: false, reason: null, userAgent: normalized };
}

export function isLikelyBotUserAgent(userAgent) {
  return detectBotUserAgent(userAgent).isBot;
}

export async function detectBotUserAgentWithApi(userAgent, options = {}) {
  const baseDetection = detectBotUserAgent(userAgent);
  if (baseDetection.isBot || !baseDetection.userAgent || options?.skipRemote) {
    return baseDetection;
  }

  const cacheKey = baseDetection.userAgent;
  if (botDetectionCache.has(cacheKey)) {
    return botDetectionCache.get(cacheKey);
  }

  try {
    const data = await queryRemoteBotDetection(cacheKey, options);
    const parsed = parseRemoteBotResponse(data);
    if (parsed.isBot) {
      const result = {
        isBot: true,
        reason: parsed.reason,
        userAgent: cacheKey,
      };
      cacheBotDetectionResult(cacheKey, result);
      return result;
    }
    const notBot = { isBot: false, reason: null, userAgent: cacheKey };
    cacheBotDetectionResult(cacheKey, notBot);
    return notBot;
  } catch (error) {
    if (!options?.suppressLog) {
      console.warn("Remote bot detection failed", error);
    }
    return baseDetection;
  }
}

export function clearBotDetectionCache() {
  botDetectionCache.clear();
}

export function setBotDetectionFetchImplementation(fetchImpl) {
  botDetectionFetchImpl = typeof fetchImpl === "function" ? fetchImpl : fetch;
}
