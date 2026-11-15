-- Since 0.6.0 the map draws screens at their real size (about five times larger than before), so
-- positions set by hand in the old units would pile the screens up. They go back to the layout.
UPDATE screens SET position = NULL WHERE position IS NOT NULL;
