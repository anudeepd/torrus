.PHONY: dev build install clean

# Build frontend and install Python package
install:
	cd frontend && npm install
	cd frontend && npm run build
	uv pip install -e .

# Build frontend only
build:
	cd frontend && npm run build

# Dev mode: run backend (assumes frontend dev server runs separately)
dev:
	TORRUS_DEV=1 .venv/bin/torrus serve --no-browser

# Run Vite dev server (in a second terminal)
frontend-dev:
	cd frontend && npm run dev

clean:
	rm -rf src/torrus/static/assets src/torrus/static/index.html src/torrus/static/fonts
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
