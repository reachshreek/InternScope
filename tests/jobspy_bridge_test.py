import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "server" / "jobspy_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Frame:
    def __init__(self, rows=None, errors=None, warnings=None):
        self.rows = rows or []
        self.attrs = {"errors": errors or {}, "warnings": warnings or {}}

    def head(self, limit):
        return self

    def reindex(self, columns):
        self.columns = columns
        return self

    def to_json(self, **options):
        return json.dumps(self.rows)


class BridgeTests(unittest.TestCase):
    def execute(self, payload, frames):
        calls = []
        def scrape(**kwargs):
            calls.append(kwargs)
            return frames.pop(0)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            bridge.run(payload, scrape, pause=lambda _: None)
        return calls, [json.loads(line) for line in output.getvalue().splitlines()]

    def test_site_mapping_and_private_input_exclusion(self):
        for kind, site in [("indeed", "indeed"), ("ziprecruiter", "zip_recruiter")]:
            calls, events = self.execute({"kind": kind, "queries": [{"keywords": "software internship", "location": "CA"}], "resume": "PRIVATE", "apiKey": "SECRET"}, [Frame()])
            self.assertEqual(calls[0]["site_name"], [site])
            self.assertEqual(calls[0]["hours_old"], 168)
            self.assertEqual(calls[0]["job_type"], "internship")
            self.assertFalse(calls[0]["fetch_description"])
            self.assertNotIn("PRIVATE", json.dumps(calls))
            self.assertNotIn("SECRET", json.dumps(calls))
            self.assertEqual(events[-1]["type"], "complete")

    def test_errors_stop_queries_and_are_explicit(self):
        calls, events = self.execute({"kind": "ziprecruiter", "queries": [{}, {}]}, [Frame(errors={"zip_recruiter": "HTTP 403"})])
        self.assertEqual(len(calls), 1)
        self.assertEqual(events[0]["error"], "HTTP 403")

    def test_completed_queries_are_emitted_before_later_failure(self):
        calls, events = self.execute({"kind": "indeed", "queries": [{}, {}]}, [Frame(rows=[{"title": "Intern"}]), Frame(errors={"indeed": "HTTP 429"})])
        self.assertEqual(len(calls), 2)
        self.assertEqual(events[0]["rows"], [{"title": "Intern"}])
        self.assertEqual(events[1]["error"], "HTTP 429")

    def test_invalid_sites_and_unbounded_queries_are_rejected(self):
        for payload in [{"kind": "linkedin", "queries": [{}]}, {"kind": "indeed", "queries": [{}] * 7}]:
            with self.assertRaises(ValueError):
                bridge.run(payload, lambda **_: None)


if __name__ == "__main__":
    unittest.main()
