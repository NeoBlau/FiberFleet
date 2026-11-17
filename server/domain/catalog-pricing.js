// Единая формула каталога: стоимость по нормо-часу, ЗП — доля от стоимости.
export function catalogAmounts(hours, hoursMax, settings) {
  const price = Math.round(Number(hours) * Number(settings.norm_hour_price));
  const priceMax = hoursMax == null ? null : Math.round(Number(hoursMax) * Number(settings.norm_hour_price));
  return { price, salary: Math.round(price * Number(settings.salary_rate)),
    price_max: priceMax, salary_max: priceMax == null ? null : Math.round(priceMax * Number(settings.salary_rate)) };
}

export function syncPlannedCatalogTasks(db, id = null) {
  db.prepare(`UPDATE tasks SET
    hours = (SELECT hours FROM work_types WHERE id = tasks.work_type_id),
    price = (SELECT price FROM work_types WHERE id = tasks.work_type_id),
    salary = (SELECT salary FROM work_types WHERE id = tasks.work_type_id)
    WHERE status = 'planned' AND work_type_id IS NOT NULL
      AND (@id IS NULL OR work_type_id = @id)`).run({ id });
}
