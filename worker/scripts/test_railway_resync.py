import sqlite3
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import railway_resync as rr  # noqa: E402

COLS = ["id", "user_id", "short_code", "view_count", "last_viewed_at", "created_at"]
DDL = """CREATE TABLE file_assets (id TEXT PRIMARY KEY NOT NULL, user_id TEXT, short_code TEXT NOT NULL,
  view_count INTEGER DEFAULT 0, last_viewed_at TEXT, created_at TEXT);
CREATE UNIQUE INDEX uq_code ON file_assets (short_code);"""


def src_row(i, views, last=None):
    return {"id": f"id-{i}", "user_id": "u1", "short_code": f"code{i}", "view_count": views, "last_viewed_at": last,
            "created_at": rr.convert("2026-11-01T10:00:00.123456+00:00", "timestamp with time zone")}


def d1_rows(db):
    db.row_factory = sqlite3.Row
    return [dict(r) for r in db.execute("SELECT id, view_count, last_viewed_at FROM file_assets")]


class Convert(unittest.TestCase):
    def test_types_follow_the_d1_conventions(self):
        self.assertEqual(rr.ts_text(rr.convert("2026-11-01T10:00:00.123456+05:30", "timestamp with time zone")), "2026-11-01T04:30:00.123Z")
        self.assertEqual(rr.ts_text(rr.convert("2026-11-01T10:00:00", "timestamp without time zone")), "2026-11-01T10:00:00.000Z")
        self.assertEqual(rr.convert({"a": 1}, "jsonb"), '{"a":1}')
        self.assertEqual(rr.convert("abc", "jsonb"), '"abc"')  # a JSON string stays valid JSON text
        self.assertEqual(rr.convert("\\x00ff", "bytea"), b"\x00\xff")
        self.assertEqual(rr.convert("ABC-DEF", "uuid"), "abc-def")
        self.assertIsNone(rr.convert(None, "jsonb"))


class Merge(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(DDL)

    def run_merge(self, src):
        d1 = d1_rows(self.db)
        p = rr.plan_table(src, d1, COLS, ["id"], "file_assets")
        stmts = rr.insert_sql("file_assets", COLS, p["new"]) + [rr.bump_sql("file_assets", ["id"], r) for r in p["bumps"]]
        self.db.executescript("".join(stmts))
        return p

    def test_adds_missing_rows_keeps_target_only_rows_and_is_idempotent(self):
        self.db.execute("INSERT INTO file_assets VALUES ('worker-only', 'u9', 'wo', 7, NULL, 't')")
        self.db.execute("INSERT INTO file_assets VALUES ('id-1', 'u1', 'code1', 5, '2026-11-02T00:00:00.000Z', 't')")
        src = [src_row(1, 3, "2026-11-01T00:00:00.000Z"), src_row(2, 4, "2026-11-03T00:00:00.000Z")]

        first = self.run_merge(src)
        self.assertEqual([r["id"] for r in first["new"]], ["id-2"])
        self.assertEqual(first["bumps"], [])  # Railway 3 < D1 5: the Worker's own views are not lost
        ids = sorted(r["id"] for r in d1_rows(self.db))
        self.assertEqual(ids, ["id-1", "id-2", "worker-only"])

        second = self.run_merge(src)  # nothing left to do
        self.assertEqual((second["new"], second["bumps"]), ([], []))
        self.assertEqual(len(d1_rows(self.db)), 3)

    def test_counter_only_goes_up(self):
        self.db.execute("INSERT INTO file_assets VALUES ('id-1', 'u1', 'code1', 5, '2026-11-02T00:00:00.000Z', 't')")
        p = self.run_merge([src_row(1, 9, "2026-11-05T00:00:00.000Z")])
        self.assertEqual(len(p["bumps"]), 1)
        row = d1_rows(self.db)[0]
        self.assertEqual((row["view_count"], row["last_viewed_at"]), (9, "2026-11-05T00:00:00.000Z"))
        self.run_merge([src_row(1, 2, "2026-11-01T00:00:00.000Z")])
        row = d1_rows(self.db)[0]
        self.assertEqual((row["view_count"], row["last_viewed_at"]), (9, "2026-11-05T00:00:00.000Z"))

    def test_overlap_differences_are_reported_per_column(self):
        self.db.execute("INSERT INTO file_assets VALUES ('id-1', 'other-user', 'code1', 0, NULL, '2026-11-01T10:00:00.123Z')")
        p = rr.plan_table([src_row(1, 0)], rr_rows(self.db), COLS, ["id"], "file_assets")
        self.assertEqual(p["diff_cols"], {"user_id": 1})  # created_at matches after the ms normalisation

    def test_new_rows_follow_a_user_merge_done_on_the_worker_side(self):
        self.db.execute("INSERT INTO file_assets VALUES ('id-1', 'merged-into', 'code1', 0, NULL, 't')")
        p = rr.plan_table([src_row(1, 0), src_row(2, 0)], rr_rows(self.db), COLS, ["id"], "file_assets")
        remap, ambiguous = rr.owner_remap(p["owners"])
        self.assertEqual((remap, ambiguous), ({"u1": "merged-into"}, []))
        self.assertEqual(rr.remap_owners(p["new"], remap), 1)
        self.assertEqual(p["new"][0]["user_id"], "merged-into")
        self.assertEqual(rr.owner_remap(rr.Counter({("a", "x"): 1, ("a", "y"): 1}))[1], ["a"])

    def test_undo_sql_deletes_exactly_the_inserted_keys(self):
        self.run_merge([src_row(1, 1), src_row(2, 1)])
        self.db.execute("INSERT INTO file_assets VALUES ('worker-only', 'u9', 'wo', 0, NULL, 't')")
        self.db.executescript("".join(rr.delete_sql("file_assets", ["id"], [("id-1",), ("id-2",)])))
        self.assertEqual([r["id"] for r in d1_rows(self.db)], ["worker-only"])


def rr_rows(db):
    db.row_factory = sqlite3.Row
    return [dict(r) for r in db.execute("SELECT * FROM file_assets")]


class Blobs(unittest.TestCase):
    def test_copies_missing_and_resized_only_and_latest_upload_wins(self):
        src = [
            {"filename": "a", "length": 10, "uploadDate": "2026-01-01T00:00:00Z"},
            {"filename": "b", "length": 20, "uploadDate": "2026-01-01T00:00:00Z"},
            {"filename": "c", "length": 30, "uploadDate": "2026-01-01T00:00:00Z"},
            {"filename": "c", "length": 31, "uploadDate": "2026-02-01T00:00:00Z"},
        ]
        todo = rr.blobs_to_copy(src, {"a": 10, "b": 99, "extra": 5})
        self.assertEqual(sorted((f["filename"], f["length"]) for f in todo), [("b", 20), ("c", 31)])

    def test_sql_files_stay_under_the_size_cap(self):
        files = rr.chunk_files(["x" * 1_000_000 + "\n"] * 9)
        self.assertEqual(len(files), 3)
        self.assertTrue(all(len(f) < rr.MAX_FILE_BYTES + 100 for f in files))
        self.assertTrue(all(f.startswith("PRAGMA defer_foreign_keys = true;") for f in files))


class Guards(unittest.TestCase):
    def test_production_write_needs_the_confirm_flag(self):
        with self.assertRaises(SystemExit) as cm:
            sys.argv = ["railway_resync.py", "--target", "production", "--apply"]
            rr.main()
        self.assertIn("--confirm-production", str(cm.exception))

    def test_undo_refuses_production(self):
        with self.assertRaises(SystemExit) as cm:
            sys.argv = ["railway_resync.py", "--target", "production", "--undo", "x.json"]
            rr.main()
        self.assertIn("staging only", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
