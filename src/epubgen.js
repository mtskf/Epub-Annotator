#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const COVER_MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function buildCoverDescriptor(filePath) {
  if (!filePath) return null;
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = COVER_MEDIA_TYPES[ext];
  if (!mediaType) return null;
  return {
    absolutePath: path.resolve(filePath),
    mediaType,
    extension: ext,
  };
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function convertInlineMarkdown(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
  escaped = escaped.replace(/__(.+?)__/gs, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.+?)\*/gs, '<em>$1</em>');
  escaped = escaped.replace(/_(.+?)_/gs, '<em>$1</em>');
  return escaped;
}

function parseFootnotes(rawText) {
  const lines = rawText.split(/\r?\n/);
  const bodyLines = [];
  const footnotes = new Map();
  let currentId = null;

  for (const line of lines) {
    const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
    if (defMatch) {
      const [, id, rest] = defMatch;
      currentId = id.trim();
      footnotes.set(currentId, [rest.trim()]);
      continue;
    }

    if (currentId && /^\s+/.test(line)) {
      const content = line.trim();
      if (content.length) {
        footnotes.get(currentId).push(content);
      }
      continue;
    }

    currentId = null;
    bodyLines.push(line);
  }

  const normalizedNotes = new Map();
  for (const [id, parts] of footnotes.entries()) {
    normalizedNotes.set(id, parts.join(' ').trim());
  }

  return { bodyText: bodyLines.join('\n').trim(), footnotes: normalizedNotes };
}

function stripMarkdownHeading(line) {
  if (!line) return '';
  const match = line.match(/^#{1,6}\s+(.*)$/);
  return match ? match[1].trim() : line.trim();
}

function normalizeText(text) {
  return (text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildTitleVariants(title) {
  const variants = new Set();
  const base = normalizeText(title);
  if (base) variants.add(base);
  const noParens = normalizeText(title.replace(/\s*\([^)]*\)\s*/g, ' '));
  if (noParens) variants.add(noParens);
  const beforeColon = normalizeText(title.split(':')[0]);
  if (beforeColon) variants.add(beforeColon);
  return [...variants];
}

function extractMetadata(bodyText, overrides = {}) {
  const lines = bodyText.split(/\r?\n/);
  const consumed = new Set();
  const nonEmptyIndices = [];

  lines.forEach((line, index) => {
    if (line.trim().length) {
      nonEmptyIndices.push(index);
    }
  });

  let title = overrides.title;
  let creator = overrides.creator;

  if (!title && nonEmptyIndices.length) {
    const index = nonEmptyIndices.shift();
    title = stripMarkdownHeading(lines[index]);
    consumed.add(index);
  }

  if (!creator && nonEmptyIndices.length) {
    const index = nonEmptyIndices.shift();
    creator = stripMarkdownHeading(lines[index]);
    consumed.add(index);
  }

  const cleanedBody = lines
    .map((line, index) => (consumed.has(index) ? '' : line))
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');

  return { title, creator, cleanedBody };
}

function renderInlineWithFootnotes(text, noteOrder, makeNoteRef) {
  const refRegex = /\[\^([^\]]+)\]/g;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = refRegex.exec(text)) !== null) {
    const segment = text.slice(lastIndex, match.index);
    if (segment) {
      result += convertInlineMarkdown(segment);
    }
    const normalizedId = match[1].trim();
    if (!noteOrder.includes(normalizedId)) {
      noteOrder.push(normalizedId);
    }
    result += makeNoteRef(normalizedId, noteOrder.indexOf(normalizedId) + 1);
    lastIndex = match.index + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail) {
    result += convertInlineMarkdown(tail);
  }
  return result;
}

function parseMarkdownBlocks(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const blocks = [];
  let buffer = [];

  const flushParagraph = () => {
    if (!buffer.length) return;
    const text = buffer.join(' ').trim();
    buffer = [];
    if (text) {
      blocks.push({ type: 'paragraph', text });
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      continue;
    }
    buffer.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

function renderContentBlocks(bodyText, noteOrder, makeNoteRef, title, titleVariants = []) {
  const blocks = parseMarkdownBlocks(bodyText);
  if (!blocks.length) return '';

  if (titleVariants.length) {
    while (blocks.length) {
      const candidate = blocks[0];
      const normalized = normalizeText(candidate.text.replace(/[\*_`]+/g, ''));
      const match = titleVariants.some((variant) => normalized === variant);
      if (match) {
        blocks.shift();
        continue;
      }
      break;
    }
  }

  return blocks
    .map((block) => {
      if (block.type === 'heading') {
        const level = Math.min(6, Math.max(2, block.level));
        const content = renderInlineWithFootnotes(block.text, noteOrder, makeNoteRef);
        return `<h${level}>${content}</h${level}>`;
      }
      const content = renderInlineWithFootnotes(block.text, noteOrder, makeNoteRef);
      return `<p>${content}</p>`;
    })
    .join('\n');
}

function renderFootnotes(noteOrder, notes) {
  if (!noteOrder.length) {
    return '';
  }

  const items = noteOrder
    .filter((id) => notes.has(id))
    .map((id, index) => {
      const number = index + 1;
      const content = escapeHtml(notes.get(id));
      return `      <li id="fn-${id}" epub:type="footnote"><p>${content}</p></li>`;
    })
    .join('\n');

  return `    <section id="footnotes" epub:type="footnotes">
      <h2>Notes</h2>
      <ol>
${items}
      </ol>
    </section>`;
}

function buildChapterXhtml(title, paragraphsHtml, footnotesHtml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head>
    <title>${escapeHtml(title)}</title>
    <meta charset="utf-8" />
    <link rel="stylesheet" type="text/css" href="styles.css" />
  </head>
  <body>
    <section>
      <h1>${escapeHtml(title)}</h1>
${paragraphsHtml}
${footnotesHtml}
    </section>
  </body>
</html>`;
}

function buildNavXhtml(title) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head>
    <title>Navigation</title>
    <meta charset="utf-8" />
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Table of Contents</h1>
      <ol>
        <li><a href="chapter.xhtml">${escapeHtml(title)}</a></li>
      </ol>
    </nav>
  </body>
</html>`;
}

function buildContentOpf({ title, creator, identifier, coverImage }) {
  const now = new Date().toISOString();
  const coverMeta = coverImage ? '    <meta name="cover" content="cover-image" />\n' : '';
  const coverManifest = coverImage
    ? `    <item id="cover-image" href="${coverImage.href}" media-type="${coverImage.mediaType}" properties="cover-image" />
`
    : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${identifier}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:creator>${escapeHtml(creator)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${now}</meta>
${coverMeta.trimEnd()}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" />
    <item id="css" href="styles.css" media-type="text/css" />
${coverManifest.trimEnd()}
  </manifest>
  <spine>
    <itemref idref="chapter" />
  </spine>
</package>`;
}

function writeStyles() {
  return `body { font-family: serif; line-height: 1.5; }
h1 { text-align: center; margin-bottom: 1.5em; }
h2 { page-break-before: always; break-before: page; margin-top: 2em; }
.footnote-backref { text-decoration: none; }
section#footnotes { border-top: 1px solid #ccc; margin-top: 2em; padding-top: 1em; }`;
}

function findCoverImage(sourcePath) {
  const { dir, name } = path.parse(sourcePath);
  try {
    const siblings = fs.readdirSync(dir);
    for (const file of siblings) {
      const parsed = path.parse(file);
      if (parsed.name !== name) {
        continue;
      }
      const ext = parsed.ext.toLowerCase();
      const mediaType = COVER_MEDIA_TYPES[ext];
      if (!mediaType) {
        continue;
      }
      return {
        absolutePath: path.join(dir, file),
        mediaType,
        extension: ext,
      };
    }
  } catch (error) {
    // If we cannot read the directory, fail silently and continue without a cover.
  }
  return null;
}

function ensureZipAvailable() {
  try {
    execFileSync('zip', ['-v'], { stdio: 'ignore' });
  } catch (error) {
    throw new Error('The "zip" command is required. Please install zip (Info-ZIP) and try again.');
  }
}

function createEpubStructure(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, 'mimetype'), 'application/epub+zip');

  const metaInfPath = path.join(tmpDir, 'META-INF');
  fs.mkdirSync(metaInfPath, { recursive: true });
  fs.writeFileSync(
    path.join(metaInfPath, 'container.xml'),
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`
  );

  const oebpsPath = path.join(tmpDir, 'OEBPS');
  fs.mkdirSync(oebpsPath, { recursive: true });
  return { oebpsPath };
}

function zipEpub(tmpDir, outputPath) {
  const cwd = tmpDir;
  const zipArgsStore = ['-X0', outputPath, 'mimetype'];
  const zipArgsRest = ['-Xr9D', outputPath, 'META-INF', 'OEBPS'];
  execFileSync('zip', zipArgsStore, { cwd, stdio: 'ignore' });
  execFileSync('zip', zipArgsRest, { cwd, stdio: 'ignore' });
}

function convertFile(inputPath, outputPath, options = {}) {
  ensureZipAvailable();

  const sourcePath = path.resolve(inputPath);
  const parsedInput = path.parse(sourcePath);
  const targetPath = outputPath
    ? path.resolve(outputPath)
    : path.join(parsedInput.dir, `${parsedInput.name}.epub`);

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Input file not found: ${sourcePath}`);
  }

  const coverImageOverride = buildCoverDescriptor(options.coverImagePath);
  const coverImage = coverImageOverride || findCoverImage(sourcePath);
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { bodyText, footnotes } = parseFootnotes(raw);
  if (!bodyText) {
    throw new Error('Input file does not contain any body text.');
  }

  const { title, creator, cleanedBody } = extractMetadata(bodyText, {
    title: options.title,
    creator: options.creator,
  });

  if (!title) {
    throw new Error('Could not determine a title from the input file.');
  }
  const effectiveCreator = creator || 'Unknown Author';
  const narrativeBody = cleanedBody || '';

  const noteOrder = [];
  const titleVariants = buildTitleVariants(title);
  const contentHtml = renderContentBlocks(narrativeBody, noteOrder, (id, number) => {
    return `<sup id="fnref-${id}"><a href="#fn-${id}" epub:type="noteref">${number}</a></sup>`;
  }, title, titleVariants);

  const footnotesHtml = renderFootnotes(noteOrder, footnotes);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'epubify-'));
  try {
    const { oebpsPath } = createEpubStructure(tmpDir);
    let coverManifestEntry = null;
    if (coverImage) {
      const coverBasename = `cover${coverImage.extension}`;
      const coverTarget = path.join(oebpsPath, coverBasename);
      try {
        fs.copyFileSync(coverImage.absolutePath, coverTarget);
        coverManifestEntry = { href: coverBasename, mediaType: coverImage.mediaType };
      } catch (error) {
        console.warn(`Failed to copy cover image (${coverImage.absolutePath}): ${error.message}`);
      }
    }

    fs.writeFileSync(path.join(oebpsPath, 'chapter.xhtml'), buildChapterXhtml(title, contentHtml, footnotesHtml));
    fs.writeFileSync(path.join(oebpsPath, 'nav.xhtml'), buildNavXhtml(title));
    fs.writeFileSync(
      path.join(oebpsPath, 'content.opf'),
      buildContentOpf({
        title,
        creator: effectiveCreator,
        identifier: options.identifier || randomUUID(),
        coverImage: coverManifestEntry,
      })
    );
    fs.writeFileSync(path.join(oebpsPath, 'styles.css'), writeStyles());

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
    zipEpub(tmpDir, targetPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return targetPath;
}

function main() {
  const [, , ...args] = process.argv;
  if (!args.length) {
    console.error('Usage: node convert.js <input.txt> [--title "Custom"] [--author "Name"]');
    process.exit(1);
  }
  const [inputArg, ...rest] = args;
  const inputPath = path.resolve(process.cwd(), inputArg);

  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!value) {
      continue;
    }
    if (flag === '--title') {
      options.title = value;
    } else if (flag === '--author') {
      options.creator = value;
    }
  }

  try {
    const outputPath = convertFile(inputPath, undefined, options);
    console.log(`Created EPUB: ${outputPath}`);
  } catch (error) {
    console.error(`Failed to create EPUB: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { convertFile };
