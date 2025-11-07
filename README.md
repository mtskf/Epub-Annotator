# Epub Annotator

Convert any `.epub`, `.md`, or `.txt` into an annotated EPUB with one command. The tool unpacks the book (if needed), adds AI-generated learning footnotes, and rebuilds an EPUB with the original cover.

## Requirements

- Node.js 20+
- `zip` command on your PATH
- `OPENAI_API_KEY` defined in the shell **or** in `.env` (auto-loaded)

## Setup

```bash
npm install
# create .env with your API key
echo "OPENAI_API_KEY=sk-..." >> .env
```

## Usage

```bash
# Annotate the sample EPUB (Markdown/plain text works the same way)
npx epub-annotator ./sample/sample.epub
```

Output written next to the source file:

- `sample_annotated.epub` – final learner-friendly EPUB
- The annotated manuscript (`_annotated.txt`) plus temporary Markdown/cover files stay inside `.cache/sample.cache/` and are removed automatically after a successful run.

### Options

```
epub-annotator <input.(epub|md|txt)> [--no-resume] [--chunk-tokens N]
```

- `--no-resume` re-annotates every chunk instead of using cached results.
- `--chunk-tokens N` overrides the token budget sent to the OpenAI API.
- `--keep-temp` keeps everything in `.cache/<book>.cache/` (Markdown, cover, annotated text, chunk caches) for inspection; by default they are deleted after success.

## Behind the scenes

1. **EPUB handling** – Parses OPF metadata, normalises headings, removes boilerplate text, and extracts the cover image.
2. **Annotation** – Splits the manuscript into token-aware chunks and adds emoji-prefixed Obsidian footnotes; caches chunks under `.cache/<book>.cache/`.
3. **EPUB rebuild** – Converts the annotated text back into a valid EPUB 3, reusing the cover art when available. The intermediate annotated text stays under `.cache/<book>.cache/`.

## Environment knobs

`src/annotate.mjs` recognises extra settings via `.env`, e.g. `MODEL_NAME`, `ANNOTATION_TEMPERATURE`, `KEEP_CHUNKS`, `VOCAB_MEMORY_STORE_LIMIT`, `FOOTNOTE_MARGIN_TOKENS`. See that file for defaults.

## Troubleshooting

- Install `zip` if it’s missing (`brew install zip`, `apt install zip`, …).
- If annotation exits immediately, confirm `OPENAI_API_KEY` is set or present in `.env`.
- Stuck chunks? Remove `.cache/<book>.cache/` or pass `--no-resume`.

MIT License.
