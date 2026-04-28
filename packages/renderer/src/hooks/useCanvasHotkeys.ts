import { useEffect } from 'react';

// 纯导出给单测调用：判断 keydown 目标是否在可输入元素上。
// 输入框 / contentEditable 聚焦时不接管快捷键，避免抢用户的按键。
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target as HTMLElement).tagName) return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

// 只处理无修饰键的 Esc / f / 0；ctrl/cmd/alt/shift 组合不拦截。
export function matchHotkey(e: KeyboardEvent): 'escape' | 'fit' | 'reset' | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.key === 'Escape') return 'escape';
  if (e.key === 'f' || e.key === 'F') return 'fit';
  if (e.key === '0') return 'reset';
  return null;
}

export interface CanvasHotkeyHandlers {
  onEscape?: () => void;
  onFit?: () => void;
  onResetZoom?: () => void;
}

/**
 * S5-M4 画布全局快捷键。
 * Esc → onEscape（关展开节点栈）
 * f   → onFit
 * 0   → onResetZoom
 * 输入框聚焦时全部放行给原生处理。
 */
export function useCanvasHotkeys(handlers: CanvasHotkeyHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const hit = matchHotkey(e);
      if (!hit) return;
      if (hit === 'escape' && handlers.onEscape) {
        e.preventDefault();
        handlers.onEscape();
      } else if (hit === 'fit' && handlers.onFit) {
        e.preventDefault();
        handlers.onFit();
      } else if (hit === 'reset' && handlers.onResetZoom) {
        e.preventDefault();
        handlers.onResetZoom();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers.onEscape, handlers.onFit, handlers.onResetZoom]);
}
