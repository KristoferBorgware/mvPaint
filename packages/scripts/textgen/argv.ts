// The one command-line reader both generators go through.
//
// `--charset latin` and `--charset=latin` are the same argument. What a value means is the
// caller's business; this only finds it.

/**
 * The value of `--<flag> <value>` or `--<flag>=<value>`, or undefined when the run gave neither.
 * The first occurrence wins, so a flag repeated on one line has one answer.
 */
export function flagFromArgv(argv: readonly string[], flag: string): string | undefined {
  const long = `--${flag}`
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === long) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${long} needs a value.`)
      return value
    }
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1)
  }
  return undefined
}
