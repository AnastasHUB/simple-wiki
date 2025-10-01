export const ROLE_FLAG_FIELDS = [
  "is_admin",
  "is_moderator",
  "is_helper",
  "is_contributor",
];

export function deriveRoleFlags(rawUser = {}) {
  const flags = {
    is_admin: Boolean(rawUser.is_admin),
    is_moderator: Boolean(rawUser.is_moderator),
    is_helper: Boolean(rawUser.is_helper),
    is_contributor: Boolean(rawUser.is_contributor),
  };

  const roleOverrides = ROLE_FLAG_FIELDS.reduce((acc, key) => {
    const roleKey = `role_${key}`;
    if (rawUser[roleKey] !== undefined && rawUser[roleKey] !== null) {
      acc[key] = Boolean(rawUser[roleKey]);
    }
    return acc;
  }, {});

  const merged = { ...flags, ...roleOverrides };
  if (merged.is_admin) {
    return {
      is_admin: true,
      is_moderator: true,
      is_helper: true,
      is_contributor: true,
    };
  }
  if (merged.is_moderator) {
    return {
      is_admin: false,
      is_moderator: true,
      is_helper: true,
      is_contributor: true,
    };
  }
  if (merged.is_contributor) {
    return {
      is_admin: false,
      is_moderator: false,
      is_helper: true,
      is_contributor: true,
    };
  }
  if (merged.is_helper) {
    return {
      is_admin: false,
      is_moderator: false,
      is_helper: true,
      is_contributor: false,
    };
  }
  return {
    is_admin: false,
    is_moderator: false,
    is_helper: false,
    is_contributor: false,
  };
}

export function buildSessionUser(rawUser, overrides = null) {
  const flags = deriveRoleFlags(rawUser);
  if (overrides) {
    for (const field of ROLE_FLAG_FIELDS) {
      if (overrides[field] !== undefined) {
        flags[field] = Boolean(overrides[field]);
      }
    }
  }
  return {
    id: rawUser.id,
    username: rawUser.username,
    display_name: rawUser.display_name || null,
    role_id: rawUser.role_id || null,
    role_name: rawUser.role_name || null,
    ...flags,
  };
}

export function needsRoleFlagSync(rawUser) {
  if (!rawUser) return false;
  const flags = deriveRoleFlags(rawUser);
  return ROLE_FLAG_FIELDS.some((field) => {
    const currentValue = Boolean(rawUser[field]);
    return currentValue !== flags[field];
  });
}

export function getRoleFlagValues(flags) {
  return ROLE_FLAG_FIELDS.map((field) => (flags[field] ? 1 : 0));
}

export function getRoleFlagPairs(flags) {
  return ROLE_FLAG_FIELDS.map((field) => [field, flags[field] ? 1 : 0]);
}
