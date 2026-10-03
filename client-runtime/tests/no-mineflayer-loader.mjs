export async function resolve(specifier, context, nextResolve) {
  if (/mineflayer|minecraft-protocol|minecraft-data|prismarine/.test(specifier)) throw new Error(`Forbidden ClientBody dependency: ${specifier}`);
  return nextResolve(specifier, context);
}
