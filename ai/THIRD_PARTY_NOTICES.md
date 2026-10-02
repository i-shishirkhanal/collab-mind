# Third-Party Notices — AI Service

Document extraction in the `ai/` service uses open-source libraries, consumed
as pinned pip dependencies (`requirements.txt`). **No upstream source code is
copied, vendored or modified in this repository.**

## MarkItDown

- **Source**: https://github.com/microsoft/markitdown
- **Version**: `markitdown==0.1.8`, installed with the extras
  `pdf,docx,pptx,xlsx,xls`
- **License**: MIT (verified from the package metadata and upstream
  `pyproject.toml`)
- **Used by**: `rag/extractor.py`, which converts PDF / DOCX / PPTX / XLSX /
  XLS / HTML / CSV / JSON / Markdown / text to markdown, then splits the result
  into page / slide / sheet / section blocks so citations can point at a real
  location.
- **Parts of the upstream repository not used**: the `markitdown-mcp` server,
  the sample plugins, the OCR / Azure Document Intelligence / audio
  transcription / YouTube / Outlook converters. Plugins are explicitly disabled
  (`enable_plugins=False`) and MarkItDown is never given a URL to fetch — web
  pages are downloaded by our own SSRF-guarded fetcher and passed in as bytes.

## Licenses of the dependencies MarkItDown brings in

Read from the installed package metadata (not assumed):

| Package | Version | License |
|---|---|---|
| pdfminer.six | 20260107 | MIT |
| pdfplumber | 0.11.10 | MIT |
| mammoth | 1.11.0 | BSD-2-Clause |
| python-pptx | 1.0.2 | MIT |
| openpyxl | 3.1.5 | MIT |
| pandas | 3.0.6 | BSD-3-Clause |
| xlrd | 2.0.2 | BSD |
| lxml | 6.1.3 | BSD-3-Clause |
| magika | 0.6.3 | Apache-2.0 |
| onnxruntime | 1.30.0 | MIT |
| beautifulsoup4 | 4.15.0 | MIT |
| markdownify | 1.2.3 | MIT |
| charset-normalizer | 3.5.2 | MIT |
| defusedxml | 0.7.1 | PSF-2.0 |

All are permissive licenses. None imposes copyleft or an online-service
attribution requirement; keep the packages' own license files intact (pip does
this when installing).

## Re-check when upgrading

Versions are pinned; re-run the license read-out above after any upgrade of
`markitdown` or its extras, since transitive dependencies can change license.
