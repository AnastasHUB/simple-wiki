import {
  generateRegistrationOptions as defaultGenerateRegistrationOptions,
  verifyRegistrationResponse as defaultVerifyRegistrationResponse,
  generateAuthenticationOptions as defaultGenerateAuthenticationOptions,
  verifyAuthenticationResponse as defaultVerifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { get, run, all } from "../db.js";

const REGISTRATION_SESSION_KEY = "pendingWebAuthnRegistration";
const AUTHENTICATION_SESSION_KEY = "pendingWebAuthnAuthentication";

const defaultAdapter = {
  generateRegistrationOptions: defaultGenerateRegistrationOptions,
  verifyRegistrationResponse: defaultVerifyRegistrationResponse,
  generateAuthenticationOptions: defaultGenerateAuthenticationOptions,
  verifyAuthenticationResponse: defaultVerifyAuthenticationResponse,
};

let activeAdapter = { ...defaultAdapter };

export function setWebAuthnAdapter(overrides = {}) {
  activeAdapter = { ...defaultAdapter, ...overrides };
}

export function resetWebAuthnAdapter() {
  activeAdapter = { ...defaultAdapter };
}

function getAdapter() {
  return activeAdapter;
}

function normalizeTransports(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter(Boolean);
      }
    } catch (_err) {
      return [];
    }
  }
  return [];
}

function serializeTransports(value) {
  const transports = normalizeTransports(value);
  return transports.length ? JSON.stringify(transports) : null;
}

function bufferToBase64Url(buffer) {
  if (!buffer) return "";
  return Buffer.from(buffer).toString("base64url");
}

function base64UrlToBuffer(value) {
  if (typeof value !== "string" || !value) {
    return Buffer.alloc(0);
  }
  return Buffer.from(value, "base64url");
}

function pickHost(req) {
  if (process.env.WEBAUTHN_HOST) {
    return process.env.WEBAUTHN_HOST;
  }
  if (typeof req?.get === "function") {
    const header = req.get("host");
    if (header) {
      return header;
    }
  }
  if (req?.headers?.host) {
    return req.headers.host;
  }
  return "localhost";
}

function pickProtocol(req) {
  if (process.env.WEBAUTHN_ORIGIN) {
    return null;
  }
  const forwarded = req?.headers?.["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) {
      return first;
    }
  }
  if (typeof req?.protocol === "string" && req.protocol) {
    return req.protocol;
  }
  return "https";
}

export function buildWebAuthnConfig(req, { rpName } = {}) {
  const host = pickHost(req);
  const rpIDSource = process.env.WEBAUTHN_RP_ID || host;
  const rpID = rpIDSource.split(":")[0].toLowerCase();
  const protocol = pickProtocol(req);
  const origin = process.env.WEBAUTHN_ORIGIN || `${protocol || "https"}://${host}`;
  const effectiveRpName =
    process.env.WEBAUTHN_RP_NAME || rpName || "SimpleWiki";
  return { rpID, origin, rpName: effectiveRpName };
}

function mapCredentialRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.credential_public_key,
    counter: Number.isFinite(row.counter) ? Number(row.counter) : 0,
    deviceType: row.device_type || null,
    backedUp: row.backed_up ? row.backed_up !== 0 : false,
    transports: normalizeTransports(row.transports),
    friendlyName: row.friendly_name || null,
    createdAt: row.created_at || null,
    lastUsedAt: row.last_used_at || null,
  };
}

export async function listUserWebAuthnCredentials(userId) {
  if (!userId) {
    return [];
  }
  const rows = await all(
    `SELECT * FROM user_webauthn_credentials WHERE user_id=? ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return rows.map((row) => mapCredentialRow(row)).filter(Boolean);
}

export async function findWebAuthnCredential(credentialId) {
  if (!credentialId) return null;
  const row = await get(
    `SELECT * FROM user_webauthn_credentials WHERE credential_id=?`,
    [credentialId],
  );
  return mapCredentialRow(row);
}

export async function saveWebAuthnCredential({
  userId,
  credentialId,
  publicKey,
  counter = 0,
  deviceType = null,
  backedUp = false,
  transports = [],
  friendlyName = null,
}) {
  if (!userId || !credentialId || !publicKey) {
    throw new Error("Informations de credential incomplètes");
  }
  const normalizedPublicKey = Buffer.isBuffer(publicKey)
    ? publicKey
    : Buffer.from(publicKey);
  const serializedTransports = serializeTransports(transports);
  await run(
    `INSERT INTO user_webauthn_credentials(
      user_id,
      credential_id,
      credential_public_key,
      counter,
      device_type,
      backed_up,
      transports,
      friendly_name
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(credential_id) DO UPDATE SET
      user_id=excluded.user_id,
      credential_public_key=excluded.credential_public_key,
      counter=excluded.counter,
      device_type=excluded.device_type,
      backed_up=excluded.backed_up,
      transports=excluded.transports,
      friendly_name=COALESCE(excluded.friendly_name, user_webauthn_credentials.friendly_name)
    `,
    [
      userId,
      credentialId,
      normalizedPublicKey,
      counter,
      deviceType,
      backedUp ? 1 : 0,
      serializedTransports,
      friendlyName,
    ],
  );
}

export async function touchWebAuthnCredential(credentialId, {
  counter,
  deviceType = null,
  backedUp = false,
  transports = null,
} = {}) {
  if (!credentialId) return;
  const serializedTransports = transports ? serializeTransports(transports) : null;
  await run(
    `UPDATE user_webauthn_credentials
      SET counter=?,
          device_type=?,
          backed_up=?,
          transports=COALESCE(?, transports),
          last_used_at=CURRENT_TIMESTAMP
      WHERE credential_id=?`,
    [counter ?? 0, deviceType, backedUp ? 1 : 0, serializedTransports, credentialId],
  );
}

export async function deleteUserWebAuthnCredential(userId, credentialId) {
  if (!userId || !credentialId) {
    return 0;
  }
  const result = await run(
    `DELETE FROM user_webauthn_credentials WHERE user_id=? AND credential_id=?`,
    [userId, credentialId],
  );
  return result?.changes || 0;
}

export function setRegistrationChallenge(session, data) {
  if (!session) return;
  session[REGISTRATION_SESSION_KEY] = {
    ...data,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

export function getRegistrationChallenge(session) {
  if (!session) return null;
  const value = session[REGISTRATION_SESSION_KEY] || null;
  if (!value) return null;
  if (value.expiresAt && Date.now() > value.expiresAt) {
    delete session[REGISTRATION_SESSION_KEY];
    return null;
  }
  return value;
}

export function clearRegistrationChallenge(session) {
  if (!session) return;
  delete session[REGISTRATION_SESSION_KEY];
}

export function setAuthenticationChallenge(session, data) {
  if (!session) return;
  session[AUTHENTICATION_SESSION_KEY] = {
    ...data,
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

export function getAuthenticationChallenge(session) {
  if (!session) return null;
  const value = session[AUTHENTICATION_SESSION_KEY] || null;
  if (!value) return null;
  if (value.expiresAt && Date.now() > value.expiresAt) {
    delete session[AUTHENTICATION_SESSION_KEY];
    return null;
  }
  return value;
}

export function clearAuthenticationChallenge(session) {
  if (!session) return;
  delete session[AUTHENTICATION_SESSION_KEY];
}

export async function createRegistrationOptions({ req, user, existingCredentials = [], rpName }) {
  if (!user?.id) {
    throw new Error("Utilisateur requis pour générer une passkey");
  }
  const config = buildWebAuthnConfig(req, { rpName });
  const adapter = getAdapter();
  const userIDBytes = Buffer.from(String(user.id), "utf-8");
  const options = await adapter.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: userIDBytes,
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    attestationType: "none",
    timeout: 60000,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: existingCredentials.map((cred) => ({
      id: cred.credentialId,
      type: "public-key",
      transports: cred.transports && cred.transports.length ? cred.transports : undefined,
    })),
  });
  return { options, challenge: options.challenge, config };
}

export async function verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRPID }) {
  const adapter = getAdapter();
  return adapter.verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID,
    requireUserVerification: false,
  });
}

export async function createAuthenticationOptions({ req, allowCredentials = [], rpName }) {
  const config = buildWebAuthnConfig(req, { rpName });
  const adapter = getAdapter();
  const options = await adapter.generateAuthenticationOptions({
    rpID: config.rpID,
    timeout: 60000,
    userVerification: "preferred",
    allowCredentials: allowCredentials.map((cred) => ({
      id: cred.credentialId,
      type: "public-key",
      transports: cred.transports && cred.transports.length ? cred.transports : undefined,
    })),
  });
  return { options, challenge: options.challenge, config };
}

export async function verifyAuthentication({ response, authenticator, expectedChallenge, expectedOrigin, expectedRPID }) {
  const adapter = getAdapter();
  const credentialID = base64UrlToBuffer(authenticator.credentialId);
  const transports =
    authenticator.transports && authenticator.transports.length
      ? authenticator.transports
      : undefined;
  const counter = Number.isFinite(authenticator.counter) ? authenticator.counter : 0;

  return adapter.verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin,
    expectedRPID,
    requireUserVerification: false,
    credential: {
      id: credentialID,
      publicKey: authenticator.publicKey,
      counter,
      transports,
    },
    // Provide legacy authenticator payload for compatibility with older adapters
    authenticator: {
      credentialID,
      credentialPublicKey: authenticator.publicKey,
      counter,
      transports,
    },
  });
}

export function toBase64Url(buffer) {
  return bufferToBase64Url(buffer);
}

export function fromBase64Url(value) {
  return base64UrlToBuffer(value);
}
