"""Tests of pgm_backup.py pieces that need no server: python3 -m unittest automation-ha/upgrade/test_pgm_backup.py"""
import configparser
import importlib.util
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("pgm_backup", os.path.join(os.path.dirname(__file__), "pgm_backup.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def cp_of(text):
    c = configparser.RawConfigParser(strict=False, interpolation=None)
    c.optionxform = str
    c.read_string(text)
    return c


class Helpers(unittest.TestCase):
    def test_mask_hides_secrets_only(self):
        t = "[global]\nrepo2-s3-key=AKIA\nrepo2-s3-key-secret=xyz\nrepo2-s3-key-type=shared\nrepo1-cipher-pass=pw\nrepo1-path=/r\n"
        out = m.mask(t)
        self.assertIn("repo2-s3-key=********", out)
        self.assertIn("repo2-s3-key-secret=********", out)
        self.assertIn("repo1-cipher-pass=********", out)
        self.assertIn("repo2-s3-key-type=shared", out)
        self.assertIn("repo1-path=/r", out)

    def test_put_and_drop_block(self):
        base = "[global]\nrepo1-path=/r\n\n[main]\npg1-path=/d\n"
        t = m.put_block(base, 2, "[global]\nrepo2-type=s3\nrepo2-s3-bucket=b\n")
        c = cp_of(t)
        self.assertEqual(c.get("global", "repo2-type"), "s3")
        self.assertEqual(c.get("main", "pg1-path"), "/d")
        self.assertEqual(m.put_block(t, 2, "[global]\nrepo2-type=s3\nrepo2-s3-bucket=b\n").count("repository 2"), 2)  # replaced, not added
        back = m.drop_block(t, 2)
        self.assertNotIn("repo2", back)
        self.assertIn("pg1-path=/d", back)
        self.assertTrue(m.put_block("", 3, "[global]\nrepo3-path=/x\n").startswith("[global]\n"))

    def test_repo_text_s3(self):
        d = {"type": "s3", "bucket": "b", "endpoint": "s3.example.com", "region": "r", "key": "k", "secret": "s",
             "verify_tls": "n", "retention_full": "2", "path": "/pg"}
        t = m.repo_text(d, 2, cp_of("[global]\nrepo1-path=/r\n"), "main", "")
        c = cp_of(t)
        self.assertEqual(c.get("global", "repo2-type"), "s3")
        self.assertEqual(c.get("global", "repo2-s3-key-secret"), "s")
        self.assertEqual(c.get("global", "repo2-storage-verify-tls"), "n")
        self.assertEqual(c.get("global", "repo2-retention-full"), "2")

    def test_repo_text_disk_through_repo_server(self):
        old = cp_of("[global]\nrepo1-host=backup1\nrepo1-host-user=pgbackrest\n[main]\npg1-path=/d\n")
        c = cp_of(m.repo_text({"type": "posix", "path": "/disk2/pgbackrest"}, 2, old, "main", "backup1"))
        self.assertEqual(c.get("global", "repo2-host"), "backup1")
        self.assertEqual(c.get("global", "repo2-host-user"), "pgbackrest")
        self.assertEqual(c.get("global", "repo2-path"), "/disk2/pgbackrest")

    def test_repo_text_rejects_bad_input(self):
        with self.assertRaises(SystemExit):
            m.repo_text({"type": "posix", "path": "relative"}, 2, cp_of("[global]\n"), "main", "")
        with self.assertRaises(SystemExit):
            m.repo_text({"type": "s3", "bucket": "b"}, 2, cp_of("[global]\n"), "main", "")
        with self.assertRaises(SystemExit):
            m.repo_text({"type": "posix", "path": "/a\nrepo1-path=/evil"}, 2, cp_of("[global]\n"), "main", "")

    def test_conf_file_value(self):
        with tempfile.NamedTemporaryFile("w", suffix=".conf", delete=False) as f:
            f.write("port = 5433\narchive_command = 'pgbackrest --config=/etc/x.conf --stanza=main archive-push %p'\n#port=1\n")
        try:
            self.assertEqual(m.conf_file_value(f.name, "port", True), "5433")
            self.assertEqual(m.conf_file_value(f.name, "port"), "")
            self.assertIn("--config=/etc/x.conf", m.conf_file_value(f.name, "archive_command"))
        finally:
            os.unlink(f.name)

    def test_options_regex(self):
        t = "pgbackrest --config=/etc/pgbackrest/prod.conf --config-include-path '/etc/pg.d' --stanza=main archive-push %p"
        opts = {g.group(1): g.group(3) for g in m.OPT_RE.finditer(t)}
        self.assertEqual(opts, {"config": "/etc/pgbackrest/prod.conf", "config-include-path": "/etc/pg.d"})


if __name__ == "__main__":
    unittest.main()
