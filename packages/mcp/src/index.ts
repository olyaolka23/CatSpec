/** Package name. */
export const packageName = "@catspec/mcp";

export { createServer, serveMcp } from "./server.js";
export type { Engine, RefactorStarted, SyncOutcome } from "./engine.js";
export { OutsideRepositoryError, repositoryPath } from "./paths.js";
export { bindingsPatchOps, ToolError, Workspace, type WorkspaceOptions } from "./tools.js";
