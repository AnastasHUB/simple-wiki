import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;
const BCRYPT_PREFIX = /^\$2[aby]\$/;

export function isBcryptHash(value) {
  return BCRYPT_PREFIX.test(value || "");
}

export function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Mot de passe invalide");
  }
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password, hash) {
  if (!hash) {
    return false;
  }
  if (!isBcryptHash(hash)) {
    return password === hash;
  }
  return bcrypt.compare(password || "", hash);
}
