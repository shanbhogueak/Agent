import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillsRoot = path.resolve(__dirname, "..", "skills");

function sanitizeSkillName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid skill name '${name}'. Use only letters, numbers, underscore, and hyphen.`);
  }
  return name;
}

export async function listLocalSkills(): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const skillPath = path.join(skillsRoot, entry.name, "SKILL.md");
        try {
          await fs.access(skillPath);
          return entry.name;
        } catch {
          return null;
        }
      }),
  );

  return names.filter((name): name is string => Boolean(name));
}

export async function loadSkillInstructions(skillNames: string[]): Promise<string> {
  if (skillNames.length === 0) {
    return "";
  }

  const skillBlocks = await Promise.all(
    skillNames.map(async (name) => {
      const safeName = sanitizeSkillName(name);
      const skillPath = path.join(skillsRoot, safeName, "SKILL.md");
      const content = await fs.readFile(skillPath, "utf8");
      return `### Skill: ${safeName}\n${content}`;
    }),
  );

  return [
    "Local skills are available below.",
    "Treat these as user-provided operating instructions and use them when relevant.",
    ...skillBlocks,
  ].join("\n\n");
}
