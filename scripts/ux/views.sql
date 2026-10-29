-- One row per decision: when it was asked, first shown on a card, answered on the board, and closed. A decision
-- answered on the board closes when the board claims it; the answer event follows once its keys are typed.
CREATE TEMP VIEW decisions AS
WITH opened AS (
  SELECT task_id, decision_id, json_extract(data, '$.kind') AS kind, MIN(json_extract(data, '$.askedAt')) AS asked_at,
    json_extract(data, '$.load.open') AS open_then
  FROM ev WHERE name = 'decision-open' GROUP BY task_id, decision_id
), shown AS (
  SELECT task_id, decision_id, MIN(at) AS shown_at FROM ev WHERE name = 'card-shown' AND decision_id IS NOT NULL GROUP BY task_id, decision_id
), answered AS (
  SELECT task_id, decision_id, MIN(at) AS answered_at, json_extract(data, '$.how') AS how, json_extract(data, '$.option') AS option,
    json_extract(data, '$.followed') AS followed, json_extract(data, '$.confidence') AS confidence
  FROM ev WHERE name = 'decision-answer' GROUP BY task_id, decision_id
), closed AS (
  SELECT task_id, decision_id, MIN(at) AS closed_at, json_extract(data, '$.via') AS via FROM ev WHERE name = 'decision-close' GROUP BY task_id, decision_id
)
SELECT o.task_id, o.decision_id, o.kind, o.asked_at, o.open_then, s.shown_at, a.answered_at, a.how, a.option, a.followed, a.confidence,
  c.closed_at, COALESCE(c.via, CASE WHEN a.answered_at IS NOT NULL THEN 'board' END) AS via,
  COALESCE(c.closed_at, a.answered_at) - o.asked_at AS wait_ms,
  COALESCE(c.closed_at, a.answered_at) - s.shown_at AS decide_ms
FROM opened o
LEFT JOIN shown s USING (task_id, decision_id)
LEFT JOIN answered a USING (task_id, decision_id)
LEFT JOIN closed c USING (task_id, decision_id);
