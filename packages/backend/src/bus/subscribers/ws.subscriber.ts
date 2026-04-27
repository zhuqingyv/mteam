// W2-5：旧 WsBroadcaster class 已删除（全量广播 → 按订阅过滤 + 可见性过滤由
// ws/ws-broadcaster.ts 的新 class 接管，接线点在 http/server.ts:65）。
// 本文件保留为 WS_EVENT_TYPES 的 re-export，仅用于 W2-H 守门测试等历史路径
// 继续 import './ws.subscriber.js'。新代码请直接从 ws/event-types.ts 导入。
export { WS_EVENT_TYPES } from '../../ws/event-types.js';
