export const type = "openhands_gateway";
export const label = "OpenHands Gateway";
export const models: { id: string; label: string }[] = [];
export const agentConfigurationDoc = `# OpenHands Gateway

Configure url, timeoutSec, and projectTargets. The gateway bearer token is read only from the mode-0600 regular file named by OPENHANDS_GATEWAY_TOKEN_FILE; it is not adapter configuration. Each project target maps repository, baseRef, and the fixed openhands profile.`;
