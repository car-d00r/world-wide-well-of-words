# Plan: v1 authentication & sign-in (optional accounts)

## Context
The app currently lets anyone submit a sentence with a freely-typed username, so
the Hall of Fame is spoofable. We're adding **optional** accounts: users can sign
up / log in, and when logged in their submissions are tied to their real account;
anonymous submissions still work. This is a lean first pass — auth + sign-in only.
Password hardening extras (lockout/rate-limiting, breached-password check, email
verification) are explicitly **deferred** to a later iteration.

Design decisions already settled:
- **Optional/additive** accounts (anonymous still allowed).
- **Server-side sessions** (revocable; session ID in an `HttpOnly` cookie, data
  server-side) — per OWASP Authentication guidance.
- **Hash on the server** with Argon2id; the browser only sends the plaintext over
  TLS. No client-side hashing. No manual salting (Argon2 embeds a per-password
  salt in its PHC string).

## What Litestar provides vs. what we build
- **Litestar handles:** session cookie, session ID, and server-side session
  data via **session middleware** (`ServerSideSessionConfig`). We use
  `request.set_session({...})`, `request.session`, `request.clear_session()`.
- **We build:** `users` table, Argon2 hash/verify, and signup/login/logout/me
  endpoints.
- **Not using `SessionAuth` in v1:** it *enforces* auth on routes, which fights
  "anonymous allowed." We use the session middleware alone and read
  `request.session` manually. `SessionAuth` is the natural upgrade when we add a
  login-required route later.
- **Session store:** no built-in Postgres store exists. Use **`FileStore`** on a
  mounted volume (persists across redeploys, single-instance-friendly). Redis is
  the prod/multi-instance upgrade.

## Dependencies
- Add **`argon2-cffi`** via `pdm add argon2-cffi` (Argon2id `PasswordHasher`;
  its defaults — t=3, 64 MiB, p=4 — already exceed the OWASP minimum).
- No new dep for sessions (Litestar core). `FileStore` needs a writable dir.

## Step 1 — Login/Signup modal in `static/index.html`
- Add a **"log in"** button to the banner (`.banner`), e.g. next to the counter.
- Add a hidden modal overlay (`#auth-modal`, `display:none`) with: a username
  field, a password field, a submit button, an error line, and a toggle between
  **Log in** and **Create account** (one modal, two modes). Style with the
  existing Win98 inset/outset classes (`.name`, `.btn98`).
- Add a small "logged in as <name> · log out" area (`#auth-status`) in the banner,
  shown when authenticated.

## Step 2 — JS handling in `static/app.js`
- `openAuthModal()` / `closeAuthModal()` toggle the overlay; toggle mode
  (login vs signup) updates the submit label and which endpoint is called.
- `submitAuth(mode)` → POST `/api/signup` or `/api/login` with `{username,
  password}` (JSON, over same-origin). On success: close modal, refresh auth UI.
  On failure: show the server's generic error message inline.
- `refreshAuthState()` → GET `/api/me` on page load; if logged in, show
  `#auth-status` (name + log out) and hide the "log in" button; also prefill/hide
  the submit form's username field so logged-in submissions use the account.
- `logout()` → POST `/api/logout`, then `refreshAuthState()`.
- Bump the `app.js?v=` query (cache-bust) in `index.html`.

## Step 3 — Backend in `app.py`
Reuse the existing async engine (`request.app.state.engine`) and the `text()` +
bound-params pattern already in the file.

1. **Session middleware + store** on the `Litestar(...)` construction:
   - `stores={"sessions": FileStore(Path(...))}`
   - `middleware=[ServerSideSessionConfig(... httponly=True, samesite="lax",
     secure=True ...).middleware]` (secure works on localhost since it's a secure
     context; required in prod).
2. **`users` table** (create in `INIT_DB`/`db/init.sql`):
   `users(username text primary key, password_hash text not null, created_at timestamp not null)`.
3. **Argon2**: one module-level `PasswordHasher()`; `ph.hash(pw)` on signup,
   `ph.verify(stored_hash, pw)` on login (raises on mismatch → caught).
4. **Endpoints** (all `text()` + bound params, following existing handlers):
   - `POST /api/signup` `{username, password}` → validate length (min 8), reject
     if username exists, `ph.hash`, insert, `request.set_session({"username": u})`,
     return `{username}`.
   - `POST /api/login` `{username, password}` → look up hash, `ph.verify`; on
     success `set_session`; on any failure return the **generic** message
     `"Invalid username or password"`. Verify against a dummy hash when the user
     is missing so timing doesn't leak existence.
   - `POST /api/logout` → `request.clear_session()`.
   - `GET /api/me` → `{username}` from `request.session` or `null`.
5. **Integrate with `POST /api/sentence`:** if `request.session.get("username")`,
   use that as the submitter (ignore any body username); otherwise keep today's
   anonymous behavior. Keeps the leaderboard trustworthy *for logged-in users*
   without blocking anonymous play.

## Baseline security applied in v1 (from the OWASP sheets)
- Argon2id server-side hashing; per-password salt (automatic); PHC string stored.
- Session ID in `HttpOnly; Secure; SameSite=Lax` cookie; data server-side;
  logout = `clear_session()` (instant revocation).
- Generic, non-enumerating login error + dummy-hash timing equalization.
- Min length 8 (note: with no MFA, OWASP prefers ≥15 — call out as a knob).
- Note: username signup inherently reveals "username taken" (unavoidable for
  username-based accounts; the enumeration concern mainly applies to email/login).

## TLS / deployment (not app code)
- Terminate TLS at a **reverse proxy** (Caddy/nginx/Traefik) in front of the app;
  forward plain HTTP internally. App sets `Secure` cookies and should trust
  `X-Forwarded-Proto`.
- Local dev over `http://localhost` needs no TLS. Add the proxy when deploying
  for real. (Caddy gives automatic HTTPS with ~3 lines.)

## Deferred to later (agreed)
Account lockout / rate limiting, breached-password (Pwned Passwords) check, email
verification, MFA. `SessionAuth` + Redis store when protected routes / scaling
arrive.

## References
- **OWASP Authentication Cheat Sheet** — §"Transmit Passwords Only Over TLS or
  Other Strong Transport" ("The login page and all subsequent authenticated pages
  must be exclusively accessed over TLS…"); §"Store Passwords in a Secure Fashion"
  and §"Compare Password Hashes Using Safe Functions" (server-side hashing model);
  plus user ID handling, password policy, generic anti-enumeration errors,
  lockout, and session/re-auth guidance.
  https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- **OWASP Password Storage Cheat Sheet** — Argon2id as first choice (≥19 MiB,
  t=2, p=1), automatic per-password salt, PHC string format, peppering,
  bcrypt 72-byte caveat, migration guidance.
  https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- **Litestar docs** — session middleware / stores (Memory, File, Redis; no
  built-in Postgres store) and `SessionAuth` (deferred to a later, login-required
  iteration).
- Note: "client sends plaintext over TLS, server hashes" is the model **implied**
  by the two OWASP sheets above (TLS-for-transport + server-side hashing); it is
  not a verbatim OWASP sentence, and OWASP does not explicitly forbid client-side
  hashing. The anti-client-hashing rationale (transmitted hash becomes the
  credential — "pass-the-hash") is standard security reasoning, not a cheat-sheet
  quote.

## Verification
- `pdm` build succeeds; `python3 -m py_compile app.py`, `node --check app.js`.
- Rebuild + recreate container (`podman-compose build app && podman rm -f
  thissentencedoesnotexist_app_1 && podman-compose up -d`).
- End-to-end via curl + a cookie jar:
  - `POST /api/signup` → 200, sets a session cookie.
  - `GET /api/me` with that cookie → `{username}`; without it → `null`.
  - `POST /api/sentence` with the cookie → row stored under the account name.
  - `POST /api/logout` → `GET /api/me` now `null`.
  - `POST /api/login` wrong password → generic error, no session cookie.
- Screenshot the modal open/closed and the logged-in banner state (headless
  Chrome, as with prior UI changes).
