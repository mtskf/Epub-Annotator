#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const StreamZip = require('node-stream-zip');
const TurndownService = require('turndown');

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  allowBooleanAttributes: true,
});

const ensureArray = (value) => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const getTextContent = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = getTextContent(entry);
      if (text) return text;
    }
    return null;
  }
  if (typeof value === 'object') {
    if (typeof value['#text'] === 'string') {
      return value['#text'].trim();
    }
    const possible = Object.values(value)
      .filter((v) => typeof v === 'string')
      .map((v) => v.trim())
      .find((v) => v.length);
    return possible || null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return String(value).trim();
};

const inferImageExtension = (href, mediaType) => {
  if (href) {
    const ext = path.extname(href);
    if (ext) return ext;
  }

  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };

  if (mediaType && map[mediaType]) {
    return map[mediaType];
  }

  return '.img';
};

const mergeSequentialHeadings = (markdown) => {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    const currentMatch = current.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!currentMatch) continue;

    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') {
      j += 1;
    }
    if (j >= lines.length) continue;

    const nextMatch = lines[j].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!nextMatch) continue;
    if (currentMatch[1].length !== nextMatch[1].length) continue;

    lines[i] = `${currentMatch[1]} ${currentMatch[2].trim()} — ${nextMatch[2].trim()}`;
    lines.splice(i + 1, j - i);
    i -= 1;
  }
  return lines.join('\n');
};

const stripQuotes = (value) => value.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();

const shouldDropLine = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return false;

  if (/^cover\s*@page/i.test(trimmed)) {
    return true;
  }

  const normalizedWord = stripQuotes(trimmed).replace(/\s+/g, ' ');
  if (/^unknown$/i.test(normalizedWord)) {
    return true;
  }

  const imageMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/i);
  if (imageMatch) {
    const alt = imageMatch[1].trim().toLowerCase();
    const target = imageMatch[2].trim().toLowerCase();
    if (
      alt.includes('title page') ||
      target.includes('titlepage') ||
      target.includes('title-page') ||
      target.startsWith('data:') ||
      target.startsWith('data-')
    ) {
      return true;
    }
  }

  return false;
};

const cleanMarkdown = (markdown) => {
  const merged = mergeSequentialHeadings(markdown);
  return merged
    .split('\n')
    .filter((line) => !shouldDropLine(line))
    .join('\n');
};

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  strongDelimiter: '**',
  emDelimiter: '*',
});

turndownService.addRule('epubLinks', {
  filter: (node) => node.nodeName === 'A',
  replacement: (content, node) => {
    const href = node.getAttribute ? node.getAttribute('href') : null;
    if (!href) return content;
    const trimmed = href.trim();
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
    if (!isAbsolute || trimmed.startsWith('about:')) {
      return content;
    }
    if (!content) return trimmed;
    return `[${content}](${trimmed})`;
  },
});

turndownService.addRule('shiftHeadings', {
  filter: (node) => /^H[1-6]$/.test(node.nodeName),
  replacement: (content, node) => {
    const level = Math.min(6, parseInt(node.nodeName.substring(1), 10) + 1 || 2);
    const hashes = '#'.repeat(level);
    return `\n\n${hashes} ${content.trim()}\n\n`;
  },
});

const resolveEntryPath = (baseDir, href) => {
  if (!href) return null;
  const safeHref = href.replace(/\\/g, '/');
  if (!baseDir || baseDir === '.' || baseDir === './') {
    return path.posix.normalize(safeHref);
  }
  return path.posix.normalize(`${baseDir.replace(/\\/g, '/')}/${safeHref}`);
};

async function convertEpubToMarkdown(inputPath, outputPath, options = {}) {
  const { coverOutputPath } = options;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  let extractedCoverPath = null;

  const zip = new StreamZip.async({ file: inputPath });
  try {
    const containerXml = (await zip.entryData('META-INF/container.xml')).toString('utf8');
    const container = xmlParser.parse(containerXml);
    const rootfiles = ensureArray(container?.container?.rootfiles?.rootfile);
    if (!rootfiles.length) {
      throw new Error('Could not locate OPF package inside EPUB (missing rootfile).');
    }

    const primaryRoot = rootfiles[0]['full-path'];
    if (!primaryRoot) {
      throw new Error('Invalid container.xml (missing full-path attribute).');
    }

    const opfContent = (await zip.entryData(primaryRoot)).toString('utf8');
    const opf = xmlParser.parse(opfContent);
    const opfPackage = opf?.package;
    if (!opfPackage) {
      throw new Error('Invalid OPF file (missing <package>).');
    }

    const metadata = opfPackage.metadata || {};
    const manifestItems = ensureArray(opfPackage.manifest?.item);
    const spineItems = ensureArray(opfPackage.spine?.itemref);
    if (!manifestItems.length || !spineItems.length) {
      throw new Error('OPF manifest or spine is empty.');
    }

    const manifestMap = new Map();
    for (const item of manifestItems) {
      manifestMap.set(item.id, item);
    }

    const titleFromOpf =
      getTextContent(metadata['dc:title']) ||
      getTextContent(metadata.title) ||
      path.parse(inputPath).name;
    const authorFromOpf =
      getTextContent(metadata['dc:creator']) ||
      getTextContent(metadata['dc:author']) ||
      'Unknown Author';

    const opfDir = path.posix.dirname(primaryRoot);
    const chunks = [];

    const metadataMeta = ensureArray(metadata.meta);
    let coverItem = null;
    for (const meta of metadataMeta) {
      const nameAttr = meta?.name || meta?.property;
      if (nameAttr === 'cover' && meta?.content && manifestMap.has(meta.content)) {
        coverItem = manifestMap.get(meta.content);
        break;
      }
    }
    if (!coverItem) {
      coverItem = manifestItems.find((item) => {
        if (!item?.properties) return false;
        return item.properties.split(/\s+/).includes('cover-image');
      }) || null;
    }

    for (const spineItem of spineItems) {
      if (spineItem.linear === 'no') continue;
      const manifestItem = manifestMap.get(spineItem.idref);
      if (!manifestItem) continue;
      if (manifestItem['media-type'] && !manifestItem['media-type'].includes('html')) continue;

      const entryPath = resolveEntryPath(opfDir, manifestItem.href);
      if (!entryPath) continue;

      let html;
      try {
        html = (await zip.entryData(entryPath)).toString('utf8');
      } catch (err) {
        console.warn(`Warning: unable to read ${entryPath}: ${err.message}`);
        continue;
      }

      const markdown = cleanMarkdown(turndownService.turndown(html)).trim();

      if (markdown) {
        chunks.push(markdown);
      }
    }

    if (!chunks.length) {
      throw new Error('No textual spine items found in EPUB.');
    }

    const body = chunks.join('\n\n');
    const lines = [`# ${titleFromOpf}`, authorFromOpf];
    if (body) {
      lines.push('', body);
    }

    await fs.promises.writeFile(outputPath, lines.join('\n'), 'utf8');

    if (coverItem && coverItem.href) {
      const coverEntryPath = resolveEntryPath(opfDir, coverItem.href);
      if (coverEntryPath) {
        try {
          const coverData = await zip.entryData(coverEntryPath);
          const coverExt = inferImageExtension(coverItem.href, coverItem['media-type']);
          let coverTargetPath;
          if (coverOutputPath) {
            coverTargetPath = path.extname(coverOutputPath)
              ? coverOutputPath
              : `${coverOutputPath}${coverExt}`;
          } else {
            coverTargetPath = path.join(
              path.dirname(outputPath),
              `${path.parse(inputPath).name}${coverExt}`
            );
          }
          await fs.promises.mkdir(path.dirname(coverTargetPath), { recursive: true });
          await fs.promises.writeFile(coverTargetPath, coverData);
          extractedCoverPath = coverTargetPath;
        } catch (err) {
          console.warn(`Warning: unable to extract cover image ${coverEntryPath}: ${err.message}`);
        }
      }
    }
  } finally {
    await zip.close();
  }

  return { markdownPath: outputPath, coverPath: extractedCoverPath };
}

async function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    console.error('Usage: epub2txt <input.epub> [output.md]');
    process.exit(1);
  }

  const inputPath = path.resolve(process.cwd(), inputArg);
  const inputDir = path.dirname(inputPath);
  const outputName = outputArg ? path.parse(outputArg).base : `${path.parse(inputPath).name}.md`;
  const outputPath = path.join(inputDir, outputName);

  try {
    await convertEpubToMarkdown(inputPath, outputPath);
    console.log(`Converted ${inputPath} -> ${outputPath}`);
  } catch (err) {
    console.error(`Conversion failed: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { convertEpubToMarkdown };
