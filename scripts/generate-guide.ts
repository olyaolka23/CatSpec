/**
 * Writes the generated pages of the user guide (./user-guide.ts).
 *
 * Usage: tsx scripts/generate-guide.ts (`npm run guide`)
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS_PAGE, commandsPage, DIAGNOSTICS_PAGE, diagnosticsPage } from "./user-guide.js";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
writeFileSync(resolve(root, DIAGNOSTICS_PAGE), diagnosticsPage());
writeFileSync(resolve(root, COMMANDS_PAGE), await commandsPage());
console.log(`wrote ${DIAGNOSTICS_PAGE} and ${COMMANDS_PAGE}`);
