<p>npm i</p>
<p>npm run db:init</p>
<p>npm start</p>

<p>
  default admin is <code>admin</code> / <code>admin</code> (created during
  <code>npm run db:init</code> with a bcrypt-hashed password). Change it after
  the first login.
</p>

<h2>Configuration</h2>

<p>
  The application reads session secrets and cookie settings from environment
  variables so that sensitive values never need to be committed to source
  control.
</p>

<ul>
  <li>
    <code>SESSION_SECRET</code> / <code>SESSION_SECRETS</code> – provide one or
    more secrets (comma separated) used to sign the session cookies. Multiple
    secrets allow for a smooth rotation window.
  </li>
  <li>
    <code>SESSION_SECRET_FILE</code> – optional path to a file containing secrets
    (one per line). The file is watched for changes so a new value takes effect
    without restarting the server.
  </li>
  <li>
    <code>SESSION_COOKIE_*</code> – tweak cookie behaviour. Supported suffixes
    are <code>NAME</code>, <code>SECURE</code>, <code>HTTP_ONLY</code>,
    <code>SAMESITE</code>, <code>MAX_AGE</code> and <code>ROLLING</code>.
  </li>
</ul>

<p>
  When no secret is provided a development-only fallback is used and a warning
  is printed. Always configure a strong secret for production.
</p>
<p>
  Plain-text passwords created before the bcrypt migration are automatically
  re-hashed on the next successful login. Communicate to existing users that a
  login may be required to finalize the migration, or reset their password from
  the admin panel if needed.
</p>
