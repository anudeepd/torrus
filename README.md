<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/torrus/main/assets/logo.svg" alt="Torrus" width="120"/>
</p>

<h1 align="center">Torrus</h1>

<p align="center">A web-based SSH terminal that works behind any reverse proxy. Install it, run it, use it.</p>

## Features

- **Web-based SSH terminal** with full xterm.js emulation
- **SFTP file browser** — upload, download, rename, delete files directly from the browser
- **Multi-tab support** — open multiple SSH sessions side by side, close all at once
- **Tab management** — right-click to rename, clone, duplicate, or save a tab as a session
- **Keyboard shortcuts** — `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+Tab` cycle tabs, `Ctrl+,` settings
- **Saved servers** — save, edit, import, and export connection configs
- **Works behind reverse proxies** — uses Socket.IO for reliable transport
- **Session sidebar** — quick-connect to saved servers
- **Admin console** — LDAP-admin session inventory, owner-bound controls, and submitted-input activity view
- **LDAP/AD authentication** — optional, via [ldapgate](https://github.com/anudeepd/ldapgate)

## Install

```bash
pip install torrus
```

## Usage

```bash
torrus serve
```

Opens the terminal in your browser. Connect to any SSH server from there.

Options:

```
--host TEXT          Bind host. [default: 127.0.0.1]
--port INTEGER       Bind port. [default: 8080]
--no-browser         Don't open the browser automatically.
--ldap-config PATH   Path to ldapgate YAML config to enable LDAP authentication.
```

## LDAP Authentication

Torrus can require users to log in via LDAP/AD before accessing the terminal. This uses [ldapgate](https://github.com/anudeepd/ldapgate) as FastAPI middleware — no separate proxy process needed.

```bash
pip install 'torrus[ldap]'
torrus serve --ldap-config /path/to/ldapgate.yaml
```

When LDAP is enabled, a logout button and (for configured admins) an admin console button appear in the top-right corner of the tab bar.

Set `TORRUS_ADMIN_USERS` to a comma-separated list of LDAP usernames allowed to use the console:

```bash
TORRUS_ADMIN_USERS=alice,bob torrus serve --ldap-config /path/to/ldapgate.yaml
```
Session controls use immutable session identity plus generation checks. New user allowlist entries apply immediately without restarting Torrus; disabling a user revokes known LDAP cookies and closes that user's active SSH tabs first, while its policy change remains queued for restart. Policy mutation requires LDAPGate user-wide revocation support (0.1.22+); older deployments fail closed without changing policy.

### Terminal input audit

LDAP deployments persist completed command lines after Enter, not raw
keystrokes or terminal output. Pasted multiline input is split into submitted
lines; the Admin Console's **Submitted input** table preserves embedded
line breaks, wraps long values, and lets an admin expand truncated previews.
Inputs entered after a detected password/passphrase/token prompt, plus command
lines containing inline credential flags or assignments, are stored only as a
`[redacted sensitive input]` marker. The password supplied while opening an
SSH connection is never recorded. Audit data is stored at
`~/.local/share/torrus/audit.db` by default (or `TORRUS_AUDIT_DB` when set).

```bash
torrus audit show --user alice
torrus audit purge --older-than 90
```

`audit show` escapes control characters so viewing an event cannot replay its
terminal escape sequences. Command text can still contain secrets that do not
match the sensitive-input detector; restrict access to the audit database.

The Admin Console's **Submitted input** view displays completed command events
to authorized admins; sensitive events show only their redaction marker.

## Development

Requires [uv](https://github.com/astral-sh/uv).

```bash
git clone https://github.com/anudeepd/torrus
cd torrus
uv sync
make dev
```

## License

MIT
