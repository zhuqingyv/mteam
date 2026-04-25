import { create } from 'zustand';

export interface Notification {
  id: string;
  title: string;
  message: string;
  time: string;
  type?: 'info' | 'task' | 'error';
}

interface NotificationState {
  notifications: Notification[];
  acknowledgedIds: string[];
  push: (n: Notification) => void;
  acknowledge: (id: string) => void;
  remove: (id: string) => void;
}

export const useNotificationStore = create<NotificationState>()((set) => ({
  notifications: [],
  acknowledgedIds: [],
  push: (n) => set((s) => ({ notifications: [n, ...s.notifications] })),
  acknowledge: (id) => set((s) => ({ acknowledgedIds: [...s.acknowledgedIds, id] })),
  remove: (id) =>
    set((s) => ({
      notifications: s.notifications.filter((n) => n.id !== id),
      acknowledgedIds: s.acknowledgedIds.filter((x) => x !== id),
    })),
}));

export const selectNotifications = (s: NotificationState) => s.notifications;
export const selectAcknowledgedIds = (s: NotificationState) => s.acknowledgedIds;
export const selectPushNotification = (s: NotificationState) => s.push;
export const selectAcknowledgeNotification = (s: NotificationState) => s.acknowledge;
export const selectRemoveNotification = (s: NotificationState) => s.remove;
