export async function loadPlugin(name: string) {
  const plugin = await import("./plugins/default");
  const dynamic = await import(name);
  const legacy = require("legacy");
  const computed = require(name);
  return [plugin, dynamic, legacy, computed];
}
