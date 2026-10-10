/**
 * The `catspec` command line (plan §D10), PBI `cli-skeleton`: `init`, `check --specs-only`,
 * `list`, `show` and `graph`.
 *
 * Exit codes: 0 ok or warnings only, 1 errors found, 2 usage or config error, 3 internal error.
 */
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import {
  ConfigError,
  didYouMean,
  findGitRoot,
  loadConfig,
  loadSpecModel,
  SPEC_STATUSES,
  type Spec,
  type SpecModel,
} from "@catspec/core";
import { Command, CommanderError, Option } from "commander";

import { formatGraph, GRAPH_FORMATS, type GraphFormat } from "./graph.js";
import { initRepository } from "./init.js";
import { COLORS, EXIT, exitCodeFor, formatJson, formatText, PLAIN, type Style } from "./report.js";

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
    .action(async (options: { name?: string }, command: Command) => {
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
    });

  program
    .command("check")
    .description("validate the specs; with --specs-only, the spec files only (no code)")
    .option(
      "--specs-only",
      "check spec files only: schema, ids, dependencies, references, layout, ADR ids",
    )
    .addOption(formatOption(["text", "json"], "text"))
    .action(async (options: { specsOnly?: boolean; format: "text" | "json" }, command: Command) => {
      if (!options.specsOnly) {
        throw new UsageError(
          "checking code against specs is not available yet; run `catspec check --specs-only`",
        );
      }
      const started = performance.now();
      const { model, style, opts } = await load(command);
      const diagnostics = model.diagnostics;
      const specs = model.specs.all();
      if (options.format === "json") {
        out.stdout.write(formatJson(diagnostics, specs.length));
      } else {
        out.stdout.write(
          formatText(diagnostics, {
            style,
            quiet: Boolean(opts.quiet),
            verbose: Boolean(opts.verbose),
            specs: specs.map((s) => ({ id: s.id, file: s.file })),
            durationMs: performance.now() - started,
          }),
        );
      }
      exitCode = exitCodeFor(diagnostics);
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
    if (error instanceof UsageError) {
      out.stderr.write(`catspec: ${error.message}\n`);
      return EXIT.usage;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    out.stderr.write(`catspec: internal error: ${err.message}\n`);
    if (verbose && err.stack) out.stderr.write(`${err.stack}\n`);
    return EXIT.internal;
  }
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
