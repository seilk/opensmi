.PHONY: help install tui build typecheck test check

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

tui:
	cd tui && bun index.ts

build:
	./scripts/build-tui.sh

typecheck:
	cd tui && bun install --frozen-lockfile && bun run tsc --noEmit

test:
	python3 -m unittest -v

check:
	./scripts/check.sh
