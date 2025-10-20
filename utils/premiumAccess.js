export function canViewPremiumContent(req) {
  if (!req) {
    return false;
  }
  const permissions = req.permissionFlags || {};
  if (permissions.is_admin || permissions.is_moderator || permissions.is_helper) {
    return true;
  }
  const sessionUser = req.session?.user;
  return Boolean(sessionUser?.premium_is_active);
}

export function normalizePremiumFlagInput(input) {
  if (typeof input === "string") {
    const normalized = input.trim().toLowerCase();
    return ["1", "true", "on", "yes"].includes(normalized);
  }
  if (typeof input === "number") {
    return input === 1;
  }
  return Boolean(input);
}
