import { randomBytes, createHash } from "crypto";
import { authenticator } from "otplib";
import QRCode from "qrcode";

const DEFAULT_RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_GROUP_LENGTH = 5;

function normalizeTwoFactorToken(token) {
  if (typeof token !== "string") {
    return "";
  }
  return token.replace(/\s+/g, "").trim();
}

function isNumericToken(token) {
  return /^\d{6}$/.test(token);
}

authenticator.options = {
  step: 30,
  digits: 6,
};

export function generateTwoFactorSecret() {
  return authenticator.generateSecret();
}

export function buildTwoFactorProvisioningUri({
  secret,
  accountName,
  issuer,
}) {
  if (!secret || !accountName || !issuer) {
    return null;
  }
  try {
    return authenticator.keyuri(accountName, issuer, secret);
  } catch (err) {
    console.warn("Unable to build provisioning URI", err);
    return null;
  }
}

export async function buildQrCodeDataUrl(value, { size = 220 } = {}) {
  if (!value) {
    return null;
  }
  try {
    return await QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
    });
  } catch (err) {
    console.warn("Unable to generate QR code", err);
    return null;
  }
}

export function verifyTwoFactorToken(secret, token) {
  if (!secret) {
    return false;
  }
  const normalized = normalizeTwoFactorToken(token);
  if (!isNumericToken(normalized)) {
    return false;
  }
  try {
    return authenticator.verify({ token: normalized, secret });
  } catch (err) {
    console.warn("Unable to verify two-factor token", err);
    return false;
  }
}

function chunkRecoveryCode(value) {
  const parts = [];
  for (let i = 0; i < value.length; i += RECOVERY_CODE_GROUP_LENGTH) {
    parts.push(value.slice(i, i + RECOVERY_CODE_GROUP_LENGTH));
  }
  return parts.join("-");
}

function generateRecoveryCodeValue() {
  const raw = randomBytes(5).toString("hex").toUpperCase();
  return chunkRecoveryCode(raw);
}

export function generateRecoveryCodes(count = DEFAULT_RECOVERY_CODE_COUNT) {
  const total = Number.isInteger(count) && count > 0 ? count : DEFAULT_RECOVERY_CODE_COUNT;
  const codes = new Set();
  while (codes.size < total) {
    codes.add(generateRecoveryCodeValue());
  }
  return Array.from(codes);
}

export function normalizeRecoveryCode(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

export function formatRecoveryCodeForDisplay(value) {
  const normalized = normalizeRecoveryCode(value);
  if (!normalized) {
    return "";
  }
  return chunkRecoveryCode(normalized);
}

export function hashRecoveryCode(value) {
  const normalized = normalizeRecoveryCode(value);
  if (!normalized) {
    return null;
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function createRecoveryCodeState(codes = []) {
  const createdAt = new Date().toISOString();
  return codes
    .map((code) => {
      const normalized = normalizeRecoveryCode(code);
      if (!normalized) {
        return null;
      }
      const hash = hashRecoveryCode(normalized);
      if (!hash) {
        return null;
      }
      return {
        hash,
        used: false,
        createdAt,
        usedAt: null,
      };
    })
    .filter(Boolean);
}

export function serializeRecoveryCodeState(state = []) {
  try {
    return JSON.stringify(state);
  } catch (err) {
    console.warn("Unable to serialize recovery code state", err);
    return null;
  }
}

export function parseRecoveryCodeState(serialized) {
  if (!serialized) {
    return [];
  }
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const hash = typeof entry.hash === "string" ? entry.hash : null;
        if (!hash) {
          return null;
        }
        return {
          hash,
          used: entry.used === true,
          createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
          usedAt: typeof entry.usedAt === "string" ? entry.usedAt : null,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn("Unable to parse recovery code state", err);
    return [];
  }
}

export function markRecoveryCodeUsed(state = [], code) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) {
    return { updated: state, used: false };
  }
  const hash = hashRecoveryCode(normalized);
  if (!hash) {
    return { updated: state, used: false };
  }
  let used = false;
  const usedAt = new Date().toISOString();
  const updated = state.map((entry) => {
    if (!used && entry.hash === hash && entry.used !== true) {
      used = true;
      return { ...entry, used: true, usedAt };
    }
    return entry;
  });
  return { updated, used };
}

export function countAvailableRecoveryCodes(state = []) {
  return state.reduce((acc, entry) => (entry.used === true ? acc : acc + 1), 0);
}

export function hasValidTwoFactorToken(token) {
  return isNumericToken(normalizeTwoFactorToken(token));
}

export function describeRecoveryCodeState(state = []) {
  return state.map((entry) => ({
    hash: entry.hash,
    used: entry.used === true,
    usedAt: entry.usedAt || null,
    createdAt: entry.createdAt || null,
  }));
}
