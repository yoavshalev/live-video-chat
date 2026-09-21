/**
 * Types for the parts of the agent CLI that test/password.test.ts imports, so
 * the Worker's password verifier can be cross-checked against the hash the CLI
 * produces without turning the CLI into TypeScript.
 */

export function hashPassword(password: string, iterations?: number): Promise<string>
export function generatePassword(): string
export function slugify(name: string): string
