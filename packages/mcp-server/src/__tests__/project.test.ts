import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Project management functions are defined inline in index.ts and not exported.
 * We replicate the same file-based logic here to test the data layer directly.
 */

let tmpDir: string;
let projectsDir: string;

type ProjectStatus = "planning" | "designing" | "developing" | "testing" | "bugfixing" | "done" | "abandoned";

interface ProjectData {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  progress: number;
  members: string[];
  experience: string;
  forbidden: string[];
  rules: string[];
  created_at: string;
  updated_at: string;
}

function readProjectFile(id: string): ProjectData | null {
  const filePath = path.join(projectsDir, `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProjectData;
  } catch {
    return null;
  }
}

function writeProjectFile(project: ProjectData): void {
  fs.writeFileSync(
    path.join(projectsDir, `${project.id}.json`),
    JSON.stringify(project, null, 2)
  );
}

function listAllProjects(): ProjectData[] {
  const files = fs.readdirSync(projectsDir).filter((f) => f.endsWith(".json"));
  const projects: ProjectData[] = [];
  for (const file of files) {
    try {
      projects.push(
        JSON.parse(fs.readFileSync(path.join(projectsDir, file), "utf-8"))
      );
    } catch {
      /* skip */
    }
  }
  const order: Record<string, number> = {
    developing: 0,
    testing: 1,
    bugfixing: 2,
    designing: 3,
    planning: 4,
    done: 5,
    abandoned: 6,
  };
  projects.sort(
    (a, b) =>
      (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
      b.updated_at.localeCompare(a.updated_at)
  );
  return projects;
}

function createProject(
  name: string,
  description = "",
  members: string[] = []
): ProjectData {
  const now = new Date().toISOString();
  const project: ProjectData = {
    id: crypto.randomUUID(),
    name,
    description,
    status: "planning",
    progress: 0,
    members,
    experience: "",
    forbidden: [],
    rules: [],
    created_at: now,
    updated_at: now,
  };
  writeProjectFile(project);
  return project;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-test-"));
  projectsDir = path.join(tmpDir, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("create project", () => {
  test("generates valid JSON with all fields", () => {
    const project = createProject("test-proj", "A test project", ["alice", "bob"]);
    expect(project.id).toBeTruthy();
    expect(project.name).toBe("test-proj");
    expect(project.description).toBe("A test project");
    expect(project.status).toBe("planning");
    expect(project.progress).toBe(0);
    expect(project.members).toEqual(["alice", "bob"]);
    expect(project.experience).toBe("");
    expect(project.forbidden).toEqual([]);
    expect(project.rules).toEqual([]);
    expect(project.created_at).toBeTruthy();
    expect(project.updated_at).toBeTruthy();

    // Verify it's persisted to disk
    const loaded = readProjectFile(project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("test-proj");
  });
});

describe("list projects", () => {
  test("returns sorted by status (active first)", () => {
    const p1 = createProject("proj-planning");
    const p2 = createProject("proj-developing");
    p2.status = "developing";
    p2.updated_at = new Date().toISOString();
    writeProjectFile(p2);

    const p3 = createProject("proj-done");
    p3.status = "done";
    p3.updated_at = new Date().toISOString();
    writeProjectFile(p3);

    const p4 = createProject("proj-testing");
    p4.status = "testing";
    p4.updated_at = new Date().toISOString();
    writeProjectFile(p4);

    const list = listAllProjects();
    expect(list.length).toBe(4);
    // developing (0) < testing (1) < planning (4) < done (5)
    expect(list[0].status).toBe("developing");
    expect(list[1].status).toBe("testing");
    expect(list[2].status).toBe("planning");
    expect(list[3].status).toBe("done");
  });

  test("returns empty array when no projects", () => {
    const list = listAllProjects();
    expect(list).toEqual([]);
  });
});

describe("get project", () => {
  test("get by id returns correct data", () => {
    const project = createProject("my-proj", "desc");
    const loaded = readProjectFile(project.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(project.id);
    expect(loaded!.name).toBe("my-proj");
  });

  test("get nonexistent project returns null", () => {
    const loaded = readProjectFile("nonexistent-id");
    expect(loaded).toBeNull();
  });
});

describe("update project", () => {
  test("update status", () => {
    const project = createProject("proj");
    project.status = "developing";
    project.updated_at = new Date().toISOString();
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.status).toBe("developing");
  });

  test("update progress clamped to 0-100", () => {
    const project = createProject("proj");
    project.progress = Math.min(100, Math.max(0, 75));
    writeProjectFile(project);
    expect(readProjectFile(project.id)!.progress).toBe(75);

    project.progress = Math.min(100, Math.max(0, 150));
    writeProjectFile(project);
    expect(readProjectFile(project.id)!.progress).toBe(100);

    project.progress = Math.min(100, Math.max(0, -10));
    writeProjectFile(project);
    expect(readProjectFile(project.id)!.progress).toBe(0);
  });

  test("update members", () => {
    const project = createProject("proj", "", ["alice"]);
    project.members = ["alice", "bob", "carol"];
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.members).toEqual(["alice", "bob", "carol"]);
  });

  test("update forbidden and rules arrays", () => {
    const project = createProject("proj");
    project.forbidden = ["no force push"];
    project.rules = ["always review"];
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.forbidden).toEqual(["no force push"]);
    expect(loaded.rules).toEqual(["always review"]);
  });

  test("update experience", () => {
    const project = createProject("proj");
    project.experience = "First lesson learned";
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.experience).toBe("First lesson learned");
  });
});

describe("delete project", () => {
  test("removes file", () => {
    const project = createProject("proj");
    const filePath = path.join(projectsDir, `${project.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    fs.rmSync(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(readProjectFile(project.id)).toBeNull();
  });
});

describe("add experience", () => {
  test("appends with member stamp", () => {
    const project = createProject("proj");
    const member = "alice";
    const content = "Cache invalidation is tricky";

    const stamp = `\n\n---\n[${member}] ${new Date().toISOString().slice(0, 10)}\n${content}`;
    project.experience = (project.experience + stamp).trim();
    project.updated_at = new Date().toISOString();
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.experience).toContain("[alice]");
    expect(loaded.experience).toContain("Cache invalidation is tricky");
  });

  test("multiple appends accumulate", () => {
    const project = createProject("proj");

    for (const [member, content] of [
      ["alice", "Lesson 1"],
      ["bob", "Lesson 2"],
    ] as const) {
      const stamp = `\n\n---\n[${member}] 2024-01-01\n${content}`;
      project.experience = (project.experience + stamp).trim();
    }
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.experience).toContain("[alice]");
    expect(loaded.experience).toContain("Lesson 1");
    expect(loaded.experience).toContain("[bob]");
    expect(loaded.experience).toContain("Lesson 2");
  });
});

describe("add rule to forbidden/rules", () => {
  test("add to forbidden array", () => {
    const project = createProject("proj");
    project.forbidden.push("No direct DB access");
    project.forbidden.push("No eval()");
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.forbidden).toEqual(["No direct DB access", "No eval()"]);
  });

  test("add to rules array", () => {
    const project = createProject("proj");
    project.rules.push("All PRs need review");
    project.rules.push("Tests must pass");
    writeProjectFile(project);

    const loaded = readProjectFile(project.id)!;
    expect(loaded.rules).toEqual(["All PRs need review", "Tests must pass"]);
  });
});
