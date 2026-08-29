#!/bin/sh

invalid() {
  printf '%s\n' 'error: invalid image reference' >&2
  exit 1
}

is_lower_hex_of_length() {
  value=$1
  required_length=$2

  case "$value" in
    ''|*[!0123456789abcdef]*) return 1 ;;
  esac

  [ "$(LC_ALL=C printf '%s' "$value" | wc -c)" -eq "$required_length" ]
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || invalid

commit=$1
if ! is_lower_hex_of_length "$commit" 40; then
  invalid
fi

if [ "$#" -eq 2 ]; then
  digest=$2
  case "$digest" in
    sha256:*) digest_hex=${digest#sha256:} ;;
    *) invalid ;;
  esac

  if ! is_lower_hex_of_length "$digest_hex" 64; then
    invalid
  fi
fi

printf 'tag=ghcr.io/voipexpert/paperclip:sha-%s\n' "$commit"

if [ "$#" -eq 2 ]; then
  printf 'image=ghcr.io/voipexpert/paperclip@%s\n' "$digest"
fi
