const MEMBERSHIP_DAY_THRESHOLDS = [
  1,
  3,
  7,
  14,
  21,
  30,
  45,
  60,
  75,
  90,
  120,
  150,
  180,
  210,
  240,
  270,
  300,
  330,
  365,
  540,
  730,
];

const PAGE_COUNT_THRESHOLDS = Array.from({ length: 80 }, (_, index) => index + 1);

function pluralize(value, singular, plural) {
  return `${value} ${value > 1 ? plural : singular}`;
}

const membershipCriteria = MEMBERSHIP_DAY_THRESHOLDS.map((days) => ({
  key: `membership_days_${days}`,
  type: "membership_duration",
  name: `Fidèle depuis ${pluralize(days, "jour", "jours")}`,
  description: `Le membre participe depuis au moins ${pluralize(days, "jour", "jours")}.`,
  emoji: days >= 365 ? "🏆" : "⏳",
  options: { days },
}));

const pageCountCriteria = PAGE_COUNT_THRESHOLDS.map((count) => ({
  key: `page_count_${count}`,
  type: "page_count",
  name: `Auteur de ${pluralize(count, "page", "pages")}`,
  description: `A publié au moins ${pluralize(count, "article", "articles")}.`,
  emoji: count >= 25 ? "📚" : "📝",
  options: { count },
}));

export const ACHIEVEMENT_CRITERIA = [...membershipCriteria, ...pageCountCriteria];

export function getAchievementCriterionByKey(key) {
  if (typeof key !== "string") {
    return null;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }
  return ACHIEVEMENT_CRITERIA.find((criterion) => criterion.key === trimmed) || null;
}
