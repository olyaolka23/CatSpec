/**
 * What the MCP server needs from the rest of CatSpec besides `@catspec/core`: the language
 * adapters, which the frontend injects into the engine (ADR-003), and the git side of `sync` and
 * `refactor`. `@catspec/cli` provides the implementation (`cliEngine`) when it starts `catspec mcp`.
 */
import type {
  CatspecConfig,
  Codebase,
  Diagnostic,
  DependencyGraph,
  RenameMap,
  SpecModel,
} from "@catspec/core";

export interface Engine {
  /**
   * The facts of the repository's source files in the working tree. The adapters stay loaded
   * between calls (the warm engine), facts are cached by blob SHA.
   */
  loadCodebase(root: string, config: CatspecConfig): Promise<Codebase>;
  /**
   * The commit being made, all read from the git index like `catspec check --staged`: the config
   * (the staged version of `configFile`, when it is staged), the specs and the code.
   */
  loadStaged(
    root: string,
    config: CatspecConfig,
    configFile: string | undefined,
  ): Promise<{ config: CatspecConfig; model: SpecModel; codebase: Codebase }>;
  /** A unified diff of one spec file, `""` when nothing changed. */
  formatDiff(file: string, before: string, after: string): string;
  /** The dependency graph as a mermaid flowchart. */
  formatGraph(graph: DependencyGraph): string;
  /** Starts a large refactor (plan §D11.8): a baseline of every binding in the scope. */
  startRefactor(
    root: string,
    config: CatspecConfig,
    options: { scope?: string[]; reason?: string },
  ): Promise<RefactorStarted>;
  /** Maps renamed and moved bindings and, with `apply`, writes the location edits (`catspec sync`). */
  syncSpecs(
    root: string,
    config: CatspecConfig,
    options: { map?: RenameMap; apply: boolean; partial?: boolean },
  ): Promise<SyncOutcome>;
  /** Releases what the engine holds open (git processes). */
  close(): Promise<void>;
}

export interface RefactorStarted {
  branch?: string;
  revision: string;
  scope: string[];
  /** Bindings recorded in the baseline. */
  bindings: number;
  /** Specs those bindings belong to. */
  specs: number;
}

export interface SyncOutcome {
  /** The `catspec sync --format json` report. */
  report: Record<string, unknown> & { diagnostics: Diagnostic[] };
  /** The `catspec sync` text report. */
  text: string;
  /** Ambiguous or lost bindings (CS0216, CS0217): nothing is written without `partial`. */
  problems: number;
}
