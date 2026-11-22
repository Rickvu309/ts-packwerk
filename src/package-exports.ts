const conditionTarget = (entry: unknown): string | undefined => {
  if (typeof entry === "string") return entry
  if (typeof entry !== "object" || entry === null) return undefined
  const conditions = entry as Record<string, unknown>
  for (const key of ["import", "default", "module", "types"]) {
    const found = conditionTarget(conditions[key])
    if (found !== undefined) return found
  }
  return undefined
}

export const exportTarget = (manifest: Record<string, unknown>, subpath: string): string | undefined => {
  const exports = manifest.exports
  if (exports === undefined) {
    if (subpath !== ".") return subpath
    const main = manifest.module ?? manifest.main
    return typeof main === "string" ? main : "index.js"
  }
  if (typeof exports !== "object" || exports === null || !Object.keys(exports).some((key) => key.startsWith("."))) {
    return subpath === "." ? conditionTarget(exports) : undefined
  }
  const map = exports as Record<string, unknown>
  if (subpath in map) return conditionTarget(map[subpath])
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*")
    if (star < 0) continue
    const [before, after] = [key.slice(0, star), key.slice(star + 1)]
    if (!subpath.startsWith(before) || !subpath.endsWith(after)) continue
    const matched = subpath.slice(before.length, subpath.length - after.length)
    return conditionTarget(value)?.replace("*", matched)
  }
  return undefined
}
