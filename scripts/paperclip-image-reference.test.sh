#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HELPER="$SCRIPT_DIR/paperclip-image-reference.sh"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_file_equals() {
  actual_file="$1"
  expected="$2"
  expected_file="$TEMP_DIR/expected"

  if [ -n "$expected" ]; then
    printf '%s\n' "$expected" >"$expected_file"
  else
    : >"$expected_file"
  fi

  cmp -s "$expected_file" "$actual_file" || fail "unexpected output for $3"
}

assert_case() {
  name="$1"
  expected_status="$2"
  expected_stdout="$3"
  expected_stderr="$4"
  shift 4

  stdout_file="$TEMP_DIR/$name.stdout"
  stderr_file="$TEMP_DIR/$name.stderr"

  set +e
  sh "$HELPER" "$@" >"$stdout_file" 2>"$stderr_file"
  status=$?
  set -e

  [ "$status" -eq "$expected_status" ] || fail "unexpected status for $name: $status"
  assert_file_equals "$stdout_file" "$expected_stdout" "$name stdout"
  assert_file_equals "$stderr_file" "$expected_stderr" "$name stderr"
}

commit='0123456789abcdef0123456789abcdef01234567'
digest='sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
tag="ghcr.io/voipexpert/paperclip:sha-$commit"
image="ghcr.io/voipexpert/paperclip@$digest"
error='error: invalid image reference'

assert_case valid_commit 0 "tag=$tag" '' "$commit"
assert_case valid_digest 0 "tag=$tag
image=$image" '' "$commit" "$digest"
assert_case missing_commit 1 '' "$error"
assert_case uppercase_commit 1 '' "$error" '0123456789ABCDEF0123456789abcdef01234567'
assert_case nonhex_commit 1 '' "$error" '0123456789abcdef0123456789abcdef0123456g'
assert_case short_commit 1 '' "$error" '0123456789abcdef0123456789abcdef0123456'
assert_case newline_commit_payload 1 '' "$error" "$commit"$'\n'payload
assert_case control_commit_payload 1 '' "$error" "$commit"$'\001payload'
assert_case uppercase_digest 1 '' "$error" "$commit" 'sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef'
assert_case wrong_digest_algorithm 1 '' "$error" "$commit" 'sha512:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
assert_case short_digest 1 '' "$error" "$commit" 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde'
assert_case newline_digest_payload 1 '' "$error" "$commit" "$digest"$'\n'payload
assert_case control_digest_payload 1 '' "$error" "$commit" "$digest"$'\001payload'
assert_case extra_argument 1 '' "$error" "$commit" "$digest" extra

printf 'paperclip image reference tests passed\n'
