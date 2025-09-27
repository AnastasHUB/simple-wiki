<p>npm i</p>
<p>npm run db:init</p>
<p>npm start</p>

<p>
  default admin is <code>admin</code> / <code>admin</code> (created during
  <code>npm run db:init</code> with a bcrypt-hashed password). Change it after
  the first login.
</p>
<p>
  Plain-text passwords created before the bcrypt migration are automatically
  re-hashed on the next successful login. Communicate to existing users that a
  login may be required to finalize the migration, or reset their password from
  the admin panel if needed.
</p>
