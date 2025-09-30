import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { answerQuestion } from "../utils/chatbot.js";

const r = Router();

r.get(
  "/chatbot",
  asyncHandler(async (req, res) => {
    const isAdmin = Boolean(req.session.user?.is_admin);
    res.render("chatbot", {
      title: "Assistant IA",
      chatbot: {
        isAdmin,
      },
    });
  }),
);

r.post(
  "/chatbot/query",
  asyncHandler(async (req, res) => {
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    const variant = req.body?.variant === "admin" ? "admin" : "public";

    if (!message.trim()) {
      return res.status(400).json({
        error: "Veuillez poser une question avant d'interroger l'assistant.",
      });
    }

    if (variant === "admin" && !req.session.user?.is_admin) {
      return res.status(403).json({
        error: "Seul un administrateur peut accéder à cette vue de l'assistant.",
      });
    }

    const result = await answerQuestion(message, variant);
    res.json(result);
  }),
);

export default r;
