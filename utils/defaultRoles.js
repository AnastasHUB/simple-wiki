export const DEFAULT_ROLE_KEYS = Object.freeze({
  EVERYONE: "everyone",
  USER: "user",
  PREMIUM: "premium",
  ADMINISTRATOR: "administrator",
});

const baseDefinitions = [
  {
    key: DEFAULT_ROLE_KEYS.ADMINISTRATOR,
    snowflake: "231903829383921664",
    name: "Administrateur",
    description: "Accès complet à toutes les fonctionnalités.",
    color: "#DC2626",
    isSystem: true,
    grantAllPermissions: true,
    permissionOverrides: {},
  },
  {
    key: DEFAULT_ROLE_KEYS.PREMIUM,
    snowflake: "231903782071590914",
    name: "Premium",
    description: "Accès aux avantages réservés aux abonnés premium.",
    color: "#F59E0B",
    isSystem: true,
    grantAllPermissions: false,
    permissionOverrides: {
      can_comment: true,
      can_submit_pages: true,
      can_view_stats_basic: true,
    },
  },
  {
    key: DEFAULT_ROLE_KEYS.USER,
    snowflake: "231903782071590913",
    name: "Utilisateurs",
    description:
      "Rôle par défaut attribué aux visiteurs qui convertissent leur profil IP en compte.",
    color: null,
    isSystem: true,
    grantAllPermissions: false,
    permissionOverrides: {
      can_comment: true,
      can_submit_pages: true,
    },
  },
  {
    key: DEFAULT_ROLE_KEYS.EVERYONE,
    snowflake: "231903782071590912",
    name: "Everyone",
    description: "Permissions de base accordées à tous les visiteurs.",
    color: null,
    isSystem: true,
    grantAllPermissions: false,
    permissionOverrides: {
      can_comment: true,
      can_submit_pages: true,
    },
  },
];

export const DEFAULT_ROLE_DEFINITIONS = Object.freeze(
  baseDefinitions.map((role) =>
    Object.freeze({
      ...role,
      permissionOverrides: Object.freeze({ ...role.permissionOverrides }),
    }),
  ),
);

export const DEFAULT_ROLE_SNOWFLAKES = Object.freeze(
  DEFAULT_ROLE_DEFINITIONS.reduce((acc, role) => {
    acc[role.key] = role.snowflake;
    return acc;
  }, {}),
);

export const EVERYONE_ROLE_SNOWFLAKE =
  DEFAULT_ROLE_SNOWFLAKES[DEFAULT_ROLE_KEYS.EVERYONE];
export const USER_ROLE_SNOWFLAKE = DEFAULT_ROLE_SNOWFLAKES[DEFAULT_ROLE_KEYS.USER];
export const PREMIUM_ROLE_SNOWFLAKE =
  DEFAULT_ROLE_SNOWFLAKES[DEFAULT_ROLE_KEYS.PREMIUM];
export const ADMINISTRATOR_ROLE_SNOWFLAKE =
  DEFAULT_ROLE_SNOWFLAKES[DEFAULT_ROLE_KEYS.ADMINISTRATOR];

export function getDefaultRoleDefinition(key) {
  return (
    DEFAULT_ROLE_DEFINITIONS.find((definition) => definition.key === key) || null
  );
}

export function normalizeRoleIdentifier(role) {
  if (role == null) {
    return null;
  }
  if (typeof role === "string" || typeof role === "number" || typeof role === "bigint") {
    const value = String(role).trim();
    return value || null;
  }
  if (typeof role === "object") {
    const candidate =
      role.snowflake_id ?? role.snowflakeId ?? role.id ?? role.role_id ?? null;
    if (candidate == null) {
      return null;
    }
    const value = String(candidate).trim();
    return value || null;
  }
  return null;
}

export function isDefaultRole(role, key) {
  const expected = DEFAULT_ROLE_SNOWFLAKES[key];
  if (!expected) {
    return false;
  }
  const identifier = normalizeRoleIdentifier(role);
  if (!identifier) {
    return false;
  }
  return identifier === expected;
}

export function applyDefaultRoleMetadata(role) {
  if (!role || typeof role !== "object") {
    return role;
  }
  const identifier = normalizeRoleIdentifier(role);
  const metadata = {
    isEveryone: identifier === EVERYONE_ROLE_SNOWFLAKE,
    isUser: identifier === USER_ROLE_SNOWFLAKE,
    isPremium: identifier === PREMIUM_ROLE_SNOWFLAKE,
    isAdministrator: identifier === ADMINISTRATOR_ROLE_SNOWFLAKE,
  };
  if (
    role.isEveryone === metadata.isEveryone &&
    role.isUser === metadata.isUser &&
    role.isPremium === metadata.isPremium &&
    role.isAdministrator === metadata.isAdministrator
  ) {
    return role;
  }
  return { ...role, ...metadata };
}

export function annotateDefaultRoles(roles = []) {
  if (!Array.isArray(roles)) {
    return [];
  }
  return roles.map((role) => applyDefaultRoleMetadata(role));
}
