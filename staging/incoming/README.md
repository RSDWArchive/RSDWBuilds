# Drop .zip submissions here.

This folder is the private publishing queue used by the approved contributor
upload page. It is intentionally outside `website/` so queued and processed
submission zips are not deployed to GitHub Pages.

Each zip must match the format produced by `/submit/` on the site:

```text
<dataset>/<slug>/build.json
<dataset>/<slug>/<images...>
<dataset>/<slug>/<download file>
```

where `<dataset>` is `builds` or `prefabs`. Then run:

```powershell
python tools/process_submissions.py
```

On success, files are extracted into `website/data/<dataset>/<slug>/`, the
dataset index is rebuilt, and the zip is moved to
`staging/incoming/_processed/<timestamp>/`.
