# Simple Wiki

Simple Wiki is a lightweight knowledge base built on Node.js, Express, and EJS templates. It provides a moderation workflow, Discord webhooks, and convenient utilities for administering a private wiki.

## Features

- Page editing with revision history and collaborative tooling.
- Comment moderation complete with temporary edit tokens and snowflake identifiers.
- Discord webhook integration for admin and public feeds with retry and duplication safeguards.
- SQLite-backed search, analytics, and optional FTS when available.
- Role-based access control for administrators, moderators, and contributors.

## Getting Started

```bash
npm install
npm run db:init
npm start
```

An administrator account (`admin` / `admin`) is created during `npm run db:init`. Log in and change the password immediately after the first sign-in. Administrators can provision moderator accounts from the Users panel without granting elevated privileges.

## Available Scripts

| Script | Description |
| ------ | ----------- |
| `npm start` | Start the Express server in production mode. |
| `npm run dev` | Start the server with auto-reload using `node --watch`. |
| `npm run db:init` | Bootstrap the SQLite database, create tables, and seed the default administrator. |
| `npm run views:aggregate` | Aggregate daily view statistics for pages. |

## Configuration

Simple Wiki reads session settings from environment variables to keep secrets outside the codebase:

- `SESSION_SECRET` or `SESSION_SECRETS`: One or more comma-separated secrets used to sign session cookies.
- `SESSION_SECRET_FILE`: Optional file path containing one secret per line. File changes are watched so new secrets are picked up without restarting the server.
- `SESSION_COOKIE_*`: Additional cookie options (`NAME`, `SECURE`, `HTTP_ONLY`, `SAMESITE`, `MAX_AGE`, `ROLLING`).

If no secret is provided, a temporary development-only secret is generated and a warning is emitted. Always set a strong secret in production.

Legacy passwords are transparently re-hashed with bcrypt during a successful login. Inform users they may need to sign in again or reset passwords from the admin panel.

## Contributing

1. Fork the repository and create a feature branch.
2. Install dependencies and run the application locally.
3. Submit a pull request describing your changes.

## License

Simple Wiki is released under the [MIT License](LICENSE).
