# Fork-Internal FirstMate Adapter Design

## Context

The `voipexpert/paperclip` fork includes a working FirstMate gateway adapter as the public workspace package `@paperclipai/adapter-firstmate-gateway`. The upstream release system requires every public workspace dependency of a published package to be enrolled in CI publishing and bootstrapped on npm. The fork cannot create a package in the upstream-owned `@paperclipai` npm scope, and its Docker deployment does not need a separately published FirstMate package.

## Decision

FirstMate will become a server-internal adapter. Its runtime behavior, adapter type, configuration schema, UI registration, and tests remain part of Paperclip, but it will no longer be an independently publishable workspace package.

## Changes

1. Move the FirstMate adapter source and tests from `packages/adapters/firstmate-gateway/src` into a dedicated module under `server/src/adapters/firstmate-gateway`.
2. Change the server adapter registry to import FirstMate through local server paths.
3. Remove `@paperclipai/adapter-firstmate-gateway` from `server/package.json` and regenerate the lockfile through pnpm.
4. Remove the FirstMate entry from `scripts/release-package-manifest.json`.
5. Remove the obsolete FirstMate workspace package directory and any Docker dependency-stage copy that exists only to make that package manifest available.
6. Preserve all adapter identifiers and externally visible behavior. Existing Paperclip company and agent records must require no migration.

## Release and Deployment Behavior

The server build will compile and bundle FirstMate with the rest of the server. CI will no longer query npm for `@paperclipai/adapter-firstmate-gateway`, attempt to publish it, or require `paperclipai` npm organization authority. The fork will continue to pull upstream Paperclip changes through the `upstream` remote while maintaining FirstMate as a fork-owned internal integration.

This change updates the fork source only. It does not restart, rebuild, or redeploy the currently running production container.

## Error Handling and Compatibility

No protocol or runtime error handling changes are planned. The move must preserve the existing adapter exports, gateway connection handling, heartbeat behavior, lifecycle events, and configuration validation. Any import or build failure is a release-blocking verification failure.

## Verification

The implementation will use test-first checks that initially fail while FirstMate remains release-enrolled, then pass after internalization. Verification will include:

- the existing FirstMate adapter unit tests from their new server location;
- server typechecking and affected release-manifest validation tests;
- confirmation that neither the server dependency graph nor release manifest references `@paperclipai/adapter-firstmate-gateway`;
- a repository search proving no obsolete package or Docker-copy references remain;
- the project-required full typecheck, test, and build gates;
- GitHub verification after a fork-local PR is merged; and
- a read-only production health and commit check proving the running checkout was not changed.

## Non-Goals

- Publishing a replacement `@voipexpert` npm package.
- Changing the FirstMate wire protocol or UI behavior.
- Deploying or restarting production.
- Refactoring unrelated Paperclip adapters or release tooling.

