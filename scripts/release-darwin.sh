#!/usr/bin/env bash
# Build, codesign, notarize, and package macOS (Darwin) acpbot binaries
# for GitHub Releases.
#
# CI only ships Linux artifacts. Darwin is built by hand on a Mac with a
# Developer ID. Gatekeeper needs notarization, not just codesign.
#
# Usage:
#   ./scripts/release-darwin.sh v0.1.0
#   ./scripts/release-darwin.sh v0.1.0 --upload          # attach to GH release
#   ./scripts/release-darwin.sh v0.1.0 --arch arm64      # this arch only
#   ./scripts/release-darwin.sh v0.1.0 --adhoc           # force ad-hoc sign
#   ./scripts/release-darwin.sh v0.1.0 --skip-notarize
#   ./scripts/release-darwin.sh v0.1.0 --install         # copy to ~/.local/bin
#
# Env:
#   CODESIGN_IDENTITY          Override identity (default: first Developer ID Application)
#   ACPBOT_SIGN_ADHOC=1        Same as --adhoc
#   NOTARY_KEYCHAIN_PROFILE    Override notarytool keychain profile
#   APPLE_ID APPLE_TEAM_ID     Passed through to notarytool when set
#   NOTARY_KEY NOTARY_KEY_ID NOTARY_ISSUER   App Store Connect API key (optional)
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
SKIP_NOTARIZE=0
CODESIGN_ID="app.acpbot"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    --upload) UPLOAD=1; shift ;;
    --install) INSTALL=1; shift ;;
    --adhoc) FORCE_ADHOC=1; shift ;;
    --skip-notarize) SKIP_NOTARIZE=1; shift ;;
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

[[ -n "$VERSION" ]] || die "usage: $0 v0.1.0 [--upload] [--install] [--arch arm64|x64] [--adhoc] [--skip-notarize]"
case "$VERSION" in
  v*) ;;
  *) VERSION="v${VERSION}" ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || die "must run on macOS"

if [[ ${#ARCHS[@]} -eq 0 ]]; then
  ARCHS=(arm64 x64)
fi

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

NOTARIZE=0
if [[ "$IDENTITY" != "-" && "$SKIP_NOTARIZE" -eq 0 ]]; then
  NOTARIZE=1
fi

if [[ "$IDENTITY" == "-" ]]; then
  log "signing: ad-hoc (local LaunchAgents only; Gatekeeper will block downloads)"
else
  log "signing: $IDENTITY"
  if [[ "$NOTARIZE" -eq 1 ]]; then
    log "notarize: yes"
  else
    log "notarize: skipped"
  fi
fi

sign_bin() {
  local bin="$1"
  if [[ "$IDENTITY" == "-" ]]; then
    codesign --force --identifier "$CODESIGN_ID" --sign - "$bin"
  else
    codesign --force --options runtime --timestamp \
      --identifier "$CODESIGN_ID" \
      --sign "$IDENTITY" \
      "$bin"
  fi
  codesign --verify --verbose=2 "$bin"
}

NOTARY_PROFILE="${NOTARY_KEYCHAIN_PROFILE:-barkvisor-notarize}"

notary_auth() {
  if [[ -n "${NOTARY_KEY:-}" && -n "${NOTARY_KEY_ID:-}" && -n "${NOTARY_ISSUER:-}" ]]; then
    echo --key "$NOTARY_KEY" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER"
    return
  fi
  echo --keychain-profile "$NOTARY_PROFILE"
  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    echo --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID"
  fi
}

ensure_notary() {
  # shellcheck disable=SC2046
  if xcrun notarytool history $(notary_auth) >/dev/null 2>&1; then
    return 0
  fi
  cat >&2 <<EOF
error: notary credentials missing. Gatekeeper will keep blocking downloads.

Set NOTARY_KEYCHAIN_PROFILE, or APPLE_ID and APPLE_TEAM_ID, or an App Store
Connect API key (NOTARY_KEY, NOTARY_KEY_ID, NOTARY_ISSUER).

Pass --skip-notarize only for a local experiment.
EOF
  exit 1
}

notarize_bin() {
  local bin="$1"
  local name="$2"
  local zip="dist/${name}.zip"
  rm -f "$zip"
  ditto -c -k --keepParent "$bin" "$zip"
  log "notarize ${name}.zip"
  # shellcheck disable=SC2046
  xcrun notarytool submit "$zip" $(notary_auth) --wait --timeout 20m
  rm -f "$zip"
  # Naked Mach-O cannot be stapled. The ticket is on Apple's servers, keyed
  # by CDHash. First launch needs network so Gatekeeper can look it up.
}

command -v bun >/dev/null || die "bun not on PATH"
mkdir -p dist

if [[ "$NOTARIZE" -eq 1 ]]; then
  ensure_notary
fi

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

  out="acpbot-${VERSION}-${suffix}"

  log "compile ${out} (${target}) — unified host+worker CLI"
  bun build --compile --target="$target" \
    --outfile="dist/${out}" \
    src/main.ts
  chmod +x "dist/${out}"

  log "codesign ${out}"
  sign_bin "dist/${out}"

  if [[ "$NOTARIZE" -eq 1 ]]; then
    notarize_bin "dist/${out}" "$out"
  fi

  log "tar ${out}.tar.gz"
  tar -C dist -czf "dist/${out}.tar.gz" "${out}"

  (cd dist && shasum -a 256 "${out}.tar.gz") >>"$SUMS_FILE"
done

log "checksums → ${SUMS_FILE}"
cat "$SUMS_FILE"

if [[ "$INSTALL" -eq 1 ]]; then
  machine="$(uname -m)"
  case "$machine" in
    arm64) inst_suffix="darwin-arm64" ;;
    x86_64) inst_suffix="darwin-x64" ;;
    *) die "unknown machine arch: $machine" ;;
  esac
  w="dist/acpbot-${VERSION}-${inst_suffix}"
  [[ -x "$w" ]] || die "missing $w for --install"
  mkdir -p "$HOME/.local/bin"
  cp -f "$w" "$HOME/.local/bin/acpbot"
  chmod +x "$HOME/.local/bin/acpbot"
  # Re-sign ad-hoc copies only. A Developer ID re-sign would change the
  # CDHash and drop the notarization ticket.
  if [[ "$IDENTITY" == "-" ]]; then
    sign_bin "$HOME/.local/bin/acpbot"
  fi
  # Optional legacy name: same binary, basename triggers host when run as acpbot-host
  ln -sfn "$HOME/.local/bin/acpbot" "$HOME/.local/bin/acpbot-host"
  log "installed → ~/.local/bin/acpbot  (+ acpbot-host → acpbot symlink)"
  log "run: acpbot host | acpbot worker | acpbot help"
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
  done
  files+=("$SUMS_FILE")
  log "upload to release ${VERSION}"
  gh release upload "$VERSION" "${files[@]}" --clobber
  log "uploaded to https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/${VERSION}"
fi

log "done"
echo ""
echo "Artifacts:"
ls -la dist/acpbot-"${VERSION}"-darwin-*.tar.gz "$SUMS_FILE" 2>/dev/null || true
echo ""
if [[ "$NOTARIZE" -eq 1 ]]; then
  echo "Notarized. First launch of a quarantined download needs network so Gatekeeper can fetch the ticket."
fi
