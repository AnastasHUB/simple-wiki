import { get } from "../db.js";
import { countPageSubmissions } from "./pageSubmissionService.js";
import { countSuspiciousIpProfiles } from "./ipProfiles.js";

export async function getAdminActionCounts() {
  const [pendingCommentsRow, pendingSubmissions, suspiciousIps] =
    await Promise.all([
      get("SELECT COUNT(*) AS total FROM comments WHERE status='pending'"),
      countPageSubmissions({ status: "pending" }),
      countSuspiciousIpProfiles(),
    ]);

  return {
    pendingComments: Number(pendingCommentsRow?.total ?? 0),
    pendingSubmissions: Number(pendingSubmissions ?? 0),
    suspiciousIps: Number(suspiciousIps ?? 0),
  };
}
