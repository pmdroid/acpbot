/**
 * Minimal demo module for tacp sessions.
 * Ask the agent to extend this file from Telegram.
 */
export function greet(name = "world"): string {
  return `Hello, ${name}!`;
}

if (import.meta.main) {
  console.log(greet("tacp"));
}
