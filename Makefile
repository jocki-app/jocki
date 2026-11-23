SHELL := /bin/sh
NODE_RUN := sh scripts/with-node.sh

.PHONY: help install run-dev test clean build-web build-electron build-macos build-windows \
	build-linux build-ios build-android sync-ios sync-android open-ios open-android \
	build-all release

help:
	@echo "Available targets:"
	@echo "  make install         Install project dependencies"
	@echo "  make run-dev         Open Electron with live updates"
	@echo "  make test            Run the test suite"
	@echo "  make clean           Remove generated build output"
	@echo "  make build-web       Build the static React client"
	@echo "  make build-electron  Build the shared React app and Electron bundles"
	@echo "  make build-macos     Package macOS DMG and ZIP files"
	@echo "  make build-windows   Package a Windows NSIS installer"
	@echo "  make build-linux     Package Linux AppImage and DEB files"
	@echo "  make build-all       Build macOS, Windows, Linux, iOS, and Android"
	@echo "  make release version=1.1.1"
	@echo "                       Tag a version and publish native builds with GitHub Actions"
	@echo "  make release version=dev"
	@echo "                       Publish a dated SemVer development prerelease"
	@echo "  make sync-ios        Sync the web build into the Capacitor iOS shell"
	@echo "  make sync-android    Sync the web build into the Capacitor Android shell"
	@echo "  make open-ios        Open the iOS project in Xcode"
	@echo "  make open-android    Open the Android project in Android Studio"
	@echo "  make build-ios       Compile an unsigned release iOS app"
	@echo "  make build-android   Compile an unsigned release Android APK"

install:
	$(NODE_RUN) npm install

run-dev:
	$(NODE_RUN) npm run electron:dev

test:
	$(NODE_RUN) npm test

clean:
	rm -rf dist dist-electron release

build-web:
	$(NODE_RUN) npm run build:web

build-electron:
	$(NODE_RUN) npm run build:desktop

build-macos:
	$(NODE_RUN) npm run build:macos -- $(BUILD_ARGS)

build-windows:
	$(NODE_RUN) npm run build:windows

build-linux:
	$(NODE_RUN) npm run build:linux

build-all: build-macos build-windows build-linux build-ios build-android

release:
	@$(NODE_RUN) node scripts/release.mjs "$(version)"

sync-ios:
	$(NODE_RUN) npm run prepare:ios

sync-android:
	$(NODE_RUN) npm run prepare:android

open-ios:
	$(NODE_RUN) npm run cap:open:ios

open-android:
	$(NODE_RUN) npm run cap:open:android

build-ios:
	$(NODE_RUN) npm run build:ios

build-android:
	$(NODE_RUN) npm run build:android
