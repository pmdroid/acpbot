/**
 * Bundled example: fan-out audit (diamond pattern).
 * Args: { root?: string } default src
 */
export const meta = {
  name: "audit-routes",
  description: "List files under a root and audit each; return findings",
  phases: [
    { title: "Discover" },
    { title: "Audit" },
    { title: "Synthesize" },
  ],
};

const root =
  args && typeof args.root === "string" ? args.root : "src";

phase("Discover");
const found = await agent(
  `List every source file under ${root}/ that looks like a route/handler/API entry (max 40 paths). Return { files: string[] }.`,
  {
    phase: "Discover",
    label: "list-files",
    schema: {
      type: "object",
      required: ["files"],
      properties: {
        files: { type: "array", items: { type: "string" } },
      },
    },
  },
);

const files = (found && found.files ? found.files : []).slice(0, 40);
log(`Auditing ${files.length} files under ${root}`);

if (!files.length) {
  return { findings: [], message: "no files" };
}

phase("Audit");
const audits = await pipeline(files, (file) =>
  agent(
    `Audit ${file} for missing authentication/authorization checks and obvious security issues. Return { file, issues: [{ title, severity, detail }] }.`,
    {
      phase: "Audit",
      label: String(file).split("/").pop() || "file",
      isolation: "none",
      schema: {
        type: "object",
        required: ["file", "issues"],
        properties: {
          file: { type: "string" },
          issues: {
            type: "array",
            items: {
              type: "object",
              required: ["title", "severity", "detail"],
              properties: {
                title: { type: "string" },
                severity: { type: "string" },
                detail: { type: "string" },
              },
            },
          },
        },
      },
    },
  ),
);

phase("Synthesize");
const valid = (audits || []).filter(Boolean);
const report = await agent(
  `Merge and rank these audit findings. Deduplicate. Return markdown summary and { count, top: string[] }.\n${JSON.stringify(valid).slice(0, 12000)}`,
  {
    phase: "Synthesize",
    label: "merge",
    schema: {
      type: "object",
      required: ["count", "summary"],
      properties: {
        count: { type: "number" },
        summary: { type: "string" },
        top: { type: "array", items: { type: "string" } },
      },
    },
  },
);

return { files: files.length, report, audits: valid };
