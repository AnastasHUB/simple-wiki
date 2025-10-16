import crypto from "node:crypto";

const CAPTCHA_ID = "math";
const CAPTCHA_LABEL = "Captcha mathématique";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MIN_OPERAND = 1;
const MAX_OPERAND = 9;

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function ensureSessionStore(req) {
  if (!req || typeof req !== "object") {
    return null;
  }
  const session = req.session;
  if (!session || typeof session !== "object") {
    return null;
  }
  if (!session.captchaChallenges || typeof session.captchaChallenges !== "object") {
    session.captchaChallenges = {};
  }
  return session.captchaChallenges;
}

function cleanupExpiredChallenges(store) {
  const now = Date.now();
  for (const [token, challenge] of Object.entries(store)) {
    if (!challenge || typeof challenge !== "object") {
      delete store[token];
      continue;
    }
    if (typeof challenge.expiresAt === "number" && challenge.expiresAt <= now) {
      delete store[token];
    }
  }
}

function createMathQuestion() {
  const a = getRandomInt(MIN_OPERAND, MAX_OPERAND);
  const b = getRandomInt(MIN_OPERAND, MAX_OPERAND);
  return {
    question: `${a} + ${b}`,
    answer: String(a + b),
  };
}

export function createCaptchaChallenge(req) {
  const store = ensureSessionStore(req);
  if (!store) {
    return null;
  }
  cleanupExpiredChallenges(store);
  const token = crypto.randomBytes(16).toString("hex");
  const { question, answer } = createMathQuestion();
  store[token] = {
    answer,
    createdAt: Date.now(),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
  return {
    id: CAPTCHA_ID,
    label: CAPTCHA_LABEL,
    token,
    question,
  };
}

export function verifyCaptchaResponse(req, { token, answer }) {
  const store = ensureSessionStore(req);
  if (!store) {
    return {
      success: false,
      errorCodes: ["session-missing"],
    };
  }
  cleanupExpiredChallenges(store);
  const trimmedToken = typeof token === "string" ? token.trim() : "";
  if (!trimmedToken) {
    return {
      success: false,
      errorCodes: ["missing-token"],
    };
  }
  const storedChallenge = store[trimmedToken];
  delete store[trimmedToken];
  if (!storedChallenge) {
    return {
      success: false,
      errorCodes: ["invalid-token"],
    };
  }
  if (
    typeof storedChallenge.expiresAt === "number" &&
    storedChallenge.expiresAt <= Date.now()
  ) {
    return {
      success: false,
      errorCodes: ["expired"],
    };
  }
  const trimmedAnswer = typeof answer === "string" ? answer.trim() : "";
  if (!trimmedAnswer) {
    return {
      success: false,
      errorCodes: ["missing-answer"],
    };
  }
  if (trimmedAnswer !== storedChallenge.answer) {
    return {
      success: false,
      errorCodes: ["incorrect-answer"],
    };
  }
  return {
    success: true,
    errorCodes: [],
  };
}

export function describeCaptcha() {
  return {
    id: CAPTCHA_ID,
    label: CAPTCHA_LABEL,
  };
}

export function isCaptchaAvailable() {
  return true;
}
