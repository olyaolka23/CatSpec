/** Package name. */
export const packageName = "@catspec/cli";

export { run, UsageError, type CliIo } from "./cli.js";
export { EXIT, exitCodeFor, formatJson, formatText } from "./report.js";
export { formatGraph, GRAPH_FORMATS, type GraphFormat } from "./graph.js";
export { initRepository, type InitResult } from "./init.js";
export { cliEngine } from "./mcp-engine.js";
