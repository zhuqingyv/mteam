import { getDb } from '../db/connection.js';

export interface McpToolVisibility {
  name: string;
  surface: string[] | '*';
  search: string[] | '*';
}

export type TemplateMcpConfig = McpToolVisibility[];

export interface RoleTemplateProps {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  availableMcps: TemplateMcpConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleTemplateInput {
  name: string;
  role: string;
  description?: string | null;
  persona?: string | null;
  availableMcps?: TemplateMcpConfig;
}

export interface UpdateRoleTemplateInput {
  role?: string;
  description?: string | null;
  persona?: string | null;
  availableMcps?: TemplateMcpConfig;
}

interface Row {
  name: string;
  role: string;
  description: string | null;
  persona: string | null;
  available_mcps: string;
  created_at: string;
  updated_at: string;
}

export class RoleTemplate {
  readonly name: string;
  role: string;
  description: string | null;
  persona: string | null;
  availableMcps: TemplateMcpConfig;
  readonly createdAt: string;
  updatedAt: string;

  private constructor(props: RoleTemplateProps) {
    this.name = props.name;
    this.role = props.role;
    this.description = props.description;
    this.persona = props.persona;
    this.availableMcps = props.availableMcps;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  private static fromRow(row: Row): RoleTemplate {
    return new RoleTemplate({
      name: row.name,
      role: row.role,
      description: row.description,
      persona: row.persona,
      availableMcps: JSON.parse(row.available_mcps) as TemplateMcpConfig,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  static create(input: CreateRoleTemplateInput): RoleTemplate {
    const db = getDb();
    const now = new Date().toISOString();
    const mcps = input.availableMcps ?? [];
    db.prepare(
      `INSERT INTO role_templates
         (name, role, description, persona, available_mcps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.name,
      input.role,
      input.description ?? null,
      input.persona ?? null,
      JSON.stringify(mcps),
      now,
      now,
    );
    return new RoleTemplate({
      name: input.name,
      role: input.role,
      description: input.description ?? null,
      persona: input.persona ?? null,
      availableMcps: mcps,
      createdAt: now,
      updatedAt: now,
    });
  }

  static findByName(name: string): RoleTemplate | null {
    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM role_templates WHERE name = ?`)
      .get(name) as Row | undefined;
    return row ? RoleTemplate.fromRow(row) : null;
  }

  static listAll(): RoleTemplate[] {
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM role_templates ORDER BY created_at ASC`)
      .all() as Row[];
    return rows.map((r) => RoleTemplate.fromRow(r));
  }

  static update(name: string, patch: UpdateRoleTemplateInput): RoleTemplate {
    const db = getDb();
    const existing = RoleTemplate.findByName(name);
    if (!existing) {
      throw new Error(`RoleTemplate not found: ${name}`);
    }
    const next: RoleTemplateProps = {
      name: existing.name,
      role: patch.role ?? existing.role,
      description:
        patch.description !== undefined ? patch.description : existing.description,
      persona: patch.persona !== undefined ? patch.persona : existing.persona,
      availableMcps: patch.availableMcps ?? existing.availableMcps,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    db.prepare(
      `UPDATE role_templates
         SET role = ?, description = ?, persona = ?, available_mcps = ?, updated_at = ?
       WHERE name = ?`,
    ).run(
      next.role,
      next.description,
      next.persona,
      JSON.stringify(next.availableMcps),
      next.updatedAt,
      next.name,
    );
    return new RoleTemplate(next);
  }

  static delete(name: string): void {
    const db = getDb();
    db.prepare(`DELETE FROM role_templates WHERE name = ?`).run(name);
  }

  toJSON(): RoleTemplateProps {
    return {
      name: this.name,
      role: this.role,
      description: this.description,
      persona: this.persona,
      availableMcps: [...this.availableMcps],
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
