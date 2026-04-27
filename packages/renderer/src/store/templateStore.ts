import { create } from 'zustand';
import type { RoleTemplate } from '../api/templates';

interface TemplateState {
  templates: RoleTemplate[];
  setTemplates: (list: RoleTemplate[]) => void;
  addTemplate: (tpl: RoleTemplate) => void;
  updateTemplate: (name: string, patch: Partial<RoleTemplate>) => void;
  removeTemplate: (name: string) => void;
}

export const useTemplateStore = create<TemplateState>()((set) => ({
  templates: [],
  setTemplates: (list) => set({ templates: list }),
  addTemplate: (tpl) => set((s) => {
    if (s.templates.some((t) => t.name === tpl.name)) {
      return { templates: s.templates.map((t) => (t.name === tpl.name ? tpl : t)) };
    }
    return { templates: [...s.templates, tpl] };
  }),
  updateTemplate: (name, patch) => set((s) => ({
    templates: s.templates.map((t) => (t.name === name ? { ...t, ...patch } : t)),
  })),
  removeTemplate: (name) => set((s) => ({
    templates: s.templates.filter((t) => t.name !== name),
  })),
}));

export const selectTemplates = (s: TemplateState) => s.templates;
