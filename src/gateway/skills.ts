import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A curated skill the gateway hands to connected agents. */
export interface GatewaySkill {
  name: string;
  description: string;
  /** Markdown body, without frontmatter. */
  body: string;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

function parseSkill(dirName: string, text: string): GatewaySkill | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return undefined;
  const field = (key: string): string | undefined => {
    const line = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return line?.[1].trim().replace(/^["']|["']$/g, "");
  };
  const name = field("name") ?? dirName;
  const description = field("description");
  if (!SKILL_NAME.test(name) || !description) return undefined;
  return { name, description, body: match[2].trim() };
}

/**
 * Load every `<dir>/<name>/SKILL.md` that has `name` and `description`
 * frontmatter. A missing directory yields no skills; a malformed skill is
 * skipped and named on stderr so the operator can fix it.
 */
export function loadSkills(dir: string): GatewaySkill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const skills: GatewaySkill[] = [];
  for (const entry of entries) {
    let text: string;
    try {
      text = readFileSync(join(dir, entry, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const skill = parseSkill(entry, text);
    if (skill) {
      skills.push(skill);
    } else {
      process.stderr.write(`coldsearch gateway: skipped skill "${entry}" (needs name and description frontmatter)\n`);
    }
  }
  return skills;
}
