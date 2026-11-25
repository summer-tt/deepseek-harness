# Invoked only through /bin/bash with a fixture-only environment.
set -eu
[[ $# == 1 ]] || exit 64
case "$1" in
  term|kill) ;;
  active) printf 'LoadState=loaded\nActiveState=active\nTasksCurrent=1\n' ;;
  inactive) printf 'LoadState=loaded\nActiveState=inactive\nTasksCurrent=[not set]\n' ;;
  slow-active|slow-inactive)
    # execFile leaves stdin open. Bash's read timeout adds delay without another executable.
    if IFS= read -r -t 1.2 ignored; then exit 65; else status=$?; fi
    [[ $status == 142 ]] || exit 65
    if [[ $1 == slow-active ]]; then
      printf 'LoadState=loaded\nActiveState=active\nTasksCurrent=1\n'
    else
      printf 'LoadState=loaded\nActiveState=inactive\nTasksCurrent=[not set]\n'
    fi
    ;;
  *) exit 64 ;;
esac
