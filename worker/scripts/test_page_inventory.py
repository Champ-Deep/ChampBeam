import json, sqlite3, subprocess, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).parent


class Inventory(unittest.TestCase):
    def test_counts_blobs_and_redaction(self):
        with tempfile.TemporaryDirectory() as d:
            p, b = f"{d}/s.sqlite", f"{d}/blobs.txt"
            db = sqlite3.connect(p)
            db.executescript("""
              CREATE TABLE file_assets (id TEXT, user_id TEXT, organization_id TEXT, status TEXT, kind TEXT,
                storage_key TEXT, created_at TEXT, share_intent TEXT, slug TEXT, filename TEXT, short_code TEXT);
              CREATE TABLE file_versions (file_id TEXT);
              INSERT INTO file_assets VALUES
                ('1','alice@example.com','org1','active','html','k/secret-name.html','2026-09-01',NULL,NULL,'secret-name.html','abc12345'),
                ('2','alice@example.com','org1','active','html','k/page','2026-09-02','host','my-page','p.html','def67890'),
                ('3','bob','','deleted','pdf','k/gone','2026-09-03','download',NULL,'x.pdf','ghi');
              INSERT INTO file_versions VALUES ('2');
            """)
            db.commit()
            Path(b).write_text("k/page\nk/unreferenced\n")
            out = subprocess.run([sys.executable, str(HERE / "page_inventory.py"), p, "--source", "t", "--blobs", b, "--salt", "s"],
                                 capture_output=True, text=True, check=True).stdout
            m = json.loads(out)
            s = m["summary"]
            self.assertEqual((s["rows"], s["legacy_html_under_files"], s["active_rows_missing_blob"], s["html_without_version_row"]), (3, 1, 1, 1))
            self.assertEqual(m["orphan_blob_keys"], 1)
            for leak in ("alice", "example.com", "secret-name", "abc12345", "my-page", "k/page"):
                self.assertNotIn(leak, out)


if __name__ == "__main__":
    unittest.main()
