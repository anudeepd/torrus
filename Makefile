.PHONY: dev build install clean test lint verify-assets check

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

# Run the backend test suite and the linter.
test:
	.venv/bin/python -m pytest -q

lint:
	.venv/bin/ruff check src/ tests/

# Prove the committed bundle matches frontend/src: rebuild and diff.
verify-assets:
	cd frontend && npm ci && npm run build
	git diff --quiet -- src/torrus/static || { \
		echo "src/torrus/static is stale — commit the rebuilt bundle"; \
		git --no-pager diff --stat -- src/torrus/static; exit 1; }

# Everything continuous integration runs, in the same order.
check: lint test verify-assets

clean:
	rm -rf src/torrus/static/assets src/torrus/static/index.html src/torrus/static/fonts
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
