-- A class is one section: one course name, taught by one teacher, in one
-- block, with its own roster. "Calculus" with Tom in block 5, Tom in block 6
-- and Greg in block 5 are three classes. Teachers move from class_members to
-- classes.teacher_id; class_members becomes the student roster only.
--
-- Scheduling rules hold for active (unarchived) classes only, so archiving
-- last year's classes frees the blocks for the new year.

ALTER TABLE classes
  ADD COLUMN block      text,  -- e.g. '5'; NULL only on classes created before this migration
  ADD COLUMN teacher_id uuid REFERENCES users (id) ON DELETE SET NULL;

-- Backfill: the earliest-added teacher keeps the class and its students. Any
-- other teacher of the same class gets their own empty section of it (a
-- student may not be in two sections of one course), which an admin then
-- fills from the Classes view.
UPDATE classes c
SET teacher_id = (
  SELECT m.user_id FROM class_members m
  WHERE m.class_id = c.id AND m.member_role = 'teacher'
  ORDER BY m.added_at, m.user_id
  LIMIT 1
);

CREATE TEMP TABLE class_split AS
SELECT m.class_id AS old_id, m.user_id AS teacher_id, nextval('classes_id_seq') AS new_id
FROM class_members m
JOIN classes c ON c.id = m.class_id
WHERE m.member_role = 'teacher' AND m.user_id <> c.teacher_id;

INSERT INTO classes (id, name, term, archived_at, created_at, teacher_id)
SELECT s.new_id, c.name, c.term, c.archived_at, c.created_at, s.teacher_id
FROM class_split s JOIN classes c ON c.id = s.old_id;

DROP TABLE class_split;

DELETE FROM class_members WHERE member_role = 'teacher';
ALTER TABLE class_members DROP COLUMN member_role;

CREATE INDEX classes_teacher_idx ON classes (teacher_id);

-- The class key: course name + teacher + block. An unassigned class (no
-- teacher yet) still may not duplicate another unassigned one.
CREATE UNIQUE INDEX classes_key_uniq
  ON classes (lower(name), teacher_id, lower(block)) NULLS NOT DISTINCT
  WHERE archived_at IS NULL;

-- A teacher is in one room per block.
CREATE UNIQUE INDEX classes_teacher_block_uniq
  ON classes (teacher_id, lower(block))
  WHERE archived_at IS NULL AND teacher_id IS NOT NULL AND block IS NOT NULL;

-- A student is in one active class per block, and in one section per course.
-- These span two tables, so a trigger checks them. It locks the student's
-- users row first so two concurrent enrolments cannot both pass the check.
CREATE FUNCTION check_student_schedule(student uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  clash record;
BEGIN
  PERFORM 1 FROM users WHERE id = student FOR UPDATE;

  -- Names each clashing class with its teacher: "Calculus with Ada Lovelace".
  SELECT min(c.block) AS block,
         string_agg(c.name || COALESCE(' with ' || t.display_name, ''), ' and ' ORDER BY c.name, t.display_name) AS names
    INTO clash
  FROM class_members m
  JOIN classes c ON c.id = m.class_id
  LEFT JOIN users t ON t.id = c.teacher_id
  WHERE m.user_id = student AND c.archived_at IS NULL AND c.block IS NOT NULL
  GROUP BY lower(c.block)
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'This student would have two classes in block %: %', clash.block, clash.names
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'class_members_student_block';
  END IF;

  SELECT min(c.name) AS name INTO clash
  FROM class_members m JOIN classes c ON c.id = m.class_id
  WHERE m.user_id = student AND c.archived_at IS NULL
  GROUP BY lower(c.name)
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'This student is already in another section of %', clash.name
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'class_members_student_course';
  END IF;
END;
$$;

CREATE FUNCTION class_members_schedule_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_student_schedule(NEW.user_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER class_members_schedule
  AFTER INSERT OR UPDATE ON class_members
  FOR EACH ROW EXECUTE FUNCTION class_members_schedule_trigger();

-- Renaming, re-blocking or un-archiving a class can create a clash for any
-- student already in it.
CREATE FUNCTION classes_schedule_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  member uuid;
BEGIN
  FOR member IN SELECT user_id FROM class_members WHERE class_id = NEW.id ORDER BY user_id LOOP
    PERFORM check_student_schedule(member);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER classes_schedule
  AFTER UPDATE OF name, block, archived_at ON classes
  FOR EACH ROW EXECUTE FUNCTION classes_schedule_trigger();
