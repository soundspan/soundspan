import fs from "node:fs";

export const CHANGELOG_PATH = "CHANGELOG.md";
export const UNRELEASED_KEY = "Unreleased";
export const STANDARD_CHANGELOG_CATEGORIES = ["Added", "Changed", "Fixed"];

const SECTION_HEADING_PATTERN =
  /^## \[(?<key>[^\]]+)\](?: - (?<date>\d{4}-\d{2}-\d{2}))?[ \t]*$/gm;
const SUBSECTION_HEADING_PATTERN = /^###\s+(?<name>[^\r\n]+?)\s*$/;

function consumeLineBreak(content, offset) {
  if (content.slice(offset, offset + 2) === "\r\n") {
    return offset + 2;
  }
  if (content[offset] === "\n") {
    return offset + 1;
  }
  return offset;
}

function normalizeKey(value) {
  return value.trim().toLowerCase();
}

function trimBody(body) {
  return body.trim();
}

export function formatReleaseDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function readChangelog(changelogPath = CHANGELOG_PATH) {
  return fs.readFileSync(changelogPath, "utf8");
}

export function writeChangelog(content, changelogPath = CHANGELOG_PATH) {
  fs.writeFileSync(changelogPath, content, "utf8");
}

export function buildStandardSectionBody(
  categories = STANDARD_CHANGELOG_CATEGORIES,
) {
  return categories.map((category) => `### ${category}`).join("\n\n");
}

export function parseChangelog(changelogContent) {
  if (typeof changelogContent !== "string" || changelogContent.trim().length === 0) {
    throw new Error("CHANGELOG content is empty.");
  }

  SECTION_HEADING_PATTERN.lastIndex = 0;
  const matches = [...changelogContent.matchAll(SECTION_HEADING_PATTERN)];
  if (matches.length === 0) {
    throw new Error("CHANGELOG must contain at least one version section heading.");
  }

  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const headingStart = match.index ?? 0;
    const headingEnd = consumeLineBreak(
      changelogContent,
      headingStart + match[0].length,
    );
    const nextHeadingStart =
      index + 1 < matches.length
        ? (matches[index + 1].index ?? changelogContent.length)
        : changelogContent.length;

    sections.push({
      key: match.groups?.key?.trim() ?? "",
      date: match.groups?.date?.trim() ?? null,
      body: trimBody(changelogContent.slice(headingEnd, nextHeadingStart)),
    });
  }

  const preamble = changelogContent.slice(0, matches[0].index ?? 0).trimEnd();
  return { preamble, sections };
}

export function renderChangelog(parsed) {
  const preamble = (parsed?.preamble ?? "").trimEnd();
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : [];
  if (sections.length === 0) {
    throw new Error("Cannot render changelog without sections.");
  }

  const output = [];
  if (preamble.length > 0) {
    output.push(preamble);
  }

  for (const section of sections) {
    const key = section?.key?.trim();
    if (!key) {
      throw new Error("Cannot render changelog section with an empty key.");
    }

    const dateSuffix =
      typeof section.date === "string" && section.date.trim().length > 0
        ? ` - ${section.date.trim()}`
        : "";

    output.push(`## [${key}]${dateSuffix}`);
    output.push("");

    const body = trimBody(section.body ?? "");
    if (body.length > 0) {
      output.push(body);
      output.push("");
    }
  }

  return `${output.join("\n").trimEnd()}\n`;
}

export function findSectionIndexByKey(sections, key) {
  const normalizedKey = normalizeKey(key);
  return sections.findIndex((section) => normalizeKey(section.key) === normalizedKey);
}

export function findSectionByKey(parsed, key) {
  const index = findSectionIndexByKey(parsed.sections, key);
  if (index < 0) {
    return null;
  }
  return {
    index,
    section: parsed.sections[index],
  };
}

function listSubsectionHeadings(body) {
  const headings = [];
  for (const line of body.split(/\r?\n/)) {
    const match = SUBSECTION_HEADING_PATTERN.exec(line.trim());
    if (!match) {
      continue;
    }
    headings.push(match.groups?.name?.trim() ?? "");
  }
  return headings;
}

export function hasRequiredCategoryHeadings(
  body,
  categories = STANDARD_CHANGELOG_CATEGORIES,
) {
  const existing = new Set(
    listSubsectionHeadings(body ?? "")
      .filter((name) => name.length > 0)
      .map((name) => normalizeKey(name)),
  );
  return categories.every((category) => existing.has(normalizeKey(category)));
}

export function ensureCategoryHeadings(
  body,
  categories = STANDARD_CHANGELOG_CATEGORIES,
) {
  const trimmed = trimBody(body ?? "");
  if (trimmed.length === 0) {
    return buildStandardSectionBody(categories);
  }

  const existing = new Set(
    listSubsectionHeadings(trimmed)
      .filter((name) => name.length > 0)
      .map((name) => normalizeKey(name)),
  );
  const missing = categories.filter(
    (category) => !existing.has(normalizeKey(category)),
  );
  if (missing.length === 0) {
    return trimmed;
  }

  const missingBlock = missing.map((category) => `### ${category}`).join("\n\n");
  return `${trimmed}\n\n${missingBlock}`;
}

export function isSectionEffectivelyEmpty(
  body,
  categories = STANDARD_CHANGELOG_CATEGORIES,
) {
  const allowed = new Set(
    categories.map((category) => `### ${normalizeKey(category)}`),
  );

  const lines = (body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const normalized = normalizeKey(line);
    if (allowed.has(normalized)) {
      continue;
    }
    if (/^<!--.*-->$/.test(line)) {
      continue;
    }
    return false;
  }

  return true;
}

export function prepareChangelogForRelease({
  changelogContent,
  version,
  releaseDate,
  unreleasedKey = UNRELEASED_KEY,
  categories = STANDARD_CHANGELOG_CATEGORIES,
}) {
  const parsed = parseChangelog(changelogContent);
  const unreleased = findSectionByKey(parsed, unreleasedKey);
  if (!unreleased) {
    throw new Error(`Missing changelog section: [${unreleasedKey}]`);
  }

  const unreleasedBodyOriginal = trimBody(unreleased.section.body ?? "");
  const unreleasedHasContent = !isSectionEffectivelyEmpty(
    unreleasedBodyOriginal,
    categories,
  );
  const versionMatch = findSectionByKey(parsed, version);
  const normalizedScaffold = buildStandardSectionBody(categories);

  if (versionMatch) {
    if (unreleasedHasContent) {
      throw new Error(
        `Cannot prepare ${version}: section [${version}] already exists and [${unreleasedKey}] still has content.`,
      );
    }

    parsed.sections[unreleased.index].body = normalizedScaffold;
    return {
      changed:
        trimBody(parsed.sections[unreleased.index].body) !==
        unreleasedBodyOriginal,
      content: renderChangelog(parsed),
    };
  }

  const promotedBody = ensureCategoryHeadings(unreleasedBodyOriginal, categories);
  parsed.sections[unreleased.index].body = normalizedScaffold;
  parsed.sections.splice(unreleased.index + 1, 0, {
    key: version,
    date: releaseDate,
    body: promotedBody,
  });

  return {
    changed: true,
    content: renderChangelog(parsed),
  };
}

export function assertChangelogPreparedForRelease({
  changelogContent,
  version,
  unreleasedKey = UNRELEASED_KEY,
  categories = STANDARD_CHANGELOG_CATEGORIES,
  requireUnreleasedEmpty = false,
}) {
  const parsed = parseChangelog(changelogContent);

  const unreleased = findSectionByKey(parsed, unreleasedKey);
  if (!unreleased) {
    throw new Error(`Missing changelog section: [${unreleasedKey}]`);
  }
  if (!hasRequiredCategoryHeadings(unreleased.section.body ?? "", categories)) {
    throw new Error(
      `[${unreleasedKey}] must contain subsection headings: ${categories.join(", ")}`,
    );
  }
  if (
    requireUnreleasedEmpty &&
    !isSectionEffectivelyEmpty(unreleased.section.body ?? "", categories)
  ) {
    throw new Error(
      `[${unreleasedKey}] must only contain empty scaffold headings after release prep.`,
    );
  }

  const release = findSectionByKey(parsed, version);
  if (!release) {
    throw new Error(
      `Missing changelog release section [${version}]. Run release prepare first.`,
    );
  }
  if (!hasRequiredCategoryHeadings(release.section.body ?? "", categories)) {
    throw new Error(
      `[${version}] must contain subsection headings: ${categories.join(", ")}`,
    );
  }
}

export function extractSectionBullets(body) {
  const bullets = new Map();
  let currentHeading = null;

  for (const line of (body ?? "").split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    const headingMatch = SUBSECTION_HEADING_PATTERN.exec(trimmed.trim());
    if (headingMatch) {
      currentHeading = normalizeKey(headingMatch.groups?.name ?? "");
      if (!bullets.has(currentHeading)) {
        bullets.set(currentHeading, []);
      }
      continue;
    }

    if (!currentHeading) {
      continue;
    }

    const bulletMatch = /^\s*-\s+(.+?)\s*$/.exec(trimmed);
    if (bulletMatch) {
      bullets.get(currentHeading).push(`- ${bulletMatch[1].trim()}`);
      continue;
    }

    if (/^\s{2,}\S+/.test(trimmed) && bullets.get(currentHeading).length > 0) {
      const items = bullets.get(currentHeading);
      const lastIndex = items.length - 1;
      items[lastIndex] = `${items[lastIndex]}\n  ${trimmed.trim()}`;
    }
  }

  return bullets;
}

export function pickBulletsByHeadingAliases(bulletsByHeading, aliases) {
  for (const alias of aliases) {
    const matches = bulletsByHeading.get(normalizeKey(alias));
    if (matches && matches.length > 0) {
      return matches;
    }
  }
  return [];
}
