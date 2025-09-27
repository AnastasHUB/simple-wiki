export function getClientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() || req.ip || null
  );
}
