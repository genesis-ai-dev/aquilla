-- 0049_model_ab_edit_distance.sql
--
-- Model A/B: record HOW MUCH each accepted/edited AI draft was rewritten, not
-- just whether it was. edit_distance is the normalized character-level
-- Levenshtein distance [0,1] between the model's draft and the human's text
-- (0 = validated verbatim, 1 = fully rewritten), computed client-side with the
-- same normalizedEditDistance the FRO-311 post-edit metrics use. The value
-- refines as the translator keeps editing (last write wins), while `outcome`
-- stays first-write-wins. AVG(edit_distance) per arm is the primary quality
-- ranking in the admin results — lower = the model's output needed less repair.

ALTER TABLE model_ab_events ADD COLUMN edit_distance DOUBLE PRECISION;
