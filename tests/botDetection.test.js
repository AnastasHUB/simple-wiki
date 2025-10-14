import test from "node:test";
import assert from "node:assert/strict";

import {
  clearBotDetectionCache,
  detectBotUserAgent,
  detectBotUserAgentWithApi,
  normalizeUserAgent,
  setBotDetectionFetchImplementation,
} from "../utils/ip.js";

test("normalizeUserAgent tronque et nettoie les valeurs incorrectes", () => {
  assert.equal(normalizeUserAgent(null), null);
  assert.equal(normalizeUserAgent(42), null);
  assert.equal(normalizeUserAgent("   "), null);

  const longUserAgent = `${"a".repeat(600)}bot`;
  const normalized = normalizeUserAgent(longUserAgent);
  assert.equal(normalized.length, 512);
  assert.ok(normalized.startsWith("a"));
});

test("detectBotUserAgent identifie les robots modernes", () => {
  const cases = [
    {
      agent:
        "Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)",
      reason: "Agent GPTBot",
    },
    {
      agent:
        "Mozilla/5.0 (Linux; Android 10; PETALBOT) AppleWebKit/537.36 (KHTML, like Gecko)",
      reason: "Agent PetalBot",
    },
    {
      agent: "Twitterbot/1.0 (+https://help.twitter.com/en/using-twitter/twitter-verified-bots)",
      reason: "Agent Twitter",
    },
    {
      agent:
        "Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com/bot)",
      reason: "Agent ClaudeBot",
    },
    {
      agent: "Bytespider (http://www.bytespider.com/info.html)",
      reason: "Agent ByteSpider",
    },
    {
      agent: "curl/8.0.1",
      reason: "Client curl",
    },
    {
      agent: "python-httpx/0.27.0",
      reason: "Client httpx",
    },
  ];

  for (const { agent, reason } of cases) {
    const detection = detectBotUserAgent(agent);
    assert.equal(detection.isBot, true, `${agent} doit être détecté`);
    assert.equal(detection.reason, reason);
    assert.equal(detection.userAgent, normalizeUserAgent(agent));
  }
});

test("detectBotUserAgent laisse passer les navigateurs légitimes", () => {
  const browsers = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  ];

  for (const agent of browsers) {
    const detection = detectBotUserAgent(agent);
    assert.equal(detection.isBot, false, `${agent} ne doit pas être détecté`);
    assert.equal(detection.reason, null);
    assert.equal(detection.userAgent, agent);
  }
});

test("detectBotUserAgentWithApi s'appuie sur l'API pour identifier un robot", async (t) => {
  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  setBotDetectionFetchImplementation(async (url) => {
    assert.ok(url.includes("ua=FriendlyVisitor"));
    return {
      ok: true,
      json: async () => ({ category: "Monitoring bot", name: "FriendlyMonitor" }),
    };
  });

  const detection = await detectBotUserAgentWithApi("FriendlyVisitor/1.0");
  assert.equal(detection.isBot, true);
  assert.equal(detection.reason, "API: Monitoring bot · FriendlyMonitor");
});

test("detectBotUserAgentWithApi met en cache les réponses négatives", async (t) => {
  t.after(() => {
    setBotDetectionFetchImplementation(null);
    clearBotDetectionCache();
  });

  let calls = 0;
  setBotDetectionFetchImplementation(async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ client: { type: "browser" } }),
    };
  });

  const agent = "Mozilla/5.0 (compatible; ExampleBrowser/1.0)";
  const first = await detectBotUserAgentWithApi(agent);
  const second = await detectBotUserAgentWithApi(agent);

  assert.equal(first.isBot, false);
  assert.equal(second.isBot, false);
  assert.equal(calls, 1);
});
