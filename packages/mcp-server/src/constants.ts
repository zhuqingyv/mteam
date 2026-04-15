// 可配置常量

/** 持锁超时阈值（分钟），stuck_scan 默认值 */
export const DEFAULT_STUCK_TIMEOUT_MINUTES = 120;

/** 有权执行特权操作的角色/名字 */
export const LEADER_ROLES: readonly string[] = ["郭总", "老锤", "刺猬"];

/** 经验相似度检查：取前 N 个字符做子串匹配 */
export const SIMILARITY_PREFIX_LEN = 30;
