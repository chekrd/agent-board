-- How decisions ended: on the board or in the terminal, and on the board how (option, own text, second opinion, menu, dismiss)
SELECT kind, COALESCE(via, 'still open') AS via, COALESCE(how, '') AS how, COUNT(*) AS decisions,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY kind)) AS pct_of_kind
FROM decisions GROUP BY 1, 2, 3 ORDER BY kind, decisions DESC;
