# Invoked only through /bin/bash with a fixture-only environment.
set -eu
case "$1" in
  active|inactive) ;;
  *) exit 64 ;;
esac
case "$2" in
  fast) ;;
  held) IFS= read -r -t 3 release && [[ "$release" == release ]] || exit 65 ;;
  *) exit 64 ;;
esac
printf 'LoadState=loaded\nActiveState=%s\nTasksCurrent=[not set]\n' "$1"
