// Shapes of the analyzer server protocol (docs/analyzer-cli.md, "Server mode").
// Only the fields the extension uses are typed; everything else is passed through untouched.

export type TestFramework = 'xunit' | 'nunit' | 'mstest';

export interface ImpactTest {
  fullyQualifiedName: string;
  className: string;
  methodName: string;
  framework: TestFramework | string;
  parameterized?: boolean;
  project: string;
  projectName: string;
  file?: string;
  line?: number;
  declaredIn?: string;
  reason: string;
  chain: string[];
}

export interface FallbackReason {
  kind: string;
  file?: string;
  message: string;
  testProjects: string[];
}

export interface Fallback {
  reasons: FallbackReason[];
  testProjects: string[];
}

export interface ReportTestProject {
  name: string;
  path: string;
  mode: 'filter' | 'all';
  tests: number;
  frameworks: string[];
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  fullPath: string;
  status: string;
  analysis: 'selective' | 'fallback' | 'ignored' | string;
  note?: string;
}

export interface ChangedSymbol {
  symbol: string;
  kind: string;
  file: string;
  line: number;
  reason: string;
  detail?: string;
}

export interface AnalyzerDiagnostic {
  severity: 'error' | 'warning' | string;
  source: string;
  message: string;
}

export interface ImpactReport {
  schemaVersion: number;
  solution: string;
  repositoryRoot: string;
  durationsMs: Record<string, number>;
  changedFiles: ChangedFile[];
  changedSymbols: ChangedSymbol[];
  fallback: Fallback | null;
  tests: ImpactTest[];
  testProjects: ReportTestProject[];
  diagnostics: AnalyzerDiagnostic[];
}

export interface WorkspaceTestProject {
  name: string;
  path: string;
  frameworks: string[];
}

export interface WorkspaceInfo {
  generation: number;
  projects: number;
  documents: number;
  loadMs: number;
  warmUpMs: number;
  testProjects: WorkspaceTestProject[];
}

export interface InitializeResult {
  protocolVersion: number;
  schemaVersion: number;
  tool: { name: string; version: string };
  solution: string;
  repositoryRoot: string | null;
  msbuild: string;
  workspace: WorkspaceInfo;
  options: { maxSymbols: number; timeoutSeconds: number; fallbackGlobs: string[] };
  capabilities: { impactSinceBase: boolean; cancellation: boolean; supersede: boolean };
  diagnostics: AnalyzerDiagnostic[];
}

export interface ReloadResult {
  success: boolean;
  reason?: string;
  durationMs?: number;
  workspace?: WorkspaceInfo;
  pendingFiles?: string[];
  diagnostics?: AnalyzerDiagnostic[];
  error?: string;
}

export interface LogNotification {
  level: 'debug' | 'info' | 'warning' | 'error' | string;
  message: string;
  id?: number | string;
}

export interface ProgressNotification {
  id?: number | string;
  method?: string;
  phase: string;
  message?: string;
}

export interface AnalyzerOptions {
  maxSymbols?: number;
  fallbackGlobs?: string[];
}

/** JSON-RPC error codes of the analyzer server. */
export const RpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  workspaceUnavailable: -32001,
  notInitialized: -32002,
  cancelled: -32800,
} as const;
