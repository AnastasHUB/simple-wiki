import { get } from "../db.js";
import { countPageSubmissions } from "./pageSubmissionService.js";
import { countSuspiciousIpProfiles } from "./ipProfiles.js";
import { countBanAppeals } from "./banAppeals.js";

export async function getAdminActionCounts() {
  const [pendingCommentsRow, pendingSubmissions, suspiciousIps, pendingAppeals] =
    await Promise.all([
      get("SELECT COUNT(*) AS total FROM comments WHERE status='pending'"),
      countPageSubmissions({ status: "pending" }),
      countSuspiciousIpProfiles(),
      countBanAppeals({ status: "pending" }),
    ]);

  return {
    pendingComments: Number(pendingCommentsRow?.total ?? 0),
    pendingSubmissions: Number(pendingSubmissions ?? 0),
    suspiciousIps: Number(suspiciousIps ?? 0),
    pendingBanAppeals: Number(pendingAppeals ?? 0),
  };
}
