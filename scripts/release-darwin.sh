#!/usr/bin/env bash
# Build, codesign, and package macOS (Darwin) acpbot binaries for GitHub Releases.
#
# CI only ships Linux artifacts. Darwin is built by hand on a Mac with a
# Developer ID (or ad-hoc sign for local use).
#
# Usage:
#   ./scripts/release-darwin.sh v0.1.0
#   ./scripts/release-darwin.sh v0.1.0 --upload          # attach to GH release
#   ./scripts/release-darwin.sh v0.1.0 --arch arm64      # this arch only
#   ./scripts/release-darwin.sh v0.1.0 --adhoc           # force ad-hoc sign
#   ./scripts/release-darwin.sh v0.1.0 --install         # copy to ~/.local/bin
#
# Env:
#   CODESIGN_IDENTITY  Override identity (default: first "Developer ID Application")
#   ACPBOT_SIGN_ADHOC=1  Same as --adhoc
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

die() { echo "error: $*" >&2; exit 1; }
log() { echo "==> $*"; }

VERSION=""
ARCHS=()
UPLOAD=0
INSTALL=0
FORCE_ADHOC=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    --upload) UPLOAD=1; shift ;;
    --install) INSTALL=1; shift ;;
    --adhoc) FORCE_ADHOC=1; shift ;;
    --arch)
      [[ $# -ge 2 ]] || die "--arch needs arm64 or x64"
      ARCHS+=("$2")
      shift 2
      ;;
    v*)
      VERSION="$1"
      shift
      ;;
    *)
      die "unknown arg: $1 (pass version like v0.1.0)"
      ;;
  esac
done

[[ -n "$VERSION" ]] || die "usage: $0 v0.1.0 [--upload] [--install] [--arch arm64|x64] [--adhoc]"
case "$VERSION" in
  v*) ;;
  *) VERSION="v${VERSION}" ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || die "must run on macOS"

if [[ ${#ARCHS[@]} -eq 0 ]]; then
  ARCHS=(arm64 x64)
fi

# Resolve codesign identity
IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ "$FORCE_ADHOC" -eq 1 || "${ACPBOT_SIGN_ADHOC:-}" == "1" ]]; then
  IDENTITY="-"
elif [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(
    security find-identity -v -p codesigning 2>/dev/null \
      | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' \
      | head -1
  )"
  if [[ -z "$IDENTITY" ]]; then
    log "no Developer ID found — using ad-hoc sign (-)"
    IDENTITY="-"
  fi
fi

if [[ "$IDENTITY" == "-" ]]; then
  log "signing: ad-hoc (local LaunchAgents only; Gatekeeper may block downloads)"
else
  log "signing: $IDENTITY"
fi

command -v bun >/dev/null || die "bun not on PATH"
mkdir -p dist

printf 'export const ACPBOT_VERSION = "%s";\n' "${VERSION}" > src/version.gen.ts

SUMS_FILE="dist/SHA256SUMS-darwin-${VERSION}"
: >"$SUMS_FILE"

for arch in "${ARCHS[@]}"; do
  case "$arch" in
    arm64|aarch64)
      target="bun-darwin-arm64"
      suffix="darwin-arm64"
      ;;
    x64|amd64|x86_64)
      target="bun-darwin-x64"
      suffix="darwin-x64"
      ;;
    *)
      die "unsupported --arch $arch (use arm64 or x64)"
      ;;
  esac

  worker="acpbot-${VERSION}-${suffix}"
  host="acpbot-host-${VERSION}-${suffix}"

  log "compile ${worker} / ${host} (${target})"
  bun build --compile --target="$target" \
    --outfile="dist/${worker}" \
    src/main.ts
  bun build --compile --target="$target" \
    --outfile="dist/${host}" \
    src/acp-host/main.ts
  chmod +x "dist/${worker}" "dist/${host}"

  log "codesign ${worker} ${host}"
  if [[ "$IDENTITY" == "-" ]]; then
    codesign --force --sign - "dist/${worker}" "dist/${host}"
  else
    # hardened runtime for Developer ID / notarization-friendly
    codesign --force --options runtime --timestamp \
      --sign "$IDENTITY" \
      "dist/${worker}" "dist/${host}"
  fi
  codesign --verify --verbose=2 "dist/${worker}"
  codesign --verify --verbose=2 "dist/${host}"

  log "tar ${worker}.tar.gz ${host}.tar.gz"
  tar -C dist -czf "dist/${worker}.tar.gz" "${worker}"
  tar -C dist -czf "dist/${host}.tar.gz" "${host}"

  (cd dist && shasum -a 256 "${worker}.tar.gz" "${host}.tar.gz") >>"$SUMS_FILE"
done

log "checksums → ${SUMS_FILE}"
cat "$SUMS_FILE"

if [[ "$INSTALL" -eq 1 ]]; then
  # Install the arch matching this machine
  machine="$(uname -m)"
  case "$machine" in
    arm64) inst_suffix="darwin-arm64" ;;
    x86_64) inst_suffix="darwin-x64" ;;
    *) die "unknown machine arch: $machine" ;;
  esac
  w="dist/acpbot-${VERSION}-${inst_suffix}"
  h="dist/acpbot-host-${VERSION}-${inst_suffix}"
  [[ -x "$w" && -x "$h" ]] || die "missing $w / $h for --install"
  mkdir -p "$HOME/.local/bin"
  cp -f "$w" "$HOME/.local/bin/acpbot"
  cp -f "$h" "$HOME/.local/bin/acpbot-host"
  chmod +x "$HOME/.local/bin/acpbot" "$HOME/.local/bin/acpbot-host"
  # re-sign after copy (codesign is path-bound for some setups)
  if [[ "$IDENTITY" == "-" ]]; then
    codesign --force --sign - "$HOME/.local/bin/acpbot" "$HOME/.local/bin/acpbot-host"
  else
    codesign --force --options runtime --timestamp \
      --sign "$IDENTITY" \
      "$HOME/.local/bin/acpbot" "$HOME/.local/bin/acpbot-host"
  fi
  log "installed → ~/.local/bin/acpbot{,-host}"
  log "restart services:  acpbot restart   (or launchctl kickstart)"
fi

if [[ "$UPLOAD" -eq 1 ]]; then
  command -v gh >/dev/null || die "gh CLI required for --upload"
  files=()
  for arch in "${ARCHS[@]}"; do
    case "$arch" in
      arm64|aarch64) suffix="darwin-arm64" ;;
      x64|amd64|x86_64) suffix="darwin-x64" ;;
    esac
    files+=("dist/acpbot-${VERSION}-${suffix}.tar.gz")
    files+=("dist/acpbot-host-${VERSION}-${suffix}.tar.gz")
  done
  files+=("$SUMS_FILE")
  log "upload to release ${VERSION}"
  gh release upload "$VERSION" "${files[@]}" --clobber
  log "uploaded to https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${VERSION}"
fi

log "done"
echo ""
echo "Artifacts:"
ls -la dist/acpbot*-"${VERSION}"-darwin-*.tar.gz "$SUMS_FILE" 2>/dev/null || true
echo ""
if [[ "$IDENTITY" != "-" ]]; then
  echo "Optional notarization (for Gatekeeper on other Macs):"
  echo "  xcrun notarytool submit dist/acpbot-${VERSION}-darwin-arm64.tar.gz \\"
  echo "    --keychain-profile <notary-profile> --wait"
  echo "  # then unzip, stapler staple the binary, re-tar if desired"
fi
