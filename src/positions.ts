export const lineStarts = (source: string): number[] => {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) if (source.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

export const position = (starts: readonly number[], offset: number): { line: number; column: number } => {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((starts[middle] ?? 0) <= offset) low = middle
    else high = middle - 1
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 }
}
