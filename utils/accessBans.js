import { isIpBanned } from "./ipBans.js";
import { isUserActionBanned } from "./userActionBans.js";

export async function resolveAccessBan({
  ip = null,
  userId = null,
  action = null,
  tags = [],
} = {}) {
  if (userId) {
    const userBan = await isUserActionBanned(userId, { action, tags });
    if (userBan) {
      return { ...userBan, subject: "user" };
    }
  }
  if (ip) {
    const ipBan = await isIpBanned(ip, { action, tags });
    if (ipBan) {
      return { ...ipBan, subject: "ip" };
    }
  }
  return null;
}
