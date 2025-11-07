#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { convertEpubToMarkdown } = require('./epub2md');
const { convertFile } = require('./epubgen');
const { promptYesNo } = require('./prompt');

const CACHE_ROOT = path.resolve(process.cwd(), '.cache');
fs.mkdirSync(CACHE_ROOT, { recursive: true });
const annotateModuleUrl = pathToFileURL(path.join(__dirname, 'annotate.mjs')).href;
let annotatorModulePromise;

function baseCacheDirForInput(inputPath) {
  const absolute = path.resolve(inputPath);
  const { name } = path.parse(absolute);
  const safeName = (name || 'input').replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(CACHE_ROOT, `${safeName}.cache`);
}

function buildPipelinePaths(inputPath) {
  const absolute = path.resolve(inputPath);
  const parsed = path.parse(absolute);
  const baseCacheDir = baseCacheDirForInput(absolute);
  const pipelineDir = path.join(baseCacheDir, 'pipeline');
  const markdownPath = path.join(pipelineDir, `${parsed.name}.md`);
  const coverBasePath = path.join(pipelineDir, 'cover');
  const annotatedPath = path.join(baseCacheDir, `${parsed.name}_annotated.txt`);
  const finalEpubPath = resolveOutputPath(parsed.dir, parsed.name, '.epub');
  return {
    absolute,
    parsed,
    baseCacheDir,
    pipelineDir,
    markdownPath,
    coverBasePath,
    annotatedPath,
    finalEpubPath,
  };
}

function printUsage() {
  console.log('Usage: epub2txt <input.(epub|md|txt)> [--no-resume] [--chunk-tokens N]');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { resume: true, chunkTokens: undefined, input: null, help: false, keepTemp: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--no-resume') {
      options.resume = false;
      continue;
    }
    if (arg === '--chunk-tokens') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--chunk-tokens requires a numeric value');
      }
      const numeric = Number.parseInt(value, 10);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        throw new Error('Chunk token limit must be a positive integer');
      }
      options.chunkTokens = numeric;
      i += 1;
      continue;
    }
    if (arg === '--keep-temp') {
      options.keepTemp = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!options.input) {
      options.input = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function loadAnnotatorModule() {
  if (!annotatorModulePromise) {
    annotatorModulePromise = import(annotateModuleUrl);
  }
  return annotatorModulePromise;
}

async function annotateTextFile(inputPath, options) {
  const { resume, chunkTokens, cacheBaseDir, outputPath, forceOverwrite, preserveChunks } = options;
  const annotator = await loadAnnotatorModule();
  if (chunkTokens && typeof annotator.setChunkTokenLimit === 'function') {
    annotator.setChunkTokenLimit(chunkTokens);
  }
  if (typeof annotator.processFile !== 'function') {
    throw new Error('annotate.mjs must export processFile()');
  }
  const annotatedPath = await annotator.processFile(inputPath, {
    resume,
    cacheBaseDir,
    outputPath,
    forceOverwrite,
    preserveChunks,
  });
  if (!annotatedPath) {
    throw new Error('Annotator did not return an output path.');
  }
  return annotatedPath;
}

function ensureInputExists(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
}

function resolveOutputPath(baseDir, baseName, extension = '.epub') {
  return path.join(baseDir, `${baseName}_annotated${extension}`);
}

function nextAvailablePath(targetPath) {
  let candidate = targetPath;
  let counter = 1;
  while (fs.existsSync(candidate)) {
    const parsed = path.parse(targetPath);
    candidate = path.join(parsed.dir, `${parsed.name}(${counter})${parsed.ext}`);
    counter += 1;
  }
  return candidate;
}

async function orchestrate({ input, resume, chunkTokens, keepTemp }) {
  if (!input) {
    throw new Error('Missing input file.');
  }

  const absoluteInput = path.resolve(process.cwd(), input);
  ensureInputExists(absoluteInput);
  const stats = fs.statSync(absoluteInput);
  if (stats.isDirectory()) {
    throw new Error('Input path points to a directory. Please provide a .epub/.md/.txt file.');
  }

  const paths = buildPipelinePaths(absoluteInput);
  const {
    parsed: parsedInput,
    baseCacheDir,
    pipelineDir,
    markdownPath,
    coverBasePath,
    annotatedPath: draftAnnotatedPath,
    finalEpubPath,
  } = paths;
  const ext = parsedInput.ext.toLowerCase();
  let targetPath = finalEpubPath;
  if (fs.existsSync(targetPath)) {
    console.warn(`Output exists: ${path.basename(targetPath)}`);
    const overwrite = await promptYesNo(`Overwrite existing file '${path.basename(targetPath)}'?`);
    if (!overwrite) {
      const nextPath = nextAvailablePath(targetPath);
      console.log(`Writing to ${path.basename(nextPath)} instead.`);
      targetPath = nextPath;
    }
  }

  let cleanupPipelineCache = false;
  let usedPipelineCache = false;
  let cleanupBaseDir = false;
  const cleanupEnabled = !keepTemp;

  let markdownSource = absoluteInput;
  let coverOverridePath = null;

  try {
    if (ext === '.epub') {
      usedPipelineCache = true;
      cleanupBaseDir = cleanupEnabled;
      await fs.promises.mkdir(pipelineDir, { recursive: true });
      console.log(`🗃️  Converting EPUB -> Markdown: ${path.basename(markdownPath)}`);
      const { markdownPath: convertedMarkdownPath, coverPath } = await convertEpubToMarkdown(
        absoluteInput,
        markdownPath,
        { coverOutputPath: coverBasePath }
      );
      markdownSource = convertedMarkdownPath;
      coverOverridePath = coverPath || null;
    } else if (ext === '.md' || ext === '.txt') {
      console.log('📝 Using provided text file directly.');
      cleanupBaseDir = cleanupEnabled;
    } else {
      throw new Error('Unsupported input type. Provide an .epub, .md, or .txt file.');
    }

    console.log('✍️  Annotating text (this may take a while)...');
    const annotatedPath = await annotateTextFile(markdownSource, {
      resume,
      chunkTokens,
      cacheBaseDir: baseCacheDir,
      outputPath: draftAnnotatedPath,
      forceOverwrite: true,
      preserveChunks: keepTemp,
    });

    console.log('📦 Building annotated EPUB...');
    convertFile(annotatedPath, targetPath, { coverImagePath: coverOverridePath });

    if (!keepTemp && annotatedPath.startsWith(baseCacheDir)) {
      try {
        await fs.promises.rm(annotatedPath, { force: true });
      } catch (error) {
        console.warn(`Could not remove temporary annotated text ${annotatedPath}: ${error.message}`);
      }
    }

    if (cleanupEnabled && usedPipelineCache) {
      cleanupPipelineCache = true;
    }

    console.log(`✅ Done: ${targetPath}`);
    return targetPath;
  } finally {
    if (cleanupPipelineCache && usedPipelineCache) {
      try {
        await fs.promises.rm(pipelineDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`Could not clean pipeline cache ${pipelineDir}: ${error.message}`);
      }
    }
    if (cleanupBaseDir) {
      try {
        const remaining = await fs.promises.readdir(baseCacheDir);
        if (!remaining.length) {
          await fs.promises.rmdir(baseCacheDir);
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) {
          console.warn(`Could not clean cache directory ${baseCacheDir}: ${error.message}`);
        }
      }
    }
  }
}

async function runCli() {
  try {
    const options = parseArgs(process.argv);
    if (options.help || !options.input) {
      printUsage();
      if (options.help) {
        process.exit(0);
      } else {
        process.exit(1);
      }
    }
    await orchestrate(options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = { runCli, orchestrate };
