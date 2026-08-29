#!/usr/bin/env bash

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
HELPER="$SCRIPT_DIR/paperclip-image-reference.sh"
REPOSITORY_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$REPOSITORY_ROOT/.github/workflows/publish-production-image.yml"
ACTIONLINT_IMAGE='rhysd/actionlint@sha256:a0383f60d92601e2694e24b24d37df7b6a40bed7cedbc447611c50009bf02d94'
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

test_workflow_contract() {
  [ -f "$WORKFLOW" ] || fail 'publish-production-image workflow is absent'

  ruby -r yaml -r json - "$WORKFLOW" "$REPOSITORY_ROOT/package.json" "$REPOSITORY_ROOT/.github/workflows/pr.yml" <<'RUBY'
workflow_path = ARGV.fetch(0)
package_path = ARGV.fetch(1)
pr_workflow_path = ARGV.fetch(2)
workflow = YAML.safe_load(File.read(workflow_path), aliases: false)

def fail_contract(message)
  warn "FAIL: #{message}"
  exit 1
end

def expect(value, message)
  fail_contract(message) unless value
end

def step(steps, id)
  result = steps.find { |candidate| candidate['id'] == id }
  expect(!result.nil?, "missing #{id} step")
  result
end

events = workflow['on'] || workflow[true]
expect(events.keys == ['workflow_dispatch'], 'workflow must have only manual dispatch')
input = events.dig('workflow_dispatch', 'inputs', 'source_commit')
expect(input.is_a?(Hash), 'manual source_commit input is missing')
expect(input.keys.sort == %w[description required type], 'source_commit input must not have a mutable default')
expect(input['description'] == 'Full lowercase 40-character commit reachable from origin/master', 'source_commit input description is incorrect')
expect(input['required'] == true, 'source_commit input must be required')
expect(input['type'] == 'string', 'source_commit input must be a string')

expect(workflow['permissions'] == { 'contents' => 'read', 'packages' => 'write' }, 'permissions must be contents: read and packages: write only')
concurrency = workflow['concurrency']
expect(concurrency.is_a?(Hash), 'workflow concurrency is missing')
expect(concurrency['group'] == 'publish-production-image-${{ inputs.source_commit }}', 'concurrency group must isolate the exact source commit')
expect(concurrency['cancel-in-progress'] == false, 'concurrency must not cancel an in-flight publication')

jobs = workflow['jobs']
expect(jobs.keys == ['publish'], 'workflow must contain only the publication job')
job = jobs.fetch('publish')
expect(job['if'] == "github.repository == 'voipexpert/paperclip'", 'publication must run only in the authoritative repository')
expect(job['permissions'].nil?, 'publication job must not broaden permissions')
steps = job.fetch('steps')

expected_actions = {
  'actions/checkout' => '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'docker/setup-buildx-action' => '37fe631027851001ddb9b187196cc803df7f5f0e',
  'docker/login-action' => 'dbcb813823bdd20940b903addbd779551569679f',
  'docker/build-push-action' => '53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
  'actions/upload-artifact' => '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'
}

uses = steps.map { |candidate| candidate['uses'] }.compact
expect(uses.length == expected_actions.length, 'workflow must use only the required third-party actions')
expect(uses.all? { |value| value.match?(%r{\A[^@\s]+@[0-9a-f]{40}\z}) }, 'every third-party action must be pinned to a full SHA')
expected_actions.each do |action, sha|
  expect(uses.include?("#{action}@#{sha}"), "missing pinned #{action} action")
end

checkout = step(steps, 'checkout')
expect(checkout.dig('with', 'ref') == 'master', 'initial checkout must use trusted master')
expect(checkout.dig('with', 'fetch-depth') == 0, 'checkout must fetch full history')
expect(checkout.dig('with', 'persist-credentials') == false, 'checkout must not persist credentials into the selected source')

source = step(steps, 'source')
source_run = source.fetch('run')
expect(source.dig('env', 'SOURCE_COMMIT') == '${{ inputs.source_commit }}', 'source input must be isolated in the validation step environment')
[
  'scripts/paperclip-image-reference.sh "$SOURCE_COMMIT"',
  'install -m 0755 scripts/paperclip-image-reference.sh "$RUNNER_TEMP/paperclip-image-reference.sh"',
  'git fetch --no-tags origin +refs/heads/master:refs/remotes/origin/master',
  'git cat-file -e "${SOURCE_COMMIT}^{commit}"',
  'git merge-base --is-ancestor "$SOURCE_COMMIT" origin/master',
  'git checkout --detach "$SOURCE_COMMIT"',
  '[ "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" ]'
].each { |required| expect(source_run.include?(required), "source validation must include #{required}") }
expect(source_run.include?('tag=') && source_run.include?('$GITHUB_OUTPUT'), 'validated immutable tag must be exported for the build')
expect(source_run.include?('commit=') && source_run.include?('$GITHUB_OUTPUT'), 'validated commit must be exported for the build')
expect(source_run.include?('helper=') && source_run.include?('$GITHUB_OUTPUT'), 'trusted formatter path must survive the detached checkout')

login = step(steps, 'login')
expect(login.dig('with', 'registry') == 'ghcr.io', 'login must target GHCR')
expect(login.dig('with', 'username') == '${{ github.actor }}', 'login must use the GitHub actor')
expect(login.dig('with', 'password') == '${{ secrets.GITHUB_TOKEN }}', 'login must use the ephemeral GitHub token')

buildx = step(steps, 'buildx')
expect(buildx['uses'] == "docker/setup-buildx-action@#{expected_actions['docker/setup-buildx-action']}", 'buildx setup must use the pinned action')

build = step(steps, 'build')
expect(build['uses'] == "docker/build-push-action@#{expected_actions['docker/build-push-action']}", 'build must use the pinned build-push action')
build_with = build.fetch('with')
expect(build_with['context'] == '.', 'build context must be the repository root')
expect(build_with['file'] == './Dockerfile', 'build must use the production Dockerfile')
expect(build_with['target'] == 'production', 'build target must be production')
expect(build_with['build-args'].include?('PAPERCLIP_BUILD_COMMIT=${{ steps.source.outputs.commit }}'), 'build must stamp the validated selected commit')
expect(build_with['tags'] == '${{ steps.source.outputs.tag }}', 'build must publish only the validated immutable tag')
expect(build_with['push'] == true, 'build must push the immutable image')
expected_revision_label = 'org.opencontainers.image.revision=${{ steps.source.outputs.commit }}'
expect(build_with['labels'] == expected_revision_label, 'build must set exactly the validated OCI revision label')
expect(!build_with['labels'].include?('inputs.source_commit'), 'OCI revision label must not use the raw unchecked workflow input')
expect(!build_with.to_s.include?('latest'), 'build must not publish a latest tag')

attestation = step(steps, 'attestation')
attestation_run = attestation.fetch('run')
expect(attestation.dig('env', 'IMAGE_REFERENCE_HELPER') == '${{ steps.source.outputs.helper }}', 'attestation must use the trusted formatter saved before checkout')
expect(attestation_run.include?('"$IMAGE_REFERENCE_HELPER" "$SOURCE_COMMIT" "$DIGEST"'), 'returned digest must be validated by the approved formatter')
expect(attestation.dig('env', 'ATTESTATION') == '${{ runner.temp }}/paperclip-image-attestation.json', 'attestation file is missing')
expect(attestation_run.include?(%q{JSON.parse(File.read(ENV.fetch('ATTESTATION')))}), 'attestation must be schema-validated before upload')
expect(attestation_run.include?(%q{['commit', 'tag', 'digest', 'repository', 'built_at']}), 'attestation must contain exactly five bounded fields')
expect(attestation_run.include?('$GITHUB_STEP_SUMMARY'), 'digest-pinned coordinates must be written to the job summary')
expect(!attestation_run.include?('GITHUB_TOKEN'), 'attestation and summary must not include credentials')

upload = step(steps, 'upload-attestation')
expect(upload.dig('with', 'name') == 'paperclip-image-attestation', 'attestation artifact name is incorrect')
expect(upload.dig('with', 'path') == '${{ runner.temp }}/paperclip-image-attestation.json', 'attestation artifact path is incorrect')
expect(upload.dig('with', 'retention-days') == 14, 'attestation artifact retention must be bounded to 14 days')

package = JSON.parse(File.read(package_path))
expect(package.dig('scripts', 'test:image-workflow') == 'bash scripts/paperclip-image-reference.test.sh', 'package image workflow contract script is missing')

pr_workflow = YAML.safe_load(File.read(pr_workflow_path), aliases: false)
pr_events = pr_workflow['on'] || pr_workflow[true]
expect(pr_events.key?('pull_request'), 'PR workflow must retain its pull_request trigger')
expect(!pr_events.key?('pull_request_target'), 'PR workflow must not use pull_request_target')
policy_steps = pr_workflow.dig('jobs', 'policy', 'steps')
expect(policy_steps.any? { |candidate| candidate['run'] == 'pnpm test:image-workflow' }, 'safe PR policy job must run the image workflow contract')
RUBY
}

test_workflow_contract

if docker info >/dev/null 2>&1; then
  docker run --rm \
    -v "$REPOSITORY_ROOT:/repo:ro" \
    -w /repo \
    "$ACTIONLINT_IMAGE" \
    -color \
    .github/workflows/publish-production-image.yml
else
  printf 'actionlint skipped: Docker unavailable\n'
fi

printf 'paperclip image reference tests passed\n'
