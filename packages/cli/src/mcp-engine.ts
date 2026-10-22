/**
 * `catspec mcp` (plan §D14): the engine the MCP server runs on. The CLI injects its language
 * adapters (ADR-003) and the git side of `sync` and `refactor`. The adapters are loaded once and
 * kept between calls; they are loaded again only when the configured languages change.
 */
import {
  Git,
  IndexProvider,
  loadSpecModel,
  parseConfig,
  relativePosix,
  type CatspecConfig,
  type Codebase,
} from "@catspec/core";
import type { AdapterRegistry } from "@catspec/lang";
import type { Engine } from "@catspec/mcp";

import { loadAdapters, loadCodebase } from "./codebase.js";
import { formatDiff } from "./diff.js";
import { formatGraph } from "./graph.js";
import { PLAIN } from "./report.js";
import { syncJson, syncText } from "./sync-report.js";
import {
  applySync,
  endRefactor,
  planRepositorySync,
  startRefactor,
  SyncUsageError,
  type AppliedSync,
} from "./sync.js";

/** The engine of `catspec mcp`. `env` is the environment git runs with. */
export function cliEngine(env?: NodeJS.ProcessEnv): Engine {
  let adapters: { key: string; registry: Promise<AdapterRegistry> } | undefined;
  const registryFor = (config: CatspecConfig): Promise<AdapterRegistry> => {
    const key = JSON.stringify(config.languages);
    if (adapters?.key !== key) adapters = { key, registry: loadAdapters(config) };
    return adapters.registry;
  };
  // One git per repository for staged reads, kept open until the engine is closed: the codebase
  // reads staged files through it later on. The promise is cached, so calls running at the same
  // time share one; a failed start is forgotten. A cat-file process that dies is restarted by Git.
  const indexGit = new Map<string, Promise<Git>>();
  const stagedGit = (root: string): Promise<Git> => {
    let git = indexGit.get(root);
    if (!git) {
      git = repository(root, "a staged check");
      indexGit.set(root, git);
      git.catch(() => indexGit.delete(root));
    }
    return git;
  };
  const repository = async (root: string, what: string): Promise<Git> => {
    const git = new Git(root, env);
    if (!(await git.isRepository())) {
      await git.close();
      throw new SyncUsageError(`${what} needs a git repository`);
    }
    return git;
  };

  return {
    async loadCodebase(root, config): Promise<Codebase> {
      return loadCodebase(root, config, { registry: await registryFor(config) });
    },

    async loadStaged(root, config, configFile) {
      const index = new IndexProvider(await stagedGit(root));
      if (configFile !== undefined) {
        const path = relativePosix(root, configFile);
        const staged = await index.read(path);
        if (staged !== undefined) config = parseConfig(staged.toString("utf8"), path);
      }
      const [model, registry] = await Promise.all([
        loadSpecModel(root, config, index),
        registryFor(config),
      ]);
      return {
        config,
        model,
        codebase: await loadCodebase(root, config, { registry, source: index }),
      };
    },

    async close() {
      const open = [...indexGit.values()];
      indexGit.clear();
      const gits = await Promise.allSettled(open);
      await Promise.all(gits.flatMap((g) => (g.status === "fulfilled" ? [g.value.close()] : [])));
    },

    formatDiff: (file, before, after) => formatDiff(file, before, after, PLAIN),

    formatGraph: (graph) => formatGraph(graph, "mermaid"),

    async startRefactor(root, config, options) {
      const git = await repository(root, "a refactor");
      try {
        const baseline = await startRefactor(root, config, git, options);
        return {
          ...(baseline.branch !== undefined ? { branch: baseline.branch } : {}),
          revision: baseline.revision,
          scope: baseline.scope,
          bindings: baseline.symbols.length,
          specs: new Set(baseline.symbols.map((s) => s.spec)).size,
        };
      } finally {
        await git.close();
      }
    },

    async syncSpecs(root, config, options) {
      const git = await repository(root, "sync");
      try {
        const run = await planRepositorySync(
          root,
          config,
          git,
          options.map ? { map: options.map } : {},
        );
        const problems = run.plan.diagnostics.filter(
          (d) => d.code === "CS0216" || d.code === "CS0217",
        );
        let applied: AppliedSync | undefined;
        let refused = false;
        let ended = false;
        if (options.apply) {
          if (problems.length > 0 && !options.partial) refused = true;
          else {
            applied = await applySync(root, run, git);
            if (run.refactor && problems.length === 0) ended = await endRefactor(git);
          }
        }
        const outcome = { applied, refused, ended };
        return {
          report: syncJson(run, outcome),
          text: syncText(run, {
            ...outcome,
            apply: options.apply,
            partial: Boolean(options.partial),
            style: PLAIN,
            quiet: false,
            verbose: false,
          }),
          problems: problems.length,
        };
      } finally {
        await git.close();
      }
    },
  };
}
