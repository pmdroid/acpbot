/**
 * Operator-facing copy: /new cannot start a session without [repos].
 * BotFather / config env names stay out of this — use `acpbot repo`.
 */

export function noReposConfiguredMessage(): string {
  return (
    "No workspace repos configured. You cannot start a session until you add one.\n" +
    "On the host:  acpbot repo add"
  );
}

export function unknownRepoMessage(repo: string): string {
  return (
    `Unknown repo "${repo}". Add it on the host, then /new again:\n` +
    `  acpbot repo add ${repo}`
  );
}

/**
 * Setup / folder browser often opens on a parent like ~/code or ~/Projects.
 * That parent is not a workspace; each /new repo is one project directory.
 */
export function projectsFolderHint(): string {
  return [
    "The folder browser may open on a parent directory (for example ~/code or ~/Projects).",
    "That parent is not a workspace. Browse into the project you want, then Use this folder.",
    "Subfolders are not registered automatically. Add more later with: acpbot repo add",
  ].join("\n");
}
