import { getCollection, type CollectionEntry } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

const SECTION_LABELS: Record<string, string> = {
  start: "Start here",
  reference: "How it works",
  advanced: "Advanced",
};

const SECTION_ORDER = ["start", "reference", "advanced"] as const;

export async function getDocsSorted(): Promise<DocEntry[]> {
  const docs = await getCollection("docs");
  return docs.sort((a, b) => {
    const sa = SECTION_ORDER.indexOf(a.data.section);
    const sb = SECTION_ORDER.indexOf(b.data.section);
    if (sa !== sb) return sa - sb;
    return a.data.order - b.data.order;
  });
}

export function docHref(entry: DocEntry): string {
  if (entry.id === "index") return "/docs";
  return `/docs/${entry.id}`;
}

export function sectionLabel(section: string): string {
  return SECTION_LABELS[section] ?? section;
}

export function groupDocsBySection(
  docs: DocEntry[],
): { section: string; label: string; entries: DocEntry[] }[] {
  const groups: { section: string; label: string; entries: DocEntry[] }[] = [];
  for (const section of SECTION_ORDER) {
    const entries = docs.filter((d) => d.data.section === section);
    if (entries.length) {
      groups.push({ section, label: sectionLabel(section), entries });
    }
  }
  return groups;
}
