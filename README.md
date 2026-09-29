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
- **Keyboard shortcuts** — `Ctrl+,` / `⌘+,` settings; browser-reserved tab and omnibox shortcuts remain native
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
--host TEXT              Bind host. [default: 127.0.0.1]
--port INTEGER           Bind port. [default: 8080]
--no-browser             Don't open the browser automatically.
--ldap-config PATH       Path to ldapgate YAML config to enable LDAP authentication.
--ssl-keyfile PATH       TLS private key, to serve HTTPS directly.
--ssl-certfile PATH      TLS certificate matching --ssl-keyfile.
--log-file PATH          Write the server log to a file as well as stderr.
```

### Connecting to servers on your own network

Torrus refuses targets that are not publicly routable by default: private,
loopback, link-local, cloud-metadata and shared (CGNAT/Tailscale) addresses,
matched by name as well as by literal IP. This keeps the web UI from being used
as an SSH pivot into the network Torrus runs in — including into the host it
runs on, which is not exempt. A refused connection reports:

> Connections to private, loopback, link-local or shared (CGNAT) addresses are not allowed. Set TORRUS_ALLOW_PRIVATE_HOSTS=true to allow them.

Set the variable when the machines you connect to are on your LAN:

```bash
TORRUS_ALLOW_PRIVATE_HOSTS=true torrus serve
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TORRUS_ADMIN_USERS` | *(empty)* | Comma-separated LDAP usernames allowed to open the Admin Console. |
| `TORRUS_AUDIT_DB` | `~/.local/share/torrus/audit.db` | Audit database location (`XDG_DATA_HOME` is honoured). |
| `TORRUS_LDAP_CONFIG` | *(empty)* | Same as `--ldap-config`, for deployments that set it in the service unit. |
| `TORRUS_LOG_FILE` | *(empty)* | Same as `--log-file`. |
| `TORRUS_DEV` | *(empty)* | Development mode: relaxed socket origins for the Vite dev server. |
| **`TORRUS_SSH_HOST_KEY_POLICY`** | `accept-new` | **`accept-new` records an unknown host key and refuses one that changed; `strict` also refuses an unknown host.** |
| `TORRUS_SSH_KNOWN_HOSTS` | `~/.local/state/torrus/known_hosts` | Where host keys trusted on first use are written (`XDG_STATE_HOME` is honoured). The system `~/.ssh/known_hosts` is always read as well. |
| **`TORRUS_ALLOW_PRIVATE_HOSTS`** | `false` | **Allow connecting to private, loopback, link-local, cloud-metadata or shared (CGNAT/Tailscale) addresses, including by name. Off by default: without it, torrus cannot be used as an SSH pivot into the network it runs in.** |
| `TORRUS_ALLOW_PRIVATE_HOSTS_WITHOUT_LDAP` | `false` | Deprecated alias for the above; kept so an existing deployment does not change behaviour silently. |
| `TORRUS_MAX_SSH_SESSIONS` | `128` | Ceiling on live SSH sessions. Each one occupies a worker of the shared I/O pool, so the default matches it: the alternative is every terminal stalling at once. |
| `TORRUS_BULK_ZIP_MAX_BYTES` | `2147483648` | Largest "download as zip" selection. Larger trees are refused before the archive starts streaming. |
| `TORRUS_MAX_UPLOAD_BYTES` | `1099511627776` | Largest single upload. |
| `TORRUS_UPLOAD_CHUNK_BYTES` | `33554432` | Upload window size. With LDAP auth it is capped at ldapgate's `proxy.max_body_size` (default 10 MB), which otherwise rejects larger windows with a 413. |
| `TORRUS_UPLOAD_CONCURRENCY` | `4` | Upload windows in flight per file. |
| `TORRUS_UPLOAD_SESSION_TTL` | `3600` | Seconds an interrupted upload stays resumable. |
| `TORRUS_SFTP_INLINE_MAX_BYTES` | `5242880` | Largest file served inline rather than as a streaming download. |

Host keys: Torrus records a host's key the first time it connects (trust on
first use) and **refuses the connection if that key later changes**, printing
both fingerprints. A host whose key legitimately changed needs its entry removed
from the store above. Set `TORRUS_SSH_HOST_KEY_POLICY=strict` to also refuse
hosts it has never seen.

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
Session controls use immutable session identity plus generation checks. New user allowlist entries and disable/re-enable changes apply immediately without restarting Torrus; disabling a user revokes known LDAP cookies and closes that user's active SSH tabs. Policy mutation requires LDAPGate user-wide revocation support (0.1.22+); older deployments fail closed without changing policy.

### Uploads behind LDAPGate

Uploads arrive at the gate in `TORRUS_UPLOAD_CHUNK_BYTES` windows, and ldapgate
answers any request body over `proxy.max_body_size` with a bare 413 before the
request reaches Torrus. Its default is 10 MB, so keep the setting at or above the
window:

```yaml
proxy:
    max_body_size: 33554432   # 32 MiB, matching TORRUS_UPLOAD_CHUNK_BYTES
```

Torrus caps the window at that limit on startup and logs a warning naming the
setting to raise, so an upload does not fail — it just shifts less data per
request. Raise both together, or lower both to 16 MiB if you would rather retry
smaller windows on a flaky link. Any reverse proxy in front of ldapgate needs a
limit at least as large (`client_max_body_size 32m` on nginx, whose default is
1 MB).

### Terminal input audit

LDAP deployments persist completed command lines after Enter, not raw
keystrokes or terminal output. Pasted multiline input is split into submitted
lines; the Admin Console's **Submitted input** table groups consecutive command
lines from the same session into one block (view only — stored events stay one
row per line), preserves embedded line breaks, wraps long values, and lets an
admin expand truncated previews.
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

### SFTP audit
LDAP deployments also record SFTP file operations: every download (inline,
streaming, or a bulk zip archive — one event per archived file) plus uploads,
deletes, renames, mkdirs, chmods, and chowns. Each event stores the resolved
remote path, the size for transfers, and op-specific detail (rename target,
permission mode, owner/group ids). Downloads are recorded when initiated;
uploads when completed. Events appear in `torrus audit show` and in the
Admin Console's activity table (kind `sftp_<operation>`), and they are
covered by the same retention purge as terminal input.


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
