#!/bin/sh

invalid() {
  printf '%s\n' 'error: invalid image reference' >&2
  exit 1
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || invalid

commit=$1
if ! printf '%s\n' "$commit" | LC_ALL=C grep -E '^[0-9a-f]{40}$' >/dev/null 2>&1; then
  invalid
fi

if [ "$#" -eq 2 ]; then
  digest=$2
  if ! printf '%s\n' "$digest" | LC_ALL=C grep -E '^sha256:[0-9a-f]{64}$' >/dev/null 2>&1; then
    invalid
  fi
fi

printf 'tag=ghcr.io/voipexpert/paperclip:sha-%s\n' "$commit"

if [ "$#" -eq 2 ]; then
  printf 'image=ghcr.io/voipexpert/paperclip@%s\n' "$digest"
fi
