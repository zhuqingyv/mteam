// 通知代理模式入口。走 notification-store 的 get/upsert，单用户固定 'default'。
// 仅注册 mode 单字段；rules（custom 规则数组）本期不单独注册，变更 mode 时保留已有 rules。

import type { SettingEntry } from '../types.js';
import { createNotificationStore } from '../../notification/notification-store.js';
import { isProxyMode } from '../../notification/types.js';

const DEFAULT_USER_ID: string | null = null;

function readConfig() {
  return createNotificationStore().get(DEFAULT_USER_ID);
}

export const notificationEntries: SettingEntry[] = [
  {
    key: 'notification.mode',
    label: '通知代理模式',
    description: 'proxy_all=全部代理给主Agent；direct=直推前端；custom=按自定义规则路由',
    category: 'notification',
    schema: { type: 'string', enum: ['proxy_all', 'direct', 'custom'] },
    readonly: false,
    notify: 'primary',
    keywords: ['通知', 'notification', 'proxy', '代理'],
    getter: () => readConfig().mode,
    setter: (value: unknown) => {
      if (!isProxyMode(value)) {
        throw new Error(`invalid notification mode: ${String(value)}`);
      }
      const current = readConfig();
      createNotificationStore().upsert({
        ...current,
        mode: value,
        updatedAt: new Date().toISOString(),
      });
    },
  },
];
