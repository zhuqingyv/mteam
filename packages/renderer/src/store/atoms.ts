// 面板全局 atoms：tab 切换 + 各模块最后一次 API 响应。
import { atom } from 'jotai';
import type { ApiResult } from '../api/client';

// 当前选中的面板
export type TabKey = 'template' | 'instance' | 'roster' | 'team' | 'mcp-store';
export const currentTabAtom = atom<TabKey>('template');

// 每个面板保留最近一次 API 响应，用于底部 JSON 展示区
export const templateResponseAtom = atom<ApiResult | null>(null);
export const instanceResponseAtom = atom<ApiResult | null>(null);
export const rosterResponseAtom = atom<ApiResult | null>(null);
export const teamResponseAtom = atom<ApiResult | null>(null);
export const mcpStoreResponseAtom = atom<ApiResult | null>(null);
