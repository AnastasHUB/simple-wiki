# SimpleWiki

SimpleWiki is a self-hosted wiki and knowledge base built with Node.js, Express, and SQLite. It provides a moderation-friendly editorial workflow, rich text tooling, and real-time operational insights suitable for small teams that want a lightweight alternative to larger wiki engines.

## Features

- **Editorial workflow** – Create, edit, and publish pages with support for drafts, scheduled publications, revision history, and diff rendering to highlight changes before publishing. Administrator tooling ensures the default `admin` account is created with full permissions on first run. 【F:app.js†L92-L154】【F:db.js†L714-L741】
- **Taggable content library** – Organize pages with tags, full-text search (FTS5) indexing, and RSS feeds for the latest publications. Scheduled jobs aggregate historical page views into daily summaries for analytics. 【F:db.js†L764-L814】【F:scripts/aggregateViews.js†L1-L66】
- **Community features** – Nested comment threads with preview and validation, reactions, and rate limiting. A captcha mathématique dynamique protège les formulaires de commentaire et d'inscription. 【F:routes/pages.js†L1-L120】【F:routes/pages.js†L136-L204】
- **Account & role management** – Session-backed authentication, configurable role flags, IP profile claims, and granular admin permissions configurable through default roles. Session secrets can be sourced from environment variables or a watched file. 【F:utils/config.js†L1-L45】【F:utils/sessionSecrets.js†L1-L83】【F:routes/pages.js†L17-L68】
- **Operational visibility** – Live visitor tracking with WebSocket updates, bot detection hooks, cookie consent middleware, and integration points for Discord/webhook notifications. 【F:utils/liveStats.js†L1-L83】【F:utils/liveStatsWebsocket.js†L1-L119】【F:app.js†L38-L88】

## Tech Stack

- **Runtime:** Node.js (ES modules)
- **Web framework:** Express with EJS templates and `express-ejs-layouts`
- **Database:** SQLite (via `sqlite` and `sqlite3` packages) with optional FTS5 full-text search
- **Authentication & security:** `express-session`, CSRF protection middleware, bcrypt password hashing, captcha mathématique intégré
- **Realtime:** `ws` WebSocket server for admin live statistics

## Getting Started

### Prerequisites

- Node.js 20+
- npm 9+
- SQLite3 runtime with FTS5 enabled (for search)

### Installation

```bash
npm install
```

### Initialize the database

The first run creates the SQLite database (`data.sqlite`) in the project root. To ensure the default administrator account exists, execute:

```bash
npm run db:init
```

This seeds an `admin` user with the password `admin` (stored hashed). Be sure to log in and change this password immediately. 【F:scripts/db-init.js†L1-L7】【F:db.js†L714-L741】

### Development server

```bash
npm run dev
```

The app listens on `http://localhost:3000` by default. Use `PORT` to override the port and `URLENCODED_BODY_LIMIT` to tune the maximum size of HTML form submissions. Static assets are served from `/public` and EJS views reside in `/views`. 【F:app.js†L38-L87】【F:app.js†L232-L238】

### Production

```bash
npm start
```

For production deployments:

1. Provide a persistent `SESSION_SECRET` (or configure `SESSION_SECRET_FILE`).
2. Run `npm run views:aggregate` on a schedule (e.g., cron) to roll up old `page_views` rows into the `page_view_daily` table.
3. Configure HTTPS termination and reverse proxies to forward WebSocket upgrades at `/admin/stats/live` for the live visitor dashboard.

## Configuration

Environment variables customize behavior. Only `SESSION_SECRET` is strongly recommended for production; the rest are optional.

| Variable | Description |
| --- | --- |
| `PORT` | HTTP port (defaults to `3000`). |
| `URLENCODED_BODY_LIMIT` | Maximum size of URL-encoded payloads for page editing forms (default `10mb`). |
| `SESSION_SECRET`, `SESSION_SECRETS` | One or more secrets for signing sessions. Multiple values can be comma-separated. |
| `SESSION_SECRET_FILE` | File path containing newline-delimited session secrets; watched for hot reloads. |
| `SESSION_COOKIE_*` | Fine-grained cookie flags (`SECURE`, `HTTP_ONLY`, `SAMESITE`, `MAX_AGE`, `NAME`, `ROLLING`). |
| `BOT_DETECTION_ENDPOINT`, `BOT_DETECTION_TIMEOUT_MS` | External bot detection service and timeout used when tracking visitors. |
| `IP_REPUTATION_*` | Configure IP reputation API endpoints and timeouts for ban and profile workflows. |
| `IP_PROFILE_SALT` | Secret salt for hashing IP profile identifiers. |

Refer to [`utils/config.js`](./utils/config.js), [`utils/sessionSecrets.js`](./utils/sessionSecrets.js), and [`utils/ipProfiles.js`](./utils/ipProfiles.js) for full details. 【F:utils/config.js†L1-L45】【F:utils/sessionSecrets.js†L1-L120】【F:utils/ipProfiles.js†L1-L37】

### Custom reactions

Administrators can manage the reaction palette for articles and comments from the **Réactions** tab of the admin panel (`/admin/reactions`). Each reaction must have a unique identifier plus either an emoji or a custom image URL, and the list can be reordered, edited, or trimmed in real time. 【F:views/admin/reactions.ejs†L1-L164】【F:routes/admin.js†L2583-L2754】

When no custom options exist the application exposes a built-in fallback set (👍, ❤️, etc.). As soon as at least one entry is defined in the `reaction_options` table, only those records are accepted; submitting a reaction whose key has been removed now returns a `400 Réaction introuvable.` response instead of silently reviving the default palette. 【F:utils/reactionService.js†L33-L75】【F:tests/likeAndReactionRoutes.test.js†L401-L461】

## NPM Scripts

| Command | Description |
| --- | --- |
| `npm start` | Launches the production server. |
| `npm run dev` | Runs the server in watch mode for development. |
| `npm run db:init` | Initializes the database and creates the default admin user. |
| `npm run views:aggregate` | Aggregates historical page views into `page_view_daily`. |
| `npm test` | Executes the Node.js test suite (`node --test`). |

## Testing

Unit and integration tests cover moderation workflows, search, scheduling, comments, and UI rendering. Execute all tests with:

```bash
npm test
```

The suite relies on Node's built-in test runner and JSDOM for server-rendered views. 【F:package.json†L7-L32】【F:tests/commentPreviewRoute.test.js†L1-L40】

## Project Structure

```
app.js                # Express app bootstrap, middleware, routing setup
routes/               # Route handlers for auth, pages, search, cookies, admin, accounts
views/                # EJS templates and layout
public/               # Static assets (CSS, JS, images)
utils/                # Business logic helpers (roles, notifications, feeds, live stats, etc.)
middleware/           # Custom middleware (auth, CSRF, rate limiting, cookie consent)
scripts/              # Maintenance scripts (DB init, view aggregation)
tests/                # Node test suites covering routes, UI, and services
```

## Deployment Checklist

- [ ] Set strong session secrets via environment variables or secret file.
- [ ] Change the default administrator password after initialization.
- [ ] Configure HTTPS and reverse proxy support for WebSockets.
- [ ] Schedule the view aggregation script to keep the `page_views` table compact.
- [ ] Vérifier que le captcha mathématique dynamique fonctionne avant d'activer les inscriptions publiques.

## Contributing

1. Fork the repository and create a feature branch.
2. Add or update tests that cover your change.
3. Ensure `npm test` passes.
4. Submit a pull request with a detailed description.

## License

This project is licensed under the [MIT License](./LICENSE).
