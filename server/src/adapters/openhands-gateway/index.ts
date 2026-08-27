export const type = "openhands_gateway";
export const label = "OpenHands Gateway";
export const models: { id: string; label: string }[] = [];
export const agentConfigurationDoc = `# OpenHands Gateway

Configure url, timeoutSec, and projectTargets. The gateway bearer token is read only from the root-owned mode-0640 regular file named by OPENHANDS_GATEWAY_TOKEN_FILE. Paperclip must run as exact nonroot UID/GID 1000:1000, and the credential's positive, non-primary GID must be present as a supplemental group. The token is not adapter configuration. Each project target maps repository, baseRef, and the fixed openhands profile.`;
