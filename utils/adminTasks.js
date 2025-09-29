import { get } from "../db.js";
import { countPageSubmissions } from "./pageSubmissionService.js";
import { countFlaggedIpProfiles } from "./ipProfiles.js";

export async function getAdminActionCounts() {
  const [pendingCommentsRow, pendingSubmissions, flaggedIps] = await Promise.all([
    get("SELECT COUNT(*) AS total FROM comments WHERE status='pending'"),
    countPageSubmissions({ status: "pending" }),
    countFlaggedIpProfiles(),
  ]);

  return {
    pendingComments: Number(pendingCommentsRow?.total ?? 0),
    pendingSubmissions: Number(pendingSubmissions ?? 0),
    flaggedIps: Number(flaggedIps ?? 0),
  };
}
