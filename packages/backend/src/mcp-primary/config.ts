export interface PrimaryMcpEnv {
  instanceId: string;
  hubUrl: string;
}

export function readEnv(): PrimaryMcpEnv {
  const instanceId = process.env.ROLE_INSTANCE_ID ?? '';
  if (!instanceId) {
    throw new Error('ROLE_INSTANCE_ID env is required');
  }
  const port = process.env.V2_PORT ?? '58580';
  const hubUrl =
    process.env.V2_SERVER_URL ??
    process.env.TEAM_HUB_URL ??
    `http://localhost:${port}`;
  return { instanceId, hubUrl };
}
