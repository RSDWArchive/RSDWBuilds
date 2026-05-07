# Drop .zip submissions here.

Each zip must match the format produced by /submit/ on the site:

    <dataset>/<slug>/build.json
    <dataset>/<slug>/<images...>
    <dataset>/<slug>/<download file>

where <dataset> is "builds" or "prefabs". Then run:

    python tools/process_submissions.py

Each zip is extracted directly into website/data/<dataset>/<slug>/, validated,
and (on success) the dataset's index.json is rebuilt and the zip is moved to
staging/incoming/_processed/<timestamp>/. On failure the extracted folder is
removed and the zip is left here so you can fix it and retry.
