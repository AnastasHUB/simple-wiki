import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROP_VERIFICATION_DIR = path.join(__dirname, "..", "propeller-verification");
const PROP_VERIFICATION_FILENAME_PATTERN = /^propellerads-[a-z0-9-]+(?:\.(?:txt|html))$/i;

export function getPropellerVerificationDir() {
  return PROP_VERIFICATION_DIR;
}

export async function ensurePropellerVerificationDir() {
  await fs.mkdir(PROP_VERIFICATION_DIR, { recursive: true });
  return PROP_VERIFICATION_DIR;
}

export function isValidPropellerVerificationFilename(filename = "") {
  if (typeof filename !== "string") {
    return false;
  }
  const normalized = filename.trim();
  if (!normalized) {
    return false;
  }
  return PROP_VERIFICATION_FILENAME_PATTERN.test(normalized);
}

export async function savePropellerVerificationFile(filename, buffer) {
  if (!isValidPropellerVerificationFilename(filename)) {
    throw new Error("Nom de fichier de vérification PropellerAds invalide.");
  }
  if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) {
    throw new Error("Le fichier de vérification PropellerAds est vide.");
  }
  const dir = await ensurePropellerVerificationDir();
  const targetPath = path.join(dir, filename);
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

export async function removePropellerVerificationFile(filename) {
  if (!isValidPropellerVerificationFilename(filename)) {
    return false;
  }
  const targetPath = path.join(PROP_VERIFICATION_DIR, filename);
  try {
    await fs.unlink(targetPath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
