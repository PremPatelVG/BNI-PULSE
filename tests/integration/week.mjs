// The dashboard's week (Tuesday-Friday) that today falls in, as the page computes it
// (getWeekTueFri): Saturday to Monday belong to the week that started the Tuesday before.
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function currentWeek(now = new Date()) {
  const day = now.getDay();
  const tue = new Date(now);
  tue.setDate(now.getDate() - (day >= 2 ? day - 2 : day + 5));
  const fri = new Date(tue);
  fri.setDate(tue.getDate() + 3);
  return { tue: iso(tue), fri: iso(fri) };
}

export const today = () => iso(new Date());
