import MarkdownIt from "markdown-it";
import { full as markdownItEmoji } from "markdown-it-emoji";
import markdownItContainer from "markdown-it-container";
import markdownItKatex from "markdown-it-katex";
import markdownItTaskLists from "markdown-it-task-lists";
import sanitizeHtml from "sanitize-html";

import { slugify } from "./linkify.js";
import { CONTENT_SANITIZE_OPTIONS } from "./articleFormatter.js";

function escapeHtml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: true,
    highlight: (code) => escapeHtml(code),
  });

  md.use(markdownItEmoji);

  md.use(markdownItContainer, "spoiler", {
    validate: (params) => /^spoiler(\s+.*)?$/i.test(params.trim()),
    render: (tokens, idx) => {
      const match = tokens[idx].info.trim().match(/^spoiler\s*(.*)$/i);
      if (tokens[idx].nesting === 1) {
        const title = match && match[1] ? match[1].trim() : "Spoiler";
        return `<details class="md-spoiler"><summary>${escapeHtml(
          title || "Spoiler",
        )}</summary>\n<div class="md-spoiler-body">\n`;
      }
      return "</div></details>\n";
    },
  });

  md.use(markdownItContainer, "details", {
    validate: (params) => /^details(\s+.*)?$/i.test(params.trim()),
    render: (tokens, idx) => {
      const match = tokens[idx].info.trim().match(/^details\s*(.*)$/i);
      if (tokens[idx].nesting === 1) {
        const title = match && match[1] ? match[1].trim() : "Détails";
        return `<details class="md-details"><summary>${escapeHtml(
          title || "Détails",
        )}</summary>\n<div class="md-details-body">\n`;
      }
      return "</div></details>\n";
    },
  });

  const calloutConfigs = [
    { name: "info", defaultTitle: "Information" },
    { name: "warning", defaultTitle: "Avertissement" },
    { name: "success", defaultTitle: "Succès" },
  ];

  calloutConfigs.forEach(({ name, defaultTitle }) => {
    const pattern = new RegExp(`^${name}\\s*(.*)$`, "i");
    md.use(markdownItContainer, name, {
      validate: (params) => pattern.test(params.trim()),
      render: (tokens, idx) => {
        const info = tokens[idx].info.trim();
        const match = info.match(pattern);
        if (tokens[idx].nesting === 1) {
          const title = match && match[1] ? match[1].trim() : defaultTitle;
          return `<div class="md-callout md-callout-${name}"><div class="md-callout-title">${escapeHtml(
            title || defaultTitle,
          )}</div>\n<div class="md-callout-body">\n`;
        }
        return "</div></div>\n";
      },
    });
  });

  md.use(markdownItKatex);

  md.use(markdownItTaskLists, {
    enabled: true,
  });

  md.core.ruler.after("inline", "wiki-links", (state) => {
    const Token = state.Token;
    state.tokens.forEach((blockToken) => {
      if (blockToken.type !== "inline" || !blockToken.children) {
        return;
      }
      const children = [];
      blockToken.children.forEach((child) => {
        if (child.type !== "text" || !child.content.includes("[[")) {
          children.push(child);
          return;
        }
        const text = child.content;
        const regex = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
        let lastIndex = 0;
        let match;
        let matched = false;
        while ((match = regex.exec(text))) {
          matched = true;
          if (match.index > lastIndex) {
            const textToken = new Token("text", "", 0);
            textToken.content = text.slice(lastIndex, match.index);
            children.push(textToken);
          }
          const target = match[1] ? match[1].trim() : "";
          if (!target) {
            const textToken = new Token("text", "", 0);
            textToken.content = match[0];
            children.push(textToken);
            lastIndex = regex.lastIndex;
            continue;
          }
          const label = match[2] ? match[2].trim() : target;
          const open = new Token("link_open", "a", 1);
          open.attrs = [
            ["href", `/lookup/${slugify(target)}`],
            ["class", "wiki-link"],
            ["target", "_blank"],
            ["rel", "noopener"],
          ];
          const textToken = new Token("text", "", 0);
          textToken.content = label;
          const close = new Token("link_close", "a", -1);
          children.push(open, textToken, close);
          lastIndex = regex.lastIndex;
        }
        if (!matched) {
          children.push(child);
        } else if (lastIndex < text.length) {
          const textToken = new Token("text", "", 0);
          textToken.content = text.slice(lastIndex);
          children.push(textToken);
        }
      });
      blockToken.children = children;
    });
  });

  return md;
}

const renderer = createMarkdownRenderer();

export function renderMarkdown(content) {
  if (!content) return "";
  const rendered = renderer.render(String(content));
  const sanitized = sanitizeHtml(rendered, CONTENT_SANITIZE_OPTIONS);
  return sanitized.trim();
}

export function renderInlineMarkdown(content) {
  if (!content) return "";
  const rendered = renderer.renderInline(String(content));
  const sanitized = sanitizeHtml(rendered, CONTENT_SANITIZE_OPTIONS);
  return sanitized.trim();
}
