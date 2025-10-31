import path from "path";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { all, run } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const COMMENT_ATTACHMENT_UPLOAD_DIR = path.join(
  __dirname,
  "..",
  "public",
  "uploads",
  "comments",
);

export function ensureCommentAttachmentDir() {
  return fs.mkdir(COMMENT_ATTACHMENT_UPLOAD_DIR, { recursive: true });
}

export async function purgeCommentAttachments(commentSnowflakeId) {
  if (!commentSnowflakeId) {
    return;
  }

  const attachments = await all(
    `SELECT file_path FROM comment_attachments WHERE comment_snowflake_id=?`,
    [commentSnowflakeId],
  );

  if (Array.isArray(attachments) && attachments.length) {
    await Promise.all(
      attachments.map(async ({ file_path }) => {
        const storedName = path.basename(file_path || "");
        if (!storedName) {
          return;
        }
        const absolutePath = path.join(COMMENT_ATTACHMENT_UPLOAD_DIR, storedName);
        try {
          await fs.unlink(absolutePath);
        } catch (error) {
          if (error?.code !== "ENOENT") {
            console.warn("Impossible de supprimer une pièce jointe de commentaire", {
              absolutePath,
              error,
            });
          }
        }
      }),
    );
  }

  await run("DELETE FROM comment_attachments WHERE comment_snowflake_id=?", [
    commentSnowflakeId,
  ]);
}
