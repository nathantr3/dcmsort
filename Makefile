# dcmsort - interactive DICOM sorting, splitting, and attribute modification
#
# Run `make` on its own for the target list.

SHELL := /bin/bash

NODE_MODULES := node_modules/.package-lock.json
FIXTURES     := test/fixtures/data
ICON         := build/icon.icns
ICON_PNG     := build/icon.png
DIST         := dist
APP          := $(DIST)/mac-arm64/dcmsort.app

# Code signing is off by default: a local build should not need a Developer ID.
# Override with `make dist-mac SIGN=1` once you have a certificate installed.
SIGN ?= 0
ifeq ($(SIGN),0)
export CSC_IDENTITY_AUTO_DISCOVERY := false
endif

# Disable certificate validation for corporate proxy environments
export NODE_TLS_REJECT_UNAUTHORIZED := 0

# Folder to open for `make run` / `make smoke`.
OPEN ?= $(FIXTURES)

# Arguments for `make cli`.
ARGS ?= --help

.DEFAULT_GOAL := help
.PHONY: help install fixtures test watch run run-blank drive smoke focus-check icon \
        cli cli-link dist-mac dist-mac-x64 dist-mac-universal dist-linux dist-linux-arm64 \
        dist-win pack clean distclean

## help: list the available targets
help:
	@echo "dcmsort targets:"
	@sed -n 's/^## \([a-z0-9-]*\): \(.*\)/  \1|\2/p' $(MAKEFILE_LIST) | column -t -s '|'
	@echo
	@echo "Variables: OPEN=<folder> (default $(FIXTURES)), SIGN=1 to code sign"

## install: install npm dependencies
install: $(NODE_MODULES)

$(NODE_MODULES): package.json package-lock.json
	npm install
	@touch $@

## fixtures: generate the synthetic test DICOMs (no PHI in the repo)
fixtures: $(FIXTURES)

$(FIXTURES): test/fixtures/generate.js | $(NODE_MODULES)
	node test/fixtures/generate.js
	@touch $@

## test: run the unit test suite
test: $(NODE_MODULES)
	npx vitest run

## watch: run the unit tests in watch mode
watch: $(NODE_MODULES)
	npx vitest

## run: launch the app, opening OPEN (default: the test fixtures)
run: $(NODE_MODULES) $(FIXTURES)
	npx electron . --open $(OPEN)

## run-blank: launch the app with no folder loaded
run-blank: $(NODE_MODULES)
	npx electron .

## drive: interactive Playwright REPL against the app window
drive: $(NODE_MODULES) $(FIXTURES)
	node scripts/drive.mjs

## smoke: launch the real app and drive one workflow end to end
smoke: $(NODE_MODULES) $(FIXTURES)
	node scripts/drive.mjs --script scripts/smoke.txt

## focus-check: assert the editors never steal focus from a field being typed in
focus-check: $(NODE_MODULES) $(FIXTURES)
	node scripts/drive.mjs --script scripts/focus.txt

## cli: run the headless CLI from source, e.g. make cli ARGS="list --folder ."
cli: $(NODE_MODULES) $(FIXTURES)
	node src/cli/cli.js $(ARGS)

## cli-link: symlink the built mac app's CLI into /usr/local/bin (needs sudo)
cli-link: $(APP)
	sudo ln -sf "$(abspath $(APP))/Contents/Resources/dcmsort" /usr/local/bin/dcmsort
	@echo "linked: $$(command -v dcmsort)"

## icon: rebuild build/icon.icns and build/icon.png from build/icon.svg
icon: $(ICON)

$(ICON) $(ICON_PNG): build/icon.svg scripts/make-icon.mjs scripts/icon-host.js | $(NODE_MODULES)
	node scripts/make-icon.mjs

## dist-mac: build the macOS arm64 zip
dist-mac: $(NODE_MODULES) $(ICON)
	npx electron-builder --mac=zip --arm64

## dist-mac-x64: build the macOS Intel dmg
dist-mac-x64: $(NODE_MODULES) $(ICON)
	npx electron-builder --mac --x64

## dist-mac-universal: build both macOS architectures
dist-mac-universal: $(NODE_MODULES) $(ICON)
	npx electron-builder --mac --arm64 --x64

## dist-linux: build the Linux x86_64 AppImage
dist-linux: $(NODE_MODULES) $(ICON_PNG)
	npx electron-builder --linux --x64

## dist-linux-arm64: build the Linux arm64 AppImage
dist-linux-arm64: $(NODE_MODULES) $(ICON_PNG)
	npx electron-builder --linux --arm64

## dist-win: build the Windows installer
dist-win: $(NODE_MODULES) $(ICON)
	npx electron-builder --win

## pack: package the app unpacked, without building an installer
pack: $(NODE_MODULES) $(ICON)
	npx electron-builder --dir

## clean: remove build output and generated fixtures
clean:
	rm -rf $(DIST) $(FIXTURES)

## distclean: clean, plus node_modules and the generated icon files
distclean: clean
	rm -rf node_modules $(ICON) $(ICON_PNG)
