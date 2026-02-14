.PHONY: help install tui build typecheck test check build-cli install-cli

help:
	@echo "Targets:"
	@echo "  install     - install Python CLI (editable)"
	@echo "  tui         - run TUI from source"
	@echo "  build       - build TUI standalone binary"
	@echo "  typecheck   - TypeScript typecheck"
	@echo "  test        - run Python unit tests"
	@echo "  check       - run all checks"

install:
	python3 -m pip install -e .

build-cli:
	./scripts/build-cli-pyz.sh

install-cli:
	./scripts/install-cli.sh

tui:
	cd tui && bun index.ts

build:
	./scripts/build-tui.sh

typecheck:
	cd tui && bun install --frozen-lockfile && bun run tsc --noEmit

test:
	PYTHONPATH=src python3 -m unittest -v

check:
	./scripts/check.sh
