import * as path from 'path';
import type { ImpactReport, ImpactTest, WorkspaceTestProject } from './analyzerProtocol';
import { pathKey } from './paths';

/** Persistent key/value storage (VS Code `workspaceState` in the extension, a Map in tests). */
export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

export class MemoryStateStore implements StateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
  }

  update(key: string, value: unknown): void {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, JSON.parse(JSON.stringify(value)));
    }
  }
}

/** A test the analyzer selected (or that failed before), as much as the runner needs. */
export interface SelectedTest {
  fullyQualifiedName: string;
  className: string;
  methodName: string;
  framework: string;
  parameterized: boolean;
  project: string;
  projectName: string;
  file?: string;
  line?: number;
  reason: string;
  chain: string[];
}

export function fromImpactTest(test: ImpactTest): SelectedTest {
  return {
    fullyQualifiedName: test.fullyQualifiedName,
    className: test.className,
    methodName: test.methodName,
    framework: test.framework,
    parameterized: test.parameterized ?? false,
    project: test.project,
    projectName: test.projectName,
    file: test.file,
    line: test.line,
    reason: test.reason,
    chain: test.chain ?? [],
  };
}

/** Work for one test project that has not run yet. */
export interface ProjectWork {
  path: string;
  name: string;
  frameworks: string[];
  /** Run every test of the project (fallback or Run All). */
  all: boolean;
  /** Why the project runs completely. */
  reasons: string[];
  tests: SelectedTest[];
}

function projectName(projectPath: string): string {
  return path.basename(projectPath).replace(/\.[^.]+$/, '');
}

/**
 * Selections that still have to run. Every successful impact result is merged here (also one for a
 * request that was superseded); entries leave only after their tests actually ran, so a cancelled
 * build or a failed build keeps them for the next run.
 */
export class PendingWork {
  private readonly projects = new Map<string, { work: ProjectWork; tests: Map<string, SelectedTest> }>();

  get isEmpty(): boolean {
    return this.projects.size === 0;
  }

  private entry(projectPath: string, name?: string, frameworks?: readonly string[]) {
    const key = pathKey(projectPath);
    let entry = this.projects.get(key);
    if (!entry) {
      entry = {
        work: { path: projectPath, name: name ?? projectName(projectPath), frameworks: [...(frameworks ?? [])], all: false, reasons: [], tests: [] },
        tests: new Map(),
      };
      this.projects.set(key, entry);
    }
    for (const framework of frameworks ?? []) {
      if (!entry.work.frameworks.includes(framework)) {
        entry.work.frameworks.push(framework);
      }
    }
    return entry;
  }

  mergeReport(report: ImpactReport): void {
    for (const project of report.testProjects ?? []) {
      const entry = this.entry(project.path, project.name, project.frameworks);
      if (project.mode === 'all') {
        entry.work.all = true;
      }
    }
    for (const reason of report.fallback?.reasons ?? []) {
      for (const projectPath of reason.testProjects ?? []) {
        const entry = this.entry(projectPath);
        entry.work.all = true;
        const text = describeFallback(reason);
        if (!entry.work.reasons.includes(text)) {
          entry.work.reasons.push(text);
        }
      }
    }
    for (const projectPath of report.fallback?.testProjects ?? []) {
      this.entry(projectPath).work.all = true;
    }
    for (const test of report.tests ?? []) {
      const entry = this.entry(test.project, test.projectName, [test.framework]);
      entry.tests.set(test.fullyQualifiedName, fromImpactTest(test));
    }
  }

  /** Every given project runs completely (Run All Tests, or the analyzer failed). */
  addAll(projects: readonly WorkspaceTestProject[], reason: string): void {
    for (const project of projects) {
      const entry = this.entry(project.path, project.name, project.frameworks);
      entry.work.all = true;
      if (!entry.work.reasons.includes(reason)) {
        entry.work.reasons.push(reason);
      }
    }
  }

  snapshot(): ProjectWork[] {
    return [...this.projects.values()]
      .map(({ work, tests }) => ({ ...work, frameworks: [...work.frameworks], reasons: [...work.reasons], tests: [...tests.values()].map((t) => ({ ...t, chain: [...t.chain] })) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Removes what ran: the given tests, and the "all" flag if the project ran completely. */
  removeExecuted(executed: Pick<ProjectWork, 'path' | 'all' | 'tests'>): void {
    const key = pathKey(executed.path);
    const entry = this.projects.get(key);
    if (!entry) {
      return;
    }
    if (executed.all) {
      this.projects.delete(key);
      return;
    }
    for (const test of executed.tests) {
      entry.tests.delete(test.fullyQualifiedName);
    }
    if (!entry.work.all && entry.tests.size === 0) {
      this.projects.delete(key);
    }
  }

  clear(): void {
    this.projects.clear();
  }

  toJSON(): ProjectWork[] {
    return this.snapshot();
  }

  static fromJSON(value: unknown): PendingWork {
    const work = new PendingWork();
    if (!Array.isArray(value)) {
      return work;
    }
    for (const item of value as ProjectWork[]) {
      if (!item || typeof item.path !== 'string') {
        continue;
      }
      const entry = work.entry(item.path, item.name, item.frameworks ?? []);
      entry.work.all = !!item.all;
      entry.work.reasons = Array.isArray(item.reasons) ? [...item.reasons] : [];
      for (const test of item.tests ?? []) {
        if (test && typeof test.fullyQualifiedName === 'string') {
          entry.tests.set(test.fullyQualifiedName, { ...test, chain: Array.isArray(test.chain) ? test.chain : [] });
        }
      }
    }
    return work;
  }
}

export function describeFallback(reason: { kind: string; file?: string; message: string }): string {
  return reason.file ? `[${reason.kind}] ${reason.file}: ${reason.message}` : `[${reason.kind}] ${reason.message}`;
}

/** A test that failed in an earlier run; it is re-run on every run until it passes. */
export interface FailedTest {
  project: string;
  projectName: string;
  fullyQualifiedName: string;
  className: string;
  methodName: string;
  framework?: string;
  parameterized?: boolean;
  file?: string;
  line?: number;
  message?: string;
  stackTrace?: string;
  failedCase?: string;
  cases?: number;
  failedCases?: number;
}

function failedKey(project: string, fullyQualifiedName: string): string {
  return `${pathKey(project)}::${fullyQualifiedName}`;
}

export class FailedTests {
  private readonly tests = new Map<string, FailedTest>();

  get size(): number {
    return this.tests.size;
  }

  all(): FailedTest[] {
    return [...this.tests.values()].sort((a, b) => a.fullyQualifiedName.localeCompare(b.fullyQualifiedName));
  }

  get(project: string, fullyQualifiedName: string): FailedTest | undefined {
    return this.tests.get(failedKey(project, fullyQualifiedName));
  }

  forProject(project: string): FailedTest[] {
    const prefix = `${pathKey(project)}::`;
    return [...this.tests.entries()].filter(([key]) => key.startsWith(prefix)).map(([, test]) => test);
  }

  upsert(test: FailedTest): void {
    this.tests.set(failedKey(test.project, test.fullyQualifiedName), test);
  }

  remove(project: string, fullyQualifiedName: string): boolean {
    return this.tests.delete(failedKey(project, fullyQualifiedName));
  }

  toJSON(): FailedTest[] {
    return this.all();
  }

  static fromJSON(value: unknown): FailedTests {
    const failed = new FailedTests();
    if (Array.isArray(value)) {
      for (const test of value as FailedTest[]) {
        if (test && typeof test.project === 'string' && typeof test.fullyQualifiedName === 'string') {
          failed.upsert(test);
        }
      }
    }
    return failed;
  }
}

export interface PlannedTest extends SelectedTest {
  origin: 'selected' | 'previouslyFailed';
}

export interface ProjectPlan {
  path: string;
  name: string;
  frameworks: string[];
  mode: 'all' | 'filter';
  reasons: string[];
  tests: PlannedTest[];
}

/** Pending selections plus every previously failed test, per test project. */
export function buildPlan(work: readonly ProjectWork[], failed: readonly FailedTest[]): ProjectPlan[] {
  const plans = new Map<string, ProjectPlan>();
  for (const project of work) {
    plans.set(pathKey(project.path), {
      path: project.path,
      name: project.name,
      frameworks: [...project.frameworks],
      mode: project.all ? 'all' : 'filter',
      reasons: [...project.reasons],
      tests: project.tests.map((t) => ({ ...t, origin: 'selected' as const })),
    });
  }
  for (const test of failed) {
    const key = pathKey(test.project);
    let plan = plans.get(key);
    if (!plan) {
      plan = { path: test.project, name: test.projectName, frameworks: [], mode: 'filter', reasons: [], tests: [] };
      plans.set(key, plan);
    }
    if (test.framework && !plan.frameworks.includes(test.framework)) {
      plan.frameworks.push(test.framework);
    }
    if (!plan.tests.some((t) => t.fullyQualifiedName === test.fullyQualifiedName)) {
      plan.tests.push({
        fullyQualifiedName: test.fullyQualifiedName,
        className: test.className,
        methodName: test.methodName,
        framework: test.framework ?? plan.frameworks[0] ?? 'unknown',
        parameterized: test.parameterized ?? false,
        project: test.project,
        projectName: test.projectName,
        file: test.file,
        line: test.line,
        reason: 'previouslyFailed',
        chain: [],
        origin: 'previouslyFailed',
      });
    }
  }
  for (const plan of plans.values()) {
    plan.tests.sort((a, b) => a.fullyQualifiedName.localeCompare(b.fullyQualifiedName));
  }
  // A project with neither a selection nor "run everything" has nothing to run.
  return [...plans.values()].filter((plan) => plan.mode === 'all' || plan.tests.length > 0).sort((a, b) => a.name.localeCompare(b.name));
}
