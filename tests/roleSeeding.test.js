import test from "node:test";
import assert from "node:assert/strict";

import {
  initDb,
  run,
  all,
  reseedDefaultRoles,
} from "../db.js";
import {
  DEFAULT_ROLE_DEFINITIONS,
  PREMIUM_ROLE_SNOWFLAKE,
} from "../utils/defaultRoles.js";
import {
  ROLE_FLAG_FIELDS,
  DEFAULT_ROLE_FLAGS,
  getRoleFlagValues,
} from "../utils/roleFlags.js";

const ROLE_FLAG_PLACEHOLDERS = ROLE_FLAG_FIELDS.map(() => "?").join(", ");
const ROLE_FLAG_COLUMN_LIST = ROLE_FLAG_FIELDS.join(", ");

function buildInsertRoleQuery() {
  return `INSERT INTO roles(snowflake_id, name, description, color, is_system, position, ${ROLE_FLAG_COLUMN_LIST})
          VALUES(?,?,?,?,?,?,${ROLE_FLAG_PLACEHOLDERS})`;
}

test("le rôle Premium est semé et positionné avant les rôles personnalisés", { concurrency: false }, async () => {
  await initDb();
  await run("BEGIN IMMEDIATE");
  try {
    const customSnowflake = `test-role-${Date.now()}`;
    await run(buildInsertRoleQuery(), [
      customSnowflake,
      "Rôle personnalisé temporaire",
      "Rôle inséré pour vérifier l'ordre de tri",
      null,
      0,
      3,
      ...getRoleFlagValues(DEFAULT_ROLE_FLAGS),
    ]);

    await run("DELETE FROM roles WHERE snowflake_id=?", [PREMIUM_ROLE_SNOWFLAKE]);

    await reseedDefaultRoles();

    const roles = await all(
      "SELECT name, position, snowflake_id, is_system FROM roles ORDER BY position ASC, name COLLATE NOCASE",
    );

    const everyone = roles.find((role) => role.name === "Everyone");
    const users = roles.find((role) => role.name === "Utilisateurs");
    const premium = roles.find((role) => role.name === "Premium");
    const admin = roles.find((role) => role.name === "Administrateur");
    assert.ok(everyone, "Le rôle Everyone doit être présent");
    assert.ok(users, "Le rôle Utilisateurs doit être présent");
    assert.ok(premium, "Le rôle Premium doit être présent après réensemencement");
    assert.ok(admin, "Le rôle Administrateur doit être présent");

    assert.equal(admin.position, 1);
    assert.equal(premium.position, 2);
    assert.equal(users.position, 3);
    assert.equal(everyone.position, 4);

    const defaultCount = DEFAULT_ROLE_DEFINITIONS.length;
    for (const role of roles) {
      if (role.is_system) {
        continue;
      }
      assert.ok(
        role.position >= defaultCount + 1,
        `Le rôle ${role.name} devrait apparaître après les rôles par défaut`,
      );
    }

    const insertedCustom = roles.find((role) => role.snowflake_id === customSnowflake);
    assert.ok(insertedCustom, "Le rôle personnalisé inséré doit être retrouvé");
    assert.equal(
      insertedCustom.position,
      defaultCount + 1,
      "Le nouveau rôle personnalisé doit être positionné juste après les rôles par défaut",
    );
  } finally {
    await run("ROLLBACK");
  }
});
