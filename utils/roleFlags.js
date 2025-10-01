export const ROLE_FLAG_FIELDS = [
  "is_admin",
  "is_moderator",
  "is_helper",
  "is_contributor",
  "can_comment",
  "can_submit_pages",
  "can_moderate_comments",
  "can_review_ban_appeals",
  "can_manage_ip_bans",
  "can_manage_ip_reputation",
  "can_manage_ip_profiles",
  "can_review_submissions",
  "can_manage_pages",
  "can_view_stats",
  "can_manage_uploads",
  "can_manage_settings",
  "can_manage_roles",
  "can_manage_users",
  "can_manage_likes",
  "can_manage_trash",
  "can_view_events",
  "can_view_snowflakes",
];

export const ADMIN_ACTION_FLAGS = ROLE_FLAG_FIELDS.filter(
  (field) =>
    ![
      "is_admin",
      "is_moderator",
      "is_helper",
      "is_contributor",
      "can_comment",
      "can_submit_pages",
    ].includes(field),
);

export const DEFAULT_ROLE_FLAGS = ROLE_FLAG_FIELDS.reduce((acc, field) => {
  acc[field] = false;
  return acc;
}, {});

function normalizeFlagSet(raw = {}) {
  const normalized = { ...DEFAULT_ROLE_FLAGS };
  for (const field of ROLE_FLAG_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) {
      normalized[field] = Boolean(raw[field]);
    }
  }
  return normalized;
}

function applyRoleDerivations(flags) {
  const derived = { ...flags };

  if (derived.is_admin) {
    for (const field of ROLE_FLAG_FIELDS) {
      derived[field] = true;
    }
    return derived;
  }

  if (derived.is_moderator) {
    derived.is_helper = true;
    derived.is_contributor = true;
    derived.can_comment = true;
    derived.can_submit_pages = true;
    derived.can_moderate_comments = true;
    derived.can_review_submissions = true;
    derived.can_review_ban_appeals = true;
    derived.can_manage_likes = true;
    derived.can_manage_trash = true;
    derived.can_view_stats = true;
  }

  if (derived.is_contributor) {
    derived.can_comment = true;
    derived.can_submit_pages = true;
  }

  if (derived.is_helper) {
    derived.can_comment = true;
  }

  return derived;
}

export function mergeRoleFlags(base = DEFAULT_ROLE_FLAGS, overrides = {}) {
  const normalizedBase = normalizeFlagSet(base);
  const normalizedOverrides = normalizeFlagSet(overrides);
  const merged = { ...normalizedBase };
  for (const field of ROLE_FLAG_FIELDS) {
    if (normalizedOverrides[field]) {
      merged[field] = true;
    }
  }
  return applyRoleDerivations(merged);
}

export function deriveRoleFlags(rawUser = {}) {
  const baseFlags = normalizeFlagSet(rawUser);
  const roleOverrides = ROLE_FLAG_FIELDS.reduce((acc, key) => {
    const roleKey = `role_${key}`;
    if (rawUser[roleKey] !== undefined && rawUser[roleKey] !== null) {
      acc[key] = Boolean(rawUser[roleKey]);
    }
    return acc;
  }, {});
  return applyRoleDerivations(mergeRoleFlags(baseFlags, roleOverrides));
}

export function buildSessionUser(rawUser, overrides = null) {
  const baseFlags = deriveRoleFlags(rawUser);
  const mergedFlags = overrides
    ? mergeRoleFlags(baseFlags, overrides)
    : baseFlags;
  return {
    id: rawUser.id,
    username: rawUser.username,
    display_name: rawUser.display_name || null,
    role_id: rawUser.role_id || null,
    role_name: rawUser.role_name || null,
    ...mergedFlags,
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

export function getRoleFlagValues(flags = DEFAULT_ROLE_FLAGS) {
  const normalized = normalizeFlagSet(flags);
  return ROLE_FLAG_FIELDS.map((field) => (normalized[field] ? 1 : 0));
}

export function getRoleFlagPairs(flags = DEFAULT_ROLE_FLAGS) {
  const normalized = normalizeFlagSet(flags);
  return ROLE_FLAG_FIELDS.map((field) => [field, normalized[field] ? 1 : 0]);
}
