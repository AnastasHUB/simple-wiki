import test from "node:test";
import assert from "node:assert/strict";

import { initDb, get } from "../db.js";
import { touchIpProfile, refreshIpReputation } from "../utils/ipProfiles.js";

const TEST_IP = "198.51.100.10";

test("refreshIpReputation gère les indisponibilités réseau", { concurrency: false }, async () => {
  await initDb();
  await touchIpProfile(TEST_IP, { skipRefresh: true });

  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    const error = new Error("connect ENETUNREACH");
    error.code = "ENETUNREACH";
    throw error;
  };

  try {
    const result = await refreshIpReputation(TEST_IP, { force: true });
    assert.ok(result, "La rafraîchissement devrait renvoyer un résultat");
    assert.equal(result.autoStatus, "unknown", "Le statut auto devrait être inconnu");
    assert.equal(result.status, "unknown", "Le statut final devrait rester inconnu");
    assert.match(
      result.summary,
      /Échec de la récupération des données de réputation/,
      "Le résumé devrait indiquer l'échec de récupération",
    );
    assert.ok(callCount >= 3, "Toutes les sources devraient avoir été interrogées");

    const row = await get(
      "SELECT reputation_summary, reputation_status, reputation_auto_status FROM ip_profiles WHERE ip=?",
      [TEST_IP],
    );
    assert.ok(row, "Le profil IP devrait exister");
    assert.equal(
      row.reputation_auto_status,
      "unknown",
      "Le statut auto en base devrait être mis à jour",
    );
    assert.equal(
      row.reputation_status,
      "unknown",
      "Le statut final en base devrait être mis à jour",
    );
    assert.match(
      row.reputation_summary,
      /Échec de la récupération des données de réputation/,
      "Le résumé en base devrait mentionner l'échec",
    );
  } finally {
    global.fetch = originalFetch;
  }
});
