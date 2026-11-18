CREATE VIRTUAL TABLE `library_chunks_fts` USING fts5(
  text, heading, content='library_chunks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `library_chunks_ai` AFTER INSERT ON `library_chunks` BEGIN
  INSERT INTO library_chunks_fts(rowid, text, heading) VALUES (new.id, new.text, coalesce(new.heading,''));
END;
--> statement-breakpoint
CREATE TRIGGER `library_chunks_ad` AFTER DELETE ON `library_chunks` BEGIN
  INSERT INTO library_chunks_fts(library_chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, coalesce(old.heading,''));
END;
--> statement-breakpoint
CREATE TRIGGER `library_chunks_au` AFTER UPDATE ON `library_chunks` BEGIN
  INSERT INTO library_chunks_fts(library_chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, coalesce(old.heading,''));
  INSERT INTO library_chunks_fts(rowid, text, heading) VALUES (new.id, new.text, coalesce(new.heading,''));
END;
