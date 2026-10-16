#!/usr/bin/env node
import { setFlagsFromString } from "node:v8";

import { run } from "./cli.js";

// The Tree-sitter grammars are large WebAssembly modules. V8 re-compiles their hot functions with
// its optimising compiler in the background and waits for those jobs before the process exits,
// which in a short run such as the pre-commit hook costs more than it saves (plan §D11.7). The
// baseline compiler alone is used; it is set before any grammar is compiled.
setFlagsFromString("--liftoff-only");

process.exitCode = await run(process.argv.slice(2));
