import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  countPageSubmissions,
  fetchPageSubmissions,
  mapSubmissionTags,
} from "../utils/pageSubmissionService.js";
import { buildPaginationView } from "../utils/pagination.js";
import { getClientIp } from "../utils/ip.js";

const r = Router();

r.use((req, res, next) => {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
});

function resolveIdentity(req) {
  return {
    submittedBy: req.session.user?.username || null,
    ip: getClientIp(req) || null,
  };
}

async function buildSection(req, identity, { status, pageParam, perPageParam, orderBy, direction }) {
  const total = await countPageSubmissions({
    status,
    submittedBy: identity.submittedBy,
    ip: identity.ip,
  });
  const pagination = buildPaginationView(req, total, { pageParam, perPageParam });
  let rows = [];
  if (total > 0) {
    const offset = (pagination.page - 1) * pagination.perPage;
    const fetched = await fetchPageSubmissions({
      status,
      limit: pagination.perPage,
      offset,
      orderBy,
      direction,
      submittedBy: identity.submittedBy,
      ip: identity.ip,
    });
    rows = fetched.map((item) => ({
      ...item,
      tag_list: mapSubmissionTags(item),
    }));
  }
  return { rows, pagination };
}

r.get(
  "/submissions",
  asyncHandler(async (req, res) => {
    const identity = resolveIdentity(req);
    const [pending, approved, rejected] = await Promise.all([
      buildSection(req, identity, {
        status: "pending",
        pageParam: "pendingPage",
        perPageParam: "pendingPerPage",
        orderBy: "created_at",
        direction: "DESC",
      }),
      buildSection(req, identity, {
        status: "approved",
        pageParam: "approvedPage",
        perPageParam: "approvedPerPage",
        orderBy: "reviewed_at",
        direction: "DESC",
      }),
      buildSection(req, identity, {
        status: "rejected",
        pageParam: "rejectedPage",
        perPageParam: "rejectedPerPage",
        orderBy: "reviewed_at",
        direction: "DESC",
      }),
    ]);

    res.render("account/submissions", {
      pending: pending.rows,
      approved: approved.rows,
      rejected: rejected.rows,
      pendingPagination: pending.pagination,
      approvedPagination: approved.pagination,
      rejectedPagination: rejected.pagination,
    });
  }),
);

export default r;
