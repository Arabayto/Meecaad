-- A shift can close with fuel left over and pass it to the next shift
-- ("carried"). It is then not a mismatch: the next shift must start with it.
ALTER TABLE fuel_sessions ADD COLUMN carried INTEGER NOT NULL DEFAULT 0 CHECK (carried IN (0, 1));
ALTER TABLE fuel_sessions ADD COLUMN carried_to TEXT;     -- the shift that took it over

-- Shifts closed before this existed, whose leftover is exactly what the next shift opened with.
UPDATE fuel_sessions SET carried = 1,
  carried_to = (SELECT n.id FROM fuel_sessions n WHERE n.business_id = fuel_sessions.business_id AND n.number = fuel_sessions.number + 1 AND n.opening_value = fuel_sessions.remaining)
WHERE status = 'closed' AND remaining > 0
  AND EXISTS (SELECT 1 FROM fuel_sessions n WHERE n.business_id = fuel_sessions.business_id AND n.number = fuel_sessions.number + 1 AND n.opening_value = fuel_sessions.remaining);
