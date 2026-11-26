#!/usr/bin/env bash
# Checks release DMGs the way a downloading Mac will: the DMG, the app inside it
# and every native binary in the app are signed with the expected team's
# Developer ID Application certificate, the app's signature is intact and uses
# the hardened runtime with a secure timestamp, and the DMG and the app carry
# stapled notarization tickets that Gatekeeper accepts.
#
#   scripts/release/verify-macos.sh <team-id> <dmg>...
#   scripts/release/verify-macos.sh --signed-only <team-id> <dmg>...
#
# --signed-only skips the notarization and Gatekeeper checks, for a local build
# signed without notarization credentials. The full check needs internet access:
# `stapler validate` asks Apple about the ticket it finds.
set -euo pipefail

notarized=1
if [[ "${1:-}" == "--signed-only" ]]; then
  notarized=0
  shift
fi
if [[ $# -lt 2 ]]; then
  echo "usage: $0 [--signed-only] <team-id> <dmg>..." >&2
  exit 2
fi
team="$1"
shift

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ "$team" =~ ^[A-Z0-9]{10}$ ]] || fail "Not an Apple team ID: $team"

# Signed by Apple's Developer ID Application certificate issued to this team,
# not merely by some certificate whose TeamIdentifier matches.
requirement="=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"$team\""

if [[ $notarized -eq 1 ]]; then
  # With assessments off, spctl reports every file as accepted.
  status="$(spctl --status 2>&1 || true)"
  [[ "$status" == *"assessments enabled"* ]] || fail "Gatekeeper assessments are not enabled on this Mac: $status"
fi

mount=""
work="$(mktemp -d)"
cleanup() {
  if [[ -n "$mount" ]]; then
    hdiutil detach -quiet "$mount" 2>/dev/null || hdiutil detach -quiet -force "$mount" 2>/dev/null || true
    rmdir "$mount" 2>/dev/null || true
    mount=""
  fi
}
trap 'cleanup; rm -rf "$work"' EXIT

shopt -s nullglob dotglob

for dmg in "$@"; do
  [[ -f "$dmg" ]] || fail "No such DMG: $dmg"
  echo "--- $dmg"

  codesign --verify --strict --verbose=2 -R "$requirement" "$dmg" || fail "The DMG is not validly signed with team $team's Developer ID: $dmg"

  mount="$(mktemp -d)"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg" >/dev/null || fail "Could not mount $dmg"

  apps=("$mount"/*.app)
  [[ ${#apps[@]} -eq 1 ]] || fail "Expected one app in $dmg, found ${#apps[@]}"
  app="${apps[0]}"
  [[ -d "$app" && ! -L "$app" ]] || fail "The app in $dmg is not a real bundle: $app"

  codesign --verify --deep --strict --verbose=2 -R "$requirement" "$app" || fail "The app is not validly signed with team $team's Developer ID"

  details="$(codesign -dv --verbose=2 "$app" 2>&1)"
  flags="$(sed -n 's/^CodeDirectory .* flags=0x\([0-9a-fA-F]*\).*/\1/p' <<<"$details")"
  [[ -n "$flags" ]] && (((16#$flags & 0x10000) != 0)) || fail "The app is not signed with the hardened runtime"
  grep -q '^Timestamp=.' <<<"$details" || fail "The app's signature has no secure timestamp"

  # Every native binary in the bundle, including the native modules under
  # Resources: every file is classified by its content, whatever its name or
  # mode, and a file that can't be read fails the check rather than being skipped.
  find "$app" -type f -print0 >"$work/files" || fail "Could not list the files in $app"
  xargs -0 file -N -0 -- <"$work/files" >"$work/types" || fail "Could not classify the files in $app"
  files=0
  binaries=0
  # `file -0` prints each name, a NUL, then ": <type>" and a newline.
  while IFS= read -r -d '' path && IFS= read -r kind; do
    files=$((files + 1))
    kind="${kind#: }"
    case "$kind" in
      "cannot open"* | ERROR* | *"read error"*) fail "Could not read ${path#"$mount"/}: $kind" ;;
      Mach-O*)
        binaries=$((binaries + 1))
        codesign --verify --strict -R "$requirement" "$path" 2>/dev/null || fail "A binary is not validly signed with team $team's Developer ID: ${path#"$mount"/}"
        ;;
    esac
  done <"$work/types"
  listed="$(tr -cd '\0' <"$work/files" | wc -c | tr -d ' ')"
  [[ $files -eq $listed ]] || fail "Classified $files of the $listed files in $app"
  [[ $binaries -gt 0 ]] || fail "Found no native binaries in $app"
  echo "$binaries native binaries signed by $team, of $files files"

  if [[ $notarized -eq 1 ]]; then
    xcrun stapler validate "$dmg" || fail "The DMG's notarization ticket did not validate (missing, or Apple unreachable)"
    xcrun stapler validate "$app" || fail "The app's notarization ticket did not validate (missing, or Apple unreachable)"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg" || fail "Gatekeeper rejects the DMG"
    spctl --assess --type execute --verbose=2 "$app" || fail "Gatekeeper rejects the app"
  fi

  cleanup
  echo "OK: $dmg"
done
