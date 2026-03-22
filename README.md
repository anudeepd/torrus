<p align="center">
  <img src="https://raw.githubusercontent.com/anudeepd/torrus/main/assets/logo.svg" alt="Torrus" width="120"/>
</p>

<h1 align="center">Torrus</h1>

<p align="center">A web-based SSH terminal that works behind any reverse proxy. Install it, run it, use it.</p>

## Features

- **Web-based SSH terminal** with full xterm.js emulation
- **Multi-tab support** — open multiple SSH sessions side by side
- **Saved servers** — save, edit, import, and export connection configs
- **Works behind reverse proxies** — uses Socket.IO for reliable transport
- **Session sidebar** — quick-connect to saved servers

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
--host TEXT     Bind host. [default: 0.0.0.0]
--port INTEGER  Bind port. [default: 8080]
--no-browser    Don't open the browser automatically.
```

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
