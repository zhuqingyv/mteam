export interface MteamEnv {
  instanceId: string;
  hubUrl: string;
  commSock: string;
}

export function readEnv(): MteamEnv {
  const instanceId = process.env.ROLE_INSTANCE_ID ?? '';
  if (!instanceId) {
    throw new Error('ROLE_INSTANCE_ID env is required');
  }
  const port = process.env.V2_PORT ?? '58580';
  const hubUrl =
    process.env.V2_SERVER_URL ??
    process.env.TEAM_HUB_URL ??
    `http://localhost:${port}`;
  const commSock = process.env.TEAM_HUB_COMM_SOCK ?? '';
  return { instanceId, hubUrl, commSock };
}
