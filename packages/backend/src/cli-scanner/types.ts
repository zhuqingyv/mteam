// agent CLI 可用性快照结构。name 属于白名单；available=false 时 path/version 必为 null。
export interface CliInfo {
  name: string;
  available: boolean;
  path: string | null;
  version: string | null;
}
