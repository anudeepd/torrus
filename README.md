<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/torrus/main/assets/logo.svg" alt="Torrus" width="120"/>
</p>

<h1 align="center">Torrus</h1>

<p align="center">A web-based SSH terminal that works behind any reverse proxy. Install it, run it, use it.</p>

## Features

- **Web-based SSH terminal** with full xterm.js emulation
- **Multi-tab support** — open multiple SSH sessions side by side, close all at once
- **Tab management** — right-click to rename, clone, duplicate, or save a tab as a session
- **Keyboard shortcuts** — `Ctrl+T` new tab, `Ctrl+W` close tab, `Ctrl+Tab` cycle tabs, `Ctrl+,` settings
- **Saved servers** — save, edit, import, and export connection configs
- **Works behind reverse proxies** — uses Socket.IO for reliable transport
- **Session sidebar** — quick-connect to saved servers
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

When LDAP is enabled, a logout button appears in the top-right corner of the tab bar.

See the [ldapgate README](https://github.com/anudeepd/ldapgate) for config file documentation.

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
