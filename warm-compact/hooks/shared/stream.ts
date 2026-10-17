// The master copy, kept at the repository's root: each mod that uses it holds a copy under
// hooks/shared/, as a mod loads and installs on its own. Edit it here, then run
// scripts/sync-shared.sh

// Passes the response on as it streams, seeing each chunk on the way
export async function* tap<T, R>(stream: AsyncGenerator<T, R>, see: (chunk: T) => Promise<void>): AsyncGenerator<T, R> {
  for (;;) {
    const step = await stream.next()
    if (step.done === true) return step.value
    await see(step.value)
    yield step.value
  }
}
