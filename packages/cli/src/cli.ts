/**
 * The `catspec` command line (plan §D10), PBIs `cli-skeleton`, `status-and-waivers`,
 * `check-command`, `staged-check`, `lock-files`, `drift-and-accept` and `hook-installer`: `init`,
 * `check`, `status`, `coverage`, `list`, `show`, `graph`, `baseline`, `accept`, `install-hooks`
 * and `uninstall-hooks`; F6 (`sync-command`, `bind-command`, `refactor-mode`): `sync`, `bind` and
 * `refactor`.
 *
 * Exit codes: 0 ok or warnings only, 1 errors found, 2 usage or config error, 3 internal error.
 */
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  applyPatch,
  checkCode,
  ConfigError,
  coverage,
  createDiagnostic,
  didYouMean,
  findGitRoot,
  Git,
  GitError,
  GitUnavailableError,
  globMatcher,
  lockPathOf,
  loadConfig,
  loadSpecModel,
  queryDiagnostics,
  runTestCommand,
  sortDiagnostics,
  SPEC_STATUSES,
  SpecEditError,
  statusGate,
  toPosix,
  type Diagnostic,
  type ItemResult,
  type Spec,
  type SpecModel,
  type SpecStatus,
} from "@catspec/core";
import { Argument, Command, CommanderError, Option } from "commander";

import { bindSymbol } from "./bind.js";
import { emptyCodebase, loadCodebase } from "./codebase.js";
import { formatDiff } from "./diff.js";

import { formatGraph, GRAPH_FORMATS, type GraphFormat } from "./graph.js";
import {
  HOOK_MANAGERS,
  HookRefusedError,
  installHooks,
  uninstallHooks,
  type HookManager,
  type HookResult,
} from "./hooks.js";
import { initRepository } from "./init.js";
import { writeLocks } from "./locks.js";
import {
  COLORS,
  EXIT,
  exitCodeFor,
  formatAgentReport,
  formatCoverage,
  formatJson,
  formatText,
  PLAIN,
  type Style,
} from "./report.js";
import { showFacts, UnknownLanguageError } from "./show-facts.js";
import { checkStaged, NotARepositoryError, recordSkip, takeSkip } from "./staged.js";
import {
  applySync,
  endRefactor,
  hookRenames,
  planRepositorySync,
  readRefactor,
  readRenameMap,
  startRefactor,
  SyncUsageError,
  type AppliedSync,
  type SyncRun,
} from "./sync.js";

export interface CliIo {
  /** Folder the command runs in (before `--cwd`). */
  cwd: string;
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
}

/** A usage error: wrong arguments or an unknown spec id (exit code 2). */
export class UsageError extends Error {}

interface GlobalOptions {
  cwd?: string;
  config?: string;
  color: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Runs `catspec` with `argv` (without the node and script paths) and returns the exit code. */
export async function run(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  const out: CliIo = {
    cwd: io.cwd ?? process.cwd(),
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
  };
  let exitCode: number = EXIT.ok;
  let verbose = false;
  // Git runs with this process's environment plus the overrides given in `io.env`.
  const gitEnv = out.env === process.env ? undefined : { ...process.env, ...out.env };

  /** Git for the repository around `--cwd`; a usage error outside a repository. */
  const repositoryGit = async (command: Command, what: string): Promise<Git> => {
    const cwd = workingDirectory(out.cwd, globals(command).cwd);
    const git = new Git(cwd, gitEnv);
    if (!(await git.isRepository())) throw new UsageError(`${what} needs a git repository`);
    return git;
  };

  const program = new Command("catspec")
    .description("Specs bound to code: check that the code keeps the contracts of its specs.")
    .version(version, "-V, --version")
    .option("--cwd <dir>", "run as if catspec was started in <dir>")
    .option("--config <file>", "use this config file instead of finding catspec.yaml")
    .option("--no-color", "print without colors")
    .option("--quiet", "print errors only")
    .option("--verbose", "print more detail")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => out.stdout.write(text),
      writeErr: (text) => out.stderr.write(text),
    })
    .showSuggestionAfterError(true)
    .hook("preAction", (_, action) => {
      verbose = Boolean(globals(action).verbose);
    });

  const formatOption = (choices: readonly string[], fallback: string): Option =>
    new Option("--format <format>", "output format").choices(choices).default(fallback);

  /** Folder, config and specs for a command. */
  const load = async (
    command: Command,
  ): Promise<{ model: SpecModel; style: Style; opts: GlobalOptions }> => {
    const opts = globals(command);
    const cwd = workingDirectory(out.cwd, opts.cwd);
    const { config, root } = await loadConfig(cwd, opts.config);
    const model = await loadSpecModel(root, config);
    return { model, style: styleFor(opts, out), opts };
  };

  program
    .command("init")
    .description(
      "create catspec.yaml, docs/spec/<example-feature>/ and the ADR log docs/architecture/adr/<name>-adr.md",
    )
    .option(
      "--name <name>",
      "name of the ADR log (<name>-adr.md); default: the repository folder name",
    )
    .option("--hooks", "also install the pre-commit hook (see install-hooks)")
    .action(async (options: { name?: string; hooks?: boolean }, command: Command) => {
      const opts = globals(command);
      const cwd = workingDirectory(out.cwd, opts.cwd);
      const root = findGitRoot(cwd) ?? cwd;
      const result = await initRepository(
        root,
        options.name === undefined ? {} : { name: options.name },
      );
      const style = styleFor(opts, out);
      if (!opts.quiet) {
        const lines = [
          ...result.created.map((f) => `${style.green("created")} ${f}`),
          ...result.skipped.map((s) => `${style.yellow("skipped")} ${s.file} (${s.reason})`),
          "",
          "Next: describe a feature in docs/spec/<feature>/ and run `catspec check --specs-only`.",
        ];
        out.stdout.write(`${lines.join("\n")}\n`);
      }
      if (options.hooks) {
        const hook = await installHooks(await repositoryGit(command, "init --hooks"));
        if (!opts.quiet) out.stdout.write(hookReport(hook, style));
      }
    });

  program
    .command("check")
    .description(
      "check the code against the specs: bindings, contracts and rules, by spec status; " +
        "--specs-only checks the spec files only, --spec <id> reports one spec until DONE",
    )
    .argument("[paths...]", "only report diagnostics for these files or folders")
    .option(
      "--specs-only",
      "check spec files only: schema, ids, dependencies, references, queries, layout, ADR ids",
    )
    .option(
      "--spec <id...>",
      "check only these specs as if implemented; prints expected / found / fix and DONE or NOT DONE",
    )
    .option("--run-tests", "run the tests of test rules with tests.command from catspec.yaml")
    .option(
      "--staged",
      "check the commit being made (the pre-commit hook): read the git index, check only the " +
        "specs it touches, then update their lock files",
    )
    .addOption(formatOption(["text", "json"], "text"))
    .action(
      async (
        paths: string[],
        options: {
          specsOnly?: boolean;
          spec?: string[];
          runTests?: boolean;
          staged?: boolean;
          format: "text" | "json";
        },
        command: Command,
      ) => {
        const started = performance.now();
        if (options.staged) {
          if (options.specsOnly || options.spec || options.runTests) {
            throw new UsageError("--staged can't be used with --specs-only, --spec or --run-tests");
          }
          exitCode = await stagedCheck(command, paths, options.format, started);
          return;
        }
        const { model, style, opts } = await load(command);
        for (const id of options.spec ?? []) findSpec(model, id);
        if (options.specsOnly && options.runTests) {
          throw new UsageError("--run-tests can't be used with --specs-only");
        }
        const testCommand = model.config.tests.command;
        if (options.runTests && testCommand === undefined) {
          throw new UsageError("--run-tests needs tests.command in catspec.yaml");
        }

        let diagnostics: Diagnostic[];
        let items: ItemResult[] = [];
        let checked: Spec[];
        if (options.specsOnly) {
          const codebase = await emptyCodebase(model.config);
          const selected = options.spec ? new Set(options.spec) : undefined;
          diagnostics = sortDiagnostics(
            [
              ...model.diagnostics,
              ...queryDiagnostics(model, (lang) => codebase.adapter(lang)),
            ].filter((d) => !selected || (d.spec !== undefined && selected.has(d.spec))),
          );
          checked = model.specs.all().filter((s) => !selected || selected.has(s.id));
        } else {
          const codebase = await loadCodebase(model.root, model.config);
          const result = await checkCode(model, codebase, {
            ...(options.spec ? { specs: options.spec, mode: "full" as const } : {}),
            ...(options.runTests && testCommand !== undefined
              ? { runTest: (symbol: string) => runTestCommand(model.root, testCommand, symbol) }
              : {}),
          });
          diagnostics = result.diagnostics;
          items = result.items;
          checked = options.spec ? result.checked : model.specs.all();
        }
        if (paths.length > 0) {
          const cwd = workingDirectory(out.cwd, opts.cwd);
          diagnostics = diagnostics.filter((d) => inPaths(d, paths, cwd, model.root));
        }

        if (options.format === "json") {
          out.stdout.write(
            formatJson(
              diagnostics,
              checked.length,
              options.spec ? { items, done: exitCodeFor(diagnostics) === EXIT.ok } : {},
            ),
          );
        } else if (options.spec && !options.specsOnly) {
          out.stdout.write(formatAgentReport({ specs: checked, items, diagnostics }, style));
        } else {
          out.stdout.write(
            formatText(diagnostics, {
              style,
              quiet: Boolean(opts.quiet),
              verbose: Boolean(opts.verbose),
              specs: checked.map((s) => ({ id: s.id, file: s.file })),
              durationMs: performance.now() - started,
            }),
          );
        }
        exitCode = exitCodeFor(diagnostics);
      },
    );

  program
    .command("status")
    .description(
      "change a spec's status: ready needs its dependencies to exist, in-progress and " +
        "implemented need them implemented and passing, implemented needs its own contracts to pass",
    )
    .argument("<spec>", "spec id")
    .addArgument(new Argument("<status>", "the new status").choices(SPEC_STATUSES))
    .option("--force", "skip the dependency gate (an implemented spec must still pass)")
    .action(
      async (id: string, target: SpecStatus, options: { force?: boolean }, command: Command) => {
        const { model, style, opts } = await load(command);
        const spec = findSpec(model, id);
        if (!spec.valid) {
          throw new UsageError(`${spec.file} has errors; run \`catspec check --specs-only\``);
        }
        if (spec.status === target) {
          if (!opts.quiet) out.stdout.write(`${spec.id} is already ${target}\n`);
          return;
        }
        const codebase = await loadCodebase(model.root, model.config);
        const gate = await statusGate(
          model,
          codebase,
          spec,
          target,
          options.force ? { force: true } : {},
        );
        if (!gate.allowed) {
          out.stdout.write(formatText(gate.diagnostics, { style }));
          out.stderr.write(`catspec: refused: ${spec.id} stays ${spec.status}\n`);
          exitCode = EXIT.errors;
          return;
        }
        const text = applyPatch(spec.source, [{ op: "set", path: ["status"], value: target }]);
        await writeFile(join(model.root, spec.file), text, "utf8");
        if (!opts.quiet) out.stdout.write(`${spec.id}: ${spec.status} → ${target}\n`);
      },
    );

  program
    .command("coverage")
    .description(
      "contract satisfaction, enforcement coverage (manual rules and unenforced prose count " +
        "against it) and reverse coverage (source files bound by a spec)",
    )
    .addOption(formatOption(["text", "json"], "text"))
    .action(async (options: { format: "text" | "json" }, command: Command) => {
      const { model, style, opts } = await load(command);
      const codebase = await loadCodebase(model.root, model.config);
      const report = await coverage(model, codebase);
      if (options.format === "json") out.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else out.stdout.write(formatCoverage(report, style));
      warnAboutErrors(model, opts, out);
    });

  program
    .command("list")
    .description("list the specs")
    .addOption(
      new Option("--status <status>", "only specs with this status").choices(SPEC_STATUSES),
    )
    .option("--ready", "only specs that are ready to start: status ready, dependencies implemented")
    .addOption(formatOption(["text", "json"], "text"))
    .action(
      async (
        options: { status?: string; ready?: boolean; format: "text" | "json" },
        command: Command,
      ) => {
        const { model, style, opts } = await load(command);
        const specs = model.specs
          .all()
          .filter((s) => options.status === undefined || s.status === options.status)
          .filter((s) => !options.ready || model.graph.isReady(s.id));
        const rows = specs.map((s) => listRow(s, model));
        if (options.format === "json") {
          out.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        } else {
          out.stdout.write(formatList(rows, style));
        }
        warnAboutErrors(model, opts, out);
      },
    );

  program
    .command("show")
    .description("show one spec: its normalised model, dependencies, tasks and diagnostics")
    .argument("<spec>", "spec id")
    .addOption(formatOption(["text", "json"], "text"))
    .action(async (id: string, options: { format: "text" | "json" }, command: Command) => {
      const { model, style } = await load(command);
      const spec = findSpec(model, id);
      const view = showView(spec, model);
      if (options.format === "json") out.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      else out.stdout.write(formatShow(view, style));
    });

  program
    .command("graph")
    .description("print the dependency graph of the specs")
    .addOption(formatOption(GRAPH_FORMATS, "mermaid"))
    .option("--focus <spec>", "only this spec, its dependencies and its dependents")
    .action(async (options: { format: GraphFormat; focus?: string }, command: Command) => {
      const { model, opts } = await load(command);
      if (options.focus !== undefined) findSpec(model, options.focus);
      out.stdout.write(formatGraph(model.graph, options.format, options.focus));
      warnAboutErrors(model, opts, out);
    });

  program
    .command("baseline")
    .description(
      "regenerate the lock files (<spec-id>.lock.json: what passed, where bindings resolved, " +
        "their shapes) of every in-progress and implemented spec from the current code; this " +
        "drops the ratchet history",
    )
    .option("--rebuild", "regenerate every lock file")
    .action(async (options: { rebuild?: boolean }, command: Command) => {
      if (!options.rebuild) throw new UsageError("use `catspec baseline --rebuild`");
      const { model, style, opts } = await load(command);
      const codebase = await loadCodebase(model.root, model.config);
      const result = await checkCode(model, codebase);
      const written = await writeLocks(model, result, result.checked, { mode: "rebuild" });
      if (!opts.quiet) {
        out.stdout.write(
          written.length > 0
            ? `${written.map((f) => `${style.green("wrote")} ${f}`).join("\n")}\n`
            : "the lock files are up to date\n",
        );
      }
      warnAboutErrors(model, opts, out);
    });

  program
    .command("accept")
    .description(
      "record the current shapes of a spec's bound declarations in its lock file, so an " +
        "intended signature change is no longer reported as drift (CS0300)",
    )
    .argument("<spec>", "spec id")
    .action(async (id: string, _options: unknown, command: Command) => {
      const { model, style, opts } = await load(command);
      const spec = findSpec(model, id);
      if (spec.type === "architecture") {
        throw new UsageError(`${spec.id} is the architecture spec; it has no lock file`);
      }
      if (!spec.valid) {
        throw new UsageError(`${spec.file} has errors; run \`catspec check --specs-only\``);
      }
      const codebase = await loadCodebase(model.root, model.config);
      const result = await checkCode(model, codebase, { specs: [spec.id], mode: "full" });
      const written = await writeLocks(model, result, [spec], { mode: "accept" });
      let staged = false;
      if (written.length > 0 && model.config.hook.stage_generated) {
        const git = new Git(model.root, gitEnv);
        try {
          if (await git.isRepository()) {
            await git.add(written);
            staged = true;
          }
        } catch (error) {
          if (!(error instanceof GitUnavailableError || error instanceof GitError)) throw error;
        } finally {
          await git.close();
        }
      }
      if (!opts.quiet) {
        out.stdout.write(
          written.length > 0
            ? `${style.green("accepted")} the current shapes of ${spec.id}: ${staged ? "wrote and staged" : "wrote"} ${lockPathOf(spec)}\n`
            : `${spec.id}: ${lockPathOf(spec)} already records the current shapes\n`,
        );
      }
    });

  program
    .command("install-hooks")
    .description(
      "install the pre-commit hook that runs `catspec check --staged`: in the git hooks folder " +
        "(core.hooksPath included), or as an entry of husky or lefthook; a hook CatSpec didn't " +
        "write is never overwritten without --force",
    )
    .addOption(
      new Option("--manager <manager>", "where to install the hook")
        .choices(HOOK_MANAGERS)
        .default("auto"),
    )
    .option(
      "--force",
      "keep an existing pre-commit hook as pre-commit.catspec-backup and run it before CatSpec",
    )
    .action(async (options: { manager: HookManager; force?: boolean }, command: Command) => {
      const git = await repositoryGit(command, "install-hooks");
      const result = await installHooks(git, options);
      if (!globals(command).quiet)
        out.stdout.write(hookReport(result, styleFor(globals(command), out)));
    });

  program
    .command("uninstall-hooks")
    .description("remove the pre-commit hook, and restore the hook it replaced")
    .addOption(
      new Option("--manager <manager>", "where the hook is installed")
        .choices(HOOK_MANAGERS)
        .default("auto"),
    )
    .action(async (options: { manager: HookManager }, command: Command) => {
      const git = await repositoryGit(command, "uninstall-hooks");
      const result = await uninstallHooks(git, options);
      if (!globals(command).quiet)
        out.stdout.write(hookReport(result, styleFor(globals(command), out)));
    });

  /** `check --staged`: the hook. Returns the exit code. */
  const stagedCheck = async (
    command: Command,
    paths: string[],
    format: "text" | "json",
    started: number,
  ): Promise<number> => {
    const opts = globals(command);
    const cwd = workingDirectory(out.cwd, opts.cwd);
    const style = styleFor(opts, out);
    const { config, root, file } = await loadConfig(cwd, opts.config);
    if (out.env.CATSPEC_SKIP === "1") {
      const git = new Git(root, gitEnv);
      try {
        if (await git.isRepository()) await recordSkip(git);
      } catch {
        // Skipping must work even where git doesn't.
      }
      out.stderr.write("catspec: CATSPEC_SKIP=1: the staged check is skipped\n");
      return EXIT.ok;
    }
    const runStaged = () =>
      checkStaged(root, config, {
        ...(gitEnv ? { env: gitEnv } : {}),
        ...(file ? { configFile: file } : {}),
      }).catch((error: unknown) => {
        if (error instanceof NotARepositoryError) throw new UsageError(error.message);
        throw error;
      });
    let staged = await runStaged();
    try {
      const renames = await hookRenames(root, staged.model.config, staged.git, staged, async () => {
        const again = await runStaged();
        await staged.git.close();
        staged = again;
        return again;
      });
      let diagnostics = renames.diagnostics;
      if (paths.length > 0) diagnostics = diagnostics.filter((d) => inPaths(d, paths, cwd, root));
      const code = exitCodeFor(diagnostics);
      const checked = staged.result.checked;
      const notes: string[] = [];
      const skipped = await takeSkip(staged.git);
      if (skipped !== undefined) {
        notes.push(
          `warning: an earlier commit skipped the CatSpec check (CATSPEC_SKIP=1, ${skipped}); ` +
            "run `catspec check` to see what it would have reported",
        );
      }
      if (renames.healed.length > 0) {
        notes.push(`heal.mode auto: updated and staged ${renames.healed.join(", ")}`);
      }
      if (code === EXIT.ok) {
        const written = await writeLocks(staged.model, staged.result, checked, { mode: "update" });
        if (written.length > 0 && staged.model.config.hook.stage_generated) {
          await staged.git.add(written);
          notes.push(`updated and staged ${written.join(", ")}`);
        } else if (written.length > 0) {
          notes.push(`updated ${written.join(", ")} (not staged: hook.stage_generated is false)`);
        }
      } else {
        const renamed = diagnostics.some(
          (d) => d.severity === "error" && ["CS0210", "CS0215", "CS0216"].includes(d.code),
        );
        notes.push(
          "commit blocked: fix the errors above or update the spec; " +
            (renamed
              ? "for renamed or moved code run `catspec sync --apply`; "
              : "for an intended signature change run `catspec accept <spec>`; ") +
            "CATSPEC_SKIP=1 or --no-verify skips the check.",
        );
      }
      if (format === "json") {
        out.stdout.write(formatJson(diagnostics, checked.length));
      } else {
        out.stdout.write(
          formatText(diagnostics, {
            style,
            quiet: Boolean(opts.quiet),
            verbose: Boolean(opts.verbose),
            specs: checked.map((s) => ({ id: s.id, file: s.file })),
            durationMs: performance.now() - started,
          }),
        );
        if (renames.healed.length === 0) {
          for (const patch of renames.patches) {
            out.stdout.write(formatDiff(patch.file, patch.before, patch.after, style));
          }
        }
      }
      if (!opts.quiet || code !== EXIT.ok) {
        for (const note of notes) out.stderr.write(`catspec: ${note}\n`);
      }
      return code;
    } finally {
      await staged.git.close();
    }
  };

  /** Config, root and git for `sync` and `refactor`, which need a repository. */
  const repository = async (
    command: Command,
    what: string,
  ): Promise<{
    root: string;
    cwd: string;
    config: Awaited<ReturnType<typeof loadConfig>>["config"];
    git: Git;
  }> => {
    const opts = globals(command);
    const cwd = workingDirectory(out.cwd, opts.cwd);
    const { config, root } = await loadConfig(cwd, opts.config);
    const git = new Git(root, gitEnv);
    if (!(await git.isRepository())) throw new UsageError(`${what} needs a git repository`);
    return { root, cwd, config, git };
  };

  program
    .command("sync")
    .description(
      "find renamed and moved declarations of bindings and fix the specs' locations (symbol and " +
        "file only, never the contract); a dry run unless --apply. During a refactor it maps every " +
        "binding of the refactor's baseline and, on success, ends the refactor",
    )
    .option("--apply", "write the spec edits and moved lock entries (and stage them)")
    .option("--staged", "read the git index instead of the working tree")
    .option("--map <file>", 'a rename map: { "symbols": {…}, "namespaces": {…}, "paths": {…} }')
    .option(
      "--partial",
      "with --apply: write what is mapped even if some bindings are ambiguous or lost",
    )
    .option(
      "--update-mentions",
      "with --apply: also rewrite backticked mentions of old names in spec bodies",
    )
    .addOption(formatOption(["text", "json"], "text"))
    .action(
      async (
        options: {
          apply?: boolean;
          staged?: boolean;
          map?: string;
          partial?: boolean;
          updateMentions?: boolean;
          format: "text" | "json";
        },
        command: Command,
      ) => {
        const opts = globals(command);
        const style = styleFor(opts, out);
        const { root, cwd, config, git } = await repository(command, "sync");
        try {
          const map = options.map ? await readRenameMap(resolve(cwd, options.map)) : undefined;
          const run = await planRepositorySync(root, config, git, {
            ...(options.staged ? { staged: true } : {}),
            ...(map ? { map } : {}),
            ...(options.updateMentions ? { updateMentions: true } : {}),
          });
          const problems = run.plan.diagnostics.filter(
            (d) => d.code === "CS0216" || d.code === "CS0217",
          );
          let applied: AppliedSync | undefined;
          let refused = false;
          let ended = false;
          if (options.apply) {
            if (problems.length > 0 && !options.partial) refused = true;
            else {
              applied = await applySync(root, run, git, options.staged ? { staged: true } : {});
              if (run.refactor && problems.length === 0) {
                ended = await endRefactor(git);
              }
            }
          }
          if (options.format === "json") {
            out.stdout.write(
              `${JSON.stringify(syncJson(run, { applied, refused, ended }), null, 2)}\n`,
            );
          } else {
            out.stdout.write(
              syncText(run, {
                applied,
                refused,
                ended,
                apply: Boolean(options.apply),
                partial: Boolean(options.partial),
                style,
                quiet: Boolean(opts.quiet),
                verbose: Boolean(opts.verbose),
              }),
            );
          }
          exitCode = problems.length > 0 ? EXIT.errors : EXIT.ok;
        } finally {
          await git.close();
        }
      },
    );

  const refactor = program
    .command("refactor")
    .description(
      "start a large refactor: record a baseline of every binding in the scope, so the hook " +
        "groups their errors into one CS0215 and `catspec sync --apply` maps them all at the end",
    )
    .option("--scope <glob...>", "files in the refactor (default: the whole repository)")
    .option("--reason <text>", "why, shown by the hook and `refactor status`")
    .option("--allow-wip", "let commits with broken bindings through, on this branch only")
    .action(
      async (
        options: { scope?: string[]; reason?: string; allowWip?: boolean },
        command: Command,
      ) => {
        const opts = globals(command);
        const style = styleFor(opts, out);
        const { root, config, git } = await repository(command, "refactor");
        try {
          const baseline = await startRefactor(root, config, git, {
            ...(options.scope ? { scope: options.scope } : {}),
            ...(options.reason !== undefined ? { reason: options.reason } : {}),
            ...(options.allowWip ? { allowWip: true } : {}),
          });
          if (!opts.quiet) {
            const specs = new Set(baseline.symbols.map((s) => s.spec)).size;
            out.stdout.write(
              `${style.green("refactor started")} on ${baseline.branch ?? "a detached HEAD"} from ${baseline.revision.slice(0, 12)}: ` +
                `${baseline.symbols.length} binding${baseline.symbols.length === 1 ? "" : "s"} of ${specs} spec${specs === 1 ? "" : "s"} in ${baseline.scope.join(", ")}` +
                `${baseline.allowWip ? `; commits with broken bindings are allowed on ${baseline.branch ?? "this branch"}` : ""}\n` +
                "next: rename and move the code, then run `catspec sync --apply` and commit the code, specs and lock files together\n",
            );
          }
        } finally {
          await git.close();
        }
      },
    );

  refactor
    .command("status")
    .description("show the refactor in progress: scope, branch, and the bindings broken so far")
    .addOption(formatOption(["text", "json"], "text"))
    .action(async (options: { format: "text" | "json" }, command: Command) => {
      const opts = globals(command);
      const style = styleFor(opts, out);
      const { root, config, git } = await repository(command, "refactor status");
      try {
        const active = await readRefactor(git);
        if (!active) {
          if (options.format === "json") out.stdout.write(`${JSON.stringify({ active: false })}\n`);
          else out.stdout.write("no refactor in progress\n");
          return;
        }
        const run = await planRepositorySync(root, config, git, { refactor: active });
        const { mapped, ambiguous, lost } = run.plan.report;
        const count = (groups: { bindings: unknown[] }[]): number =>
          groups.reduce((n, g) => n + g.bindings.length, 0);
        const status = {
          active: true,
          branch: active.branch ?? null,
          revision: active.revision,
          startedAt: active.startedAt,
          reason: active.reason ?? null,
          scope: active.scope,
          allowWip: active.allowWip,
          bindings: active.symbols.length,
          broken: run.broken.length,
          mapped: count(mapped),
          ambiguous: count(ambiguous),
          lost: count(lost),
        };
        if (options.format === "json") {
          out.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        out.stdout.write(
          [
            `${style.bold("refactor in progress")} since ${active.startedAt} on ${active.branch ?? "a detached HEAD"} (from ${active.revision.slice(0, 12)})`,
            ...(active.reason ? [`  reason    ${active.reason}`] : []),
            `  scope     ${active.scope.join(", ")}`,
            `  wip       ${active.allowWip ? `commits with broken bindings allowed on ${active.branch ?? "its branch"}` : "commits with broken bindings are blocked"}`,
            `  bindings  ${status.bindings} in the baseline, ${status.broken} unresolved so far: ${status.mapped} mapped, ${status.ambiguous} ambiguous, ${status.lost} lost`,
            "next: `catspec sync` shows the mapping, `catspec sync --apply` finishes the refactor, `catspec refactor abort` drops it",
          ].join("\n") + "\n",
        );
      } finally {
        await git.close();
      }
    });

  refactor
    .command("abort")
    .description("drop the refactor in progress: its baseline is deleted, no spec is changed")
    .action(async (_options: unknown, command: Command) => {
      const opts = globals(command);
      const { git } = await repository(command, "refactor abort");
      try {
        const ended = await endRefactor(git);
        if (!opts.quiet) {
          out.stdout.write(
            ended
              ? "refactor aborted: its baseline is deleted; no spec was changed\n"
              : "no refactor in progress\n",
          );
        }
      } finally {
        await git.close();
      }
    });

  program
    .command("bind")
    .description(
      "add a binding for an existing declaration to a spec, with its current shape (kind, bases, " +
        "constructor dependencies, public members and their signatures) as the contract",
    )
    .argument("<symbol>", "the declaration: Name, Namespace.Name or path/to/module#Name")
    .requiredOption("--spec <id>", "the spec to add the binding to")
    .option("--file <file>", "only look in this file or glob (it is also written as the file hint)")
    .action(async (symbol: string, options: { spec: string; file?: string }, command: Command) => {
      const { model, style, opts } = await load(command);
      const spec = findSpec(model, options.spec);
      if (spec.type === "architecture") {
        throw new UsageError(`${spec.id} is the architecture spec; it has no bindings`);
      }
      if (!spec.valid) {
        throw new UsageError(`${spec.file} has errors; run \`catspec check --specs-only\``);
      }
      const codebase = await loadCodebase(model.root, model.config);
      const result = bindSymbol(spec, codebase, symbol, options.file);
      if (!result.text || !result.binding) {
        out.stdout.write(formatText(result.diagnostics, { style }));
        exitCode = EXIT.errors;
        return;
      }
      await writeFile(join(model.root, spec.file), result.text, "utf8");
      if (!opts.quiet) {
        out.stdout.write(
          `${style.green("bound")} ${symbol} (${result.resolved}) as binding "${String(result.binding.id)}" of ${spec.id}\n` +
            formatDiff(spec.file, spec.source.text, result.text, style) +
            `next: \`catspec check --spec ${spec.id}\`\n`,
        );
      }
    });

  program
    .command("show-facts", { hidden: true })
    .description("debug: print the facts CatSpec extracts from a source file, as JSON")
    .argument("<file>", "source file")
    .action(async (file: string, _options: unknown, command: Command) => {
      const opts = globals(command);
      const cwd = workingDirectory(out.cwd, opts.cwd);
      const { config, root } = await loadConfig(cwd, opts.config);
      const { facts, diagnostics } = await showFacts(root, cwd, config, file).catch(
        (error: unknown) => {
          if (error instanceof UnknownLanguageError) throw new UsageError(error.message);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new UsageError(`no such file: ${file}`);
          }
          throw error;
        },
      );
      out.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
      if (diagnostics.length > 0 && !opts.quiet) {
        out.stderr.write(
          formatText(diagnostics, {
            style: styleFor(opts, out),
            verbose: Boolean(opts.verbose),
          }),
        );
      }
      exitCode = exitCodeFor(diagnostics);
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (error instanceof ConfigError) {
      for (const issue of error.issues) {
        const allowed =
          issue.allowed && !issue.message.includes("allowed:")
            ? ` (allowed: ${issue.allowed.join(", ")})`
            : "";
        out.stderr.write(
          `catspec: ${issue.file}:${issue.line}:${issue.column}: ${issue.message}${allowed}\n`,
        );
      }
      return EXIT.usage;
    }
    if (error instanceof GitUnavailableError) {
      out.stdout.write(
        formatText(
          [
            createDiagnostic("CS0902", {
              message:
                "git is required for this command, but it can't be run: it isn't installed or isn't on PATH",
              suggestions: [{ message: "install git, or add it to PATH" }],
            }),
          ],
          { style: styleFor({ color: true }, out) },
        ),
      );
      return EXIT.errors;
    }
    if (error instanceof HookRefusedError) {
      out.stderr.write(`catspec: ${error.message}\n`);
      return EXIT.errors;
    }
    if (
      error instanceof UsageError ||
      error instanceof SpecEditError ||
      error instanceof SyncUsageError
    ) {
      out.stderr.write(`catspec: ${error.message}\n`);
      return EXIT.usage;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    out.stderr.write(`catspec: internal error: ${err.message}\n`);
    if (verbose && err.stack) out.stderr.write(`${err.stack}\n`);
    return EXIT.internal;
  }
}

function hookReport(result: HookResult, style: Style): string {
  const lines = [`${style.green(result.manager)}: ${result.message}`];
  if (result.next) lines.push(`next: ${result.next}`);
  return `${lines.join("\n")}\n`;
}

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function workingDirectory(base: string, cwd: string | undefined): string {
  const dir = resolve(base, cwd ?? ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new UsageError(`--cwd: no such folder: ${dir}`);
  }
  return dir;
}

function styleFor(opts: GlobalOptions, io: CliIo): Style {
  const forced = io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== "0";
  const enabled =
    opts.color && io.env.NO_COLOR === undefined && (forced || io.stdout.isTTY === true);
  return enabled ? COLORS : PLAIN;
}

/** True when a diagnostic's code or spec location is under one of `paths` (files, folders or globs). */
function inPaths(d: Diagnostic, paths: string[], cwd: string, root: string): boolean {
  const targets = paths.map((p) => {
    const rel = toPosix(relative(root, resolve(cwd, p)));
    return rel === "" ? "." : rel;
  });
  const glob = globMatcher(targets);
  const files = [d.codeLocation?.file, d.specLocation?.file].filter(
    (f): f is string => f !== undefined,
  );
  return files.some(
    (file) =>
      glob(file) ||
      targets.some((t) => t === "." || file === t || (!isAbsolute(t) && file.startsWith(`${t}/`))),
  );
}

function findSpec(model: SpecModel, id: string): Spec {
  const spec = model.specs.get(id);
  if (spec) return spec;
  const close = didYouMean(id, model.specs.byId.keys());
  throw new UsageError(
    `no spec with id "${id}"${close.length > 0 ? `; did you mean ${close.map((c) => `"${c}"`).join(", ")}?` : ""}`,
  );
}

/** list / graph still work on specs with errors; say so once on stderr. */
function warnAboutErrors(model: SpecModel, opts: GlobalOptions, io: CliIo): void {
  const errors = model.diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0 || opts.quiet) return;
  const count = `${errors.length} error${errors.length === 1 ? "" : "s"}`;
  io.stderr.write(`catspec: ${count} in the specs; run \`catspec check --specs-only\`\n`);
}

interface ListRow {
  id: string;
  title: string;
  type: string;
  status: string;
  file: string;
  dependsOn: string[];
  depsSatisfied: boolean;
  ready: boolean;
  aggregate: boolean;
  tasks: { done: number; total: number };
}

function listRow(spec: Spec, model: SpecModel): ListRow {
  return {
    id: spec.id,
    title: spec.title,
    type: spec.type,
    status: spec.status,
    file: spec.file,
    dependsOn: spec.dependsOn,
    depsSatisfied: model.graph.depsSatisfied(spec.id),
    ready: model.graph.isReady(spec.id),
    aggregate: spec.aggregate,
    tasks: { done: spec.body.tasks.filter((t) => t.done).length, total: spec.body.tasks.length },
  };
}

function formatList(rows: ListRow[], style: Style): string {
  if (rows.length === 0) return "no specs\n";
  const table = [
    ["ID", "STATUS", "TASKS", "DEPENDS ON", "TITLE"],
    ...rows.map((r) => [
      r.id,
      r.status,
      r.tasks.total > 0 ? `${r.tasks.done}/${r.tasks.total}` : "-",
      r.dependsOn.length > 0 ? r.dependsOn.join(", ") : "-",
      r.title,
    ]),
  ];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  return (
    table
      .map((row, index) => {
        const line = row
          .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
          .join("  ");
        return index === 0 ? style.bold(line) : line;
      })
      .join("\n") + "\n"
  );
}

function showView(spec: Spec, model: SpecModel) {
  const { graph } = model;
  return {
    id: spec.id,
    title: spec.title,
    type: spec.type,
    status: spec.status,
    file: spec.file,
    valid: spec.valid,
    aggregate: spec.aggregate,
    ready: graph.isReady(spec.id),
    dependsOn: spec.dependsOn.map((id) => ({
      id,
      status: model.specs.get(id)?.status ?? "unknown",
      satisfied: model.specs.get(id)?.status === "implemented",
    })),
    dependents: graph.dependents(spec.id),
    owners: spec.owners,
    scope: spec.scope,
    bindings: spec.bindings.map(withoutIndex),
    rules: spec.rules.map(withoutIndex),
    waivers: spec.waivers.map(withoutIndex),
    infrastructure: spec.infrastructure,
    ...(spec.links ? { links: spec.links } : {}),
    extra: spec.extra,
    tasks: {
      done: spec.body.tasks.filter((t) => t.done).length,
      total: spec.body.tasks.length,
      items: spec.body.tasks,
    },
    diagnostics: model.diagnostics.filter((d) => d.spec === spec.id),
  };
}

/** A model item without its position in the frontmatter list. */
function withoutIndex<T extends { index: number }>(item: T): Omit<T, "index"> {
  const copy: Partial<T> = { ...item };
  delete copy.index;
  return copy as Omit<T, "index">;
}

type ShowView = ReturnType<typeof showView>;

function formatShow(view: ShowView, style: Style): string {
  const lines = [
    `${style.bold(view.id)} — ${view.title}`,
    `  file        ${view.file}`,
    `  type        ${view.type}${view.aggregate ? " (aggregate)" : ""}`,
    `  status      ${view.status}${view.ready ? " (ready to start)" : ""}`,
    `  depends on  ${view.dependsOn.length > 0 ? view.dependsOn.map((d) => `${d.id} (${d.status})`).join(", ") : "-"}`,
    `  needed by   ${view.dependents.length > 0 ? view.dependents.join(", ") : "-"}`,
    `  tasks       ${view.tasks.total > 0 ? `${view.tasks.done}/${view.tasks.total}` : "-"}`,
  ];
  if (view.bindings.length > 0) {
    lines.push("  bindings");
    for (const b of view.bindings) {
      const hint = b.file ? `  (file: ${b.file.join(", ")})` : "";
      lines.push(`    ${b.id}: ${b.kind ?? "symbol"} ${b.symbol}${hint}`);
      if (b.implements) lines.push(`      implements ${b.implements.join(", ")}`);
      if (b.extends) lines.push(`      extends ${b.extends}`);
      if (b.constructorRequires)
        lines.push(`      constructor requires ${b.constructorRequires.join(", ")}`);
      for (const m of b.members) {
        const signature = m.params ? `(${m.params.join(", ")})` : "";
        const returns = m.returns ? `: ${m.returns}` : "";
        lines.push(
          `      ${m.kind ?? "member"} ${m.name}${signature}${returns}${m.optional ? " (optional)" : ""}`,
        );
      }
    }
  }
  if (view.rules.length > 0) {
    lines.push("  rules");
    for (const r of view.rules) lines.push(`    ${r.id}: ${r.class}${r.adr ? ` (${r.adr})` : ""}`);
  }
  if (view.waivers.length > 0) {
    lines.push("  waivers");
    for (const w of view.waivers)
      lines.push(`    ${w.rule}: ${w.reason}${w.until ? ` (until ${w.until})` : ""}`);
  }
  if (view.diagnostics.length > 0) {
    lines.push("", formatText(view.diagnostics, { style }).trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

interface SyncOutcome {
  applied: AppliedSync | undefined;
  refused: boolean;
  ended: boolean;
}

const bindingsOf = (groups: { bindings: { spec: string; binding: string }[] }[]): number =>
  groups.reduce((n, g) => n + g.bindings.length, 0);

/** The `sync --format json` report. */
function syncJson(run: SyncRun, outcome: SyncOutcome) {
  const { mapped, ambiguous, lost } = run.plan.report;
  const name = (resolved: string): string => resolved;
  const target = (e: { file: { path: string }; symbol: { qualifiedName: string } }): string =>
    `${e.file.path}#${e.symbol.qualifiedName}`;
  return {
    mapped: mapped.flatMap((m) =>
      m.bindings.map((b) => ({
        spec: b.spec,
        binding: b.binding,
        from: name(b.resolved),
        to: target(m.target),
        evidence: m.evidence,
        ...(m.score !== undefined ? { score: m.score } : {}),
        ...(m.detail ? { detail: m.detail } : {}),
      })),
    ),
    ambiguous: ambiguous.flatMap((a) =>
      a.bindings.map((b) => ({
        spec: b.spec,
        binding: b.binding,
        from: name(b.resolved),
        candidates: a.candidates.map((c) => ({ symbol: target(c.entry), score: c.score })),
      })),
    ),
    lost: lost.flatMap((l) =>
      l.bindings.map((b) => ({
        spec: b.spec,
        binding: b.binding,
        from: name(b.resolved),
        ...(l.best ? { best: { symbol: target(l.best.entry), score: l.best.score } } : {}),
      })),
    ),
    edits: run.plan.edits.map((e) => ({ file: e.spec.file, ops: e.ops })),
    diagnostics: run.plan.diagnostics,
    applied: outcome.applied !== undefined,
    refused: outcome.refused,
    written: outcome.applied?.written ?? [],
    staged: outcome.applied?.staged ?? [],
    refactor: run.refactor
      ? { active: !outcome.ended, ended: outcome.ended }
      : { active: false, ended: false },
  };
}

/** The `sync` text report: the diagnostics, the diff of every edit, and what happened. */
function syncText(
  run: SyncRun,
  outcome: SyncOutcome & {
    apply: boolean;
    partial: boolean;
    style: Style;
    quiet: boolean;
    verbose: boolean;
  },
): string {
  const { style } = outcome;
  const { report, edits, diagnostics } = run.plan;
  const parts: string[] = [];
  if (diagnostics.length > 0) {
    parts.push(formatText(diagnostics, { style, quiet: outcome.quiet, verbose: outcome.verbose }));
  }
  if (!outcome.quiet)
    for (const edit of edits)
      parts.push(formatDiff(edit.spec.file, edit.spec.source.text, edit.text, style));
  const counts =
    `${bindingsOf(report.mapped)} mapped, ${bindingsOf(report.ambiguous)} ambiguous, ` +
    `${bindingsOf(report.lost)} lost` +
    (run.refactor ? ` (refactor from ${run.refactor.revision.slice(0, 12)})` : "");
  const lines: string[] = [];
  if (run.broken.length === 0 && edits.length === 0) {
    lines.push(
      run.refactor
        ? "every binding of the refactor resolves; nothing to sync"
        : "every binding resolves; nothing to sync",
    );
    if (outcome.apply && run.refactor && outcome.ended)
      lines.push(style.green("the refactor is finished"));
  } else if (!outcome.apply) {
    lines.push(
      `${counts}; dry run: no file was changed${edits.length > 0 ? "; run `catspec sync --apply` to write the edits" : ""}`,
    );
  } else if (outcome.refused) {
    lines.push(
      `${counts}; ${style.red("nothing written")}: name the ambiguous and lost bindings in a rename map (--map), restore the code or change the specs; --partial writes the mapped part` +
        (run.refactor ? " (the refactor stays open)" : ""),
    );
  } else {
    const applied = outcome.applied!;
    const unstaged = applied.written.filter((f) => !applied.staged.includes(f));
    lines.push(
      `${counts}; ${style.green("wrote")} ${applied.written.length > 0 ? applied.written.join(", ") : "nothing"}` +
        (applied.staged.length > 0
          ? `; staged ${applied.staged.length === applied.written.length ? "them" : applied.staged.join(", ")}`
          : "") +
        (unstaged.length > 0 ? `; not staged (unstaged changes): ${unstaged.join(", ")}` : ""),
    );
    if (run.refactor) {
      lines.push(
        outcome.ended
          ? `${style.green("the refactor is finished")}: commit the code, specs and lock files together`
          : "the refactor stays open: map the rest, then run `catspec sync --apply` again",
      );
    }
  }
  parts.push(`${lines.join("\n")}\n`);
  return parts.join("");
}
