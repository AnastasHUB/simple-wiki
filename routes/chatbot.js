import { Router } from "express";
import { generateChatbotReply, countChatbotDocuments } from "../utils/chatbotService.js";

const r = Router();
const MAX_HISTORY = 12;

function wantsJson(req) {
  const accepted = req.accepts(["json", "html"]);
  if (!accepted) {
    return false;
  }
  return accepted === "json";
}

function getHistory(req) {
  if (Array.isArray(req.session?.chatbotHistory)) {
    return req.session.chatbotHistory.map(normalizeEntry).filter(Boolean);
  }
  return [];
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const role = entry.role === "assistant" ? "assistant" : "user";
  const content = typeof entry.content === "string" ? entry.content.trim() : "";
  const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString();
  if (!content) {
    return null;
  }
  return { role, content, createdAt };
}

function storeHistory(req, history) {
  req.session.chatbotHistory = history.slice(-MAX_HISTORY);
}

r.get("/chatbot", async (req, res, next) => {
  try {
    const history = getHistory(req);
    const documentsCount = await countChatbotDocuments();
    res.render("chatbot", {
      history,
      hasTrainingData: documentsCount > 0,
    });
  } catch (err) {
    next(err);
  }
});

r.post("/chatbot/message", async (req, res, next) => {
  const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    if (wantsJson(req)) {
      return res.status(400).json({ error: "Message vide." });
    }
    return res.redirect("/chatbot");
  }

  try {
    const history = getHistory(req);
    const userEntry = {
      role: "user",
      content: message,
      createdAt: new Date().toISOString(),
    };
    history.push(userEntry);

    const reply = await generateChatbotReply(message, history);
    history.push({
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    });
    storeHistory(req, history);

    if (wantsJson(req)) {
      return res.json({ history: getHistory(req) });
    }
    return res.redirect("/chatbot");
  } catch (err) {
    return next(err);
  }
});

r.post("/chatbot/reset", (req, res) => {
  req.session.chatbotHistory = [];
  if (wantsJson(req)) {
    return res.json({ history: [] });
  }
  return res.redirect("/chatbot");
});

export default r;
