# Torrus Frontend

React + TypeScript + Vite application for the Torrus web-based SSH terminal.

## Development

```bash
npm install
npm run dev          # Start Vite dev server
npm run build        # Production build
npm run test         # Run tests once
npm run test:watch   # Run tests in watch mode
```

## Project Structure

- `src/components/` — React components (layout, terminal, UI, settings)
- `src/store/` — Zustand state stores (terminal, layout, broadcast, settings, saved servers)
- `src/hooks/` — Custom React hooks (socket connection)
- `src/types/` — TypeScript type definitions
- `src/utils/` — Utility functions (UUID generation, platform detection)
- `src/test/` — Test setup and mocks

## Key Dependencies

- [xterm.js](https://xtermjs.org/) — Terminal emulation
- [socket.io-client](https://socket.io/) — Real-time communication with backend
- [zustand](https://github.com/pmndrs/zustand) — State management
- [Tailwind CSS](https://tailwindcss.com/) — Styling
- [lucide-react](https://lucide.dev/) — Icons
