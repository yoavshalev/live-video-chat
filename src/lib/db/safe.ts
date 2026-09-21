/** Runs a history write that must never take a state transition down with it. */
export async function safeDb(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  } catch (error) {
    console.error(`[db:${label}]`, error instanceof Error ? error.message : String(error))
  }
}
