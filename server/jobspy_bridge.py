"""JSON-lines worker. Receives explicit search preferences, never a resume or API key."""
import contextlib
import importlib.metadata
import json
import sys
import time

SITES = {"indeed": "indeed", "ziprecruiter": "zip_recruiter"}
FIELDS = ["title", "company", "location", "job_url", "description", "date_posted", "job_type", "is_remote"]


def emit(event):
    print(json.dumps(event, ensure_ascii=True, allow_nan=False), flush=True)


def run(payload, scrape_jobs, pause=time.sleep):
    kind = payload.get("kind")
    if kind not in SITES:
        raise ValueError("JobSpy is enabled only for Indeed and ZipRecruiter.")
    queries = payload.get("queries")
    if not isinstance(queries, list) or not 1 <= len(queries) <= 6:
        raise ValueError("Provide one to six search queries.")
    wanted = max(1, min(200, int(payload.get("resultsWanted", 60))))
    site = SITES[kind]
    for index, query in enumerate(queries):
        if index:
            pause(1.5)
        try:
            # The library's diagnostic prints must not corrupt our JSON protocol.
            with contextlib.redirect_stdout(sys.stderr):
                frame = scrape_jobs(
                    site_name=[site],
                    search_term=str(query.get("keywords", "internship"))[:512],
                    location=str(query.get("location", ""))[:200] or None,
                    job_type="internship",
                    results_wanted=wanted,
                    hours_old=168,
                    country_indeed=str(payload.get("country", "USA"))[:60],
                    is_remote=bool(payload.get("remoteOnly", False)),
                    description_format="plain",
                    fetch_description=False,
                    verbose=0,
                    proxies=None,
                )
            errors = frame.attrs.get("errors", {})
            warnings = frame.attrs.get("warnings", {}).get(site, [])
            if isinstance(warnings, str):
                warnings = [warnings]
            # DataFrame JSON serialization handles dates and missing/NaN values.
            selected = frame.head(wanted).reindex(columns=FIELDS)
            rows = json.loads(selected.to_json(orient="records", date_format="iso"))
            for row in rows:
                if isinstance(row.get("description"), str):
                    row["description"] = row["description"][:60000]
            error = errors.get(site)
            emit({"type": "query", "rows": rows, "warnings": [str(w)[:500] for w in warnings][:10], "error": str(error)[:500] if error else None})
            if error:
                break
        except Exception as error:
            emit({"type": "query", "rows": [], "warnings": [], "error": str(error)[:500]})
            break
    emit({"type": "complete"})


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            from jobspy import scrape_jobs
        if "--check" in sys.argv:
            emit({"type": "ready", "version": importlib.metadata.version("python-jobspy")})
        else:
            raw = sys.stdin.read(16385)
            if len(raw) > 16384:
                raise ValueError("Search input exceeds the limit.")
            run(json.loads(raw), scrape_jobs)
    except ImportError:
        emit({"type": "error", "error": "JobSpy is not installed in the configured Python environment. Run the JobSpy setup script."})
        sys.exit(2)
    except Exception as error:
        emit({"type": "error", "error": str(error)[:500]})
        sys.exit(2)
