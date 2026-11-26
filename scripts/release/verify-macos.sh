#!/usr/bin/env bash
# Checks release DMGs and update zips the way a downloading Mac will: the DMG,
# the app inside each and every native binary in the app are signed with the
# expected team's Developer ID Application certificate, the app's signature is
# intact and uses the hardened runtime with a secure timestamp, and the DMG and
# the app carry stapled notarization tickets that Gatekeeper accepts. A zip has
# no signature of its own: the app inside it is what electron-updater installs.
#
#   scripts/release/verify-macos.sh <team-id> <dmg-or-zip>...
#   scripts/release/verify-macos.sh --signed-only <team-id> <dmg-or-zip>...
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
  echo "usage: $0 [--signed-only] <team-id> <dmg-or-zip>..." >&2
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
extracted=""
work="$(mktemp -d)"
cleanup() {
  if [[ -n "$mount" ]]; then
    hdiutil detach -quiet "$mount" 2>/dev/null || hdiutil detach -quiet -force "$mount" 2>/dev/null || true
    rmdir "$mount" 2>/dev/null || true
    mount=""
  fi
  if [[ -n "$extracted" ]]; then
    rm -rf "$extracted"
    extracted=""
  fi
}
trap 'cleanup; rm -rf "$work"' EXIT

shopt -s nullglob dotglob

# The single app at the top of a folder (a mounted DMG, an extracted zip).
only_app() {
  local apps=("$1"/*.app)
  [[ ${#apps[@]} -eq 1 ]] || fail "Expected one app in $2, found ${#apps[@]}"
  [[ -d "${apps[0]}" && ! -L "${apps[0]}" ]] || fail "The app in $2 is not a real bundle: ${apps[0]}"
  printf '%s' "${apps[0]}"
}

# Every check on the app itself; `root` is the folder holding it, for messages.
verify_app() {
  local app="$1" root="$2"
  codesign --verify --deep --strict --verbose=2 -R "$requirement" "$app" || fail "The app is not validly signed with team $team's Developer ID"

  local details flags
  details="$(codesign -dv --verbose=2 "$app" 2>&1)"
  flags="$(sed -n 's/^CodeDirectory .* flags=0x\([0-9a-fA-F]*\).*/\1/p' <<<"$details")"
  [[ -n "$flags" ]] && (((16#$flags & 0x10000) != 0)) || fail "The app is not signed with the hardened runtime"
  grep -q '^Timestamp=.' <<<"$details" || fail "The app's signature has no secure timestamp"

  # Every native binary in the bundle, including the native modules under
  # Resources: every file is classified by its content, whatever its name or
  # mode, and a file that can't be read fails the check rather than being skipped.
  find "$app" -type f -print0 >"$work/files" || fail "Could not list the files in $app"
  xargs -0 file -N -0 -- <"$work/files" >"$work/types" || fail "Could not classify the files in $app"
  local files=0 binaries=0 path kind listed
  # `file -0` prints each name, a NUL, then ": <type>" and a newline.
  while IFS= read -r -d '' path && IFS= read -r kind; do
    files=$((files + 1))
    kind="${kind#: }"
    case "$kind" in
      "cannot open"* | ERROR* | *"read error"*) fail "Could not read ${path#"$root"/}: $kind" ;;
      Mach-O*)
        binaries=$((binaries + 1))
        codesign --verify --strict -R "$requirement" "$path" 2>/dev/null || fail "A binary is not validly signed with team $team's Developer ID: ${path#"$root"/}"
        ;;
    esac
  done <"$work/types"
  listed="$(tr -cd '\0' <"$work/files" | wc -c | tr -d ' ')"
  [[ $files -eq $listed ]] || fail "Classified $files of the $listed files in $app"
  [[ $binaries -gt 0 ]] || fail "Found no native binaries in $app"
  echo "$binaries native binaries signed by $team, of $files files"

  if [[ $notarized -eq 1 ]]; then
    xcrun stapler validate "$app" || fail "The app's notarization ticket did not validate (missing, or Apple unreachable)"
    spctl --assess --type execute --verbose=2 "$app" || fail "Gatekeeper rejects the app"
  fi
}

for file in "$@"; do
  [[ -f "$file" ]] || fail "No such file: $file"
  echo "--- $file"
  case "$file" in
    *.dmg)
      codesign --verify --strict --verbose=2 -R "$requirement" "$file" || fail "The DMG is not validly signed with team $team's Developer ID: $file"
      if [[ $notarized -eq 1 ]]; then
        xcrun stapler validate "$file" || fail "The DMG's notarization ticket did not validate (missing, or Apple unreachable)"
        spctl --assess --type open --context context:primary-signature --verbose=2 "$file" || fail "Gatekeeper rejects the DMG"
      fi
      mount="$(mktemp -d)"
      hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$file" >/dev/null || fail "Could not mount $file"
      app="$(only_app "$mount" "$file")"
      verify_app "$app" "$mount"
      ;;
    *.zip)
      # ditto keeps the bundle's symlinks, extended attributes and stapled
      # ticket the way Squirrel.Mac's own extraction does.
      extracted="$(mktemp -d)"
      ditto -x -k "$file" "$extracted" || fail "Could not extract $file"
      app="$(only_app "$extracted" "$file")"
      verify_app "$app" "$extracted"
      ;;
    *) fail "Not a DMG or a zip: $file" ;;
  esac
  cleanup
  echo "OK: $file"
done
