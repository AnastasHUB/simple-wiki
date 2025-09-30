const USER_AGENT_MAX_LENGTH = 512;

export function getClientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() || req.ip || null
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
  { pattern: /whatsapp/, reason: "Agent WhatsApp" },
  { pattern: /applebot/, reason: "Agent Applebot" },
  { pattern: /facebookexternalhit/, reason: "Agent Facebook" },
  { pattern: /facebot/, reason: "Agent Facebook" },
  { pattern: /ia_archiver/, reason: "Agent Alexa" },
  { pattern: /lighthouse/, reason: "Agent Lighthouse" },
  { pattern: /headlesschrome/, reason: "Navigateur Headless" },
  { pattern: /phantomjs/, reason: "Navigateur PhantomJS" },
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
