import { get } from "../db.js";
import { countPageSubmissions } from "./pageSubmissionService.js";

export async function getAdminActionCounts() {
  const [pendingCommentsRow, pendingSubmissions] = await Promise.all([
    get("SELECT COUNT(*) AS total FROM comments WHERE status='pending'"),
    countPageSubmissions({ status: "pending" }),
  ]);

  return {
    pendingComments: Number(pendingCommentsRow?.total ?? 0),
    pendingSubmissions: Number(pendingSubmissions ?? 0),
  };
}
